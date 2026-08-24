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
import type { ItemNuevo, VentaNueva } from '@sta/shared';
import { subtotalItem } from '@sta/shared';
import { getOrCreateSesionActual, siguienteNumeroOrdenTurno } from './sesion-caja.js';
import { recordAudit } from './audit.js';
import { encolarComandasParaVenta, ventaYaEnviadaACocina } from './impresion.js';
import {
  resolverDeltasDeLista,
  deltaDeModificadores,
  opcionIdsDeItems,
} from './deltas-lista.js';

/**
 * Desarma promos/combos en ItemVentas componentes, calculando el precio EN EL
 * SERVER (nunca del cliente). El precio del combo se reparte proporcional al
 * precio suelto de cada componente; la última línea absorbe el redondeo para
 * que la suma dé EXACTO precioCombo × cantidad. Cada línea queda tagueada con
 * parteDeComboId + una `instancia` por promo → cuenta como producto individual
 * "(en promo)" y el ticket la agrupa.
 *
 * Lo usan crearVenta y agregarItemsAVenta (mismo comportamiento en ambos).
 */
async function expandirPromosAItems(args: {
  promos: Array<{ comboId: string; cantidad: number; observacion?: string }>;
  listaId: string;
  ajustePct: number;
  ordenInicial: number;
}): Promise<{
  items: Prisma.ItemVentaCreateWithoutVentaInput[];
  subtotal: number;
  tieneCocina: boolean;
}> {
  const { promos, listaId, ajustePct } = args;
  if (promos.length === 0) return { items: [], subtotal: 0, tieneCocina: false };

  const comboIds = [...new Set(promos.map((p) => p.comboId))];
  const combos = await prisma.combo.findMany({
    where: { id: { in: comboIds }, activo: true },
    include: {
      componentes: {
        orderBy: { orden: 'asc' },
        include: {
          producto: {
            include: { tipoProducto: true, preciosPorLista: { where: { listaId }, take: 1 } },
          },
        },
      },
    },
  });
  const comboMap = new Map(combos.map((c) => [c.id, c]));

  const items: Prisma.ItemVentaCreateWithoutVentaInput[] = [];
  let subtotal = 0;
  let tieneCocina = false;
  let orden = args.ordenInicial;

  for (const promo of promos) {
    const combo = comboMap.get(promo.comboId);
    if (!combo) throw new ReglaNegocioError(`Combo ${promo.comboId} no existe o está inactivo`);
    const comps = combo.componentes.filter((c) => c.producto);
    if (comps.length === 0) throw new ReglaNegocioError(`Combo ${combo.nombre} no tiene productos`);

    const Q = promo.cantidad;
    const totalCombo = Math.round(Number(combo.precioCombo) * Q * 100) / 100;
    const instancia = crypto.randomUUID();

    const sueltos = comps.map((c) => {
      const prod = c.producto!;
      const precioOverride = prod.preciosPorLista[0]?.precioEfectivo;
      const precioLista = precioOverride
        ? Number(precioOverride)
        : Number(prod.precioBase) * (1 + ajustePct / 100);
      return precioLista * Number(c.cantidad);
    });
    const sueltoTotal = sueltos.reduce((a, b) => a + b, 0);

    let acumulado = 0;
    comps.forEach((comp, i) => {
      const prod = comp.producto!;
      const totalUnits = Number(comp.cantidad) * Q;
      let share: number;
      if (i === comps.length - 1) {
        share = Math.round((totalCombo - acumulado) * 100) / 100;
      } else {
        const prop = sueltoTotal > 0 ? sueltos[i]! / sueltoTotal : 1 / comps.length;
        share = Math.round(totalCombo * prop * 100) / 100;
        acumulado += share;
      }
      const precioUnit = totalUnits > 0 ? Math.round((share / totalUnits) * 100) / 100 : 0;
      const cocinaInterviene = prod.cocinaIntervieneOverride ?? prod.tipoProducto.cocinaInterviene;
      if (cocinaInterviene) tieneCocina = true;
      subtotal += share;
      items.push({
        producto: { connect: { id: prod.id } },
        nombreSnapshot: prod.nombre,
        cantidad: String(totalUnits),
        unidad: prod.formaVenta as DbFormaVenta,
        precioUnitario: precioUnit.toFixed(2),
        modificadoresAplicados: [] as never,
        deltaModificadores: '0',
        subtotal: share.toFixed(2),
        totalLinea: share.toFixed(2),
        observacion: promo.observacion ?? null,
        orden: orden++,
        cocinaInterviene,
        combo: { connect: { id: combo.id } },
        parteDeComboInstancia: instancia,
      });
    });
  }

  return { items, subtotal, tieneCocina };
}

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

  // Resolvemos la lista de precios por CANAL (canalDefault), NO por nombre. Así
  // el nombre de la lista se puede cambiar (ej. "Local" → "Venta al público")
  // sin romper la venta. Las listas custom/mayoristas usan canal MAYORISTA, así
  // que nunca colisionan con la resolución de los canales de venta.
  const canalListaPorVenta: Record<CanalVenta, CanalListaPrecios> = {
    MOSTRADOR: CanalListaPrecios.LOCAL_MOSTRADOR,
    TELEFONO: CanalListaPrecios.LOCAL_MOSTRADOR,
    WHATSAPP: CanalListaPrecios.LOCAL_MOSTRADOR,
    WEB: CanalListaPrecios.LOCAL_MOSTRADOR,
    RAPPI: CanalListaPrecios.RAPPI,
    PEDIDOS_YA: CanalListaPrecios.PEDIDOS_YA,
    MERCADO_LIBRE: CanalListaPrecios.MERCADO_LIBRE,
    DELIVERATE: CanalListaPrecios.DELIVERATE,
  };
  const canalLista = canalListaPorVenta[data.canal as CanalVenta];
  const lista = await prisma.listaPrecios.findFirst({
    where: { canalDefault: canalLista, activa: true },
    orderBy: { nombre: 'asc' },
  });
  if (!lista) throw new ReglaNegocioError(`No hay lista de precios activa para el canal ${canalLista}`);

  const sesion = await getOrCreateSesionActual(usuarioId);
  const numeroOrden = await siguienteNumeroOrdenTurno(sesion.id);

  // Cargar info de productos en batch
  const productoIds = [...new Set(data.items.map((i) => i.productoId))];
  const productos = await prisma.producto.findMany({
    where: { id: { in: productoIds } },
    include: { tipoProducto: true, preciosPorLista: { where: { listaId: lista.id }, take: 1 } },
  });
  const productoMap = new Map(productos.map((p) => [p.id, p]));

  // Deltas de los sabores RESUELTOS CONTRA ESTA LISTA (ver deltas-lista.ts).
  const deltas = await resolverDeltasDeLista(lista.id, opcionIdsDeItems(data.items));

  // Calcular items con snapshot
  const itemsToCreate: Array<Prisma.ItemVentaCreateWithoutVentaInput> = [];
  let subtotalVenta = 0;
  let tieneCocina = false;
  const ajustePct = Number(lista.ajustePctDefault);

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
    const subTotalNum = Number(subTotalItemStr);
    subtotalVenta += subTotalNum;
    // Cocina: el override por-producto (casillero "Enviar a cocina") gana; si es
    // null, hereda de `tipoProducto.cocinaInterviene` (comportamiento de siempre).
    const cocinaInterviene =
      producto.cocinaIntervieneOverride ?? producto.tipoProducto.cocinaInterviene;
    if (cocinaInterviene) tieneCocina = true;

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
      cocinaInterviene,
      ...(item.parteDeComboId && {
        combo: { connect: { id: item.parteDeComboId } },
      }),
      parteDeComboInstancia: item.parteDeComboInstancia ?? null,
    });
  }

  // ── PROMOS / COMBOS ─────────────────────────────────────────────────────
  // Cada promo se DESARMA en el server (nunca se confía el precio del cliente).
  const promoExp = await expandirPromosAItems({
    promos: data.promos ?? [],
    listaId: lista.id,
    ajustePct,
    ordenInicial: data.items.length,
  });
  itemsToCreate.push(...promoExp.items);
  subtotalVenta += promoExp.subtotal;
  if (promoExp.tieneCocina) tieneCocina = true;

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
        let direccionNueva: { id: string } | null = null;
        if (data.direccionEntrega) {
          direccionNueva = await tx.direccion.create({
            data: {
              clienteId: nuevo.id,
              etiqueta: 'Casa',
              calle: data.direccionEntrega,
              numero: '—',
              indicaciones: data.indicacionesEntrega ?? null,
              esDefault: true,
            },
            select: { id: true },
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
        // La dirección va DESPUÉS del cliente (mayor `secuencia`), que es el
        // orden que respeta la FK direccion → cliente al replicar.
        if (direccionNueva) {
          await recordAudit({
            tabla: 'direcciones',
            registroId: direccionNueva.id,
            accion: 'INSERT',
            usuarioId,
            pcOrigen: data.pcOrigen,
            contexto: { autoCreadoDesdePedido: true, clienteId: nuevo.id },
            tx,
          });
        }
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
      // Los ids de los items hacen falta para auditarlos uno por uno (ver abajo).
      include: { items: { select: { id: true } } },
    });

    let deliveryNuevo: { id: string } | null = null;
    if (tieneDatosDelivery && esDelivery) {
      deliveryNuevo = await tx.deliveryInfo.create({
        select: { id: true },
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

    // Un audit POR RENGLÓN y por el delivery. `items_venta` y `delivery_info`
    // son OTRAS tablas, y el replicador replica fila por fila a partir de los
    // eventos de outbox: sin evento propio se quedan en la base local y la
    // venta llega a la nube VACÍA. Hasta ahora no se notaba porque las cajas
    // escribían directo a Supabase; en cuanto pasan a escribirle a S1, cada
    // venta replicaría sin sus renglones. Mismo bug que el de las facturas por
    // OCR (2026-08-14), en el camino central del sistema.
    //
    // Van DESPUÉS del audit de la venta (mayor `secuencia`), que es el orden
    // que respeta las FK item → venta y delivery → venta al replicar.
    for (const it of venta.items) {
      await recordAudit({
        tabla: 'items_venta',
        registroId: it.id,
        accion: 'INSERT',
        usuarioId,
        pcOrigen: data.pcOrigen,
        contexto: { ventaId: venta.id },
        tx,
      });
    }
    if (deliveryNuevo) {
      await recordAudit({
        tabla: 'delivery_info',
        registroId: deliveryNuevo.id,
        accion: 'INSERT',
        usuarioId,
        pcOrigen: data.pcOrigen,
        contexto: { ventaId: venta.id },
        tx,
      });
    }

    // Comanda de COCINA: solo si el pedido se "envía" al crear (Enviar a cocina /
    // Cargar otro / apps externas → enviarACocina=true, el default). En el flujo
    // "Cobrar" (enviarACocina=false) la comanda NO sale acá: sale al confirmar el
    // pago en POST /ventas/:id/finalizar, para no imprimir en cocina un pedido que
    // el cliente todavía está armando (y no cocinar pedidos que se caen antes de
    // pagar). El dedup de encolarComandasParaVenta colapsa disparos en ráfaga.
    // El TICKET_CLIENTE y el TICKET_DELIVERY siempre salen al finalizar (con el pago).
    if (data.enviarACocina !== false) {
      await encolarComandasParaVenta(venta.id, tx);
    }
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
      // Adiciones de encargo ("modificación adicional al pedido X") — el modal
      // de detalle las muestra con su estado de cobro y saldo pendiente.
      adicionesEncargo: {
        where: { estado: { not: 'ANULADA' } },
        orderBy: { fechaApertura: 'asc' },
        include: { items: { orderBy: { orden: 'asc' } }, pagos: true },
      },
    },
  });
}

/**
 * Lista de ventas de la sesión actual (para drawer "Historial").
 */
export async function listarVentasDeSesionActual(sesionId: string) {
  return prisma.venta.findMany({
    // Los encargos no entran al historial del cajero (tienen su propia pestaña).
    where: { sesionCajaId: sesionId, esEncargo: false },
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
  promos?: Array<{ comboId: string; cantidad: number; observacion?: string }>;
  usuarioId: string;
}) {
  const { ventaId, items } = args;
  const promos = args.promos ?? [];
  const venta = await prisma.venta.findUnique({
    where: { id: ventaId },
    include: { listaPrecios: true, items: true },
  });
  if (!venta) throw new ReglaNegocioError('Venta no encontrada');

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
  const deltas = await resolverDeltasDeLista(venta.listaPreciosId, opcionIdsDeItems(items));
  const ordenInicial = (venta.items[venta.items.length - 1]?.orden ?? -1) + 1;

  const itemsToCreate: Array<Prisma.ItemVentaCreateWithoutVentaInput> = [];
  let subtotalAdicional = 0;
  let tieneCocinaNuevo = venta.tieneCocina;

  for (const [idx, item] of items.entries()) {
    const producto = productoMap.get(item.productoId);
    if (!producto) throw new ReglaNegocioError(`Producto ${item.productoId} no existe`);

    const precioOverride = producto.preciosPorLista[0]?.precioEfectivo;
    const precioBaseNum = Number(producto.precioBase);
    const precioListaSinDelta = precioOverride
      ? Number(precioOverride)
      : precioBaseNum * (1 + ajustePct / 100);
    const deltaMod = deltaDeModificadores(item.modificadores, deltas);
    const precioUnitario = precioListaSinDelta + deltaMod;

    const subTotalItemStr = subtotalItem({
      cantidad: item.cantidad,
      precioUnitario: precioUnitario.toFixed(2),
      unidadPrecio: producto.unidadPrecio,
    });
    subtotalAdicional += Number(subTotalItemStr);
    // Cocina: override por-producto gana; si es null, hereda del tipo.
    const cocinaInterviene =
      producto.cocinaIntervieneOverride ?? producto.tipoProducto.cocinaInterviene;
    if (cocinaInterviene) tieneCocinaNuevo = true;

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
      cocinaInterviene,
      ...(item.parteDeComboId && {
        combo: { connect: { id: item.parteDeComboId } },
      }),
      parteDeComboInstancia: item.parteDeComboInstancia ?? null,
    });
  }

  // Promos agregadas a la venta abierta (mismo desarme server-side que al crear).
  const promoExp = await expandirPromosAItems({
    promos,
    listaId: venta.listaPreciosId,
    ajustePct,
    ordenInicial: ordenInicial + items.length,
  });
  itemsToCreate.push(...promoExp.items);
  subtotalAdicional += promoExp.subtotal;
  if (promoExp.tieneCocina) tieneCocinaNuevo = true;

  const subtotalNuevo = Number(venta.subtotal) + subtotalAdicional;
  const totalNuevo = subtotalNuevo - Number(venta.descuentoTotal) + Number(venta.recargoCanal);

  const idsPrevios = new Set(venta.items.map((i) => i.id));

  return prisma.$transaction(async (tx) => {
    const updated = await tx.venta.update({
      where: { id: ventaId },
      data: {
        subtotal: subtotalNuevo.toFixed(2),
        total: totalNuevo.toFixed(2),
        tieneCocina: tieneCocinaNuevo,
        items: { create: itemsToCreate },
      },
      include: { items: { select: { id: true } } },
    });

    // La venta cambió de totales y tiene renglones NUEVOS. Las dos cosas
    // necesitan su evento de outbox o la nube se queda con la versión vieja y
    // sin los items agregados. Antes acá no se auditaba nada.
    await recordAudit({
      tabla: 'ventas',
      registroId: ventaId,
      accion: 'UPDATE',
      usuarioId: args.usuarioId,
      valorNuevo: { subtotal: updated.subtotal, total: updated.total },
      contexto: { motivo: 'items agregados' },
      tx,
    });
    // Solo los que no estaban antes: re-auditar los viejos no rompe nada
    // (el replicador upsertea) pero ensucia el log y la cola.
    for (const it of updated.items) {
      if (idsPrevios.has(it.id)) continue;
      await recordAudit({
        tabla: 'items_venta',
        registroId: it.id,
        accion: 'INSERT',
        usuarioId: args.usuarioId,
        contexto: { ventaId },
        tx,
      });
    }

    // Re-encolar la comanda de COCINA con los items nuevos — SOLO si el pedido YA
    // fue enviado a cocina (se creó con "Enviar a cocina", o ya se cobró). Así la
    // cocina que ya arrancó ve lo agregado al toque. Si todavía NO se envió (flujo
    // "Cobrar" sin confirmar el pago), no imprimimos nada acá: la comanda saldrá
    // completa al confirmar el pago. El dedup colapsa disparos en ráfaga.
    if (await ventaYaEnviadaACocina(ventaId, tx)) {
      await encolarComandasParaVenta(ventaId, tx);
    }
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
  if (!venta) throw new ReglaNegocioError('Venta no encontrada');
  const item = venta.items.find((i) => i.id === args.itemId);
  if (!item) throw new ReglaNegocioError('Item no encontrado en esta venta');

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
  if (!venta) throw new ReglaNegocioError('Venta no encontrada');
  const item = venta.items.find((i) => i.id === args.itemId);
  if (!item) throw new ReglaNegocioError('Item no encontrado en esta venta');

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
