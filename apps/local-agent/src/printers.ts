/**
 * Drivers de impresoras del local — EPSON TM-T20II (térmica) + Lexmark E460 (láser).
 *
 * La térmica habla ESC/POS sobre TCP:9100 — usamos `node-thermal-printer`.
 * La láser usa CUPS / driver del SO — emulamos con Puppeteer (HTML→PDF→imprimir),
 * pero por ahora dejamos un stub.
 */

import { ThermalPrinter, PrinterTypes } from 'node-thermal-printer';

export interface PrinterConfig {
  destino: 'KITCHEN' | 'COUNTER' | 'DELIVERY';
  host: string;
  port: number;
  width?: number; // chars
}

const DEFAULTS: Record<PrinterConfig['destino'], { host: string; port: number; width: number }> = {
  KITCHEN: {
    host: process.env.AGENT_PRINTER_KITCHEN_HOST ?? '192.168.1.50',
    port: Number(process.env.AGENT_PRINTER_KITCHEN_PORT ?? 9100),
    width: 42,
  },
  COUNTER: {
    host: process.env.AGENT_PRINTER_COUNTER_HOST ?? '192.168.1.51',
    port: Number(process.env.AGENT_PRINTER_COUNTER_PORT ?? 9100),
    width: 42,
  },
  DELIVERY: {
    host: process.env.AGENT_PRINTER_DELIVERY_HOST ?? '192.168.1.52',
    port: Number(process.env.AGENT_PRINTER_DELIVERY_PORT ?? 9100),
    width: 42,
  },
};

export function makePrinter(destino: PrinterConfig['destino']): ThermalPrinter {
  const cfg = DEFAULTS[destino];
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${cfg.host}:${cfg.port}`,
    characterSet: 'PC850_MULTILINGUAL',
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
  };
}

/**
 * Renderiza una comanda de cocina (Wireframe 10 — Ticket 1).
 * Compatible con EPSON TM-T20II (80mm, 42 chars).
 */
export async function imprimirComanda(payload: ComandaPayload): Promise<void> {
  const printer = makePrinter('KITCHEN');

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

  printer.setTextSize(2, 2);
  printer.println(payload.esReimpresion ? '*** REIMPRESIÓN ***' : 'COMANDA');
  printer.println(`# ${String(payload.numeroOrden).padStart(3, '0')}`);
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
  items: Array<{ cantidad: string; nombre: string; precio: string; subtotal: string }>;
  subtotal: string;
  descuento?: { pct: number; monto: string } | null;
  total: string;
  pago: { metodo: string; recibido?: string; cambio?: string };
  fecha: string;
}

export async function imprimirTicketCliente(payload: TicketClientePayload): Promise<void> {
  const printer = makePrinter('COUNTER');

  printer.alignCenter();
  printer.bold(true);
  printer.println('SANTA TERESITA PASTAS');
  printer.bold(false);
  printer.println('Av. 44 e. 12 y Plaza Paso');
  printer.println('La Plata, Bs. As.');
  printer.drawLine();

  printer.alignLeft();
  printer.println(`Venta:    ${payload.numeroVenta}`);
  printer.println(`Orden:    # ${String(payload.numeroOrden).padStart(3, '0')}`);
  printer.println(`Cliente:  ${payload.cliente}`);
  printer.println(`Vendedor: ${payload.vendedor} (${payload.pcOrigen})`);
  printer.drawLine();

  for (const it of payload.items) {
    printer.println(`${it.cantidad.padEnd(8)} ${it.nombre}`);
    printer.alignRight();
    printer.println(`${it.precio} = ${it.subtotal}`);
    printer.alignLeft();
  }
  printer.drawLine();

  printer.alignRight();
  printer.println(`Subtotal: $ ${payload.subtotal}`);
  if (payload.descuento) {
    printer.println(`Descuento ${payload.descuento.pct}%: -$ ${payload.descuento.monto}`);
  }
  printer.bold(true);
  printer.setTextDoubleHeight();
  printer.println(`TOTAL: $ ${payload.total}`);
  printer.setTextNormal();
  printer.bold(false);
  printer.newLine();

  printer.alignLeft();
  printer.println(`Pago:    ${payload.pago.metodo}`);
  if (payload.pago.recibido) printer.println(`Recibí:  $ ${payload.pago.recibido}`);
  if (payload.pago.cambio) printer.println(`Cambio:  $ ${payload.pago.cambio}`);
  printer.newLine();

  printer.alignCenter();
  printer.println('¡Gracias por su compra!');
  printer.drawLine();

  printer.println('Ticket no fiscal');
  printer.println(payload.fecha);
  printer.cut();

  await printer.execute();
}

// ─── Ticket de delivery (Wireframe 10 — Ticket 3) ─────────────────────
//
// Se imprime al pasar venta a PROCESADA cuando modalidad = DELIVERY_*.
// Sale en la láser Lexmark E460 (oficina delivery) en formato compacto.
// Por ahora dejamos solo el tipo de payload documentado — el render concreto
// se implementa cuando se conecte el local-agent con la impresora real.

export interface TicketDeliveryPayload {
  numeroOrden: number;
  numeroDelivery: number;
  canal: string;
  idExterno?: string;

  // Repartidor: viene del campo `delivery_info`. Solo uno de los dos:
  //   - empleadoNombre = "Damián" o nombre del empleado del local
  //   - empresaExterna = "DELIVERATE", "PEDIDOS YA", "RAPPI", "MELI"
  empleadoNombre?: string;
  empresaExterna?: string;

  cliente: {
    nombre: string;
    telefono?: string;
    direccion: string;
    indicaciones?: string;
  };
  horaPrometida?: string;
  items: Array<{
    cantidad: string;
    nombre: string;
    precioUnitario: string;
    subtotal: string;
    componentesCombo?: string[];
  }>;
  total: string;
  pago: {
    metodo: string;
    estado: 'PAGADO' | 'A_COBRAR';
    montoACobrar?: string;
  };
  cajero: string;
  pcOrigen: string;
  fecha: string;
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
