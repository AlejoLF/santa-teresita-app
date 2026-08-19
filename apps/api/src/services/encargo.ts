import { prisma } from '@sta/db/client';
import {
  CanalVenta,
  CanalListaPrecios,
  ModalidadVenta,
  EstadoVenta,
  FormaVenta as DbFormaVenta,
  type Venta,
  type Prisma,
} from '@sta/db';
import type { EncargoNuevo } from '@sta/shared';
import { subtotalItem } from '@sta/shared';
import { whereRangoDiaUtc, type FiltroTemporal } from './filtro-temporal.js';
import { getOrCreateSesionActual, siguienteNumeroOrdenTurno } from './sesion-caja.js';
import { recordAudit } from './audit.js';
import { encolarComandaEncargo, esDestinoImpresion } from './impresion.js';
import { agregarItemsAVenta } from './venta.js';
import {
  resolverDeltasDeLista,
  deltaDeModificadores,
  opcionIdsDeItems,
} from './deltas-lista.js';

/**
 * Crea un ENCARGO (pedido para un día futuro) reutilizando la tabla `ventas`.
 *
 * Diferencias con una venta normal:
 *   - `esEncargo = true` + datos de entrega futura (día, hora/franja, retiro/envío).
 *   - Nace PROCESADA + estadoCobroEncargo = A_PAGAR (no cuenta en caja hasta
 *     finalizar el cobro — el cierre filtra por FINALIZADA).
 *   - NO encola la comanda de cocina; encola COMANDA_ENCARGO → MOSTRADOR (registro
 *     para la encargada). Si la acción es 'cobrar', la comanda "COBRADO" sale
 *     recién al finalizar el cobro (no acá).
 *   - Siempre guarda DeliveryInfo con el contacto (nombre/tel/dirección), incluso
 *     en RETIRO, para reutilizar el render de comanda y la ficha de cliente.
 *
 * RETIRO → canal MOSTRADOR + modalidad TAKE_AWAY.
 * ENVÍO  → canal TELEFONO + modalidad DELIVERY_PROPIO (repartidor reasignable
 *          luego desde el panel de delivery; la lógica de plata sigue por modalidad).
 */
export async function crearEncargo(args: {
  data: EncargoNuevo;
  usuarioId: string;
}): Promise<Venta> {
  const { data, usuarioId } = args;

  const esEnvio = data.tipoEntrega === 'ENVIO';
  const canal: CanalVenta = esEnvio ? CanalVenta.TELEFONO : CanalVenta.MOSTRADOR;
  const modalidad: ModalidadVenta = esEnvio
    ? ModalidadVenta.DELIVERY_PROPIO
    : ModalidadVenta.TAKE_AWAY;

  // Encargos siempre usan la lista del local (precio de mostrador).
  const lista = await prisma.listaPrecios.findFirst({
    where: { canalDefault: CanalListaPrecios.LOCAL_MOSTRADOR, activa: true },
    orderBy: { nombre: 'asc' },
  });
  if (!lista) throw new Error('No hay lista de precios activa para el local');

  const sesion = await getOrCreateSesionActual(usuarioId);
  const numeroOrden = await siguienteNumeroOrdenTurno(sesion.id);

  // Snapshot de precios (mismo criterio que crearVenta).
  const productoIds = [...new Set(data.items.map((i) => i.productoId))];
  const productos = await prisma.producto.findMany({
    where: { id: { in: productoIds } },
    include: { tipoProducto: true, preciosPorLista: { where: { listaId: lista.id }, take: 1 } },
  });
  const productoMap = new Map(productos.map((p) => [p.id, p]));
  const ajustePct = Number(lista.ajustePctDefault);
  const deltas = await resolverDeltasDeLista(lista.id, opcionIdsDeItems(data.items));

  const itemsToCreate: Array<Prisma.ItemVentaCreateWithoutVentaInput> = [];
  let subtotalVenta = 0;
  let tieneCocina = false;

  for (const [idx, item] of data.items.entries()) {
    const producto = productoMap.get(item.productoId);
    if (!producto) throw new Error(`Producto ${item.productoId} no existe`);

    const precioOverride = producto.preciosPorLista[0]?.precioEfectivo;
    const precioBaseNumber = Number(producto.precioBase);
    const precioListaSinDelta = precioOverride
      ? Number(precioOverride)
      : precioBaseNumber * (1 + ajustePct / 100);
    const deltaMod = deltaDeModificadores(item.modificadores, deltas);
    const precioUnitario = precioListaSinDelta + deltaMod;

    const subTotalItemStr = subtotalItem({
      cantidad: item.cantidad,
      precioUnitario: precioUnitario.toFixed(2),
      unidadPrecio: producto.unidadPrecio,
    });
    subtotalVenta += Number(subTotalItemStr);
    if (producto.tipoProducto.cocinaInterviene) tieneCocina = true;

    itemsToCreate.push({
      producto: { connect: { id: producto.id } },
      nombreSnapshot: producto.nombre,
      cantidad: String(item.cantidad),
      unidad: producto.formaVenta as DbFormaVenta,
      precioUnitario: precioUnitario.toFixed(2),
      modificadoresAplicados: item.modificadores as never,
      deltaModificadores: deltaMod.toFixed(2),
      subtotal: subTotalItemStr,
      totalLinea: subTotalItemStr,
      observacion: item.observacion ?? null,
      orden: idx,
      cocinaInterviene: producto.tipoProducto.cocinaInterviene,
      ...(item.parteDeComboId && { combo: { connect: { id: item.parteDeComboId } } }),
      parteDeComboInstancia: item.parteDeComboInstancia ?? null,
    });
  }

  // `@db.Date` en UTC explícito → guarda exactamente el día elegido sin importar
  // la TZ del proceso (mismo patrón que SesionCaja.fecha; al leer se formatea en UTC).
  const fechaEntregaPromesa = new Date(`${data.fechaEntrega}T00:00:00.000Z`);

  return prisma.$transaction(async (tx) => {
    // Auto-crear/linkear cliente por teléfono (la ficha sirve para historial).
    let clienteIdResuelto: string | null = null;
    const tel = data.clienteTelefono.replace(/[\s-]/g, '');
    const existente = tel
      ? await tx.cliente.findFirst({ where: { telefono: { contains: tel } } })
      : null;
    if (existente) {
      clienteIdResuelto = existente.id;
    } else {
      const partes = data.clienteNombre.trim().split(/\s+/);
      const nombre = partes[0] ?? data.clienteNombre.trim();
      const apellido = partes.length > 1 ? partes.slice(1).join(' ') : null;
      const nuevo = await tx.cliente.create({
        data: { tipo: 'REGISTRADO', nombre, apellido, telefono: data.clienteTelefono.trim() },
      });
      clienteIdResuelto = nuevo.id;
      if (esEnvio && data.direccionEntrega) {
        await tx.direccion.create({
          data: {
            clienteId: nuevo.id,
            etiqueta: 'Casa',
            calle: data.direccionEntrega,
            numero: '—',
            indicaciones: data.indicacionesEntrega ?? null,
            esDefault: true,
          },
        });
      }
    }

    const venta = await tx.venta.create({
      data: {
        canal,
        modalidad,
        pcOrigen: data.pcOrigen,
        clienteId: clienteIdResuelto,
        listaPreciosId: lista.id,
        sesionCajaId: sesion.id,
        numeroOrdenTurno: numeroOrden,
        usuarioAperturaId: usuarioId,
        observaciones: data.observaciones ?? null,
        subtotal: subtotalVenta.toFixed(2),
        total: subtotalVenta.toFixed(2),
        tieneCocina,
        estado: EstadoVenta.PROCESADA,
        // ── Campos de encargo ──
        esEncargo: true,
        fechaEntregaPromesa,
        horaEntregaExacta: data.horaEntregaExacta ?? null,
        franjaEntrega: data.franjaEntrega ?? null,
        tipoEntregaEncargo: data.tipoEntrega,
        estadoCobroEncargo: 'A_PAGAR',
        // Se recuerda para que la comanda del cobro diferido salga por la misma
        // comandera que eligió la caja al cargar el encargo.
        destinoImpresionEncargo: data.destinoImpresion,
        items: { create: itemsToCreate },
      },
    });

    // Contacto del encargo en DeliveryInfo (sirve para comanda + ficha cliente),
    // incluso en RETIRO (sin dirección).
    await tx.deliveryInfo.create({
      data: {
        ventaId: venta.id,
        direccionSnapshot: {
          clienteNombre: data.clienteNombre,
          clienteTelefono: data.clienteTelefono,
          direccion: esEnvio ? (data.direccionEntrega ?? null) : null,
          indicaciones: data.indicacionesEntrega ?? null,
          _retiro: !esEnvio,
        } as never,
      },
    });

    await recordAudit({
      tabla: 'ventas',
      registroId: venta.id,
      accion: 'INSERT',
      usuarioId,
      pcOrigen: data.pcOrigen,
      valorNuevo: {
        encargo: true,
        numero: venta.numero,
        total: venta.total,
        fechaEntrega: data.fechaEntrega,
        tipoEntrega: data.tipoEntrega,
      },
      tx,
    });

    // Si es "cargar" (A_PAGAR), imprimimos ya la comanda ENCARGO con "A PAGAR".
    // Si es "cobrar", la comanda "COBRADO" sale al finalizar el cobro (no acá).
    // El destino lo elige la caja: los encargos también se toman desde PCs que
    // no son la del mostrador.
    if (data.accion === 'cargar') {
      await encolarComandaEncargo(venta.id, 'A_PAGAR', tx, data.destinoImpresion);
    }

    return venta;
  });
}

/**
 * Crea una ADICIÓN a un encargo existente ("modificación adicional al pedido X"):
 * el cliente sumó productos a un encargo ya cargado (pagado o no). Es una venta
 * hija (esEncargo + encargoPadreId) con su PROPIA secuencia de pago:
 *   - Nace PROCESADA + A_PAGAR en la sesión ACTUAL.
 *   - Si se cobra ya (accion='cobrar'), va por el finalizar normal de encargos
 *     (entra a la caja de la sesión del cobro).
 *   - Si queda a pagar, la comanda fusionada sale con "PAGO PARCIAL" mostrando
 *     qué está pagado y qué no.
 * Hereda del padre: canal/modalidad/lista/cliente + datos de entrega (solo
 * informativos acá — la comanda siempre se arma desde el padre).
 */
export async function crearAdicionEncargo(args: {
  padreId: string;
  items: EncargoNuevo['items'];
  pcOrigen: string;
  usuarioId: string;
  accion: 'cargar' | 'cobrar';
}): Promise<Venta> {
  const { padreId, items, pcOrigen, usuarioId, accion } = args;

  const padre = await prisma.venta.findUnique({ where: { id: padreId } });
  if (!padre || !padre.esEncargo) throw new Error('Encargo no encontrado');
  if (padre.estado === EstadoVenta.ANULADA) throw new Error('El encargo está anulado');
  // Las adiciones cuelgan SIEMPRE de la raíz (sin anidar).
  const rootId = padre.encargoPadreId ?? padre.id;
  const root = padre.encargoPadreId
    ? await prisma.venta.findUnique({ where: { id: rootId } })
    : padre;
  if (!root) throw new Error('Encargo no encontrado');
  // La comanda fusionada sale por la comandera que se eligió al cargar el
  // encargo raíz (encargos viejos, sin el campo, siguen saliendo a Mostrador).
  const destinoRaiz = esDestinoImpresion(root.destinoImpresionEncargo)
    ? root.destinoImpresionEncargo
    : 'MOSTRADOR';

  // ── Encargo TODAVÍA NO cobrado: sumar al MISMO encargo ────────────────────
  // Si la persona viene a retirar un encargo impago y suma productos, esos van
  // al mismo pedido: el total a pagar se ACTUALIZA y un solo cobro cubre todo.
  // (Antes se creaba una venta-adición aparte con su propia secuencia de pago,
  // así que el cobro mostraba solo el total viejo — incidente del encargo #022.)
  // La venta-adición separada solo se necesita cuando el encargo YA fue cobrado:
  // ahí sí es un cobro nuevo (PAGO PARCIAL). El root es editable mientras esté
  // PROCESADA (no FINALIZADA/ANULADA).
  if (root.estado === EstadoVenta.PROCESADA && root.estadoCobroEncargo !== 'COBRADO') {
    const actualizado = await agregarItemsAVenta({ ventaId: root.id, items, usuarioId });
    // Si queda a pagar, re-imprimimos la comanda del encargo con el total nuevo.
    // Si es 'cobrar', la comanda sale al finalizar el cobro (con el total ya
    // fusionado). Sale por la comandera con la que se cargó el encargo.
    if (accion === 'cargar') {
      await encolarComandaEncargo(root.id, 'A_PAGAR', undefined, destinoRaiz);
    }
    return actualizado;
  }

  const sesion = await getOrCreateSesionActual(usuarioId);
  const numeroOrden = await siguienteNumeroOrdenTurno(sesion.id);

  // Snapshot de precios — mismo criterio que crearEncargo, con la lista del padre.
  const productoIds = [...new Set(items.map((i) => i.productoId))];
  const productos = await prisma.producto.findMany({
    where: { id: { in: productoIds } },
    include: {
      tipoProducto: true,
      preciosPorLista: { where: { listaId: root.listaPreciosId }, take: 1 },
    },
  });
  const lista = await prisma.listaPrecios.findUnique({ where: { id: root.listaPreciosId } });
  const ajustePct = Number(lista?.ajustePctDefault ?? 0);
  const productoMap = new Map(productos.map((p) => [p.id, p]));
  const deltas = await resolverDeltasDeLista(root.listaPreciosId, opcionIdsDeItems(items));

  const itemsToCreate: Array<Prisma.ItemVentaCreateWithoutVentaInput> = [];
  let subtotalVenta = 0;
  let tieneCocina = false;
  for (const [idx, item] of items.entries()) {
    const producto = productoMap.get(item.productoId);
    if (!producto) throw new Error(`Producto ${item.productoId} no existe`);
    const precioOverride = producto.preciosPorLista[0]?.precioEfectivo;
    const precioListaSinDelta = precioOverride
      ? Number(precioOverride)
      : Number(producto.precioBase) * (1 + ajustePct / 100);
    const deltaMod = deltaDeModificadores(item.modificadores, deltas);
    const precioUnitario = precioListaSinDelta + deltaMod;
    const subTotalItemStr = subtotalItem({
      cantidad: item.cantidad,
      precioUnitario: precioUnitario.toFixed(2),
      unidadPrecio: producto.unidadPrecio,
    });
    subtotalVenta += Number(subTotalItemStr);
    const cocinaItem =
      producto.cocinaIntervieneOverride ?? producto.tipoProducto.cocinaInterviene;
    if (cocinaItem) tieneCocina = true;
    itemsToCreate.push({
      producto: { connect: { id: producto.id } },
      nombreSnapshot: producto.nombre,
      cantidad: String(item.cantidad),
      unidad: producto.formaVenta as DbFormaVenta,
      precioUnitario: precioUnitario.toFixed(2),
      modificadoresAplicados: item.modificadores as never,
      deltaModificadores: deltaMod.toFixed(2),
      subtotal: subTotalItemStr,
      totalLinea: subTotalItemStr,
      observacion: item.observacion ?? null,
      orden: idx,
      cocinaInterviene: cocinaItem,
    });
  }

  return prisma.$transaction(async (tx) => {
    const venta = await tx.venta.create({
      data: {
        canal: root.canal,
        modalidad: root.modalidad,
        pcOrigen,
        clienteId: root.clienteId,
        listaPreciosId: root.listaPreciosId,
        sesionCajaId: sesion.id,
        numeroOrdenTurno: numeroOrden,
        usuarioAperturaId: usuarioId,
        // Referencia visible en el programa/tickets (pedido explícito del dueño).
        observaciones: `Modificación adicional al pedido #${root.numero}`,
        subtotal: subtotalVenta.toFixed(2),
        total: subtotalVenta.toFixed(2),
        tieneCocina,
        estado: EstadoVenta.PROCESADA,
        esEncargo: true,
        encargoPadreId: root.id,
        fechaEntregaPromesa: root.fechaEntregaPromesa,
        horaEntregaExacta: root.horaEntregaExacta,
        franjaEntrega: root.franjaEntrega,
        tipoEntregaEncargo: root.tipoEntregaEncargo,
        estadoCobroEncargo: 'A_PAGAR',
        destinoImpresionEncargo: root.destinoImpresionEncargo,
        items: { create: itemsToCreate },
      },
    });

    await recordAudit({
      tabla: 'ventas',
      registroId: venta.id,
      accion: 'INSERT',
      usuarioId,
      pcOrigen,
      valorNuevo: {
        encargoAdicion: true,
        encargoPadre: root.numero,
        total: venta.total,
      },
      tx,
    });

    // Si queda a pagar, re-imprimimos YA la comanda fusionada (saldrá con
    // PAGO PARCIAL si el padre estaba cobrado). Si es 'cobrar', la comanda
    // fusionada sale al finalizar el cobro. Sale por la comandera del encargo
    // raíz (la que eligió la caja al cargarlo).
    if (accion === 'cargar') {
      await encolarComandaEncargo(venta.id, 'A_PAGAR', tx, destinoRaiz);
    }
    return venta;
  });
}

/**
 * Lista los encargos cuyo día de entrega cae en [desde, hasta] (formato
 * YYYY-MM-DD). Excluye anulados. Devuelve lo necesario para el calendario y
 * las tarjetas (sin items, salvo el conteo).
 */
// Select + mapping compartidos por listarEncargos (calendario) y buscarEncargos
// (buscador amplio) — misma forma de tarjeta.
const ENCARGO_LIST_SELECT = {
  id: true,
  numero: true,
  numeroOrdenTurno: true,
  estado: true,
  total: true,
  tipoEntregaEncargo: true,
  fechaEntregaPromesa: true,
  horaEntregaExacta: true,
  franjaEntrega: true,
  estadoCobroEncargo: true,
  retiradoAt: true,
  cliente: { select: { nombre: true, apellido: true, telefono: true } },
  deliveryInfo: { select: { direccionSnapshot: true } },
  _count: { select: { items: true } },
  adicionesEncargo: {
    where: { estado: { not: EstadoVenta.ANULADA } },
    select: { total: true, estadoCobroEncargo: true },
  },
} satisfies Prisma.VentaSelect;

type EncargoListRow = Prisma.VentaGetPayload<{ select: typeof ENCARGO_LIST_SELECT }>;

function mapEncargoListItem(e: EncargoListRow) {
  const snap = (e.deliveryInfo?.direccionSnapshot as Record<string, unknown> | null) ?? {};
  const nombreSnap = typeof snap.clienteNombre === 'string' ? snap.clienteNombre.trim() : '';
  const telSnap = typeof snap.clienteTelefono === 'string' ? snap.clienteTelefono : '';
  const clienteNombre =
    nombreSnap ||
    (e.cliente ? `${e.cliente.nombre}${e.cliente.apellido ? ' ' + e.cliente.apellido : ''}`.trim() : '');
  // Estado/total fusionados con las adiciones: todo cobrado → COBRADO, nada
  // → A_PAGAR, mezcla → PARCIAL (la tarjeta lo muestra en naranja).
  const partes = [
    e.estadoCobroEncargo === 'COBRADO',
    ...e.adicionesEncargo.map((a) => a.estadoCobroEncargo === 'COBRADO'),
  ];
  const estadoCobroMerged = partes.every(Boolean)
    ? 'COBRADO'
    : partes.every((p) => !p)
      ? 'A_PAGAR'
      : 'PARCIAL';
  const totalMerged = Number(e.total) + e.adicionesEncargo.reduce((a, x) => a + Number(x.total), 0);
  return {
    id: e.id,
    numero: e.numero,
    numeroOrdenTurno: e.numeroOrdenTurno,
    estado: e.estado,
    total: totalMerged.toFixed(2),
    tipoEntrega: e.tipoEntregaEncargo,
    // YYYY-MM-DD (UTC, como se guardó).
    fechaEntrega: e.fechaEntregaPromesa ? e.fechaEntregaPromesa.toISOString().slice(0, 10) : null,
    horaEntregaExacta: e.horaEntregaExacta,
    franjaEntrega: e.franjaEntrega,
    estadoCobro: estadoCobroMerged,
    // Entrega: ortogonal al cobro (se puede retirar pagado o impago).
    retiradoAt: e.retiradoAt,
    cliente: clienteNombre || null,
    telefono: (telSnap || e.cliente?.telefono) ?? null,
    itemsCount: e._count.items,
  };
}

export async function listarEncargos(args: { desde: string; hasta: string }) {
  const desde = new Date(`${args.desde}T00:00:00.000Z`);
  const hasta = new Date(`${args.hasta}T00:00:00.000Z`);
  const encargos = await prisma.venta.findMany({
    where: {
      esEncargo: true,
      estado: { not: EstadoVenta.ANULADA },
      fechaEntregaPromesa: { gte: desde, lte: hasta },
      // Las adiciones no son tarjetas propias: se funden en el encargo raíz.
      encargoPadreId: null,
    },
    orderBy: [{ fechaEntregaPromesa: 'asc' }, { horaEntregaExacta: 'asc' }, { numeroOrdenTurno: 'asc' }],
    select: ENCARGO_LIST_SELECT,
  });
  return encargos.map(mapEncargoListItem);
}

/**
 * Búsqueda AMPLIA de encargos (buscador del calendario): sin restricción de
 * fecha, sobre TODOS los encargos (futuros y pasados ya entregados). Matchea por
 * nombre de cliente, teléfono, día de entrega (YYYY-MM-DD), total exacto y nº de
 * pedido / de orden. `entrega` filtra por retiro: todos | entregados | pendientes.
 */
export async function buscarEncargos(args: {
  /** Vacío = no filtra por texto (se listan todos los del período). */
  q?: string;
  entrega?: 'todos' | 'entregados' | 'pendientes';
  /** Filtro temporal ya resuelto (ver services/filtro-temporal.ts). */
  filtroTemporal?: FiltroTemporal;
  page?: number;
  pageSize?: number;
}) {
  const q = (args.q ?? '').trim();
  const entrega = args.entrega ?? 'todos';
  const page = args.page ?? 1;
  const pageSize = args.pageSize ?? 12;

  const or: Prisma.VentaWhereInput[] = [
    { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
    { cliente: { apellido: { contains: q, mode: 'insensitive' } } },
    { cliente: { telefono: { contains: q } } },
    { deliveryInfo: { is: { direccionSnapshot: { path: ['clienteNombre'], string_contains: q } } } },
    { deliveryInfo: { is: { direccionSnapshot: { path: ['clienteTelefono'], string_contains: q } } } },
  ];
  // Nº de pedido / de orden — si el término es (o contiene) un entero.
  const soloDigitos = q.replace(/\D/g, '');
  if (soloDigitos && soloDigitos.length <= 9) {
    const n = parseInt(soloDigitos, 10);
    if (Number.isSafeInteger(n)) {
      or.push({ numero: n }, { numeroOrdenTurno: n });
    }
  }
  // Total exacto ("6000" o "6000.50").
  if (/^\d+(\.\d{1,2})?$/.test(q)) {
    or.push({ total: q });
  }
  // Día de entrega exacto (YYYY-MM-DD).
  if (/^\d{4}-\d{2}-\d{2}$/.test(q)) {
    or.push({ fechaEntregaPromesa: new Date(`${q}T00:00:00.000Z`) });
  }

  const ft = args.filtroTemporal;
  const where: Prisma.VentaWhereInput = {
    esEncargo: true,
    estado: { not: EstadoVenta.ANULADA },
    encargoPadreId: null,
    // Sin texto no filtramos por OR (listamos todo el período).
    ...(q ? { OR: or } : {}),
    // Criterio temporal: por SESIÓN, el encargo pertenece al turno en que se
    // cargó/cobró (sesionCajaId). Por RANGO DE FECHAS, lo que importa es
    // cuándo se ENTREGA (fechaEntregaPromesa) — que es como el dueño piensa
    // los encargos. `whereRangoDiaUtc` porque esa columna es @db.Date.
    ...(ft?.sesionCajaId ? { sesionCajaId: ft.sesionCajaId } : {}),
    ...(ft ? whereRangoDiaUtc('fechaEntregaPromesa', ft) : {}),
  };
  if (entrega === 'entregados') where.retiradoAt = { not: null };
  else if (entrega === 'pendientes') where.retiradoAt = null;

  const [encargos, total] = await Promise.all([
    prisma.venta.findMany({
      where,
      orderBy: [{ fechaEntregaPromesa: 'desc' }, { numeroOrdenTurno: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: ENCARGO_LIST_SELECT,
    }),
    prisma.venta.count({ where }),
  ]);
  return { encargos: encargos.map(mapEncargoListItem), total, page, pageSize };
}
