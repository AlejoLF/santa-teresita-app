/**
 * Drivers de impresoras del local — EPSON TM-T20II (térmica) + Lexmark E460 (láser).
 *
 * La térmica habla ESC/POS sobre TCP:9100 — usamos `node-thermal-printer`.
 * La láser usa CUPS / driver del SO — emulamos con Puppeteer (HTML→PDF→imprimir),
 * pero por ahora dejamos un stub.
 */

import { ThermalPrinter, PrinterTypes, CharacterSet } from 'node-thermal-printer';

/**
 * Las 3 comanderas físicas del local Santa Teresita:
 *   - MOSTRADOR (Comandera 1) — todos los pedidos cobrados en mostrador
 *   - DELIVERY  (Comandera 2) — todos los pedidos de delivery propio (TELEFONO/WHATSAPP)
 *   - COCINA    (Comandera 3) — pedidos que requieren preparación caliente +
 *                                todos los de apps externas (RAPPI / PYA / MELI / DELIVERATE)
 */
export type DestinoImpresora = 'MOSTRADOR' | 'DELIVERY' | 'COCINA';

export interface PrinterConfig {
  destino: DestinoImpresora;
  host: string;
  port: number;
  width: number;
  activa: boolean;
}

const DEFAULTS: Record<DestinoImpresora, { host: string; port: number; width: number; activa: boolean }> = {
  MOSTRADOR: { host: '192.168.1.50', port: 9100, width: 42, activa: true },
  DELIVERY: { host: '192.168.1.51', port: 9100, width: 42, activa: true },
  COCINA: { host: '192.168.1.52', port: 9100, width: 42, activa: true },
};

// Cache de la config — el agent la pisa en cada poll usando setPrinterConfig().
// Si nunca se llamó, fallback a DEFAULTS.
const runtimeConfig: Record<DestinoImpresora, PrinterConfig> = {
  MOSTRADOR: { ...DEFAULTS.MOSTRADOR, destino: 'MOSTRADOR' },
  DELIVERY: { ...DEFAULTS.DELIVERY, destino: 'DELIVERY' },
  COCINA: { ...DEFAULTS.COCINA, destino: 'COCINA' },
};

/**
 * Actualiza la config en memoria (la llama el agent al recibir nueva config
 * desde la API). El agent re-fetcha en cada poll, así que cambios desde el
 * panel admin se reflejan en ~2-5 segundos.
 */
export function setPrinterConfig(cfg: Partial<Record<DestinoImpresora, PrinterConfig>>): void {
  for (const k of ['MOSTRADOR', 'DELIVERY', 'COCINA'] as const) {
    const incoming = cfg[k];
    if (incoming) runtimeConfig[k] = { ...incoming, destino: k };
  }
}

export function getPrinterConfig(destino: DestinoImpresora): PrinterConfig {
  return runtimeConfig[destino];
}

export function makePrinter(destino: DestinoImpresora): ThermalPrinter {
  const cfg = runtimeConfig[destino];
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${cfg.host}:${cfg.port}`,
    characterSet: CharacterSet.PC850_MULTILINGUAL,
    removeSpecialCharacters: false,
    options: { timeout: 5000 },
  });
}

export interface ComandaPayload {
  numeroOrden: number;
  hora: string;
  canal: string;
  items: Array<{
    cantidad: string;
    nombre: string;
    modificadores: string[];
    observacion?: string;
    parteDeCombo?: string;
  }>;
  pcOrigen: string;
  esCancelada?: boolean;
  esReimpresion?: boolean;
  /**
   * Datos del cliente cuando la venta es delivery. Si están presentes, la comanda
   * los imprime debajo del listado de items para que la cocinera/encargada vea a
   * dónde va el pedido al despacharlo.
   */
  delivery?: {
    clienteNombre?: string;
    clienteTelefono?: string;
    direccion?: string;
    indicaciones?: string;
    horaPrometida?: string;
    /** Quién entrega el pedido: "Damián", "DELIVERATE", "PEDIDOS YA", etc. */
    repartidor?: string;
  };
}

/**
 * Renderiza una comanda (mostrador / delivery / cocina).
 * El destino se pasa como argumento porque la misma comanda puede ir a
 * múltiples impresoras según las reglas de routing (ver `determinarDestinos`
 * en apps/api/src/services/impresion.ts).
 *
 * Compatible con EPSON TM-T20II (80mm, 42 chars).
 */
export async function imprimirComanda(
  payload: ComandaPayload,
  destino: DestinoImpresora = 'COCINA',
): Promise<void> {
  const printer = makePrinter(destino);

  printer.alignCenter();
  printer.setTextDoubleHeight();
  printer.setTextSize(1, 1);
  printer.println('SANTA TERESITA PASTAS');
  printer.setTextNormal();
  printer.drawLine();
  printer.newLine();

  if (payload.esCancelada) {
    printer.invert(true);
    printer.bold(true);
    printer.println('  *** CANCELADA ***  ');
    printer.bold(false);
    printer.invert(false);
    printer.newLine();
  }

  // Header con el número de orden grande. Antes mostraba "COMANDA" como
  // título y debajo el número; ahora dejamos solo el número en doble tamaño
  // para que la cocinera/encargada lo vea de un golpe. La etiqueta de
  // reimpresión sí queda (chica) por encima cuando aplica.
  if (payload.esReimpresion) {
    printer.bold(true);
    printer.println('*** REIMPRESIÓN ***');
    printer.bold(false);
  }
  printer.setTextSize(3, 3);
  printer.bold(true);
  printer.println(`# ${String(payload.numeroOrden).padStart(3, '0')}`);
  printer.bold(false);
  printer.setTextNormal();
  printer.newLine();

  printer.alignLeft();
  printer.println(`Hora pedido: ${payload.hora}`);
  printer.println(`Canal:       ${payload.canal}`);
  printer.drawLine();
  printer.newLine();

  for (const item of payload.items) {
    printer.setTextDoubleHeight();
    printer.bold(true);
    printer.println(`## ${item.cantidad}  ${item.nombre}`);
    printer.bold(false);
    printer.setTextNormal();
    for (const m of item.modificadores) {
      printer.println(`           > ${m}`);
    }
    if (item.observacion) {
      // Observación GRANDE en la comanda — la cocinera tiene que verla a metros.
      printer.newLine();
      printer.bold(true);
      printer.invert(true);
      printer.setTextDoubleHeight();
      printer.setTextSize(2, 2);
      printer.println(`>> ${item.observacion.toUpperCase()}`);
      printer.setTextNormal();
      printer.invert(false);
      printer.bold(false);
    }
    if (item.parteDeCombo) {
      printer.println(`           > [COMBO: ${item.parteDeCombo}]`);
    }
    printer.newLine();
  }

  // Datos del cliente para delivery — los imprimimos GRANDES al final para que
  // se vean al despachar el pedido. La cocinera puede usarlos para coordinar.
  if (payload.delivery) {
    const d = payload.delivery;
    printer.drawLine();
    printer.bold(true);
    printer.invert(true);
    printer.println(' DELIVERY ');
    printer.invert(false);
    printer.bold(false);
    printer.newLine();
    if (d.clienteNombre) {
      printer.bold(true);
      printer.println(`Cliente:  ${d.clienteNombre}`);
      printer.bold(false);
    }
    if (d.clienteTelefono) {
      printer.println(`Tel:      ${d.clienteTelefono}`);
    }
    if (d.direccion) {
      printer.bold(true);
      printer.setTextDoubleHeight();
      printer.println(d.direccion);
      printer.setTextNormal();
      printer.bold(false);
    }
    if (d.indicaciones) {
      printer.println(`Ref: ${d.indicaciones}`);
    }
    if (d.horaPrometida) {
      printer.println(`Hora prometida: ${d.horaPrometida}`);
    }
    if (d.repartidor) {
      printer.bold(true);
      printer.println(`Repartidor: ${d.repartidor}`);
      printer.bold(false);
    }
    printer.newLine();
  }

  printer.drawLine();
  printer.alignLeft();
  printer.println(`${payload.pcOrigen}  ·  ${payload.hora}`);
  printer.newLine();
  printer.cut();

  await printer.execute();
}

export interface TicketClientePayload {
  numeroVenta: number;
  numeroOrden: number;
  cliente: string;
  vendedor: string;
  pcOrigen: string;
  /** Items con valores numéricos como string sin formatear (ej: "1234.56"). */
  items: Array<{ cantidad: string; nombre: string; precio: string; subtotal: string }>;
  subtotal: string;
  descuento?: { pct: number; monto: string } | null;
  total: string;
  pago: { metodo: string; recibido?: string; cambio?: string };
  /** Quién va a entregar el pedido (si es delivery). "Damián", "DELIVERATE",
   *  "PEDIDOS YA", etc. Sale en la misma sección que el método de pago. */
  repartidor?: string;
  /** ISO date string. El renderer lo formatea como DD/MM/YYYY HH:MM:SS en TZ AR. */
  fecha: string;
}

// ── Helpers de formato ────────────────────────────────────────────────

/** "1234.56" → "1.234,56" (formato argentino). Acepta number o string. */
function formatARS(v: string | number): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!isFinite(n)) return String(v);
  return n.toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** ISO o Date → "DD/MM/YYYY HH:MM:SS" en TZ Argentina. */
function formatFechaAR(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (isNaN(d.getTime())) return String(input);
  return d
    .toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    .replace(',', '');
}

/**
 * Línea tabular de 4 columnas para tickets de 42 chars de ancho.
 * Layout: Cant(5) ' ' Desc(15) ' ' Unitario(9) ' ' Monto(10) = 42.
 * Si la descripción excede los 15 chars la truncamos con '…'.
 */
function rowTabular(
  cant: string,
  desc: string,
  unitario: string,
  monto: string,
  width = 42,
): string[] {
  const CANT_W = 5;
  const UNIT_W = 9;
  const MONTO_W = 10;
  const DESC_W = width - CANT_W - UNIT_W - MONTO_W - 3;
  const cantStr = cant.length > CANT_W ? cant.slice(0, CANT_W) : cant.padEnd(CANT_W);
  const unitStr = unitario.padStart(UNIT_W).slice(-UNIT_W);
  const montoStr = monto.padStart(MONTO_W).slice(-MONTO_W);
  // Si nombre es largo, partimos a 2 líneas: la primera con cant/unit/monto,
  // la segunda solo el resto del nombre indentado.
  if (desc.length <= DESC_W) {
    return [`${cantStr} ${desc.padEnd(DESC_W)} ${unitStr} ${montoStr}`];
  }
  const head = desc.slice(0, DESC_W);
  const tail = desc.slice(DESC_W).slice(0, DESC_W); // máximo 2 líneas
  return [
    `${cantStr} ${head} ${unitStr} ${montoStr}`,
    `${' '.repeat(CANT_W)} ${tail.padEnd(DESC_W)}${' '.repeat(UNIT_W + MONTO_W + 2)}`,
  ];
}

export async function imprimirTicketCliente(payload: TicketClientePayload): Promise<void> {
  const printer = makePrinter('MOSTRADOR');

  // ── Header ──
  printer.alignCenter();
  printer.bold(true);
  printer.println('Santa Teresita Pastas');
  printer.bold(false);
  printer.println('Av. 44 e. 12 y Plaza Paso');
  printer.drawLine();

  // ── Datos venta ──
  printer.alignLeft();
  printer.println(`Venta: ${payload.numeroVenta}`);
  printer.println(`Cliente: ${payload.cliente}`);
  printer.println(`Vendedor: ${payload.vendedor}`);
  printer.drawLine();

  // ── Tabla de items ──
  printer.println(rowTabular('Cant.', 'Descripción', 'Unitario', 'Monto')[0]!);
  printer.newLine();
  for (const it of payload.items) {
    const lineas = rowTabular(
      it.cantidad,
      it.nombre,
      formatARS(it.precio),
      formatARS(it.subtotal),
    );
    for (const linea of lineas) printer.println(linea);
  }
  printer.drawLine();

  // ── Totales ──
  printer.alignRight();
  printer.println(`Subtotal: $${formatARS(payload.subtotal)}`);
  if (payload.descuento) {
    printer.println(
      `-> Descuento ${payload.descuento.pct}% (-${payload.descuento.pct},00 %)`,
    );
  }
  printer.bold(true);
  printer.setTextDoubleHeight();
  printer.println(`TOTAL: $${formatARS(payload.total)}`);
  printer.setTextNormal();
  printer.bold(false);
  printer.newLine();

  // ── Método de pago + repartidor (delivery) ──
  // Repartidor sale en la misma sección que la forma de pago para que la
  // encargada los vea juntos al despachar el pedido.
  printer.alignLeft();
  printer.println(`Forma de pago: ${payload.pago.metodo}`);
  if (payload.pago.recibido) {
    printer.println(`Recibí: $${formatARS(payload.pago.recibido)}`);
  }
  if (payload.pago.cambio && Number(payload.pago.cambio) > 0) {
    printer.println(`Cambio: $${formatARS(payload.pago.cambio)}`);
  }
  if (payload.repartidor) {
    printer.bold(true);
    printer.println(`Repartidor: ${payload.repartidor}`);
    printer.bold(false);
  }
  printer.newLine();

  // ── Pie ──
  printer.alignCenter();
  printer.drawLine();
  printer.println('Ticket no fiscal');
  printer.println(`Fecha y hora: ${formatFechaAR(payload.fecha)}`);
  printer.drawLine();
  printer.cut();

  await printer.execute();
}

// ─── Ticket de delivery ───────────────────────────────────────────────
//
// Se imprime en la comandera DELIVERY al pasar la venta a PROCESADA cuando
// modalidad es DELIVERY_PROPIO (ventas TELEFONO/WHATSAPP/WEB). Lleva todos
// los datos que el motoquero necesita para entregar y cobrar:
//   - Header del comercio + número de delivery
//   - Cliente: nombre, teléfono, dirección, indicaciones
//   - Items en columnas (Cant | Descripción | Precio | Total)
//   - Total + costo de envío si aplica
//   - Hora prometida de entrega
//   - Forma de pago (importante: si es A_COBRAR el motoquero sabe cuánto cobrar)
//   - Fecha y hora de impresión + usuario emisor

export interface TicketDeliveryPayload {
  numeroVenta: number;
  numeroOrden: number;
  canal: string;
  idExterno?: string;

  empleadoNombre?: string;
  empresaExterna?: string;

  cliente: {
    nombre: string;
    telefono?: string;
    direccion: string;
    indicaciones?: string;
  };
  /** ISO o null. Si está, sale como "Entrega: HH:MM hs.". */
  horaPrometida?: string | null;
  items: Array<{
    cantidad: string;
    nombre: string;
    precioUnitario: string;
    subtotal: string;
  }>;
  /** Costo de envío. Si > 0, sale como una línea ENVIO al final de los items. */
  envio?: string | null;
  total: string;
  pago: {
    metodo: string;
    /** PAGADO = ya pagó (online/anticipado). A_COBRAR = el motoquero cobra al entregar. */
    estado: 'PAGADO' | 'A_COBRAR';
    montoACobrar?: string;
  };
  cajero: string;
  pcOrigen: string;
  /** ISO date string. */
  fecha: string;
}

export async function imprimirTicketDelivery(payload: TicketDeliveryPayload): Promise<void> {
  const printer = makePrinter('DELIVERY');

  // ── Header ──
  printer.alignCenter();
  printer.bold(true);
  printer.println('Santa Teresita Pastas');
  printer.bold(false);
  printer.println('Av. 44 e. 12 y Plaza Paso');
  printer.println('La Plata, Bs. As.');
  printer.newLine();

  printer.bold(true);
  printer.setTextDoubleHeight();
  printer.println(`Delivery: ${payload.numeroVenta}`);
  printer.setTextNormal();
  printer.bold(false);
  printer.drawLine();

  // ── Datos cliente ──
  printer.alignLeft();
  printer.bold(true);
  printer.println(`Cliente: ${payload.cliente.nombre}`);
  printer.bold(false);
  if (payload.cliente.telefono) {
    printer.println(`Teléfono: ${payload.cliente.telefono}`);
  }
  printer.println(`Dirección: ${payload.cliente.direccion}`);
  if (payload.cliente.indicaciones) {
    printer.println(`Indicaciones: ${payload.cliente.indicaciones}`);
  }
  if (payload.empleadoNombre) {
    printer.println(`Repartidor: ${payload.empleadoNombre}`);
  } else if (payload.empresaExterna) {
    printer.println(`Repartidor: ${payload.empresaExterna}`);
  }
  printer.drawLine();

  // ── Tabla de items (mismo helper que ticket cliente) ──
  printer.println(rowTabular('Cant.', 'Descripción', 'Precio', 'Total')[0]!);
  printer.newLine();
  for (const it of payload.items) {
    const lineas = rowTabular(
      it.cantidad,
      it.nombre,
      formatARS(it.precioUnitario),
      formatARS(it.subtotal),
    );
    for (const linea of lineas) printer.println(linea);
  }
  if (payload.envio && Number(payload.envio) > 0) {
    const envioLineas = rowTabular(
      '1',
      'ENVIO',
      formatARS(payload.envio),
      formatARS(payload.envio),
    );
    for (const linea of envioLineas) printer.println(linea);
  }
  printer.drawLine();

  // ── Total ──
  printer.alignRight();
  printer.bold(true);
  printer.setTextDoubleHeight();
  printer.println(`TOTAL: $${formatARS(payload.total)}`);
  printer.setTextNormal();
  printer.bold(false);
  printer.newLine();

  // ── Pago ──
  printer.alignLeft();
  printer.bold(true);
  if (payload.pago.estado === 'A_COBRAR') {
    printer.println(`A COBRAR: ${payload.pago.metodo}`);
    if (payload.pago.montoACobrar) {
      printer.println(`Monto a cobrar: $${formatARS(payload.pago.montoACobrar)}`);
    }
  } else {
    printer.println(`PAGADO: ${payload.pago.metodo}`);
  }
  printer.bold(false);
  printer.newLine();

  // ── Hora de entrega ──
  if (payload.horaPrometida) {
    const d = new Date(payload.horaPrometida);
    if (!isNaN(d.getTime())) {
      const hhmm = d.toLocaleTimeString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      printer.alignCenter();
      printer.bold(true);
      printer.println(`Entrega: ${hhmm} hs.`);
      printer.bold(false);
    }
  }

  // ── Pie ──
  printer.drawLine();
  printer.alignLeft();
  printer.println(`Impresión: ${formatFechaAR(payload.fecha)}`);
  printer.println(`Usuario: ${payload.cajero}`);
  printer.cut();

  await printer.execute();
}

/**
 * Test de impresora — útil para troubleshooting.
 */
export async function testPrinter(destino: PrinterConfig['destino']): Promise<boolean> {
  const printer = makePrinter(destino);
  const isConnected = await printer.isPrinterConnected();
  if (!isConnected) return false;
  printer.alignCenter();
  printer.println('=== TEST OK ===');
  printer.println(new Date().toLocaleString('es-AR'));
  printer.println(`Destino: ${destino}`);
  printer.cut();
  await printer.execute();
  return true;
}
