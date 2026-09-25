import { ReglaNegocioError } from './errores.js';
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
import { recordAudit, recordAuditBatch } from './audit.js';
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

  // ── El mayorista destinatario, si lo hay ────────────────────────────
  const aCuentaCorriente = data.cobro === 'CUENTA_CORRIENTE';
  let mayorista = null;
  if (data.clienteMayoristaId) {
    mayorista = await prisma.clienteMayorista.findUnique({
      where: { id: data.clienteMayoristaId },
      select: { id: true, nombre: true, activo: true, listaPreciosId: true },
    });
    if (!mayorista) throw new ReglaNegocioError('El mayorista elegido no existe');
    if (!mayorista.activo) {
      throw new ReglaNegocioError(`El mayorista "${mayorista.nombre}" está desactivado.`);
    }
  }
  // Sin mayorista no hay cuenta corriente a la que cargar la deuda. Se valida
  // acá y no sólo en la pantalla: es plata que se entrega sin registrar.
  if (aCuentaCorriente && !mayorista) {
    throw new ReglaNegocioError(
      'Para dejar un encargo en cuenta corriente hay que decir de qué mayorista es.',
    );
  }

  const esEnvio = data.tipoEntrega === 'ENVIO';
  const canal: CanalVenta = esEnvio ? CanalVenta.TELEFONO : CanalVenta.MOSTRADOR;
  const modalidad: ModalidadVenta = esEnvio
    ? ModalidadVenta.DELIVERY_PROPIO
    : ModalidadVenta.TAKE_AWAY;

  // ── Con qué lista se valúa ──────────────────────────────────────────
  //
  // Antes era siempre la del local. La encargada también carga encargos para
  // mayoristas, que tienen su propia lista: cargarlos a precio de mostrador y
  // corregir a mano después es la clase de trabajo manual que termina en un
  // precio mal puesto.
  //
  // Prioridad: la que eligió explícitamente > la del mayorista destinatario >
  // la del local. La explícita gana sobre la del mayorista a propósito: se
  // pidió poder elegir CUALQUIER lista para cualquier cliente.
  let lista;
  if (data.listaPreciosId) {
    lista = await prisma.listaPrecios.findUnique({ where: { id: data.listaPreciosId } });
    if (!lista) throw new ReglaNegocioError('La lista de precios elegida no existe');
    if (!lista.activa) {
      throw new ReglaNegocioError(`La lista "${lista.nombre}" está desactivada.`);
    }
  } else if (mayorista) {
    lista = await prisma.listaPrecios.findUnique({ where: { id: mayorista.listaPreciosId } });
    if (!lista) throw new ReglaNegocioError('El mayorista apunta a una lista que no existe');
  } else {
    lista = await prisma.listaPrecios.findFirst({
      where: { canalDefault: CanalListaPrecios.LOCAL_MOSTRADOR, activa: true },
      orderBy: { nombre: 'asc' },
    });
  }
  if (!lista) throw new ReglaNegocioError('No hay lista de precios activa para el local');

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
    if (!producto) throw new ReglaNegocioError(`Producto ${item.productoId} no existe`);

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
        clienteMayoristaId: mayorista?.id ?? null,
        encargoACuentaCorriente: aCuentaCorriente,
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
  if (!padre || !padre.esEncargo) throw new ReglaNegocioError('Encargo no encontrado');
  if (padre.estado === EstadoVenta.ANULADA) throw new ReglaNegocioError('El encargo está anulado');
  // Las adiciones cuelgan SIEMPRE de la raíz (sin anidar).
  const rootId = padre.encargoPadreId ?? padre.id;
  const root = padre.encargoPadreId
    ? await prisma.venta.findUnique({ where: { id: rootId } })
    : padre;
  if (!root) throw new ReglaNegocioError('Encargo no encontrado');
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
    if (!producto) throw new ReglaNegocioError(`Producto ${item.productoId} no existe`);
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

/**
 * El encargo a cuenta corriente se convierte en deuda del mayorista.
 *
 * ─── Por qué al ENTREGAR y no al cargar ──────────────────────────────────
 *
 * Un encargo se carga días antes y se puede cambiar, ampliar o anular en el
 * medio. Si el remito naciera con el encargo, la cuenta corriente mostraría
 * deuda por mercadería que todavía está en el mostrador —y que quizás nunca
 * sale—. La deuda arranca cuando la mercadería se va: por eso cuelga del
 * retiro, que es el momento en que eso pasa de verdad.
 *
 * ─── Por qué no puede duplicarse ─────────────────────────────────────────
 *
 * `remitos.encargo_id` tiene índice ÚNICO. Marcar la entrega dos veces (dos
 * clicks, dos cajas, un reintento de red) rebota contra la base, no contra un
 * chequeo de la aplicación que podría correr tarde. El chequeo previo está
 * igual, pero para dar un error entendible, no como única defensa.
 *
 * Incluye las adiciones no anuladas: lo que se entrega es el pedido completo,
 * no la versión con la que nació.
 */
export async function generarRemitoDeEncargo(
  tx: Prisma.TransactionClient,
  args: { encargoId: string; usuarioId: string },
): Promise<{ id: string; numero: number; total: string } | null> {
  const { encargoId, usuarioId } = args;

  const encargo = await tx.venta.findUnique({
    where: { id: encargoId },
    include: {
      items: { orderBy: { orden: 'asc' } },
      adicionesEncargo: {
        where: { estado: { not: EstadoVenta.ANULADA } },
        orderBy: { fechaApertura: 'asc' },
        include: { items: { orderBy: { orden: 'asc' } } },
      },
      clienteMayorista: { select: { id: true, nombre: true } },
    },
  });
  if (!encargo || !encargo.encargoACuentaCorriente || !encargo.clienteMayorista) return null;
  if (encargo.estado === EstadoVenta.ANULADA) return null;

  const yaTiene = await tx.remito.findUnique({
    where: { encargoId },
    select: { id: true, numero: true, total: true, estado: true },
  });
  if (yaTiene) {
    // Idempotente: volver a marcar la entrega devuelve el remito que ya existe
    // en vez de romper. Anulado es distinto — ver el comentario de abajo.
    if (yaTiene.estado !== 'ANULADO') {
      return { id: yaTiene.id, numero: yaTiene.numero, total: yaTiene.total.toFixed(2) };
    }
    throw new ReglaNegocioError(
      `Este encargo ya generó el remito #${yaTiene.numero} y está anulado. ` +
        'Si la mercadería sale igual, cargá el remito a mano desde Mayoristas.',
      409,
    );
  }

  // Todas las líneas: las del encargo y las de sus adiciones vivas.
  const lineas = [...encargo.items, ...encargo.adicionesEncargo.flatMap((a) => a.items)];
  if (lineas.length === 0) return null;

  // El total sale de sumar las líneas, igual que un remito cargado a mano. No
  // se usa `venta.total` a propósito: ése puede traer descuento o recargo de
  // canal del flujo de cobro, y este encargo justamente NO se cobra acá.
  const total = lineas.reduce((acc, it) => acc + Number(it.subtotal), 0);

  const remito = await tx.remito.create({
    data: {
      clienteMayoristaId: encargo.clienteMayorista.id,
      encargoId,
      fecha: new Date(),
      total: total.toFixed(2),
      observaciones: `Encargo #${encargo.numero}`,
      usuarioId,
      items: {
        create: lineas.map((it, idx) => ({
          productoId: it.productoId,
          nombreSnapshot: it.nombreSnapshot,
          cantidad: it.cantidad,
          precioUnitario: it.precioUnitario,
          subtotal: it.subtotal,
          orden: idx,
          modificadoresAplicados: it.modificadoresAplicados as never,
          deltaModificadores: it.deltaModificadores,
        })),
      },
    },
    include: { items: true },
  });

  // El padre ANTES que los hijos: el replicador aplica por secuencia y la FK
  // del item exige que el remito ya esté en la nube. Mismo motivo que en la
  // carga manual de remitos (routes/mayoristas.ts).
  await recordAudit({
    tabla: 'remitos',
    registroId: remito.id,
    accion: 'INSERT',
    usuarioId,
    valorNuevo: {
      numero: remito.numero,
      cliente: encargo.clienteMayorista.nombre,
      total: remito.total.toFixed(2),
      desdeEncargo: encargo.numero,
    },
    tx,
  });
  // En tanda: un remito de muchos renglones no tiene por qué costar tres
  // viajes a la base por renglón dentro de la transacción.
  await recordAuditBatch(
    tx,
    remito.items.map((it) => ({
      tabla: 'remito_items',
      registroId: it.id,
      accion: 'INSERT',
      usuarioId,
      valorNuevo: { remitoId: remito.id, nombre: it.nombreSnapshot },
    })),
  );

  return { id: remito.id, numero: remito.numero, total: remito.total.toFixed(2) };
}

/**
 * Deshacer la entrega (o anular el encargo) tiene que sacar la deuda.
 *
 * Si no, queda un mayorista debiendo mercadería que no se llevó — y eso no lo
 * detecta nadie hasta que discute la cuenta a fin de mes.
 *
 * Un remito YA COBRADO no se toca: ahí la plata entró, y borrarlo dejaría el
 * cobro apuntando al vacío. En ese caso se avisa y lo resuelve una persona.
 */
export async function anularRemitoDeEncargo(
  tx: Prisma.TransactionClient,
  args: { encargoId: string; usuarioId: string; motivo: string },
): Promise<void> {
  const remito = await tx.remito.findUnique({
    where: { encargoId: args.encargoId },
    select: { id: true, numero: true, estado: true },
  });
  if (!remito || remito.estado === 'ANULADO') return;
  if (remito.estado === 'PAGADO') {
    throw new ReglaNegocioError(
      `El remito #${remito.numero} de este encargo ya fue cobrado. Para deshacerlo hay que ` +
        'revertir primero ese cobro desde Mayoristas.',
      409,
    );
  }

  await tx.remito.update({
    where: { id: remito.id },
    data: { estado: 'ANULADO', motivoAnulacion: args.motivo, anuladoAt: new Date() },
  });
  await recordAudit({
    tabla: 'remitos',
    registroId: remito.id,
    accion: 'UPDATE',
    usuarioId: args.usuarioId,
    valorAnterior: { estado: remito.estado },
    valorNuevo: { estado: 'ANULADO', motivo: args.motivo },
    tx,
  });
}
