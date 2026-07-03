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

/**
 * Sanitiza texto del usuario/cliente antes de mandarlo a la comandera.
 * ESC/POS es binario: los bytes de control (< 0x20, 0x7F) son COMANDOS, no
 * texto. Un pedido cuyo nombre/dirección/indicaciones traiga esos bytes (un
 * cliente o un webhook de RAPPI/PYA puede inyectarlos) podría cortar el ticket,
 * resetear la impresora o abrir la gaveta. Los reemplazamos por espacio.
 * Seguridad: ESC/POS command injection.
 */
function limpiar(s: unknown): string {
  // Reemplaza bytes de control 0x00-0x1F y 0x7F (comandos ESC/POS) por espacio.
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
}

const ASCII_MAP: Record<string, string> = {
  '¿': '?', '¡': '!', '€': 'EUR', '°': 'o', º: 'o', ª: 'a',
  '–': '-', '—': '-', '«': '"', '»': '"', '…': '...',
  '‘': "'", '’': "'", '“': '"', '”': '"',
};

/**
 * Transcribe texto a ASCII puro (< 0x80). Necesario para comanderas cuya página
 * de códigos activa NO es la latina (PC850) sino una multibyte tipo CJK: ahí
 * cada byte alto (acento á/é/í/ó/ú/ñ) se interpreta como el PRIMER byte de un
 * glifo de 2 bytes → imprime un símbolo raro (ej. "徢") Y se COME el carácter
 * siguiente (por eso "Teléfono" salía "Tel徢ono", sin la 'f'). Mandando solo
 * ASCII ningún byte dispara ese modo. Fold: é→e, ñ→n, ó→o, ¿→?, «»→", …→...
 */
function ascii(s: unknown): string {
  return limpiar(s)
    .normalize('NFKD') // é → e + ´ (marca combinada) ; ñ → n + ~
    .replace(/[̀-ͯ]/g, '') // borra las marcas diacríticas combinadas
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, (c) => ASCII_MAP[c] ?? ''); // resto no-ASCII → mapa o se descarta
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
  /**
   * ID global de la venta (lo que aparece en /admin/ventas en el programa).
   * Distinto del `numeroOrden` que es el correlativo del turno (sirve para
   * contar pedidos del día). Se imprime chiquito al pie para que la encargada
   * pueda buscar el pedido en el programa cuando le acercan el ticket.
   */
  numeroVenta?: number;
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
    printer.println(`## ${item.cantidad}  ${limpiar(item.nombre)}`);
    printer.bold(false);
    printer.setTextNormal();
    for (const m of item.modificadores) {
      printer.println(`           > ${limpiar(m)}`);
    }
    if (item.observacion) {
      // Observación GRANDE en la comanda — la cocinera tiene que verla a metros.
      printer.newLine();
      printer.bold(true);
      printer.invert(true);
      printer.setTextDoubleHeight();
      printer.setTextSize(2, 2);
      printer.println(`>> ${limpiar(item.observacion).toUpperCase()}`);
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
      printer.println(`Cliente:  ${limpiar(d.clienteNombre)}`);
      printer.bold(false);
    }
    if (d.clienteTelefono) {
      printer.println(`Tel:      ${limpiar(d.clienteTelefono)}`);
    }
    if (d.direccion) {
      printer.bold(true);
      printer.setTextDoubleHeight();
      printer.println(limpiar(d.direccion));
      printer.setTextNormal();
      printer.bold(false);
    }
    if (d.indicaciones) {
      printer.println(`Ref: ${limpiar(d.indicaciones)}`);
    }
    if (d.horaPrometida) {
      printer.println(`Hora prometida: ${d.horaPrometida}`);
    }
    if (d.repartidor) {
      printer.bold(true);
      printer.println(`Repartidor: ${limpiar(d.repartidor)}`);
      printer.bold(false);
    }
    printer.newLine();
  }

  printer.drawLine();
  printer.alignLeft();
  printer.println(`${payload.pcOrigen}  ·  ${payload.hora}`);
  if (payload.numeroVenta != null) {
    printer.alignCenter();
    printer.println(`Venta #${payload.numeroVenta} en el programa`);
    printer.alignLeft();
  }
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
  items: Array<{
    cantidad: string;
    nombre: string;
    /** Sabor/tipo elegido (ej. "Carne", "Salsa Príncipe"). Sale debajo del nombre. */
    modificadores?: string[];
    observacion?: string;
    precio: string;
    subtotal: string;
  }>;
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
  printer.println(`Cliente: ${limpiar(payload.cliente)}`);
  printer.println(`Vendedor: ${limpiar(payload.vendedor)}`);
  printer.drawLine();

  // ── Tabla de items ──
  printer.println(rowTabular('Cant.', 'Descripción', 'Unitario', 'Monto')[0]!);
  printer.newLine();
  for (const it of payload.items) {
    const lineas = rowTabular(
      it.cantidad,
      limpiar(it.nombre),
      formatARS(it.precio),
      formatARS(it.subtotal),
    );
    for (const linea of lineas) printer.println(linea);
    // Sabor/tipo elegido — debajo del item, indentado ("  > Carne").
    for (const m of it.modificadores ?? []) {
      printer.println(`      > ${limpiar(m)}`);
    }
    if (it.observacion) {
      printer.println(`      * ${limpiar(it.observacion)}`);
    }
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
    printer.println(`Repartidor: ${limpiar(payload.repartidor)}`);
    printer.bold(false);
  }
  printer.newLine();

  // ── Pie ──
  printer.alignCenter();
  printer.drawLine();
  printer.println('Ticket no fiscal');
  printer.println(`Fecha y hora: ${formatFechaAR(payload.fecha)}`);
  printer.println(`Venta #${payload.numeroVenta} en el programa`);
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
    /** Sabor/tipo elegido (ej. "Carne", "Salsa Príncipe"). Sale debajo del nombre. */
    modificadores?: string[];
    observacion?: string;
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
  // La comandera de DELIVERY es de OTRO modelo: su página de códigos por defecto
  // es multibyte (tipo CJK), así que los acentos (é/í/ó/ñ) salían como símbolos
  // raros y se COMÍAN la letra siguiente ("Teléfono" → "Tel徢ono"). Mandamos TODO
  // el texto como ASCII puro vía `ascii()` — ningún byte alto dispara ese modo.
  // `PL` = println que siempre foldea a ASCII. `width` = ancho configurado de
  // ESTA comandera (por si es más angosta que 42) para que las columnas no se
  // desborden (antes rowTabular usaba 42 fijo y el precio se partía en 2 líneas).
  const width = getPrinterConfig('DELIVERY').width;
  const PL = (s: string) => printer.println(ascii(s));

  // ── Header ──
  printer.alignCenter();
  printer.bold(true);
  PL('Santa Teresita Pastas');
  printer.bold(false);
  PL('Av. 44 e. 12 y Plaza Paso');
  PL('La Plata, Bs. As.');
  printer.newLine();

  printer.bold(true);
  PL('DELIVERY');
  // Número de COMANDA grande (correlativo del turno) — el mismo "# 102" que sale
  // en la comanda de cocina y en la columna "Comanda" de /admin/ventas.
  printer.setTextSize(3, 3);
  PL(`# ${String(payload.numeroOrden).padStart(3, '0')}`);
  printer.setTextNormal();
  printer.bold(false);
  PL(`Venta ${payload.numeroVenta} en el programa`);
  printer.drawLine();

  // ── Datos cliente ──
  printer.alignLeft();
  printer.bold(true);
  PL(`Cliente: ${payload.cliente.nombre}`);
  printer.bold(false);
  if (payload.cliente.telefono) {
    PL(`Telefono: ${payload.cliente.telefono}`);
  }
  PL(`Direccion: ${payload.cliente.direccion}`);
  if (payload.cliente.indicaciones) {
    PL(`Indicaciones: ${payload.cliente.indicaciones}`);
  }
  if (payload.empleadoNombre) {
    PL(`Repartidor: ${payload.empleadoNombre}`);
  } else if (payload.empresaExterna) {
    PL(`Repartidor: ${payload.empresaExterna}`);
  }
  printer.drawLine();

  // ── Tabla de items (mismo helper que ticket cliente, con el ancho real) ──
  PL(rowTabular('Cant.', 'Descripcion', 'Precio', 'Total', width)[0]!);
  printer.newLine();
  for (const it of payload.items) {
    const lineas = rowTabular(
      it.cantidad,
      ascii(it.nombre),
      formatARS(it.precioUnitario),
      formatARS(it.subtotal),
      width,
    );
    for (const linea of lineas) PL(linea);
    // Sabor/tipo elegido — debajo del item, indentado ("  > Carne").
    for (const m of it.modificadores ?? []) {
      PL(`      > ${m}`);
    }
    if (it.observacion) {
      PL(`      * ${it.observacion}`);
    }
  }
  if (payload.envio && Number(payload.envio) > 0) {
    const envioLineas = rowTabular(
      '1',
      'ENVIO',
      formatARS(payload.envio),
      formatARS(payload.envio),
      width,
    );
    for (const linea of envioLineas) PL(linea);
  }
  printer.drawLine();

  // ── Total ──
  printer.alignRight();
  printer.bold(true);
  printer.setTextDoubleHeight();
  PL(`TOTAL: $${formatARS(payload.total)}`);
  printer.setTextNormal();
  printer.bold(false);
  printer.newLine();

  // ── Pago ──
  printer.alignLeft();
  printer.bold(true);
  if (payload.pago.estado === 'A_COBRAR') {
    PL(`A COBRAR: ${payload.pago.metodo}`);
    if (payload.pago.montoACobrar) {
      PL(`Monto a cobrar: $${formatARS(payload.pago.montoACobrar)}`);
    }
  } else {
    PL(`PAGADO: ${payload.pago.metodo}`);
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
      PL(`Entrega: ${hhmm} hs.`);
      printer.bold(false);
    }
  }

  // ── Pie ──
  printer.drawLine();
  printer.alignLeft();
  PL(`Impresion: ${formatFechaAR(payload.fecha)}`);
  PL(`Usuario: ${payload.cajero}`);
  printer.alignCenter();
  PL(`Venta #${payload.numeroVenta} en el programa`);
  printer.cut();

  await printer.execute();
}

// ─── Comanda de ENCARGO (pedido para un día futuro) ───────────────────
//
// Se imprime SIEMPRE en la comandera de MOSTRADOR (decisión del dueño): es el
// registro físico del encargo para la encargada. Lleva dos rótulos grandes con
// fondo oscuro y letras blancas: "ENCARGO" arriba y "A PAGAR"/"COBRADO" abajo.

export interface ComandaEncargoPayload {
  numeroOrden: number;
  numeroVenta?: number;
  hora: string;
  estado: 'A_PAGAR' | 'COBRADO' | 'PAGO_PARCIAL';
  tipoEntrega: 'RETIRO' | 'ENVIO';
  /** Día de entrega, formato "YYYY-MM-DD". */
  fechaEntrega: string | null;
  /** Hora exacta "HH:MM" (si no hay franja). */
  horaEntrega?: string;
  /** Franja MANANA/TARDE/NOCHE (si no hay hora exacta). */
  franja?: 'MANANA' | 'TARDE' | 'NOCHE';
  cliente: { nombre: string; telefono?: string; direccion?: string; indicaciones?: string };
  items: Array<{
    cantidad: string;
    nombre: string;
    modificadores: string[];
    observacion?: string;
    /** ¿Este item pertenece a una parte ya cobrada? (PAGO PARCIAL). */
    pagado?: boolean;
    /** Nº de adición ("modificación adicional") a la que pertenece, si aplica. */
    adicion?: number;
  }>;
  total: string;
  /** Suma de las partes ya cobradas (PAGO PARCIAL). */
  totalPagado?: string;
  /** Lo que falta cobrar (PAGO PARCIAL). */
  totalPendiente?: string;
  /** Observaciones a nivel encargo (campo de la carga). */
  observaciones?: string;
  pcOrigen: string;
}

const FRANJA_LABEL: Record<string, string> = {
  MANANA: 'Mañana',
  TARDE: 'Tarde',
  NOCHE: 'Noche',
};

/** "YYYY-MM-DD" → "DD/MM/YYYY" (sin parsear a Date — evita corrimientos de TZ). */
function formatFechaDia(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

export async function imprimirComandaEncargo(
  payload: ComandaEncargoPayload,
  destino: DestinoImpresora = 'MOSTRADOR',
): Promise<void> {
  const printer = makePrinter(destino);

  // ── Header ──
  printer.alignCenter();
  printer.setTextDoubleHeight();
  printer.setTextSize(1, 1);
  printer.println('SANTA TERESITA PASTAS');
  printer.setTextNormal();
  printer.drawLine();
  printer.newLine();

  // ── Rótulo grande ENCARGO (fondo oscuro, letras blancas) ──
  printer.bold(true);
  printer.invert(true);
  printer.setTextSize(2, 2);
  printer.println('  ENCARGO  ');
  printer.setTextNormal();
  printer.invert(false);
  printer.bold(false);
  printer.newLine();

  // ── Número de comanda grande ──
  printer.setTextSize(3, 3);
  printer.bold(true);
  printer.println(`# ${String(payload.numeroOrden).padStart(3, '0')}`);
  printer.bold(false);
  printer.setTextNormal();
  printer.newLine();

  // ── Día y hora de entrega (grande, lo más importante del encargo) ──
  printer.alignLeft();
  printer.bold(true);
  printer.setTextDoubleHeight();
  printer.println(`Entrega: ${formatFechaDia(payload.fechaEntrega)}`);
  const cuando = payload.horaEntrega
    ? `${payload.horaEntrega} hs.`
    : payload.franja
      ? FRANJA_LABEL[payload.franja] ?? payload.franja
      : '';
  if (cuando) printer.println(`Horario: ${cuando}`);
  printer.setTextNormal();
  printer.bold(false);
  printer.println(`Modo:    ${payload.tipoEntrega === 'ENVIO' ? 'ENVÍO a domicilio' : 'RETIRA en local'}`);
  printer.println(`Pedido:  ${payload.hora}`);
  printer.drawLine();
  printer.newLine();

  // ── Items ──
  // En PAGO PARCIAL los agrupamos: primero lo ya PAGADO, después lo A PAGAR,
  // cada bloque con su encabezado — la encargada ve de un vistazo qué cobrar.
  const esParcial = payload.estado === 'PAGO_PARCIAL';
  const imprimirItem = (item: (typeof payload.items)[number]) => {
    printer.setTextDoubleHeight();
    printer.bold(true);
    const tagAdicion = item.adicion ? ` [ADIC.${item.adicion}]` : '';
    printer.println(`## ${item.cantidad}  ${limpiar(item.nombre)}${tagAdicion}`);
    printer.bold(false);
    printer.setTextNormal();
    for (const m of item.modificadores) {
      printer.println(`           > ${limpiar(m)}`);
    }
    if (item.observacion) {
      printer.newLine();
      printer.bold(true);
      printer.invert(true);
      printer.setTextDoubleHeight();
      printer.setTextSize(2, 2);
      printer.println(`>> ${limpiar(item.observacion).toUpperCase()}`);
      printer.setTextNormal();
      printer.invert(false);
      printer.bold(false);
    }
    printer.newLine();
  };
  if (esParcial) {
    const pagados = payload.items.filter((i) => i.pagado);
    const pendientes = payload.items.filter((i) => !i.pagado);
    if (pagados.length > 0) {
      printer.bold(true);
      printer.println('--- YA PAGADO ---');
      printer.bold(false);
      for (const item of pagados) imprimirItem(item);
      if (payload.totalPagado) printer.println(`     Pagado: $${formatARS(payload.totalPagado)}`);
      printer.newLine();
    }
    if (pendientes.length > 0) {
      printer.bold(true);
      printer.println('--- A PAGAR ---');
      printer.bold(false);
      for (const item of pendientes) imprimirItem(item);
      if (payload.totalPendiente) {
        printer.bold(true);
        printer.println(`     Falta pagar: $${formatARS(payload.totalPendiente)}`);
        printer.bold(false);
      }
      printer.newLine();
    }
  } else {
    for (const item of payload.items) imprimirItem(item);
  }

  // ── Observaciones del encargo (campo de la carga — grande, no puede pasarse) ──
  if (payload.observaciones) {
    printer.bold(true);
    printer.invert(true);
    printer.setTextDoubleHeight();
    printer.println(` OBS: ${limpiar(payload.observaciones).toUpperCase()} `);
    printer.setTextNormal();
    printer.invert(false);
    printer.bold(false);
    printer.newLine();
  }

  // ── Datos del cliente ──
  printer.drawLine();
  printer.bold(true);
  printer.println(`Cliente: ${limpiar(payload.cliente.nombre)}`);
  printer.bold(false);
  if (payload.cliente.telefono) {
    printer.println(`Tel:     ${limpiar(payload.cliente.telefono)}`);
  }
  if (payload.tipoEntrega === 'ENVIO' && payload.cliente.direccion) {
    printer.bold(true);
    printer.setTextDoubleHeight();
    printer.println(limpiar(payload.cliente.direccion));
    printer.setTextNormal();
    printer.bold(false);
  }
  if (payload.cliente.indicaciones) {
    printer.println(`Ref: ${limpiar(payload.cliente.indicaciones)}`);
  }
  printer.newLine();

  // ── Total ──
  printer.alignRight();
  printer.bold(true);
  printer.setTextDoubleHeight();
  printer.println(`TOTAL: $${formatARS(payload.total)}`);
  printer.setTextNormal();
  printer.bold(false);
  printer.newLine();

  // ── Rótulo de estado de cobro (fondo oscuro, letras blancas) ──
  printer.alignCenter();
  printer.bold(true);
  printer.invert(true);
  printer.setTextSize(2, 2);
  printer.println(
    payload.estado === 'COBRADO'
      ? '  COBRADO  '
      : payload.estado === 'PAGO_PARCIAL'
        ? ' PAGO PARCIAL '
        : '  A PAGAR  ',
  );
  printer.setTextNormal();
  printer.invert(false);
  printer.bold(false);
  printer.newLine();

  // ── Pie ──
  printer.drawLine();
  printer.alignLeft();
  printer.println(`${payload.pcOrigen}  ·  ${payload.hora}`);
  if (payload.numeroVenta != null) {
    printer.alignCenter();
    printer.println(`Encargo #${payload.numeroVenta} en el programa`);
    printer.alignLeft();
  }
  printer.newLine();
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
