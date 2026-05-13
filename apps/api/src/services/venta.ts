import { prisma } from '@sta/db/client';
import {
  CanalVenta,
  ModalidadVenta,
  EstadoVenta,
  FormaVenta as DbFormaVenta,
  type Venta,
  type Prisma,
} from '@sta/db';
import type { ItemNuevo, VentaNueva } from '@sta/shared';
import { subtotalItem } from '@sta/shared';
import { getOrCreateSesionActual, siguienteNumeroOrdenTurno } from './sesion-caja.js';
import { recordAudit } from './audit.js';
import { encolarComandasParaVenta } from './impresion.js';

/**
 * Crea una venta en estado PROCESADA, con items snapshot del precio.
 *
 * - Resuelve la lista de precios según canal
 * - Asigna numero_orden_turno consecutivo dentro de la sesión actual
 * - Calcula subtotal de cada item con snapshot del precio
 * - Marca tieneCocina si algún item lo tiene
 *
 * No imprime comanda — eso lo encola otro servicio (impresion.ts) cuando se confirma.
 */
export async function crearVenta(args: {
  data: VentaNueva;
  usuarioId: string;
}): Promise<Venta> {
  const { data, usuarioId } = args;

  // Buscar lista de precios según canal — fallback a Local.
  const listaPorCanal: Record<CanalVenta, string> = {
    MOSTRADOR: 'Local',
    TELEFONO: 'Local',
    WHATSAPP: 'Local',
    WEB: 'Local',
    RAPPI: 'RAPPI',
    PEDIDOS_YA: 'Pedidos YA',
    MERCADO_LIBRE: 'Mercado Libre',
    DELIVERATE: 'DELIVERATE',
  };
  const listaNombre = listaPorCanal[data.canal as CanalVenta];
  const lista = await prisma.listaPrecios.findUnique({ where: { nombre: listaNombre } });
  if (!lista) throw new Error(`Lista de precios "${listaNombre}" no encontrada`);

  const sesion = await getOrCreateSesionActual(usuarioId);
  const numeroOrden = await siguienteNumeroOrdenTurno(sesion.id);

  // Cargar info de productos en batch
  const productoIds = [...new Set(data.items.map((i) => i.productoId))];
  const productos = await prisma.producto.findMany({
    where: { id: { in: productoIds } },
    include: { tipoProducto: true, preciosPorLista: { where: { listaId: lista.id }, take: 1 } },
  });
  const productoMap = new Map(productos.map((p) => [p.id, p]));

  // Calcular items con snapshot
  const itemsToCreate: Array<Prisma.ItemVentaCreateWithoutVentaInput> = [];
  let subtotalVenta = 0;
  let tieneCocina = false;
  const ajustePct = Number(lista.ajustePctDefault);

  for (const [idx, item] of data.items.entries()) {
    const producto = productoMap.get(item.productoId);
    if (!producto) throw new Error(`Producto ${item.productoId} no existe`);

    const precioOverride = producto.preciosPorLista[0]?.precioEfectivo;
    const precioBaseNumber = Number(producto.precioBase);
    const precioListaSinDelta = precioOverride
      ? Number(precioOverride)
      : precioBaseNumber * (1 + ajustePct / 100);
    const deltaMod = item.modificadores.reduce((acc, m) => acc + Number(m.deltaPrecio || 0), 0);
    const precioUnitario = precioListaSinDelta + deltaMod;

    const subTotalItemStr = subtotalItem({
      cantidad: item.cantidad,
      precioUnitario: precioUnitario.toFixed(2),
      unidadPrecio: producto.unidadPrecio,
    });
    const subTotalNum = Number(subTotalItemStr);
    subtotalVenta += subTotalNum;
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
      ...(item.parteDeComboId && {
        combo: { connect: { id: item.parteDeComboId } },
      }),
      parteDeComboInstancia: item.parteDeComboInstancia ?? null,
    });
  }

  // Todo en una transacción atómica: crear venta + items + audit log + delivery
  // info. Si cualquiera falla, la venta no queda persistida (no más estados
  // huérfanos: venta sin audit, venta delivery sin DeliveryInfo, etc.).
  const tieneDatosDelivery =
    !!data.clienteNombre ||
    !!data.clienteTelefono ||
    !!data.direccionEntrega ||
    !!data.indicacionesEntrega;
  const esDelivery = data.modalidad !== ('TAKE_AWAY' as ModalidadVenta);

  return prisma.$transaction(async (tx) => {
    // Auto-crear/linkear cliente: si no vino clienteId pero el cajero
    // tipeó nombre/teléfono (pedido por wsp/tel/web), buscamos por
    // teléfono y reutilizamos si existe; sino creamos un cliente nuevo +
    // dirección. Esto evita que la encargada tenga que ir a "Clientes" a
    // crear cada uno a mano — cualquier pedido genera la ficha.
    let clienteIdResuelto = data.clienteId ?? null;
    if (
      !clienteIdResuelto &&
      esDelivery &&
      data.clienteNombre &&
      data.clienteTelefono
    ) {
      const tel = data.clienteTelefono.replace(/[\s-]/g, '');
      const existente = tel
        ? await tx.cliente.findFirst({
            where: { telefono: { contains: tel } },
          })
        : null;
      if (existente) {
        clienteIdResuelto = existente.id;
      } else {
        const partes = data.clienteNombre.trim().split(/\s+/);
        const nombre = partes[0] ?? data.clienteNombre.trim();
        const apellido = partes.length > 1 ? partes.slice(1).join(' ') : null;
        const nuevo = await tx.cliente.create({
          data: {
            tipo: 'REGISTRADO',
            nombre,
            apellido,
            telefono: data.clienteTelefono.trim(),
          },
        });
        clienteIdResuelto = nuevo.id;
        // Si vino dirección, guardar como dirección del cliente. La marcamos
        // default — el primer pedido le da casa por defecto.
        if (data.direccionEntrega) {
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
        await recordAudit({
          tabla: 'clientes',
          registroId: nuevo.id,
          accion: 'INSERT',
          usuarioId,
          pcOrigen: data.pcOrigen,
          contexto: { autoCreadoDesdePedido: true, canal: data.canal },
          tx,
        });
      }
    }

    const venta = await tx.venta.create({
      data: {
        canal: data.canal as CanalVenta,
        modalidad: data.modalidad as ModalidadVenta,
        pcOrigen: data.pcOrigen,
        clienteId: clienteIdResuelto,
        idExternoCanal: data.idExternoCanal ?? null,
        listaPreciosId: lista.id,
        sesionCajaId: sesion.id,
        numeroOrdenTurno: numeroOrden,
        usuarioAperturaId: usuarioId,
        observaciones: data.observaciones ?? null,
        subtotal: subtotalVenta.toFixed(2),
        total: subtotalVenta.toFixed(2),
        tieneCocina,
        estado: EstadoVenta.PROCESADA,
        items: { create: itemsToCreate },
      },
    });

    if (tieneDatosDelivery && esDelivery) {
      await tx.deliveryInfo.create({
        data: {
          ventaId: venta.id,
          direccionSnapshot: {
            clienteNombre: data.clienteNombre ?? null,
            clienteTelefono: data.clienteTelefono ?? null,
            direccion: data.direccionEntrega ?? null,
            indicaciones: data.indicacionesEntrega ?? null,
          } as never,
        },
      });
    }

    await recordAudit({
      tabla: 'ventas',
      registroId: venta.id,
      accion: 'INSERT',
      usuarioId,
      pcOrigen: data.pcOrigen,
      valorNuevo: { numero: venta.numero, total: venta.total, canal: venta.canal },
      tx,
    });

    // Encolar comandas en TODOS los destinos físicos correspondientes según
    // las reglas (mostrador / delivery / cocina). Para una venta de mostrador
    // con item caliente, esto crea 2 trabajos (Mostrador + Cocina). Para una
    // de RAPPI, 1 trabajo (Cocina). Para una WhatsApp con bebida, 1 (Delivery).
    await encolarComandasParaVenta(venta.id, tx);

    return venta;
  });
}

export async function getVentaCompleta(id: string) {
  return prisma.venta.findUnique({
    where: { id },
    include: {
      items: { orderBy: { orden: 'asc' } },
      pagos: true,
      cliente: true,
      listaPrecios: true,
      deliveryInfo: true,
    },
  });
}

/**
 * Lista de ventas de la sesión actual (para drawer "Historial").
 */
export async function listarVentasDeSesionActual(sesionId: string) {
  return prisma.venta.findMany({
    where: { sesionCajaId: sesionId },
    orderBy: { fechaApertura: 'desc' },
    take: 100,
    select: {
      id: true,
      numero: true,
      numeroOrdenTurno: true,
      canal: true,
      modalidad: true,
      estado: true,
      total: true,
      fechaApertura: true,
      motivoAnulacion: true,
    },
  });
}

/**
 * Agrega items a una venta existente en estado PROCESADA.
 * Recalcula subtotal/total y refresca tieneCocina si alguno de los nuevos lo dispara.
 */
export async function agregarItemsAVenta(args: {
  ventaId: string;
  items: ItemNuevo[];
  usuarioId: string;
}) {
  const { ventaId, items } = args;
  const venta = await prisma.venta.findUnique({
    where: { id: ventaId },
    include: { listaPrecios: true, items: true },
  });
  if (!venta) throw new Error('Venta no encontrada');

  const productoIds = [...new Set(items.map((i) => i.productoId))];
  const productos = await prisma.producto.findMany({
    where: { id: { in: productoIds } },
    include: {
      tipoProducto: true,
      preciosPorLista: { where: { listaId: venta.listaPreciosId }, take: 1 },
    },
  });
  const productoMap = new Map(productos.map((p) => [p.id, p]));

  const ajustePct = Number(venta.listaPrecios.ajustePctDefault);
  const ordenInicial = (venta.items[venta.items.length - 1]?.orden ?? -1) + 1;

  const itemsToCreate: Array<Prisma.ItemVentaCreateWithoutVentaInput> = [];
  let subtotalAdicional = 0;
  let tieneCocinaNuevo = venta.tieneCocina;

  for (const [idx, item] of items.entries()) {
    const producto = productoMap.get(item.productoId);
    if (!producto) throw new Error(`Producto ${item.productoId} no existe`);

    const precioOverride = producto.preciosPorLista[0]?.precioEfectivo;
    const precioBaseNum = Number(producto.precioBase);
    const precioListaSinDelta = precioOverride
      ? Number(precioOverride)
      : precioBaseNum * (1 + ajustePct / 100);
    const deltaMod = item.modificadores.reduce((acc, m) => acc + Number(m.deltaPrecio || 0), 0);
    const precioUnitario = precioListaSinDelta + deltaMod;

    const subTotalItemStr = subtotalItem({
      cantidad: item.cantidad,
      precioUnitario: precioUnitario.toFixed(2),
      unidadPrecio: producto.unidadPrecio,
    });
    subtotalAdicional += Number(subTotalItemStr);
    if (producto.tipoProducto.cocinaInterviene) tieneCocinaNuevo = true;

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
      orden: ordenInicial + idx,
      cocinaInterviene: producto.tipoProducto.cocinaInterviene,
      ...(item.parteDeComboId && {
        combo: { connect: { id: item.parteDeComboId } },
      }),
      parteDeComboInstancia: item.parteDeComboInstancia ?? null,
    });
  }

  const subtotalNuevo = Number(venta.subtotal) + subtotalAdicional;
  const totalNuevo = subtotalNuevo - Number(venta.descuentoTotal) + Number(venta.recargoCanal);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.venta.update({
      where: { id: ventaId },
      data: {
        subtotal: subtotalNuevo.toFixed(2),
        total: totalNuevo.toFixed(2),
        tieneCocina: tieneCocinaNuevo,
        items: { create: itemsToCreate },
      },
    });

    // Re-encolar comandas con la versión actualizada (que ya incluye los
    // items nuevos). Reimprime en todos los destinos correspondientes según
    // las reglas. Si ya se cocinó la versión anterior, las comanderas
    // descartan la vieja y usan la nueva.
    await encolarComandasParaVenta(ventaId, tx);

    return updated;
  });
}

/**
 * Quita un item específico de una venta PROCESADA y recalcula totales.
 */
/**
 * Edita campos editables de un ItemVenta (por ahora solo observacion).
 * Se llama desde PATCH /ventas/:id/items/:itemId. La venta debe estar
 * PROCESADA — no editamos items de ventas finalizadas/anuladas.
 *
 * Encola re-impresión de comanda si el item interviene en cocina (la
 * cocinera necesita ver la observación nueva).
 */
export async function editarItemDeVenta(args: {
  ventaId: string;
  itemId: string;
  observacion: string | null;
  usuarioId: string;
}) {
  const venta = await prisma.venta.findUnique({
    where: { id: args.ventaId },
    include: { items: true },
  });
  if (!venta) throw new Error('Venta no encontrada');
  const item = venta.items.find((i) => i.id === args.itemId);
  if (!item) throw new Error('Item no encontrado en esta venta');

  await prisma.itemVenta.update({
    where: { id: args.itemId },
    data: {
      observacion: args.observacion,
      editadoAt: new Date(),
      editadoPorId: args.usuarioId,
    },
  });

  return getVentaCompleta(args.ventaId);
}

export async function quitarItemDeVenta(args: { ventaId: string; itemId: string }) {
  const venta = await prisma.venta.findUnique({
    where: { id: args.ventaId },
    include: { items: true },
  });
  if (!venta) throw new Error('Venta no encontrada');
  const item = venta.items.find((i) => i.id === args.itemId);
  if (!item) throw new Error('Item no encontrado en esta venta');

  await prisma.itemVenta.delete({ where: { id: args.itemId } });

  const restantes = venta.items.filter((i) => i.id !== args.itemId);
  const subtotalNuevo = restantes.reduce((acc, i) => acc + Number(i.totalLinea), 0);
  const tieneCocinaNuevo = restantes.some((i) => i.cocinaInterviene);
  const totalNuevo = subtotalNuevo - Number(venta.descuentoTotal) + Number(venta.recargoCanal);

  return prisma.venta.update({
    where: { id: args.ventaId },
    data: {
      subtotal: subtotalNuevo.toFixed(2),
      total: totalNuevo.toFixed(2),
      tieneCocina: tieneCocinaNuevo,
    },
  });
}
