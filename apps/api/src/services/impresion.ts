import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
import { TipoTrabajoImpresion } from '@sta/db';

/**
 * Servicio de la cola de impresión.
 *
 * Encolar trabajos es idempotente vía `tx` opcional para que la creación de
 * la venta y la encolada del trabajo sean un único commit atómico.
 *
 * REGLAS DE ROUTING (qué venta va a qué comandera) — SOLO PARA COMANDAS.
 * El TICKET_CLIENTE va siempre a MOSTRADOR y se enqueua aparte en
 * `encolarTicketClienteParaVenta` al finalizar la venta.
 *
 *   Comandera 1 = MOSTRADOR — solo TICKET_CLIENTE (no comandas, la cajera
 *                              ve el pedido en pantalla y le entrega al
 *                              cliente el ticket fiscal con totales).
 *   Comandera 2 = DELIVERY  — todos los pedidos de delivery propio
 *                              (TELEFONO/WHATSAPP/WEB con DELIVERY_PROPIO)
 *   Comandera 3 = COCINA    — pedidos con items que requieren preparación
 *                              caliente + todos los de apps externas (RAPPI,
 *                              Pedidos YA, MELI, DELIVERATE)
 *
 * | Caso                                    | MOSTRADOR | DELIVERY | COCINA |
 * |-----------------------------------------|-----------|----------|--------|
 * | Mostrador + sin cocina                  | ·         | ·        | ·      |
 * | Mostrador + con cocina                  | ·         | ·        | ✓      |
 * | Delivery propio + sin cocina            | ·         | ✓        | ·      |
 * | Delivery propio + con cocina            | ·         | ✓        | ✓      |
 * | Apps externas (RAPPI/PYA/MELI/DELIVERATE)| ·        | ·        | ✓      |
 */

type DbClient = Prisma.TransactionClient | typeof prisma;

export type DestinoImpresion = 'MOSTRADOR' | 'DELIVERY' | 'COCINA';

/**
 * Devuelve la lista de destinos físicos donde tiene que imprimirse la
 * comanda de una venta, según las reglas operativas del local.
 *
 * @param canal       Canal de la venta (MOSTRADOR / TELEFONO / WHATSAPP /
 *                    RAPPI / PEDIDOS_YA / MERCADO_LIBRE / DELIVERATE / WEB)
 * @param tieneCocina true si al menos un item requiere preparación caliente
 */
export function determinarDestinos(
  canal: string,
  tieneCocina: boolean,
): DestinoImpresion[] {
  // Apps externas: solo cocina (la cocinera prepara y deja listo para que
  // el motoquero de la app retire). DELIVERATE va acá también — empresa de
  // delivery contratada que retira el pedido del local.
  if (canal === 'RAPPI' || canal === 'PEDIDOS_YA' || canal === 'MERCADO_LIBRE' || canal === 'DELIVERATE') {
    return ['COCINA'];
  }

  // Delivery propio (motoquero del local — Damián): Comandera 2.
  // + Cocina si tiene items que cocinan.
  if (canal === 'TELEFONO' || canal === 'WHATSAPP' || canal === 'WEB') {
    return tieneCocina ? ['DELIVERY', 'COCINA'] : ['DELIVERY'];
  }

  // Mostrador: solo va a cocina si hay items calientes. La cajera ve el
  // pedido en pantalla, no necesita comanda en papel — el TICKET_CLIENTE
  // se imprime aparte al finalizar (con precios, totales, header del comercio).
  return tieneCocina ? ['COCINA'] : [];
}

interface EncolarArgs {
  tipo: TipoTrabajoImpresion;
  destino: DestinoImpresion;
  payload: Record<string, unknown>;
  ventaId?: string | null;
  tx?: Prisma.TransactionClient;
}

export async function encolarTrabajo(args: EncolarArgs) {
  const client: DbClient = args.tx ?? prisma;
  return client.trabajoImpresion.create({
    data: {
      tipo: args.tipo,
      destino: args.destino,
      payload: args.payload as Prisma.InputJsonValue,
      ventaId: args.ventaId ?? null,
    },
  });
}

/**
 * Construye el ComandaPayload completo a partir de la venta y sus items.
 *
 * Incluye los datos de delivery (cliente, dirección, teléfono, indicaciones)
 * cuando la venta es DELIVERY_*. La cocinera ve TODO en una sola hoja:
 * items de cocina + a quién/dónde se entrega.
 */
export async function buildComandaPayload(
  ventaId: string,
  client: DbClient = prisma,
): Promise<Record<string, unknown>> {
  const venta = await client.venta.findUnique({
    where: { id: ventaId },
    include: {
      items: {
        orderBy: { orden: 'asc' },
        include: { combo: true },
      },
      deliveryInfo: true,
    },
  });
  if (!venta) throw new Error(`Venta ${ventaId} no encontrada`);

  // Datos de delivery: solo si modalidad es delivery y hay deliveryInfo
  let delivery: Record<string, unknown> | undefined;
  if (venta.modalidad !== 'TAKE_AWAY' && venta.deliveryInfo?.direccionSnapshot) {
    const snap = venta.deliveryInfo.direccionSnapshot as Record<string, unknown>;
    // Repartidor: empleado interno (snap._empleadoNombre) o empresa externa
    // (deliveryInfo.empresaExterna o snap._empresaExterna). Si la encargada
    // no eligió todavía, queda undefined y no se imprime esa línea.
    const empleadoNombre =
      typeof snap._empleadoNombre === 'string' ? snap._empleadoNombre : undefined;
    const empresaExterna =
      venta.deliveryInfo.empresaExterna ??
      (typeof snap._empresaExterna === 'string' ? snap._empresaExterna : undefined);
    const repartidor = empleadoNombre ?? empresaExterna ?? undefined;
    delivery = {
      clienteNombre: snap.clienteNombre ?? null,
      clienteTelefono: snap.clienteTelefono ?? null,
      direccion: snap.direccion ?? null,
      indicaciones: snap.indicaciones ?? null,
      horaPrometida: venta.deliveryInfo.horaPrometida
        ? venta.deliveryInfo.horaPrometida.toISOString()
        : null,
      repartidor,
    };
  }

  return {
    numeroOrden: venta.numeroOrdenTurno,
    hora: venta.fechaApertura.toISOString().slice(11, 16),
    canal: venta.canal,
    items: venta.items.map((it) => {
      const mods = (it.modificadoresAplicados as Array<{ opcionNombre?: string }> | null) ?? [];
      return {
        cantidad: String(it.cantidad),
        nombre: it.nombreSnapshot,
        modificadores: mods
          .map((m) => m?.opcionNombre)
          .filter((x): x is string => typeof x === 'string'),
        observacion: it.observacion ?? undefined,
        parteDeCombo: it.combo?.nombre,
      };
    }),
    pcOrigen: venta.pcOrigen,
    delivery,
  };
}

/**
 * Encolar comandas para una venta — aplica las reglas de `determinarDestinos`
 * y crea trabajos del tipo correcto por destino:
 *   - COCINA   → COMANDA_COCINA (formato comanda con items para preparar)
 *   - DELIVERY → TICKET_DELIVERY (ticket completo: cliente, dirección, total,
 *                forma de pago, hora prometida — todo lo que el motoquero
 *                necesita para entregar y cobrar)
 *
 * MOSTRADOR no se encola desde acá — el ticket cliente sale en
 * `encolarTicketClienteParaVenta` al finalizar la venta.
 *
 * Se llama al crear venta y al agregar items. Idempotente para retries: cada
 * llamada genera trabajos nuevos.
 */
export async function encolarComandasParaVenta(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<DestinoImpresion[]> {
  const venta = await tx.venta.findUnique({
    where: { id: ventaId },
    select: { canal: true, tieneCocina: true },
  });
  if (!venta) return [];

  const destinos = determinarDestinos(venta.canal, venta.tieneCocina);
  if (destinos.length === 0) return [];

  // Cocina y delivery tienen payloads distintos; las construimos solo si
  // hace falta para no pegarle a la DB de más.
  let comandaPayload: Record<string, unknown> | null = null;
  let deliveryPayload: Record<string, unknown> | null = null;

  for (const destino of destinos) {
    if (destino === 'COCINA') {
      comandaPayload ??= await buildComandaPayload(ventaId, tx);
      await encolarTrabajo({
        tipo: TipoTrabajoImpresion.COMANDA_COCINA,
        destino,
        payload: comandaPayload,
        ventaId,
        tx,
      });
    } else if (destino === 'DELIVERY') {
      deliveryPayload ??= await buildTicketDeliveryPayload(ventaId, tx);
      if (deliveryPayload) {
        await encolarTrabajo({
          tipo: TipoTrabajoImpresion.TICKET_DELIVERY,
          destino,
          payload: deliveryPayload,
          ventaId,
          tx,
        });
      }
    }
  }
  return destinos;
}

/**
 * Construye el TicketDeliveryPayload con datos del cliente, dirección, items,
 * total, hora prometida y forma de pago. Devuelve null si la venta no tiene
 * deliveryInfo (no debería pasar para canales delivery, pero por las dudas).
 */
async function buildTicketDeliveryPayload(
  ventaId: string,
  client: DbClient = prisma,
): Promise<Record<string, unknown> | null> {
  const venta = await client.venta.findUnique({
    where: { id: ventaId },
    include: {
      items: { orderBy: { orden: 'asc' } },
      pagos: { orderBy: { fecha: 'asc' } },
      cliente: true,
      usuarioApertura: true,
      deliveryInfo: true,
    },
  });
  if (!venta) return null;

  const snap = (venta.deliveryInfo?.direccionSnapshot as Record<string, unknown>) ?? {};
  const clienteNombre =
    (typeof snap.clienteNombre === 'string' && snap.clienteNombre) ||
    (venta.cliente
      ? `${venta.cliente.nombre}${venta.cliente.apellido ? ' ' + venta.cliente.apellido : ''}`
      : 'Sin nombre');
  const clienteTelefono =
    (typeof snap.clienteTelefono === 'string' && snap.clienteTelefono) ||
    venta.cliente?.telefono ||
    undefined;

  // direccion puede venir como string (snapshot legacy) o como objeto
  // estructurado. Normalizamos a string.
  let direccion = '';
  if (typeof snap.direccion === 'string') {
    direccion = snap.direccion;
  } else if (snap.direccion && typeof snap.direccion === 'object') {
    const d = snap.direccion as Record<string, unknown>;
    const partes = [
      [d.calle, d.numero].filter(Boolean).join(' '),
      d.piso ? `piso ${d.piso}` : null,
      d.depto ? `dpto ${d.depto}` : null,
      d.entreCalles ? `entre ${d.entreCalles}` : null,
      d.localidad,
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);
    direccion = partes.join(', ');
  } else {
    // fallback: campos planos en el snapshot
    const partes = [
      [snap.calle, snap.numero].filter(Boolean).join(' '),
      snap.piso ? `piso ${snap.piso}` : null,
      snap.depto ? `dpto ${snap.depto}` : null,
      snap.entreCalles ? `entre ${snap.entreCalles}` : null,
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);
    direccion = partes.join(', ');
  }

  const indicaciones =
    (typeof snap.indicaciones === 'string' && snap.indicaciones) ||
    venta.deliveryInfo?.observaciones ||
    undefined;

  const empleadoNombre =
    typeof snap._empleadoNombre === 'string' ? snap._empleadoNombre : undefined;
  const empresaExterna =
    venta.deliveryInfo?.empresaExterna ??
    (typeof snap._empresaExterna === 'string' ? snap._empresaExterna : undefined);

  // Pago: si hay pagos confirmados → PAGADO. Sino A_COBRAR (motoquero cobra).
  const pagosConfirmados = venta.pagos.filter((p) => p.estado === 'CONFIRMADO');
  let pago: { metodo: string; estado: 'PAGADO' | 'A_COBRAR'; montoACobrar?: string };
  if (pagosConfirmados.length > 0) {
    const metodo =
      pagosConfirmados.length === 1
        ? pagosConfirmados[0]!.metodo
        : pagosConfirmados.map((p) => p.metodo).join(' + ');
    pago = { metodo, estado: 'PAGADO' };
  } else {
    // Default: efectivo a cobrar al entregar (caso típico).
    pago = {
      metodo: 'EFECTIVO',
      estado: 'A_COBRAR',
      montoACobrar: Number(venta.total).toFixed(2),
    };
  }

  return {
    numeroVenta: venta.numero,
    numeroOrden: venta.numeroOrdenTurno,
    canal: venta.canal,
    idExterno: venta.idExternoCanal ?? undefined,
    empleadoNombre,
    empresaExterna,
    cliente: {
      nombre: clienteNombre,
      telefono: clienteTelefono,
      direccion,
      indicaciones,
    },
    horaPrometida: venta.deliveryInfo?.horaPrometida
      ? venta.deliveryInfo.horaPrometida.toISOString()
      : null,
    items: venta.items.map((it) => ({
      cantidad: String(it.cantidad),
      nombre: it.nombreSnapshot,
      precioUnitario: Number(it.precioUnitario).toFixed(2),
      subtotal: Number(it.totalLinea).toFixed(2),
    })),
    envio:
      venta.modalidad === 'DELIVERY_PROPIO' && Number(venta.recargoCanal) > 0
        ? Number(venta.recargoCanal).toFixed(2)
        : null,
    total: Number(venta.total).toFixed(2),
    pago,
    cajero: venta.usuarioApertura?.nombre ?? 'NN',
    pcOrigen: venta.pcOrigen,
    fecha: venta.fechaApertura.toISOString(),
  };
}

/**
 * Encolar comandas CANCELADAS para una venta — sale con marca
 * "*** CANCELADA ***" en todas las comanderas donde se imprimió el original
 * (mostrador / delivery / cocina), para que el operador en cada estación
 * tache el pedido.
 */
export async function encolarComandasCanceladas(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<DestinoImpresion[]> {
  const venta = await tx.venta.findUnique({
    where: { id: ventaId },
    select: { canal: true, tieneCocina: true },
  });
  if (!venta) return [];

  const destinos = determinarDestinos(venta.canal, venta.tieneCocina);
  if (destinos.length === 0) return [];

  const payload = await buildComandaPayload(ventaId, tx);
  for (const destino of destinos) {
    await encolarTrabajo({
      tipo: TipoTrabajoImpresion.COMANDA_CANCELADA,
      destino,
      payload,
      ventaId,
      tx,
    });
  }
  return destinos;
}

/**
 * Encola el TICKET_CLIENTE — comprobante con datos completos (precios,
 * descuento, total, método de pago, fecha, header del comercio) que se
 * imprime en la comandera de MOSTRADOR al finalizar la venta y se entrega
 * al cliente.
 *
 * Sólo aplica para canal = MOSTRADOR (el cliente está físicamente en el
 * local). Delivery propio + apps externas reciben el comprobante por otros
 * medios (motoquero / la propia app).
 *
 * Para multi-pago se concatenan los métodos ("EFECTIVO + DEBITO"). Si es
 * single y EFECTIVO, mostramos `recibido` + `cambio` para que cierre la
 * conciliación de caja del cliente.
 */
export async function encolarTicketClienteParaVenta(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const venta = await tx.venta.findUnique({
    where: { id: ventaId },
    include: {
      items: { orderBy: { orden: 'asc' } },
      pagos: { orderBy: { fecha: 'asc' } },
      cliente: true,
      usuarioCierre: true,
      usuarioApertura: true,
      deliveryInfo: true,
    },
  });
  if (!venta) return false;
  if (venta.canal !== 'MOSTRADOR') return false;

  // Repartidor (en caso de mostrador + modalidad delivery, raro pero posible).
  // Empleado interno o empresa externa. Se imprime en la misma sección que
  // el método de pago para que la encargada vea quién va a entregar.
  let repartidor: string | undefined;
  if (venta.deliveryInfo) {
    const snap = (venta.deliveryInfo.direccionSnapshot ?? {}) as Record<string, unknown>;
    const emp = typeof snap._empleadoNombre === 'string' ? snap._empleadoNombre : undefined;
    const ext =
      venta.deliveryInfo.empresaExterna ??
      (typeof snap._empresaExterna === 'string' ? snap._empresaExterna : undefined);
    repartidor = emp ?? ext ?? undefined;
  }

  const pagosConfirmados = venta.pagos.filter((p) => p.estado === 'CONFIRMADO');
  let pagoInfo: { metodo: string; recibido?: string; cambio?: string };
  const primer = pagosConfirmados[0];
  if (pagosConfirmados.length === 1 && primer) {
    const isEfectivo = primer.metodo === 'EFECTIVO';
    const cambio = Number(primer.cambioDado);
    pagoInfo = {
      metodo: primer.metodo,
      recibido: isEfectivo ? Number(primer.monto).toFixed(2) : undefined,
      cambio: isEfectivo && cambio > 0 ? cambio.toFixed(2) : undefined,
    };
  } else {
    pagoInfo = { metodo: pagosConfirmados.map((p) => p.metodo).join(' + ') || 'MIXTO' };
  }

  const clienteNombre = venta.cliente
    ? `${venta.cliente.nombre}${venta.cliente.apellido ? ' ' + venta.cliente.apellido : ''}`
    : 'Mostrador';
  const vendedorNombre =
    venta.usuarioCierre?.nombre ?? venta.usuarioApertura?.nombre ?? 'NN';

  const subtotal = Number(venta.subtotal);
  const descuentoMonto = Number(venta.descuentoTotal);
  const descuento =
    descuentoMonto > 0 && subtotal > 0
      ? { pct: Math.round((descuentoMonto / subtotal) * 100), monto: descuentoMonto.toFixed(2) }
      : null;

  const fechaIso = (venta.fechaFinalizacion ?? venta.fechaApertura).toISOString();

  const payload = {
    numeroVenta: venta.numero,
    numeroOrden: venta.numeroOrdenTurno,
    cliente: clienteNombre,
    vendedor: vendedorNombre,
    pcOrigen: venta.pcOrigen,
    items: venta.items.map((it) => ({
      cantidad: String(it.cantidad),
      nombre: it.nombreSnapshot,
      precio: Number(it.precioUnitario).toFixed(2),
      subtotal: Number(it.totalLinea).toFixed(2),
    })),
    subtotal: subtotal.toFixed(2),
    descuento,
    total: Number(venta.total).toFixed(2),
    pago: pagoInfo,
    ...(repartidor && { repartidor }),
    // ISO — el renderer del local-agent lo formatea como DD/MM/YYYY HH:MM:SS AR
    fecha: fechaIso,
  };

  await encolarTrabajo({
    tipo: TipoTrabajoImpresion.TICKET_CLIENTE,
    destino: 'MOSTRADOR',
    payload,
    ventaId,
    tx,
  });
  return true;
}

/**
 * Re-encola los tickets/comandas de una venta ya existente. Marca el tipo
 * como REIMPRESION para que el renderer muestre el header "*** REIMPRESIÓN ***"
 * y la cocinera/encargada sepa que es duplicado (no procesar la cocina de
 * nuevo).
 *
 * Acepta una lista opcional de destinos. Si no se pasa, re-imprime en todos
 * los destinos donde originalmente se imprimió (COCINA si tenía items
 * cocinables + DELIVERY si era delivery propio + MOSTRADOR si era mostrador).
 */
export async function reimprimirVenta(
  ventaId: string,
  destinos?: DestinoImpresion[],
): Promise<DestinoImpresion[]> {
  const venta = await prisma.venta.findUnique({
    where: { id: ventaId },
    select: { canal: true, tieneCocina: true },
  });
  if (!venta) throw new Error('Venta no encontrada');

  const originales = determinarDestinos(venta.canal, venta.tieneCocina);
  const incluirMostrador = venta.canal === 'MOSTRADOR';
  const todosDisponibles = [
    ...originales,
    ...(incluirMostrador ? (['MOSTRADOR'] as DestinoImpresion[]) : []),
  ];
  const targets = destinos
    ? destinos.filter((d) => todosDisponibles.includes(d))
    : todosDisponibles;

  const resultados: DestinoImpresion[] = [];
  for (const destino of targets) {
    if (destino === 'COCINA') {
      const payload = await buildComandaPayload(ventaId);
      await encolarTrabajo({
        tipo: TipoTrabajoImpresion.COMANDA_REIMPRESION,
        destino,
        payload,
        ventaId,
      });
      resultados.push(destino);
    } else if (destino === 'DELIVERY') {
      const payload = await buildTicketDeliveryPayload(ventaId);
      if (payload) {
        await encolarTrabajo({
          tipo: TipoTrabajoImpresion.TICKET_DELIVERY,
          destino,
          payload,
          ventaId,
        });
        resultados.push(destino);
      }
    } else if (destino === 'MOSTRADOR') {
      // Solo aplica si la venta es de mostrador (canal=MOSTRADOR).
      // Usamos una mini transacción para reusar encolarTicketClienteParaVenta.
      await prisma.$transaction(async (tx) => {
        await encolarTicketClienteParaVenta(ventaId, tx);
      });
      resultados.push(destino);
    }
  }
  return resultados;
}

/**
 * Trabajo TEST — útil para que el admin verifique que la impresora está OK
 * desde el panel de configuración (un click → sale un ticket "=== TEST OK ===").
 */
export async function encolarTrabajoTest(destino: DestinoImpresion) {
  return encolarTrabajo({
    tipo: TipoTrabajoImpresion.TEST,
    destino,
    payload: { destino },
  });
}

/**
 * Configuración runtime de impresoras (por destino). Se persiste en
 * `configuracion_sistema` con clave `impresora_kitchen|counter|delivery`.
 *
 * Defaults: 192.168.1.50/51/52:9100 con 42 chars de ancho (papel 80mm).
 * El admin puede cambiarlas desde el panel.
 */
export interface PrinterDestinoConfig {
  host: string;
  port: number;
  width: number;
  activa: boolean;
}

const DEFAULT_CONFIG: Record<DestinoImpresion, PrinterDestinoConfig> = {
  MOSTRADOR: { host: '192.168.1.50', port: 9100, width: 42, activa: true },
  DELIVERY: { host: '192.168.1.51', port: 9100, width: 42, activa: true },
  COCINA: { host: '192.168.1.52', port: 9100, width: 42, activa: true },
};

export async function getConfigImpresion(): Promise<
  Record<DestinoImpresion, PrinterDestinoConfig>
> {
  const rows = await prisma.configuracionSistema.findMany({
    where: { categoria: 'impresoras' },
  });
  const byClave = new Map(rows.map((r) => [r.clave, r.valor]));
  const result: Record<DestinoImpresion, PrinterDestinoConfig> = { ...DEFAULT_CONFIG };
  for (const destino of ['MOSTRADOR', 'DELIVERY', 'COCINA'] as const) {
    const raw = byClave.get(`impresora_${destino.toLowerCase()}`);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<PrinterDestinoConfig>;
      result[destino] = { ...DEFAULT_CONFIG[destino], ...parsed };
    } catch {
      /* fallback al default */
    }
  }
  return result;
}
