import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
import { RolUsuario, EstadoMovimiento, TipoCategoriaMovimiento } from '@sta/db';
import { subtotalItem } from '@sta/shared';
import { recordAudit } from '../services/audit.js';
import { encolarTicketRemito } from '../services/impresion.js';
import { getOrCreateSesionActual, FueraDeHorarioError } from '../services/sesion-caja.js';

/**
 * MAYORISTAS — Clientes con cuenta corriente.
 *
 * Modelo de negocio: vendemos a empresas a precio especial (vía una lista de
 * precios dedicada por cliente). Cada entrega se documenta con un REMITO que
 * suma a la cuenta corriente del cliente. A fin de mes se agrupan los remitos
 * del período (resumen para facturar por fuera) y, cuando el cliente paga, se
 * registra un COBRO (movimiento INGRESO) que baja el saldo.
 *
 * Saldo adeudado = Σ remitos PENDIENTE − Σ cobros confirmados.
 * El cobro se modela como Movimiento INGRESO (entidadId = clienteMayoristaId)
 * para que la plata aterrice en el cashflow recién cuando efectivamente se cobra.
 */

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

interface ItemEntrada {
  productoId?: string;
  nombre: string;
  cantidad: number;
  precioUnitario?: string;
}
interface ItemsResueltos {
  itemsData: Array<{
    productoId: string | null;
    nombreSnapshot: string;
    cantidad: string;
    precioUnitario: string;
    subtotal: string;
    orden: number;
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

  const itemsData: ItemsResueltos['itemsData'] = [];
  let total = 0;
  for (const [idx, it] of items.entries()) {
    let precioUnitario: number;
    let subtotalStr: string;
    let nombre = it.nombre;
    if (it.productoId) {
      const p = prodMap.get(it.productoId);
      if (!p) throw new ItemRemitoError(`Producto ${it.productoId} no existe`);
      const override = p.preciosPorLista[0]?.precioEfectivo;
      precioUnitario = override ? Number(override) : Number(p.precioBase) * (1 + ajustePct / 100);
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
    });
  }
  return { itemsData, total };
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
      const [remitado, cobrado] = await Promise.all([
        prisma.remito.groupBy({
          by: ['clienteMayoristaId'],
          _sum: { total: true },
          // `not: ANULADO` (no `= PENDIENTE`): un remito PAGADO SIGUE contando
          // en lo remitado. El saldo es remitado - cobrado, y el cobro ya está
          // del otro lado de la resta; si los PAGADO salieran del total, el
          // pago se restaría dos veces y el saldo daría negativo.
          where: { estado: { not: 'ANULADO' }, clienteMayoristaId: { in: ids } },
        }),
        prisma.movimiento.groupBy({
          by: ['entidadId'],
          _sum: { monto: true },
          where: { estado: EstadoMovimiento.CONFIRMADO, tipo: 'INGRESO', entidadId: { in: ids } },
        }),
      ]);
      const remMap = new Map(remitado.map((r) => [r.clienteMayoristaId, Number(r._sum.total ?? 0)]));
      const cobMap = new Map(cobrado.map((c) => [c.entidadId, Number(c._sum.monto ?? 0)]));

      return {
        clientes: clientes.map((c) => {
          const saldo = (remMap.get(c.id) ?? 0) - (cobMap.get(c.id) ?? 0);
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
        prisma.remito.aggregate({
          _sum: { total: true },
          // Ver la nota del listado: PAGADO es una MARCA de qué cobro saldó el
          // remito, no una baja del total remitado.
          where: { clienteMayoristaId: id, estado: { not: 'ANULADO' } },
        }),
        prisma.movimiento.aggregate({
          _sum: { monto: true },
          where: { entidadId: id, tipo: 'INGRESO', estado: EstadoMovimiento.CONFIRMADO },
        }),
      ]);

      const totalRemitado = Number(remitado._sum.total ?? 0);
      const totalCobrado = Number(cobrado._sum.monto ?? 0);

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
        saldo: (totalRemitado - totalCobrado).toFixed(2),
        totales: { remitado: totalRemitado.toFixed(2), cobrado: totalCobrado.toFixed(2) },
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
      const productos = await prisma.producto.findMany({
        where: { activo: true },
        orderBy: { nombre: 'asc' },
        include: {
          preciosPorLista: {
            where: { listaId: cliente.listaPreciosId },
            orderBy: { vigenciaDesde: 'desc' },
            take: 1,
          },
        },
      });

      return {
        lista: { id: cliente.listaPrecios.id, nombre: cliente.listaPrecios.nombre },
        productos: productos.map((p) => {
          const override = p.preciosPorLista[0]?.precioEfectivo;
          const precio = override
            ? Number(override)
            : Number(p.precioBase) * (1 + ajustePct / 100);
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
          items: z
            .array(
              z.object({
                productoId: z.string().uuid().optional(),
                nombre: z.string().min(1).max(200),
                cantidad: z.coerce.number().positive(),
                // precioUnitario sólo se usa para ítems libres (sin productoId).
                precioUnitario: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
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
        items: Array<{ productoId?: string; nombre: string; cantidad: number; precioUnitario?: string }>;
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
      return reply.code(201).send(remito);
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
          cuentaId: z.string().uuid(),
          metodo: z.enum(METODOS).default('TRANSFERENCIA'),
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
        cuentaId: string;
        metodo: (typeof METODOS)[number];
        fecha?: string;
        numeroReferencia?: string;
        observacion?: string;
        remitoIds?: string[];
      };
      const cliente = await prisma.clienteMayorista.findUnique({ where: { id } });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

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
      const monto = Number(b.monto);
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

      const mov = await prisma.$transaction(async (tx) => {
        const m = await tx.movimiento.create({
          data: {
            tipo: 'INGRESO',
            monto: b.monto,
            categoriaId,
            cuentaDestinoId: b.cuentaId,
            entidadId: cliente.id,
            fechaComputo: fecha,
            observacion: obs,
            estado: EstadoMovimiento.CONFIRMADO,
            usuarioId: req.usuario!.id,
            sesionCajaId: sesionId,
          },
        });
        const pago = await tx.pago.create({
          data: {
            movimientoId: m.id,
            metodo: b.metodo,
            cuentaId: b.cuentaId,
            monto: b.monto,
            numeroReferencia: b.numeroReferencia ?? null,
            estado: 'CONFIRMADO',
            fecha,
          },
        });
        // Los dos audits van DENTRO de la transacción: si el cobro se rollbackea
        // no queremos eventos de replicación de algo que no existe.
        await recordAudit({
          tabla: 'movimientos',
          registroId: m.id,
          accion: 'INSERT',
          usuarioId: req.usuario!.id,
          valorNuevo: {
            tipo: 'INGRESO',
            concepto: 'Cobro cuenta corriente',
            cliente: cliente.nombre,
            monto: b.monto,
            remitosImputados: aImputar.length,
          },
          tx,
        });
        // `pagos` es otra tabla: sin evento propio, el cobro llega a la nube sin
        // su forma de pago. Después del movimiento (mayor `secuencia`), que es
        // el orden que respeta la FK pago → movimiento al replicar.
        await recordAudit({
          tabla: 'pagos',
          registroId: pago.id,
          accion: 'INSERT',
          usuarioId: req.usuario!.id,
          contexto: { movimientoId: m.id, motivo: 'cobro mayorista' },
          tx,
        });
        await tx.cuenta.update({
          where: { id: b.cuentaId },
          data: { saldoActual: { increment: monto } },
        });
        // Imputación: los remitos elegidos quedan PAGADO y apuntando a ESTE
        // movimiento. Va DENTRO de la tx: si falla, no queremos remitos
        // marcados como cobrados sin el cobro registrado.
        if (aImputar.length) {
          await tx.remito.updateMany({
            where: { id: { in: aImputar } },
            data: { estado: 'PAGADO', pagadoAt: fecha, pagadoConMovimientoId: m.id },
          });
        }
        return m;
      });
      // El audit del movimiento se emite DENTRO de la transacción (arriba),
      // junto con el del pago. Acá había un segundo audit del mismo movimiento
      // que quedó de más al moverlo adentro.
      return reply.code(201).send({ ...mov, remitosImputados: aImputar.length });
    },
  );
}
