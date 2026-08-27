import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
import { RolUsuario, EstadoMovimiento, TipoCategoriaMovimiento } from '@sta/db';
import { subtotalItem } from '@sta/shared';
import { recordAudit } from '../services/audit.js';
import { encolarTicketRemito } from '../services/impresion.js';
import { getOrCreateSesionActual, FueraDeHorarioError } from '../services/sesion-caja.js';
import {
  resolverDeltasDeLista,
  deltaDeModificadores,
  opcionIdsDeItems,
} from '../services/deltas-lista.js';

/**
 * MAYORISTAS — Clientes con cuenta corriente.
 *
 * Modelo de negocio: vendemos a empresas a precio especial (vía una lista de
 * precios dedicada por cliente). Cada entrega se documenta con un REMITO que
 * suma a la cuenta corriente del cliente. A fin de mes se agrupan los remitos
 * del período (resumen para facturar por fuera) y, cuando el cliente paga, se
 * registra un COBRO (movimiento INGRESO) que baja el saldo.
 *
 * Saldo adeudado = Σ remitos PENDIENTE − crédito libre (ver `calcularSaldo`).
 * El cobro se modela como Movimiento INGRESO (entidadId = clienteMayoristaId)
 * para que la plata aterrice en el cashflow recién cuando efectivamente se cobra.
 */

/**
 * Saldo de la cuenta corriente de un cliente.
 *
 * La cuenta tiene dos lados que se pueden mover por separado: los remitos
 * cambian de estado (PENDIENTE → PAGADO) y los cobros entran plata. Lo natural
 * sería `remitado − cobrado`, y eso es lo que había: mientras los dos lados se
 * muevan juntos da bien, porque marcar PAGADO es sólo la MARCA de qué cobro
 * cubrió qué remito.
 *
 * El problema es que el botón "Marcar cobrado" de la ficha marca el remito sin
 * registrar ningún cobro. Con esa fórmula, ese remito seguía sumando entero a
 * la deuda: la pantalla mostraba el remito en verde y el saldo idéntico al
 * total remitado. Incidente real: La Juanita.
 *
 * Ésta lo calcula al revés y no se rompe en ese caso:
 *
 *   crédito libre = cobros − remitos ya marcados PAGADO   (nunca negativo)
 *   saldo         = remitos PENDIENTE − crédito libre
 *
 * Con los dos lados sanos da EXACTAMENTE lo mismo que antes (el crédito libre
 * es 0 y la resta se acomoda sola), incluidos los cobros "a cuenta" —plata
 * recibida sin imputar a ningún remito, que baja la deuda igual— y los pagos de
 * más, que siguen dando saldo negativo (el cliente queda a favor). La
 * diferencia aparece sólo cuando un remito quedó PAGADO sin cobro detrás: ahí
 * deja de contar como deuda, que es lo que la encargada ve en pantalla.
 *
 * Eso NO tapa el descalce: la plata sigue sin estar en la caja. Por eso el
 * detalle del cliente devuelve `descalce` con lo que está marcado cobrado y no
 * tiene cobro que lo respalde, y la ficha lo muestra.
 */
function calcularSaldo(a: { pendiente: number; pagado: number; cobrado: number }) {
  const creditoLibre = Math.max(0, a.cobrado - a.pagado);
  return a.pendiente - creditoLibre;
}

const METODOS = [
  'EFECTIVO',
  'TRANSFERENCIA',
  'DEPOSITO',
  'CHEQUE',
  'MERCADOPAGO_QR',
  'OTRO',
] as const;

const CATEGORIA_COBRO = 'Cobro cuenta corriente';

/** Resuelve la categoría de sistema de los cobros (idempotente). */
async function getCategoriaCobroId(): Promise<string> {
  const cat = await prisma.categoriaMovimiento.upsert({
    where: { nombre: CATEGORIA_COBRO },
    create: {
      nombre: CATEGORIA_COBRO,
      tipo: TipoCategoriaMovimiento.INGRESO,
      esSistema: true,
      esOperativa: true,
    },
    update: {},
  });
  return cat.id;
}

/** Un ítem del remito no se pudo resolver (producto inexistente, precio faltante). */
class ItemRemitoError extends Error {}

interface ModificadorEntrada {
  grupoId?: string;
  grupoNombre?: string;
  opcionId?: string;
  opcionNombre?: string;
  deltaPrecio?: string;
}
interface ItemEntrada {
  productoId?: string;
  nombre: string;
  cantidad: number;
  precioUnitario?: string;
  modificadores?: ModificadorEntrada[];
}
interface ItemsResueltos {
  itemsData: Array<{
    productoId: string | null;
    nombreSnapshot: string;
    cantidad: string;
    precioUnitario: string;
    subtotal: string;
    orden: number;
    modificadoresAplicados: Prisma.InputJsonValue | undefined;
    deltaModificadores: string;
  }>;
  total: number;
}

/**
 * Resuelve los ítems de un remito contra la lista de precios del cliente.
 *
 * Los precios se resuelven **server-side**: para un ítem con `productoId` NO se
 * confía en lo que manda el front, se lee el precio efectivo de la lista (o el
 * precio base con el ajuste porcentual). Sólo los ítems libres (sin producto
 * del catálogo) llevan precio manual.
 *
 * Los SABORES también: el delta sale de `deltas-lista.ts`, que resuelve el
 * precio de la opción contra la lista del cliente. Un producto con variantes
 * (pizzas, ravioles) no tiene un precio solo, y antes el remito lo cargaba
 * como si lo tuviera.
 *
 * Extraído para que crear y EDITAR un remito usen exactamente el mismo cálculo:
 * si divergen, editar un remito le cambia el total sin que nadie lo pida.
 */
async function resolverItemsRemito(
  cliente: { listaPreciosId: string; listaPrecios: { ajustePctDefault: Prisma.Decimal } },
  items: ItemEntrada[],
): Promise<ItemsResueltos> {
  const ajustePct = Number(cliente.listaPrecios.ajustePctDefault);
  const productoIds = [...new Set(items.map((i) => i.productoId).filter(Boolean) as string[])];
  const productos = productoIds.length
    ? await prisma.producto.findMany({
        where: { id: { in: productoIds } },
        include: {
          preciosPorLista: {
            where: { listaId: cliente.listaPreciosId },
            orderBy: { vigenciaDesde: 'desc' },
            take: 1,
          },
        },
      })
    : [];
  const prodMap = new Map(productos.map((p) => [p.id, p]));
  const deltas = await resolverDeltasDeLista(cliente.listaPreciosId, opcionIdsDeItems(items));

  const itemsData: ItemsResueltos['itemsData'] = [];
  let total = 0;
  for (const [idx, it] of items.entries()) {
    let precioUnitario: number;
    let subtotalStr: string;
    let nombre = it.nombre;
    let deltaMod = 0;
    if (it.productoId) {
      const p = prodMap.get(it.productoId);
      if (!p) throw new ItemRemitoError(`Producto ${it.productoId} no existe`);
      const override = p.preciosPorLista[0]?.precioEfectivo;
      deltaMod = deltaDeModificadores(it.modificadores ?? [], deltas);
      precioUnitario =
        (override ? Number(override) : Number(p.precioBase) * (1 + ajustePct / 100)) + deltaMod;
      nombre = p.nombre;
      subtotalStr = subtotalItem({
        cantidad: it.cantidad,
        precioUnitario: precioUnitario.toFixed(2),
        unidadPrecio: p.unidadPrecio,
      });
    } else {
      // Ítem libre (sin producto del catálogo): precio manual, por unidad.
      precioUnitario = Number(it.precioUnitario ?? 0);
      if (precioUnitario <= 0) {
        throw new ItemRemitoError(`Falta el precio del ítem "${it.nombre}"`);
      }
      subtotalStr = (it.cantidad * precioUnitario).toFixed(2);
    }
    total += Number(subtotalStr);
    itemsData.push({
      productoId: it.productoId ?? null,
      nombreSnapshot: nombre,
      cantidad: String(it.cantidad),
      precioUnitario: precioUnitario.toFixed(2),
      subtotal: subtotalStr,
      orden: idx,
      modificadoresAplicados: it.modificadores?.length
        ? (it.modificadores as unknown as Prisma.InputJsonValue)
        : undefined,
      deltaModificadores: deltaMod.toFixed(2),
    });
  }
  return { itemsData, total };
}

/** Una línea de cobro ya normalizada (venga de la forma simple o de la dividida). */
interface LineaCobro {
  metodo: (typeof METODOS)[number];
  cuentaId: string;
  monto: string;
  numeroReferencia?: string;
}

/**
 * Registra un cobro de cuenta corriente DENTRO de una transacción.
 *
 * UN MOVIMIENTO POR LÍNEA. Un `Movimiento` tiene una sola `cuentaDestinoId`:
 * si el cobro se paga mitad por transferencia y mitad en efectivo, meterlo en
 * un movimiento solo dejaría la plata entera en una cuenta y el arqueo de la
 * otra daría de menos. Con una línea = un movimiento cada cuenta recibe lo
 * suyo, y el saldo del cliente (que suma los INGRESO por `entidadId`) sigue
 * dando igual.
 *
 * Devuelve el PRIMER movimiento: es el que queda como `pagadoConMovimientoId`
 * de los remitos imputados (el campo es uno solo).
 *
 * Está acá afuera para que cobrar desde la ficha del cliente y cobrar un
 * remito en el momento de crearlo hagan exactamente lo mismo.
 */
async function registrarCobro(
  tx: Prisma.TransactionClient,
  args: {
    cliente: { id: string; nombre: string };
    lineas: LineaCobro[];
    fecha: Date;
    observacion: string;
    categoriaId: string;
    usuarioId: string;
    sesionId: string;
    aImputar: string[];
    montoTotal: string;
  },
) {
  const { cliente, lineas, fecha, categoriaId, usuarioId, sesionId, aImputar } = args;
  const movimientos = [];
  for (const linea of lineas) {
    const m = await tx.movimiento.create({
      data: {
        tipo: 'INGRESO',
        monto: linea.monto,
        categoriaId,
        cuentaDestinoId: linea.cuentaId,
        entidadId: cliente.id,
        fechaComputo: fecha,
        observacion: lineas.length > 1 ? `${args.observacion} (${linea.metodo})` : args.observacion,
        estado: EstadoMovimiento.CONFIRMADO,
        usuarioId,
        // El cobro de cuenta corriente es PLATA QUE ENTRA A LA CAJA DEL TURNO,
        // así que necesita `sesionCajaId` como cualquier otro movimiento. Sin
        // esto queda con sesion_caja_id NULL: NO entra al cierre (que filtra
        // por sesión) pero SÍ aparece en /admin/movimientos (que filtra por
        // fecha) — la encargada lo ve listado y el cierre no lo cuenta.
        sesionCajaId: sesionId,
      },
    });
    const pago = await tx.pago.create({
      data: {
        movimientoId: m.id,
        metodo: linea.metodo,
        cuentaId: linea.cuentaId,
        monto: linea.monto,
        numeroReferencia: linea.numeroReferencia ?? null,
        estado: 'CONFIRMADO',
        fecha,
      },
    });
    // Los audits van DENTRO de la transacción: si el cobro se rollbackea no
    // queremos eventos de replicación de algo que no existe.
    await recordAudit({
      tabla: 'movimientos',
      registroId: m.id,
      accion: 'INSERT',
      usuarioId,
      valorNuevo: {
        tipo: 'INGRESO',
        concepto: 'Cobro cuenta corriente',
        cliente: cliente.nombre,
        monto: linea.monto,
        metodo: linea.metodo,
        totalCobro: args.montoTotal,
        remitosImputados: aImputar.length,
      },
      tx,
    });
    // `pagos` es otra tabla: sin evento propio, el cobro llega a la nube sin su
    // forma de pago. Después del movimiento (mayor `secuencia`), que es el
    // orden que respeta la FK pago → movimiento al replicar.
    await recordAudit({
      tabla: 'pagos',
      registroId: pago.id,
      accion: 'INSERT',
      usuarioId,
      contexto: { movimientoId: m.id, motivo: 'cobro mayorista' },
      tx,
    });
    await tx.cuenta.update({
      where: { id: linea.cuentaId },
      data: { saldoActual: { increment: Number(linea.monto) } },
    });
    movimientos.push(m);
  }
  // Imputación: los remitos elegidos quedan PAGADO y apuntando al primer
  // movimiento del cobro. Va DENTRO de la tx: si falla, no queremos remitos
  // marcados como cobrados sin el cobro registrado.
  if (aImputar.length) {
    await tx.remito.updateMany({
      where: { id: { in: aImputar } },
      data: { estado: 'PAGADO', pagadoAt: fecha, pagadoConMovimientoId: movimientos[0]!.id },
    });
  }
  return movimientos[0]!;
}

export default async function mayoristasRoutes(fastify: FastifyInstance) {
  // ── Listas de precios disponibles (para asignar a un cliente) ──
  fastify.get(
    '/admin/mayoristas/listas',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const listas = await prisma.listaPrecios.findMany({
        where: { activa: true },
        orderBy: { nombre: 'asc' },
        select: { id: true, nombre: true },
      });
      return { listas };
    },
  );

  // ── Listado de clientes mayoristas con su saldo de cuenta corriente ──
  fastify.get(
    '/admin/mayoristas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({ incluirInactivos: z.coerce.boolean().optional() }),
      },
    },
    async (req) => {
      const q = req.query as { incluirInactivos?: boolean };
      const clientes = await prisma.clienteMayorista.findMany({
        where: q.incluirInactivos ? {} : { activo: true },
        include: { listaPrecios: { select: { id: true, nombre: true } } },
        orderBy: { nombre: 'asc' },
      });
      const ids = clientes.map((c) => c.id);
      const [porEstado, cobrado] = await Promise.all([
        // Agrupado por estado, no sólo `not: ANULADO`: `calcularSaldo` necesita
        // PENDIENTE y PAGADO por separado.
        prisma.remito.groupBy({
          by: ['clienteMayoristaId', 'estado'],
          _sum: { total: true },
          where: { estado: { not: 'ANULADO' }, clienteMayoristaId: { in: ids } },
        }),
        prisma.movimiento.groupBy({
          by: ['entidadId'],
          _sum: { monto: true },
          where: { estado: EstadoMovimiento.CONFIRMADO, tipo: 'INGRESO', entidadId: { in: ids } },
        }),
      ]);
      const pendMap = new Map<string, number>();
      const pagMap = new Map<string, number>();
      for (const r of porEstado) {
        const destino = r.estado === 'PAGADO' ? pagMap : pendMap;
        destino.set(r.clienteMayoristaId, Number(r._sum.total ?? 0));
      }
      const cobMap = new Map(cobrado.map((c) => [c.entidadId, Number(c._sum.monto ?? 0)]));

      return {
        clientes: clientes.map((c) => {
          const saldo = calcularSaldo({
            pendiente: pendMap.get(c.id) ?? 0,
            pagado: pagMap.get(c.id) ?? 0,
            cobrado: cobMap.get(c.id) ?? 0,
          });
          return {
            id: c.id,
            nombre: c.nombre,
            cuit: c.cuit,
            telefono: c.telefono,
            activo: c.activo,
            lista: c.listaPrecios,
            saldo: saldo.toFixed(2),
          };
        }),
      };
    },
  );

  // ── Crear cliente mayorista ──
  fastify.post(
    '/admin/mayoristas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(160),
          listaPreciosId: z.string().uuid(),
          cuit: z.string().max(20).optional(),
          contacto: z.string().max(120).optional(),
          telefono: z.string().max(40).optional(),
          email: z.string().max(120).optional(),
          direccion: z.string().max(500).optional(),
          observaciones: z.string().max(1000).optional(),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body as {
        nombre: string;
        listaPreciosId: string;
        cuit?: string;
        contacto?: string;
        telefono?: string;
        email?: string;
        direccion?: string;
        observaciones?: string;
      };
      const lista = await prisma.listaPrecios.findUnique({ where: { id: b.listaPreciosId } });
      if (!lista) return reply.code(400).send({ error: 'La lista de precios no existe' });

      const cliente = await prisma.clienteMayorista.create({
        data: {
          nombre: b.nombre,
          listaPreciosId: b.listaPreciosId,
          cuit: b.cuit || null,
          contacto: b.contacto || null,
          telefono: b.telefono || null,
          email: b.email || null,
          direccion: b.direccion || null,
          observaciones: b.observaciones || null,
        },
      });
      await recordAudit({
        tabla: 'clientes_mayoristas',
        registroId: cliente.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: cliente.nombre, lista: lista.nombre },
      });
      return reply.code(201).send(cliente);
    },
  );

  // ── Editar / activar-desactivar cliente ──
  fastify.patch(
    '/admin/mayoristas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(160).optional(),
          listaPreciosId: z.string().uuid().optional(),
          cuit: z.string().max(20).nullable().optional(),
          contacto: z.string().max(120).nullable().optional(),
          telefono: z.string().max(40).nullable().optional(),
          email: z.string().max(120).nullable().optional(),
          direccion: z.string().max(500).nullable().optional(),
          observaciones: z.string().max(1000).nullable().optional(),
          activo: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as Record<string, unknown>;
      const existe = await prisma.clienteMayorista.findUnique({ where: { id } });
      if (!existe) return reply.code(404).send({ error: 'Cliente no encontrado' });
      const updated = await prisma.clienteMayorista.update({
        where: { id },
        data: b as Prisma.ClienteMayoristaUncheckedUpdateInput,
      });
      await recordAudit({
        tabla: 'clientes_mayoristas',
        registroId: id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorNuevo: b as Record<string, unknown>,
      });
      return updated;
    },
  );

  // ── Detalle: cliente + saldo + remitos + cobros ──
  fastify.get(
    '/admin/mayoristas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const cliente = await prisma.clienteMayorista.findUnique({
        where: { id },
        include: { listaPrecios: { select: { id: true, nombre: true } } },
      });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

      const [remitos, cobros, remitado, cobrado] = await Promise.all([
        prisma.remito.findMany({
          where: { clienteMayoristaId: id },
          orderBy: { fecha: 'desc' },
          take: 500,
          // Items completos: el "Imprimir resumen" lista los productos de cada
          // remito (nombre, cantidad, unitario, total de línea).
          include: {
            _count: { select: { items: true } },
            items: { orderBy: { orden: 'asc' } },
          },
        }),
        prisma.movimiento.findMany({
          where: { entidadId: id, tipo: 'INGRESO' },
          orderBy: { fechaComputo: 'desc' },
          take: 200,
          include: {
            cuentaDestino: { select: { nombre: true } },
            usuario: { select: { nombre: true } },
          },
        }),
        prisma.remito.groupBy({
          by: ['estado'],
          _sum: { total: true },
          where: { clienteMayoristaId: id, estado: { not: 'ANULADO' } },
        }),
        prisma.movimiento.aggregate({
          _sum: { monto: true },
          where: { entidadId: id, tipo: 'INGRESO', estado: EstadoMovimiento.CONFIRMADO },
        }),
      ]);

      const sumaPorEstado = (e: string) =>
        Number(remitado.find((r) => r.estado === e)?._sum.total ?? 0);
      const totalPendiente = sumaPorEstado('PENDIENTE');
      const totalPagado = sumaPorEstado('PAGADO');
      const totalRemitado = totalPendiente + totalPagado;
      const totalCobrado = Number(cobrado._sum.monto ?? 0);

      // Plata que la ficha da por cobrada y que no está en ninguna cuenta:
      // remitos marcados con "Marcar cobrado" sin registrar el cobro. Es el
      // espejo del crédito libre — sólo uno de los dos puede ser > 0. Va a la
      // respuesta para que la ficha lo muestre en vez de que el descalce viva
      // escondido en la diferencia entre dos números.
      const descalce = Math.max(0, totalPagado - totalCobrado);
      const remitosSinRespaldo = remitos
        .filter((r) => r.estado === 'PAGADO' && !r.pagadoConMovimientoId)
        .map((r) => r.numero);

      return {
        cliente: {
          id: cliente.id,
          nombre: cliente.nombre,
          cuit: cliente.cuit,
          contacto: cliente.contacto,
          telefono: cliente.telefono,
          email: cliente.email,
          direccion: cliente.direccion,
          observaciones: cliente.observaciones,
          activo: cliente.activo,
          lista: cliente.listaPrecios,
        },
        saldo: calcularSaldo({
          pendiente: totalPendiente,
          pagado: totalPagado,
          cobrado: totalCobrado,
        }).toFixed(2),
        totales: { remitado: totalRemitado.toFixed(2), cobrado: totalCobrado.toFixed(2) },
        descalce: {
          monto: descalce.toFixed(2),
          remitos: remitosSinRespaldo,
        },
        // Plata cobrada que todavía no está imputada a ningún remito. Es lo
        // único con lo que se puede marcar un remito cobrado sin mover plata:
        // la ficha avisa cuando alcanza y cuando no.
        creditoLibre: Math.max(0, totalCobrado - totalPagado).toFixed(2),
        remitos: remitos.map((r) => ({
          id: r.id,
          numero: r.numero,
          fecha: r.fecha,
          total: r.total.toFixed(2),
          estado: r.estado,
          pagadoAt: r.pagadoAt,
          itemsCount: r._count.items,
          observaciones: r.observaciones,
          items: r.items.map((it) => ({
            nombre: it.nombreSnapshot,
            cantidad: it.cantidad.toString(),
            precioUnitario: it.precioUnitario.toFixed(2),
            subtotal: it.subtotal.toFixed(2),
            modificadores: it.modificadoresAplicados ?? null,
          })),
        })),
        cobros: cobros
          .filter((m) => m.estado === EstadoMovimiento.CONFIRMADO)
          .map((m) => ({
            id: m.id,
            fecha: m.fechaComputo,
            monto: m.monto.toFixed(2),
            cuenta: m.cuentaDestino?.nombre ?? '—',
            usuario: m.usuario?.nombre ?? null,
            observacion: m.observacion,
          })),
      };
    },
  );

  // ── Catálogo con precios resueltos para la lista del cliente ──
  fastify.get(
    '/admin/mayoristas/:id/catalogo',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const cliente = await prisma.clienteMayorista.findUnique({
        where: { id },
        include: { listaPrecios: true },
      });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

      const ajustePct = Number(cliente.listaPrecios.ajustePctDefault);

      // Las listas de mayorista son CUSTOM: tienen MIEMBROS. Un producto está en
      // la lista si tiene fila en `precios_por_lista` — es el mismo criterio con
      // el que `listas.ts` cuenta los productos de la lista y con el que la
      // pantalla de catálogo deja marcarlos/desmarcarlos.
      //
      // Acá se pedía `where: { activo: true }` a secas, así que el remito
      // ofrecía TODO el catálogo aunque la lista tuviera tres productos. La
      // encargada armaba la lista y no servía para nada: los precios salían del
      // ajuste % general y aparecían productos que ese cliente no compra.
      const esCustom = cliente.listaPrecios.canalDefault === 'MAYORISTA';
      // Los modificadores llegan por el tipo de producto o por el producto
      // puntual: hay que traer los dos y unirlos, igual que /catalogo/productos.
      const incluirModificadores = {
        include: {
          grupoModificador: {
            include: { opciones: { where: { activa: true }, orderBy: { orden: 'asc' as const } } },
          },
        },
      };
      const productos = await prisma.producto.findMany({
        where: esCustom
          ? { activo: true, preciosPorLista: { some: { listaId: cliente.listaPreciosId } } }
          : { activo: true },
        orderBy: { nombre: 'asc' },
        include: {
          preciosPorLista: {
            where: { listaId: cliente.listaPreciosId },
            orderBy: { vigenciaDesde: 'desc' },
            take: 1,
          },
          tipoProducto: { include: { modificadores: incluirModificadores } },
          modificadores: incluirModificadores,
        },
      });

      // Deltas de sabor pisados para la lista de este cliente.
      const overrides = await prisma.deltaOpcionPorLista.findMany({
        where: { listaId: cliente.listaPreciosId },
        select: { opcionId: true, deltaPrecio: true },
      });
      const overrideMap = new Map(overrides.map((o) => [o.opcionId, o.deltaPrecio.toString()]));

      return {
        lista: { id: cliente.listaPrecios.id, nombre: cliente.listaPrecios.nombre },
        productos: productos.map((p) => {
          const override = p.preciosPorLista[0]?.precioEfectivo;
          const precio = override
            ? Number(override)
            : Number(p.precioBase) * (1 + ajustePct / 100);
          // Sabores del producto, con el precio que tienen EN ESTA LISTA. Sin
          // esto el remito de un producto con variantes (pizzas, ravioles)
          // salía con el precio del producto "pelado".
          const grupos = [...p.modificadores, ...p.tipoProducto.modificadores].map((ma) => {
            const g = ma.grupoModificador;
            return {
              grupoId: g.id,
              grupoNombre: g.nombre,
              obligatorio: ma.obligatorioOverride ?? g.obligatorio,
              tipoSeleccion: g.tipoSeleccion,
              opciones: g.opciones.map((o) => ({
                opcionId: o.id,
                nombre: o.nombre,
                codigo: o.codigo,
                deltaPrecio: overrideMap.get(o.id) ?? o.deltaPrecio.toString(),
              })),
            };
          });
          return {
            id: p.id,
            nombre: p.nombre,
            marca: p.marca,
            // código y presentación: para que el buscador del remito filtre por
            // ellos además del nombre/marca.
            codigo: p.codigo,
            presentacion: p.presentacion,
            unidadPrecio: p.unidadPrecio,
            unidadPrecioLabel: p.unidadPrecioLabel,
            formaVenta: p.formaVenta,
            precioUnitario: precio.toFixed(2),
            grupos,
          };
        }),
      };
    },
  );

  // ── Crear remito ──
  fastify.post(
    '/admin/mayoristas/:id/remitos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          fecha: z.string().datetime().optional(),
          observaciones: z.string().max(1000).optional(),
          // Cobrar el remito EN EL MOMENTO. Sin esto había que crear el remito,
          // volver a la ficha y cargar el cobro aparte imputándolo a mano — tres
          // pantallas para lo que en el mostrador es un solo gesto.
          // El monto sale del total calculado server-side, no del front.
          cobrar: z
            .object({
              pagos: z
                .array(
                  z.object({
                    metodo: z.enum(METODOS),
                    cuentaId: z.string().uuid(),
                    monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
                    numeroReferencia: z.string().max(80).optional(),
                  }),
                )
                .min(1)
                .max(10),
            })
            .optional(),
          items: z
            .array(
              z.object({
                productoId: z.string().uuid().optional(),
                nombre: z.string().min(1).max(200),
                cantidad: z.coerce.number().positive(),
                // precioUnitario sólo se usa para ítems libres (sin productoId).
                precioUnitario: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
                modificadores: z
                  .array(
                    z.object({
                      grupoId: z.string().uuid().optional(),
                      grupoNombre: z.string().max(80).optional(),
                      opcionId: z.string().uuid().optional(),
                      opcionNombre: z.string().max(120).optional(),
                      // El server lo re-resuelve contra la lista del cliente y
                      // lo usa sólo como techo — ver deltas-lista.ts.
                      deltaPrecio: z.string().regex(/^-?\d+(\.\d{1,2})?$/).optional(),
                    }),
                  )
                  .optional(),
              }),
            )
            .min(1),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as {
        fecha?: string;
        observaciones?: string;
        items: ItemEntrada[];
        cobrar?: { pagos: LineaCobro[] };
      };
      const cliente = await prisma.clienteMayorista.findUnique({
        where: { id },
        include: { listaPrecios: true },
      });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

      let resuelto: ItemsResueltos;
      try {
        resuelto = await resolverItemsRemito(cliente, b.items);
      } catch (e) {
        if (e instanceof ItemRemitoError) return reply.code(400).send({ error: e.message });
        throw e;
      }
      const { itemsData, total } = resuelto;

      // Si se cobra en el momento, los pagos tienen que cubrir el total que
      // calculó el SERVER (no el que muestra la pantalla, que puede estar
      // desactualizado si cambió un precio mientras cargaban el remito).
      let sesionId: string | null = null;
      let categoriaId: string | null = null;
      if (b.cobrar) {
        const suma = b.cobrar.pagos.reduce((a, p) => a + Number(p.monto), 0);
        if (Math.abs(suma - total) > 0.01) {
          return reply.code(400).send({
            error:
              `Los pagos suman $${suma.toFixed(2)} y el remito da $${total.toFixed(2)}. ` +
              'Revisá los montos (puede haber cambiado un precio).',
          });
        }
        try {
          sesionId = (await getOrCreateSesionActual(req.usuario!.id)).id;
        } catch (e) {
          if (e instanceof FueraDeHorarioError) {
            return reply.code(423).send({
              error:
                'No hay un turno abierto, así que el cobro no tendría dónde ' +
                'imputarse. Guardá el remito sin cobrar y registrá el cobro cuando abra la caja.',
              code: 'FUERA_DE_HORARIO',
            });
          }
          throw e;
        }
        categoriaId = await getCategoriaCobroId();
      }

      const remito = await prisma.remito.create({
        data: {
          clienteMayoristaId: id,
          fecha: b.fecha ? new Date(b.fecha) : new Date(),
          total: total.toFixed(2),
          observaciones: b.observaciones || null,
          usuarioId: req.usuario!.id,
          items: { create: itemsData },
        },
        include: { items: true },
      });
      await recordAudit({
        tabla: 'remitos',
        registroId: remito.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { numero: remito.numero, cliente: cliente.nombre, total: remito.total.toFixed(2) },
      });
      // Los ítems se auditan DESPUÉS del remito (secuencia mayor): el
      // replicador aplica por secuencia y la FK del hijo pide que el padre ya
      // esté en la nube. Sin este audit las filas nunca salían de la caja —
      // el mismo agujero que tenían los items de venta.
      for (const it of remito.items) {
        await recordAudit({
          tabla: 'remito_items',
          registroId: it.id,
          accion: 'INSERT',
          usuarioId: req.usuario!.id,
          valorNuevo: { remitoId: remito.id, nombre: it.nombreSnapshot },
        });
      }
      // El cobro va DESPUÉS de que el remito existe: se imputa contra él, así
      // queda PAGADO y apuntando a su movimiento como cualquier otro cobro.
      if (b.cobrar && sesionId && categoriaId) {
        await prisma.$transaction((tx) =>
          registrarCobro(tx, {
            cliente: { id: cliente.id, nombre: cliente.nombre },
            lineas: b.cobrar!.pagos,
            fecha: new Date(),
            observacion: `Cobro ${cliente.nombre} · remito #${remito.numero}`,
            categoriaId: categoriaId!,
            usuarioId: req.usuario!.id,
            sesionId: sesionId!,
            aImputar: [remito.id],
            montoTotal: total.toFixed(2),
          }),
        );
      }
      return reply.code(201).send({ ...remito, cobrado: Boolean(b.cobrar) });
    },
  );

  // ── Detalle de un remito (para verlo / imprimirlo) ──
  fastify.get(
    '/admin/mayoristas/remitos/:remitoId',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ remitoId: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { remitoId } = req.params as { remitoId: string };
      const remito = await prisma.remito.findUnique({
        where: { id: remitoId },
        include: {
          items: { orderBy: { orden: 'asc' } },
          clienteMayorista: { select: { nombre: true, cuit: true } },
        },
      });
      if (!remito) return reply.code(404).send({ error: 'Remito no encontrado' });
      return {
        id: remito.id,
        numero: remito.numero,
        fecha: remito.fecha,
        estado: remito.estado,
        pagadoAt: remito.pagadoAt,
        total: remito.total.toFixed(2),
        observaciones: remito.observaciones,
        cliente: remito.clienteMayorista,
        items: remito.items.map((it) => ({
          // productoId hace falta para PRECARGAR el editor: sin él no se puede
          // reconstruir la línea contra el catálogo y editar perdería el ítem.
          productoId: it.productoId,
          nombre: it.nombreSnapshot,
          cantidad: it.cantidad.toString(),
          precioUnitario: it.precioUnitario.toFixed(2),
          subtotal: it.subtotal.toFixed(2),
          // Los sabores elegidos, para que editar el remito los precargue en
          // vez de perderlos (y recalcular el total sin ellos).
          modificadores: it.modificadoresAplicados ?? null,
          deltaModificadores: it.deltaModificadores.toFixed(2),
        })),
      };
    },
  );

  // ── Editar remito (reemplaza los ítems y recalcula el total) ──
  //
  // Un remito ANULADO no se edita: ya salió de la cuenta corriente y
  // reescribirlo dejaría el audit sin sentido. Uno PAGADO tampoco: cambiarle el
  // total después de cobrarlo descuadra el saldo contra el cobro ya registrado.
  fastify.put(
    '/admin/mayoristas/remitos/:remitoId',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ remitoId: z.string().uuid() }),
        body: z.object({
          fecha: z.string().datetime().optional(),
          observaciones: z.string().max(1000).nullable().optional(),
          items: z
            .array(
              z.object({
                productoId: z.string().uuid().optional(),
                nombre: z.string().min(1).max(200),
                cantidad: z.coerce.number().positive(),
                precioUnitario: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
                modificadores: z
                  .array(
                    z.object({
                      grupoId: z.string().uuid().optional(),
                      grupoNombre: z.string().max(80).optional(),
                      opcionId: z.string().uuid().optional(),
                      opcionNombre: z.string().max(120).optional(),
                      // El server lo re-resuelve contra la lista del cliente y
                      // lo usa sólo como techo — ver deltas-lista.ts.
                      deltaPrecio: z.string().regex(/^-?\d+(\.\d{1,2})?$/).optional(),
                    }),
                  )
                  .optional(),
              }),
            )
            .min(1),
        }),
      },
    },
    async (req, reply) => {
      const { remitoId } = req.params as { remitoId: string };
      const b = req.body as {
        fecha?: string;
        observaciones?: string | null;
        items: ItemEntrada[];
      };
      const remito = await prisma.remito.findUnique({ where: { id: remitoId } });
      if (!remito) return reply.code(404).send({ error: 'Remito no encontrado' });
      if (remito.estado === 'ANULADO') {
        return reply.code(400).send({ error: 'No se puede editar un remito anulado' });
      }
      if (remito.estado === 'PAGADO') {
        return reply.code(400).send({
          error: 'No se puede editar un remito ya cobrado. Marcalo como pendiente primero.',
        });
      }
      const cliente = await prisma.clienteMayorista.findUnique({
        where: { id: remito.clienteMayoristaId },
        include: { listaPrecios: true },
      });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

      let resuelto: ItemsResueltos;
      try {
        resuelto = await resolverItemsRemito(cliente, b.items);
      } catch (e) {
        if (e instanceof ItemRemitoError) return reply.code(400).send({ error: e.message });
        throw e;
      }
      const totalAnterior = remito.total.toFixed(2);

      const actualizado = await prisma.$transaction(async (tx) => {
        // Reemplazo completo: borrar + recrear es más simple y seguro que
        // diffear, y el remito es chico. Los ítems no se referencian desde
        // ningún lado, así que no hay nada que se rompa al borrarlos.
        // Los ids viejos hacen falta para auditar las BAJAS: sin eso la nube
        // se queda con los ítems anteriores y el remito replicado suma dos
        // veces (los borrados + los nuevos).
        const previos = await tx.remitoItem.findMany({
          where: { remitoId },
          select: { id: true },
        });
        await tx.remitoItem.deleteMany({ where: { remitoId } });
        const upd = await tx.remito.update({
          where: { id: remitoId },
          data: {
            ...(b.fecha && { fecha: new Date(b.fecha) }),
            ...(b.observaciones !== undefined && { observaciones: b.observaciones || null }),
            total: resuelto.total.toFixed(2),
            items: { create: resuelto.itemsData },
          },
          include: { items: { orderBy: { orden: 'asc' } } },
        });
        await recordAudit({
          tabla: 'remitos',
          registroId: remitoId,
          accion: 'UPDATE',
          usuarioId: req.usuario!.id,
          valorAnterior: { total: totalAnterior },
          valorNuevo: { total: upd.total.toFixed(2), items: upd.items.length },
          tx,
        });
        for (const prev of previos) {
          await recordAudit({
            tabla: 'remito_items',
            registroId: prev.id,
            accion: 'DELETE',
            usuarioId: req.usuario!.id,
            valorAnterior: { remitoId },
            tx,
          });
        }
        for (const it of upd.items) {
          await recordAudit({
            tabla: 'remito_items',
            registroId: it.id,
            accion: 'INSERT',
            usuarioId: req.usuario!.id,
            valorNuevo: { remitoId, nombre: it.nombreSnapshot },
            tx,
          });
        }
        return upd;
      });
      return actualizado;
    },
  );

  // ── Marcar un remito como cobrado (o volverlo a pendiente) ──
  //
  // OJO: esto NO mueve plata. Es una MARCA para saber qué remitos cubrió un
  // cobro; el dinero entra por `/cobros` (movimiento INGRESO). Un remito PAGADO
  // sigue contando en el total remitado — ver la nota del cálculo de saldo.
  fastify.post(
    '/admin/mayoristas/remitos/:remitoId/pagar',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ remitoId: z.string().uuid() }),
        body: z.object({ pagado: z.boolean().default(true) }).optional(),
      },
    },
    async (req, reply) => {
      const { remitoId } = req.params as { remitoId: string };
      const pagado = (req.body as { pagado?: boolean } | undefined)?.pagado ?? true;
      const remito = await prisma.remito.findUnique({ where: { id: remitoId } });
      if (!remito) return reply.code(404).send({ error: 'Remito no encontrado' });
      if (remito.estado === 'ANULADO') {
        return reply.code(400).send({ error: 'El remito está anulado' });
      }
      const destino = pagado ? 'PAGADO' : 'PENDIENTE';
      if (remito.estado === destino) return remito; // idempotente

      const updated = await prisma.remito.update({
        where: { id: remitoId },
        data: {
          estado: destino,
          pagadoAt: pagado ? new Date() : null,
          // Al despagar se suelta el link al cobro: si volvió a pendiente, ese
          // movimiento ya no lo cubre.
          ...(pagado ? {} : { pagadoConMovimientoId: null }),
        },
      });
      await recordAudit({
        tabla: 'remitos',
        registroId: remitoId,
        accion: 'TRANSITION',
        usuarioId: req.usuario!.id,
        valorAnterior: { estado: remito.estado },
        valorNuevo: { estado: destino },
      });
      return updated;
    },
  );

  // ── Imprimir el remito como TICKET (comandera térmica) ──
  //
  // Distinto del "resumen de cuenta": ese es un A4 del período que se arma en
  // el navegador y va al contador. Esto es el papel que se le entrega a la
  // empresa con la mercadería, en formato de ticket de mostrador.
  fastify.post(
    '/admin/mayoristas/remitos/:remitoId/imprimir',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ remitoId: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { remitoId } = req.params as { remitoId: string };
      const out = await encolarTicketRemito(remitoId);
      if (!out) return reply.code(404).send({ error: 'Remito no encontrado' });
      return reply.code(202).send({ encolado: true, ...out });
    },
  );

  // ── Anular remito ──
  fastify.post(
    '/admin/mayoristas/remitos/:remitoId/anular',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ remitoId: z.string().uuid() }),
        body: z.object({ motivo: z.string().max(300).optional() }).optional(),
      },
    },
    async (req, reply) => {
      const { remitoId } = req.params as { remitoId: string };
      const body = (req.body as { motivo?: string } | undefined) ?? {};
      const remito = await prisma.remito.findUnique({ where: { id: remitoId } });
      if (!remito) return reply.code(404).send({ error: 'Remito no encontrado' });
      if (remito.estado === 'ANULADO') {
        return reply.code(400).send({ error: 'El remito ya está anulado' });
      }
      const updated = await prisma.remito.update({
        where: { id: remitoId },
        data: { estado: 'ANULADO', motivoAnulacion: body.motivo || null, anuladoAt: new Date() },
      });
      await recordAudit({
        tabla: 'remitos',
        registroId: remitoId,
        accion: 'TRANSITION',
        usuarioId: req.usuario!.id,
        valorAnterior: { estado: 'PENDIENTE' },
        valorNuevo: { estado: 'ANULADO', motivo: body.motivo ?? null },
      });
      return updated;
    },
  );

  // ── Registrar cobro de cuenta corriente (movimiento INGRESO) ──
  fastify.post(
    '/admin/mayoristas/:id/cobros',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
          // Forma simple (un método): `cuentaId` + `metodo`. Se mantiene porque
          // es el 90% de los cobros y no vale la pena obligar a armar un array.
          cuentaId: z.string().uuid().optional(),
          metodo: z.enum(METODOS).default('TRANSFERENCIA'),
          // Forma dividida: la empresa paga una parte por transferencia y otra
          // en efectivo. Cada línea aterriza en SU cuenta — si se metieran
          // todas en una, el arqueo de esa cuenta daría de más.
          pagos: z
            .array(
              z.object({
                metodo: z.enum(METODOS),
                cuentaId: z.string().uuid(),
                monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
                numeroReferencia: z.string().max(80).optional(),
              }),
            )
            .max(10)
            .optional(),
          fecha: z.string().datetime().optional(),
          numeroReferencia: z.string().max(80).optional(),
          observacion: z.string().max(500).optional(),
          // Remitos que este cobro salda. Opcional: se puede cobrar "a cuenta"
          // sin imputar a remitos puntuales, que es como venía funcionando.
          remitoIds: z.array(z.string().uuid()).max(500).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as {
        monto: string;
        cuentaId?: string;
        metodo: (typeof METODOS)[number];
        pagos?: Array<{
          metodo: (typeof METODOS)[number];
          cuentaId: string;
          monto: string;
          numeroReferencia?: string;
        }>;
        fecha?: string;
        numeroReferencia?: string;
        observacion?: string;
        remitoIds?: string[];
      };
      const cliente = await prisma.clienteMayorista.findUnique({ where: { id } });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

      // Las dos formas se normalizan a una sola lista de líneas: de acá para
      // abajo el handler no sabe si vino un método o cinco.
      const lineas = b.pagos?.length
        ? b.pagos
        : b.cuentaId
          ? [
              {
                metodo: b.metodo,
                cuentaId: b.cuentaId,
                monto: b.monto,
                numeroReferencia: b.numeroReferencia,
              },
            ]
          : null;
      if (!lineas) {
        return reply.code(400).send({ error: 'Falta la cuenta destino del cobro' });
      }
      const sumaLineas = lineas.reduce((a, p) => a + Number(p.monto), 0);
      if (Math.abs(sumaLineas - Number(b.monto)) > 0.01) {
        return reply.code(400).send({
          error: `Los pagos suman $${sumaLineas.toFixed(2)} y el cobro es de $${Number(b.monto).toFixed(2)}`,
        });
      }

      // Los remitos a imputar tienen que ser DE ESTE cliente y no estar
      // anulados. Sin este chequeo, un id de otro cliente marcaría pagado un
      // remito ajeno.
      let aImputar: string[] = [];
      if (b.remitoIds?.length) {
        const validos = await prisma.remito.findMany({
          where: {
            id: { in: b.remitoIds },
            clienteMayoristaId: cliente.id,
            estado: { not: 'ANULADO' },
          },
          select: { id: true },
        });
        if (validos.length !== b.remitoIds.length) {
          return reply.code(400).send({
            error: 'Hay remitos que no son de este cliente o están anulados',
          });
        }
        aImputar = validos.map((r) => r.id);
      }

      const categoriaId = await getCategoriaCobroId();
      const fecha = b.fecha ? new Date(b.fecha) : new Date();
      const obs = `Cobro ${cliente.nombre}${b.observacion ? ' · ' + b.observacion : ''}`;

      // El cobro de cuenta corriente es PLATA QUE ENTRA A LA CAJA DEL TURNO, así
      // que necesita `sesionCajaId` como cualquier otro movimiento. Sin esto el
      // registro queda con sesion_caja_id NULL: NO entra al cierre (que filtra
      // por sesión) pero SÍ aparece en /admin/movimientos (que filtra por
      // fecha) — o sea que la encargada lo ve listado y el cierre no lo cuenta,
      // y la caja le da de menos sin ninguna señal de por qué.
      //
      // Es EL MISMO bug que se arregló en alpha.19 para POST /admin/movimientos
      // y que quedó vivo en esta ruta. Ver el invariante en CLAUDE.md.
      let sesionId: string;
      try {
        sesionId = (await getOrCreateSesionActual(req.usuario!.id)).id;
      } catch (e) {
        if (e instanceof FueraDeHorarioError) {
          return reply.code(423).send({
            error:
              'No hay un turno abierto en este momento, así que el cobro no ' +
              'tendría dónde imputarse. Abrí la caja y volvé a registrarlo.',
            code: 'FUERA_DE_HORARIO',
          });
        }
        throw e;
      }

      const mov = await prisma.$transaction((tx) =>
        registrarCobro(tx, {
          cliente,
          lineas,
          fecha,
          observacion: obs,
          categoriaId,
          usuarioId: req.usuario!.id,
          sesionId,
          aImputar,
          montoTotal: b.monto,
        }),
      );
      // El audit del movimiento se emite DENTRO de la transacción (arriba),
      // junto con el del pago. Acá había un segundo audit del mismo movimiento
      // que quedó de más al moverlo adentro.
      return reply.code(201).send({
        ...mov,
        remitosImputados: aImputar.length,
        pagos: lineas.length,
        montoTotal: b.monto,
      });
    },
  );
}
