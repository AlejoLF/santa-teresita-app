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
import { getOrCreateSesionActual, siguienteNumeroOrdenTurno } from './sesion-caja.js';
import { recordAudit } from './audit.js';
import { encolarComandaEncargo } from './impresion.js';

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
    // Seguridad: el delta de cada modificador SUMA, nunca resta (clamp a >= 0).
    const deltaMod = item.modificadores.reduce(
      (acc, m) => acc + Math.max(0, Number(m.deltaPrecio || 0)),
      0,
    );
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
    if (data.accion === 'cargar') {
      await encolarComandaEncargo(venta.id, 'A_PAGAR', tx);
    }

    return venta;
  });
}

/**
 * Lista los encargos cuyo día de entrega cae en [desde, hasta] (formato
 * YYYY-MM-DD). Excluye anulados. Devuelve lo necesario para el calendario y
 * las tarjetas (sin items, salvo el conteo).
 */
export async function listarEncargos(args: { desde: string; hasta: string }) {
  const desde = new Date(`${args.desde}T00:00:00.000Z`);
  const hasta = new Date(`${args.hasta}T00:00:00.000Z`);

  const encargos = await prisma.venta.findMany({
    where: {
      esEncargo: true,
      estado: { not: EstadoVenta.ANULADA },
      fechaEntregaPromesa: { gte: desde, lte: hasta },
    },
    orderBy: [{ fechaEntregaPromesa: 'asc' }, { horaEntregaExacta: 'asc' }, { numeroOrdenTurno: 'asc' }],
    select: {
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
      cliente: { select: { nombre: true, apellido: true, telefono: true } },
      deliveryInfo: { select: { direccionSnapshot: true } },
      _count: { select: { items: true } },
    },
  });

  return encargos.map((e) => {
    const snap = (e.deliveryInfo?.direccionSnapshot as Record<string, unknown> | null) ?? {};
    const nombreSnap = typeof snap.clienteNombre === 'string' ? snap.clienteNombre.trim() : '';
    const telSnap = typeof snap.clienteTelefono === 'string' ? snap.clienteTelefono : '';
    const clienteNombre =
      nombreSnap ||
      (e.cliente ? `${e.cliente.nombre}${e.cliente.apellido ? ' ' + e.cliente.apellido : ''}`.trim() : '');
    return {
      id: e.id,
      numero: e.numero,
      numeroOrdenTurno: e.numeroOrdenTurno,
      estado: e.estado,
      total: e.total.toString(),
      tipoEntrega: e.tipoEntregaEncargo,
      // YYYY-MM-DD (UTC, como se guardó).
      fechaEntrega: e.fechaEntregaPromesa
        ? e.fechaEntregaPromesa.toISOString().slice(0, 10)
        : null,
      horaEntregaExacta: e.horaEntregaExacta,
      franjaEntrega: e.franjaEntrega,
      estadoCobro: e.estadoCobroEncargo,
      cliente: clienteNombre || null,
      telefono: (telSnap || e.cliente?.telefono) ?? null,
      itemsCount: e._count.items,
    };
  });
}
