/**
 * Exportador de cierre de caja: arma el Excel + HTML para el email del admin.
 *
 * Estructura del Excel:
 *   - "Resumen"      → totales del turno
 *   - "Ventas"       → cada venta con número, hora, items, métodos, total
 *   - "Pagos"        → desglose por método y cuenta
 *   - "Movimientos"  → ingresos/egresos del turno
 */

import ExcelJS from 'exceljs';
import { prisma } from '@sta/db/client';

interface SesionConTodo {
  id: string;
  fecha: Date;
  turno: 'MANANA' | 'TARDE';
  estado: string;
  horarioApertura: Date;
  horarioCierre: Date | null;
  existenciaInicial: string;
  existenciaFinal: string | null;
  recaudacionEsperada: string | null;
  diferencia: string | null;
  observaciones: string | null;
  usuarioApertura: string;
  usuarioCierre: string | null;
}

interface LineaVenta {
  numero: number;
  numeroOrdenTurno: number;
  hora: Date;
  estado: string;
  canal: string;
  modalidad: string;
  subtotal: string;
  descuento: string;
  total: string;
  items: Array<{ nombre: string; cantidad: string; precioUnitario: string; totalLinea: string }>;
  pagos: Array<{ metodo: string; cuenta: string; monto: string }>;
}

interface LineaPago {
  metodo: string;
  cuenta: string;
  cantidad: number;
  total: number;
}

/**
 * Categorización jerárquica MOSTRADOR / DELIVERY / PLATAFORMAS pedida por el dueño.
 * Es la misma estructura que usa /admin/ventas y el email del cierre.
 */
export interface CategoriaCobros {
  mostrador: {
    efectivo: number; // suma a caja
    debito: number;
    creditoOtros: number; // crédito + MP/QR + transfer + naranja
  };
  delivery: {
    efectivoDamian: number; // suma a caja
    online: number; // débito + transfer en pedidos por tel/wsp/web
    efectivoDeliverate: number; // INFORMATIVO, no suma
  };
  plataformas: {
    app: number; // cobrado por la app (RAPPI/PYA/MELI)
    efectivo: number; // suma a caja (cliente paga al motoquero de la app)
  };
  /** Suma total que entra a caja hoy (mostrador efectivo + Damián + plataformas efectivo). */
  efectivoFromVentas: number;
  /** Total cobrado del día (suma todos los métodos, excluye DELIVERATE informativo). */
  totalDelDia: number;
  /** Subtotales por bloque (para los headers del email/excel). */
  totalMostrador: number;
  totalDelivery: number;
  totalPlataformas: number;
}

export function categorizarCobros(opts: {
  pagos: Array<{ metodo: string; canal: string; modalidad: string; monto: number }>;
}): CategoriaCobros {
  const c: CategoriaCobros = {
    mostrador: { efectivo: 0, debito: 0, creditoOtros: 0 },
    delivery: { efectivoDamian: 0, online: 0, efectivoDeliverate: 0 },
    plataformas: { app: 0, efectivo: 0 },
    efectivoFromVentas: 0,
    totalDelDia: 0,
    totalMostrador: 0,
    totalDelivery: 0,
    totalPlataformas: 0,
  };
  for (const p of opts.pagos) {
    const esEfectivo = p.metodo === 'EFECTIVO';
    const esDebito = p.metodo === 'DEBITO';
    const esMostrador = p.canal === 'MOSTRADOR';
    const esDeliveryLocal =
      p.canal === 'TELEFONO' || p.canal === 'WHATSAPP' || p.canal === 'WEB';
    const esDeliverate = p.canal === 'DELIVERATE';
    const esPlataforma =
      p.canal === 'RAPPI' || p.canal === 'PEDIDOS_YA' || p.canal === 'MERCADO_LIBRE';

    if (esMostrador) {
      if (esEfectivo) c.mostrador.efectivo += p.monto;
      else if (esDebito) c.mostrador.debito += p.monto;
      else c.mostrador.creditoOtros += p.monto;
    } else if (esDeliveryLocal) {
      if (esEfectivo) c.delivery.efectivoDamian += p.monto;
      else c.delivery.online += p.monto;
    } else if (esDeliverate) {
      if (esEfectivo) c.delivery.efectivoDeliverate += p.monto;
      else c.delivery.online += p.monto;
    } else if (esPlataforma) {
      if (esEfectivo) c.plataformas.efectivo += p.monto;
      else c.plataformas.app += p.monto;
    } else {
      // Fallback: lo metemos en mostrador
      if (esEfectivo) c.mostrador.efectivo += p.monto;
      else if (esDebito) c.mostrador.debito += p.monto;
      else c.mostrador.creditoOtros += p.monto;
    }
  }
  c.totalMostrador = c.mostrador.efectivo + c.mostrador.debito + c.mostrador.creditoOtros;
  c.totalDelivery =
    c.delivery.efectivoDamian + c.delivery.online + c.delivery.efectivoDeliverate;
  c.totalPlataformas = c.plataformas.app + c.plataformas.efectivo;
  c.efectivoFromVentas =
    c.mostrador.efectivo + c.delivery.efectivoDamian + c.plataformas.efectivo;
  c.totalDelDia =
    c.totalMostrador +
    (c.totalDelivery - c.delivery.efectivoDeliverate) +
    c.totalPlataformas;
  return c;
}

interface LineaMovimiento {
  hora: Date;
  tipo: string;
  categoria: string;
  cuenta: string;
  monto: string;
  observacion: string | null;
  usuario: string;
}

export interface CierreData {
  sesion: SesionConTodo;
  ventas: LineaVenta[];
  pagosAgregados: LineaPago[];
  movimientos: LineaMovimiento[];
  /** Cobros categorizados como los entiende la encargada (sin discriminar cuentas). */
  categorias: CategoriaCobros;
  resumen: {
    ventasFinalizadas: number;
    ventasAnuladas: number;
    totalCobrado: number;
    totalEfectivo: number;
    totalNoEfectivo: number;
    egresos: number;
    ingresos: number;
    descuentos: number;
  };
}

// ────────────────────────────────────────────────────────────────────────
//   Cargar la data del cierre desde DB
// ────────────────────────────────────────────────────────────────────────

export async function cargarCierre(sesionId: string): Promise<CierreData> {
  const sesion = await prisma.sesionCaja.findUnique({
    where: { id: sesionId },
    include: {
      usuarioApertura: { select: { nombre: true } },
      usuarioCierre: { select: { nombre: true } },
    },
  });
  if (!sesion) throw new Error('Sesión no encontrada');

  const ventasRaw = await prisma.venta.findMany({
    where: { sesionCajaId: sesionId },
    orderBy: { numeroOrdenTurno: 'asc' },
    include: {
      items: {
        select: {
          nombreSnapshot: true,
          cantidad: true,
          precioUnitario: true,
          totalLinea: true,
        },
      },
      pagos: {
        include: { cuenta: { select: { nombre: true } } },
      },
    },
  });

  const movimientosRaw = await prisma.movimiento.findMany({
    where: { sesionCajaId: sesionId },
    orderBy: { fechaComputo: 'asc' },
    include: {
      categoria: { select: { nombre: true } },
      cuentaOrigen: { select: { nombre: true } },
      cuentaDestino: { select: { nombre: true } },
      usuario: { select: { nombre: true } },
    },
  });

  // Pagos agregados por (metodo, cuenta)
  const pagAgg = new Map<string, LineaPago>();
  for (const v of ventasRaw) {
    if (v.estado !== 'FINALIZADA') continue;
    for (const p of v.pagos) {
      if (p.estado !== 'CONFIRMADO') continue;
      const key = `${p.metodo}|${p.cuenta.nombre}`;
      const prev = pagAgg.get(key);
      if (prev) {
        prev.cantidad += 1;
        prev.total += Number(p.monto);
      } else {
        pagAgg.set(key, {
          metodo: p.metodo,
          cuenta: p.cuenta.nombre,
          cantidad: 1,
          total: Number(p.monto),
        });
      }
    }
  }

  const ventas: LineaVenta[] = ventasRaw.map((v) => ({
    numero: v.numero,
    numeroOrdenTurno: v.numeroOrdenTurno,
    hora: v.fechaApertura,
    estado: v.estado,
    canal: v.canal,
    modalidad: v.modalidad,
    subtotal: v.subtotal.toString(),
    descuento: v.descuentoTotal.toString(),
    total: v.total.toString(),
    items: v.items.map((i) => ({
      nombre: i.nombreSnapshot,
      cantidad: i.cantidad.toString(),
      precioUnitario: i.precioUnitario.toString(),
      totalLinea: i.totalLinea.toString(),
    })),
    pagos: v.pagos.map((p) => ({
      metodo: p.metodo,
      cuenta: p.cuenta.nombre,
      monto: p.monto.toString(),
    })),
  }));

  const movimientos: LineaMovimiento[] = movimientosRaw.map((m) => ({
    hora: m.fechaComputo,
    tipo: m.tipo,
    categoria: m.categoria.nombre,
    cuenta:
      m.tipo === 'TRANSFERENCIA_INTERNA'
        ? `${m.cuentaOrigen?.nombre ?? '—'} → ${m.cuentaDestino?.nombre ?? '—'}`
        : m.cuentaOrigen?.nombre ?? m.cuentaDestino?.nombre ?? '—',
    monto: m.monto.toString(),
    observacion: m.observacion,
    usuario: m.usuario.nombre,
  }));

  const ventasFinalizadas = ventasRaw.filter((v) => v.estado === 'FINALIZADA');
  const ventasAnuladas = ventasRaw.filter((v) => v.estado === 'ANULADA');

  // Categorías de cobro tal como la encargada las quiere (sin discriminar cuentas).
  const pagosParaCategorizar = ventasFinalizadas.flatMap((v) =>
    v.pagos
      .filter((p) => p.estado === 'CONFIRMADO')
      .map((p) => ({
        metodo: p.metodo,
        canal: v.canal,
        modalidad: v.modalidad,
        monto: Number(p.monto),
      })),
  );
  const categorias = categorizarCobros({ pagos: pagosParaCategorizar });

  const totalCobrado = ventasFinalizadas.reduce((acc, v) => acc + Number(v.total), 0);
  const totalEfectivo = Array.from(pagAgg.values())
    .filter((p) => p.metodo === 'EFECTIVO')
    .reduce((acc, p) => acc + p.total, 0);
  const totalNoEfectivo = Array.from(pagAgg.values())
    .filter((p) => p.metodo !== 'EFECTIVO')
    .reduce((acc, p) => acc + p.total, 0);
  const egresos = movimientos
    .filter((m) => m.tipo === 'EGRESO')
    .reduce((acc, m) => acc + Number(m.monto), 0);
  const ingresos = movimientos
    .filter((m) => m.tipo === 'INGRESO')
    .reduce((acc, m) => acc + Number(m.monto), 0);
  const descuentos = ventasFinalizadas.reduce((acc, v) => acc + Number(v.descuentoTotal), 0);

  return {
    sesion: {
      id: sesion.id,
      fecha: sesion.fecha,
      turno: sesion.turno,
      estado: sesion.estado,
      horarioApertura: sesion.horarioApertura,
      horarioCierre: sesion.horarioCierre,
      existenciaInicial: sesion.existenciaInicial.toString(),
      existenciaFinal: sesion.existenciaFinal?.toString() ?? null,
      recaudacionEsperada: sesion.recaudacionEsperada?.toString() ?? null,
      diferencia: sesion.diferencia?.toString() ?? null,
      observaciones: sesion.observaciones,
      usuarioApertura: sesion.usuarioApertura.nombre,
      usuarioCierre: sesion.usuarioCierre?.nombre ?? null,
    },
    ventas,
    pagosAgregados: Array.from(pagAgg.values()).sort(
      (a, b) =>
        a.metodo.localeCompare(b.metodo) || a.cuenta.localeCompare(b.cuenta),
    ),
    movimientos,
    categorias,
    resumen: {
      ventasFinalizadas: ventasFinalizadas.length,
      ventasAnuladas: ventasAnuladas.length,
      totalCobrado,
      totalEfectivo,
      totalNoEfectivo,
      egresos,
      ingresos,
      descuentos,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
//   Generar el .xlsx
// ────────────────────────────────────────────────────────────────────────

const VERDE_TERESITA = 'FF1B3A2B'; // ARGB
const CREMA = 'FFF8F2E2';
const ROJO = 'FFB94A48';

function fmtMoney(n: number | string): string {
  const num = typeof n === 'string' ? Number(n) : n;
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2,
  }).format(num);
}

function fmtDate(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtMetodo(m: string): string {
  return m.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function generarExcelCierre(data: CierreData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Santa Teresita Pastas';
  wb.created = new Date();

  // ── Sheet: Resumen ──
  const wsResumen = wb.addWorksheet('Resumen');
  wsResumen.columns = [{ width: 35 }, { width: 22 }];

  const titulo = wsResumen.addRow([
    `Cierre — ${data.sesion.turno === 'MANANA' ? 'Mañana' : 'Tarde'} · ${data.sesion.fecha.toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}`,
  ]);
  titulo.font = { name: 'Calibri', size: 16, bold: true, color: { argb: VERDE_TERESITA } };
  wsResumen.mergeCells(titulo.number, 1, titulo.number, 2);

  wsResumen.addRow([]);

  const seccionLabel = (txt: string) => {
    const r = wsResumen.addRow([txt]);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: VERDE_TERESITA },
    };
    wsResumen.mergeCells(r.number, 1, r.number, 2);
    return r;
  };

  seccionLabel('Sesión');
  wsResumen.addRow(['Estado', data.sesion.estado]);
  wsResumen.addRow(['Apertura', fmtDate(data.sesion.horarioApertura)]);
  wsResumen.addRow(['Cierre', fmtDate(data.sesion.horarioCierre)]);
  wsResumen.addRow(['Cajero apertura', data.sesion.usuarioApertura]);
  wsResumen.addRow(['Cajero cierre', data.sesion.usuarioCierre ?? '—']);

  wsResumen.addRow([]);
  seccionLabel('Recaudación');
  wsResumen.addRow(['Existencia inicial', fmtMoney(data.sesion.existenciaInicial)]);
  wsResumen.addRow(['Cobrado en efectivo', fmtMoney(data.resumen.totalEfectivo)]);
  wsResumen.addRow(['Egresos en efectivo', fmtMoney(-data.resumen.egresos)]);
  wsResumen.addRow(['Ingresos en efectivo', fmtMoney(data.resumen.ingresos)]);
  wsResumen.addRow([
    'Recaudación esperada efectivo',
    fmtMoney(data.sesion.recaudacionEsperada ?? '0'),
  ]);
  wsResumen.addRow(['Existencia contada (cierre)', fmtMoney(data.sesion.existenciaFinal ?? '0')]);

  const dif = Number(data.sesion.diferencia ?? 0);
  const rDif = wsResumen.addRow(['Diferencia', fmtMoney(dif)]);
  if (Math.abs(dif) > 0.01) {
    rDif.font = {
      bold: true,
      color: { argb: dif < 0 ? ROJO : 'FFB7791F' },
    };
  } else {
    rDif.font = { bold: true, color: { argb: '2C8C5A' } };
  }

  wsResumen.addRow([]);
  seccionLabel('Ventas');
  wsResumen.addRow(['Ventas finalizadas', data.resumen.ventasFinalizadas]);
  wsResumen.addRow(['Ventas anuladas', data.resumen.ventasAnuladas]);
  wsResumen.addRow(['Total cobrado (todos los métodos)', fmtMoney(data.resumen.totalCobrado)]);
  wsResumen.addRow([
    '  · efectivo',
    `${fmtMoney(data.resumen.totalEfectivo)}  (${pctStr(data.resumen.totalEfectivo, data.resumen.totalCobrado)})`,
  ]);
  wsResumen.addRow([
    '  · no efectivo',
    `${fmtMoney(data.resumen.totalNoEfectivo)}  (${pctStr(data.resumen.totalNoEfectivo, data.resumen.totalCobrado)})`,
  ]);
  wsResumen.addRow(['Descuentos aplicados', fmtMoney(data.resumen.descuentos)]);

  if (data.sesion.observaciones) {
    wsResumen.addRow([]);
    seccionLabel('Observaciones');
    wsResumen.addRow([data.sesion.observaciones]);
    wsResumen.mergeCells(wsResumen.lastRow!.number, 1, wsResumen.lastRow!.number, 2);
  }

  // ── Sheet: Pagos categorizados (mostrador / delivery / plataformas) ──
  const wsPagos = wb.addWorksheet('Pagos');
  wsPagos.columns = [
    { header: 'Bloque', key: 'bloque', width: 30 },
    { header: 'Detalle', key: 'detalle', width: 22 },
    { header: 'Total', key: 'total', width: 18 },
  ];
  estiloHeader(wsPagos.getRow(1));
  const cat = data.categorias;
  const seccion = (label: string, color: string) => {
    const r = wsPagos.addRow({ bloque: label, detalle: '', total: '' });
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    wsPagos.mergeCells(r.number, 1, r.number, 3);
  };
  const linea = (
    bloque: string,
    detalle: string,
    monto: number,
    opts: { informativo?: boolean } = {},
  ) => {
    const r = wsPagos.addRow({ bloque, detalle, total: fmtMoney(monto) });
    if (opts.informativo) r.font = { italic: true, color: { argb: 'FF888888' } };
    if (monto === 0) r.font = { color: { argb: 'FFCCCCCC' } };
  };
  const subtotal = (label: string, monto: number) => {
    const r = wsPagos.addRow({ bloque: label, detalle: '', total: fmtMoney(monto) });
    r.font = { bold: true, color: { argb: VERDE_TERESITA } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREMA } };
  };

  seccion('MOSTRADOR', VERDE_TERESITA);
  linea('', 'Efectivo', cat.mostrador.efectivo);
  linea('', 'Débito', cat.mostrador.debito);
  linea('', 'Crédito / MP / Transfer', cat.mostrador.creditoOtros);
  subtotal('Subtotal mostrador', cat.totalMostrador);

  seccion('DELIVERY (local + WSP + web)', 'FFB7791F');
  linea('', 'Efectivo · Damián', cat.delivery.efectivoDamian);
  linea('', 'Transfer / Débito online', cat.delivery.online);
  linea('', 'Efectivo · DELIVERATE (rinde semanal)', cat.delivery.efectivoDeliverate, {
    informativo: true,
  });
  subtotal('Subtotal delivery', cat.totalDelivery);

  seccion('PLATAFORMAS (RAPPI · PYA · MELI)', 'FF2C5A8C');
  linea('', 'Cobrado por la app', cat.plataformas.app);
  linea('', 'Efectivo · al motoquero', cat.plataformas.efectivo);
  subtotal('Subtotal plataformas', cat.totalPlataformas);

  const totRow = wsPagos.addRow({
    bloque: 'TOTAL DEL DÍA',
    detalle: '(excluye DELIVERATE informativo)',
    total: fmtMoney(cat.totalDelDia),
  });
  totRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  totRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERDE_TERESITA } };
  totRow.height = 24;

  // Sub-tabla con desglose por cuenta (para el equipo de admin que sí quiera el detalle)
  wsPagos.addRow([]);
  const detalleHeader = wsPagos.addRow({
    bloque: 'Detalle por cuenta (referencia)',
    detalle: '',
    total: '',
  });
  detalleHeader.font = { bold: true, italic: true, color: { argb: '666666' } };
  wsPagos.mergeCells(detalleHeader.number, 1, detalleHeader.number, 3);
  for (const p of data.pagosAgregados) {
    wsPagos.addRow({
      bloque: fmtMetodo(p.metodo),
      detalle: `${p.cuenta} · ${p.cantidad} pagos`,
      total: fmtMoney(p.total),
    });
  }

  // ── Sheet: Ventas ──
  const wsVentas = wb.addWorksheet('Ventas');
  wsVentas.columns = [
    { header: '#', key: 'orden', width: 6 },
    { header: 'Hora', key: 'hora', width: 8 },
    { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Canal', key: 'canal', width: 14 },
    { header: 'Modalidad', key: 'modalidad', width: 22 },
    { header: 'Items', key: 'items', width: 60 },
    { header: 'Subtotal', key: 'subtotal', width: 14 },
    { header: 'Descuento', key: 'descuento', width: 14 },
    { header: 'Total', key: 'total', width: 14 },
    { header: 'Pagos', key: 'pagos', width: 50 },
  ];
  estiloHeader(wsVentas.getRow(1));
  for (const v of data.ventas) {
    const itemsStr = v.items
      .map((i) => `${i.cantidad} × ${i.nombre}`)
      .join('; ')
      .slice(0, 200);
    const pagosStr = v.pagos
      .map((p) => `${fmtMetodo(p.metodo)} ${fmtMoney(p.monto)} (${p.cuenta})`)
      .join('; ');
    const row = wsVentas.addRow({
      orden: v.numeroOrdenTurno,
      hora: v.hora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
      estado: v.estado,
      canal: v.canal,
      modalidad: v.modalidad,
      items: itemsStr,
      subtotal: fmtMoney(v.subtotal),
      descuento: Number(v.descuento) > 0 ? fmtMoney(v.descuento) : '',
      total: fmtMoney(v.total),
      pagos: pagosStr,
    });
    if (v.estado === 'ANULADA') {
      row.font = { color: { argb: ROJO }, strike: true };
    }
  }

  // ── Sheet: Movimientos ──
  const wsMov = wb.addWorksheet('Movimientos');
  wsMov.columns = [
    { header: 'Hora', key: 'hora', width: 12 },
    { header: 'Tipo', key: 'tipo', width: 18 },
    { header: 'Categoría', key: 'categoria', width: 24 },
    { header: 'Cuenta', key: 'cuenta', width: 24 },
    { header: 'Monto', key: 'monto', width: 14 },
    { header: 'Observación', key: 'observacion', width: 40 },
    { header: 'Usuario', key: 'usuario', width: 16 },
  ];
  estiloHeader(wsMov.getRow(1));
  for (const m of data.movimientos) {
    const row = wsMov.addRow({
      hora: m.hora.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }),
      tipo: m.tipo,
      categoria: m.categoria,
      cuenta: m.cuenta,
      monto: fmtMoney(Number(m.monto)),
      observacion: m.observacion ?? '',
      usuario: m.usuario,
    });
    if (m.tipo === 'EGRESO') row.font = { color: { argb: ROJO } };
    else if (m.tipo === 'INGRESO') row.font = { color: { argb: '2C8C5A' } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function estiloHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: VERDE_TERESITA },
  };
  row.alignment = { vertical: 'middle' };
  row.height = 22;
}

function pctStr(parte: number, total: number): string {
  if (total <= 0) return '0%';
  return `${((parte / total) * 100).toFixed(1)}%`;
}

// ────────────────────────────────────────────────────────────────────────
//   HTML del email — versión compacta para el body
// ────────────────────────────────────────────────────────────────────────

export function generarHtmlCierre(data: CierreData): { subject: string; html: string; text: string } {
  const fechaStr = data.sesion.fecha.toLocaleDateString('es-AR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  });
  const turnoStr = data.sesion.turno === 'MANANA' ? 'Mañana' : 'Tarde';
  const subject = `Cierre ${turnoStr} · ${fechaStr} · ${fmtMoney(data.resumen.totalCobrado)}`;
  const dif = Number(data.sesion.diferencia ?? 0);
  const difTone = Math.abs(dif) < 0.01 ? '#2C8C5A' : dif < 0 ? ROJO : '#B7791F';

  const c = data.categorias;
  // Movimientos separados: Empleados (sueldos/adelantos/comisiones) vs el resto (Aportes y egresos)
  const esCategoriaEmpleado = (cat: string) =>
    /sueldo|adelanto a empleado|comisi/i.test(cat);
  const movsEmpleados = data.movimientos.filter((m) => esCategoriaEmpleado(m.categoria));
  const movsAportesEgresos = data.movimientos.filter(
    (m) => !esCategoriaEmpleado(m.categoria),
  );
  const totalEmpleados = movsEmpleados.reduce(
    (acc, m) => acc + Number(m.monto),
    0,
  );
  const totalAportes = movsAportesEgresos
    .filter((m) => m.tipo === 'INGRESO')
    .reduce((acc, m) => acc + Number(m.monto), 0);
  const totalEgresosOtros = movsAportesEgresos
    .filter((m) => m.tipo === 'EGRESO')
    .reduce((acc, m) => acc + Number(m.monto), 0);

  // Fila simple de un bucket
  const filaSimple = (label: string, total: number, opts: { sub?: string; bold?: boolean; informativo?: boolean } = {}) => {
    const colorTotal = opts.informativo ? '#999' : opts.bold ? '#1B3A2B' : '#111';
    const fontWeight = opts.bold ? '600' : '400';
    return `<tr>
      <td style="padding:6px 10px;color:${colorTotal};font-weight:${fontWeight}">${label}${opts.sub ? `<div style="font-size:11px;color:#888;font-weight:400;font-style:italic">${opts.sub}</div>` : ''}</td>
      <td style="padding:6px 10px;text-align:right;font-family:monospace;color:${colorTotal};font-weight:${fontWeight}">${fmtMoney(total)}</td>
    </tr>`;
  };
  const filaSubtotal = (label: string, total: number) =>
    `<tr style="background:#F8F2E2;border-top:1px solid #1B3A2B;">
      <td style="padding:8px 10px;color:#1B3A2B;font-weight:600;text-transform:uppercase;font-size:12px;letter-spacing:.5px;">${label}</td>
      <td style="padding:8px 10px;text-align:right;font-family:monospace;font-size:14px;font-weight:600;color:#1B3A2B;">${fmtMoney(total)}</td>
    </tr>`;
  const seccionHeader = (label: string, color: string) =>
    `<tr style="background:${color};color:#fff;">
      <td colspan="2" style="padding:6px 10px;font-weight:600;text-transform:uppercase;font-size:12px;letter-spacing:.5px;">${label}</td>
    </tr>`;

  const filasMov = data.movimientos
    .slice(0, 20)
    .map(
      (m) =>
        `<tr><td style="padding:4px 8px;font-size:11px">${m.hora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</td><td style="padding:4px 8px;color:${m.tipo === 'EGRESO' ? '#' + ROJO.slice(2) : m.tipo === 'INGRESO' ? '#2C8C5A' : '#777'}">${m.tipo}</td><td style="padding:4px 8px">${m.categoria}</td><td style="padding:4px 8px;color:#777">${m.cuenta}</td><td style="padding:4px 8px;text-align:right;font-family:monospace">${fmtMoney(Number(m.monto))}</td></tr>`,
    )
    .join('');

  const html = `
<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#111;">
  <div style="border-bottom:3px solid #1B3A2B;padding-bottom:12px;margin-bottom:20px;">
    <h1 style="margin:0;font-size:20px;color:#1B3A2B;letter-spacing:.5px;">🍝 Santa Teresita Pastas</h1>
    <div style="color:#777;font-size:12px;margin-top:4px;text-transform:capitalize;">
      Cierre de caja · ${turnoStr} · ${fechaStr}
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;">
    <tr>
      <td style="padding:8px;width:50%;background:#F8F2E2;border-radius:6px 0 0 6px;">
        <div style="font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.5px;">Total cobrado</div>
        <div style="font-size:22px;font-weight:600;color:#1B3A2B;font-family:monospace;">${fmtMoney(data.resumen.totalCobrado)}</div>
        <div style="font-size:11px;color:#777;">${data.resumen.ventasFinalizadas} ventas finalizadas</div>
      </td>
      <td style="padding:8px;background:#F8F2E2;border-radius:0 6px 6px 0;">
        <div style="font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.5px;">Diferencia caja</div>
        <div style="font-size:22px;font-weight:600;color:${difTone};font-family:monospace;">${fmtMoney(dif)}</div>
        <div style="font-size:11px;color:#777;">${Math.abs(dif) < 0.01 ? 'cuadra perfecto ✓' : dif < 0 ? 'falta efectivo' : 'sobra efectivo'}</div>
      </td>
    </tr>
  </table>

  <h2 style="font-size:14px;color:#1B3A2B;margin:18px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;">Cobros del turno</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tbody>
      ${seccionHeader('Mostrador', '#1B3A2B')}
      ${filaSimple('Efectivo', c.mostrador.efectivo, { sub: 'suma a caja' })}
      ${filaSimple('Débito', c.mostrador.debito)}
      ${filaSimple('Crédito / MP / Transfer', c.mostrador.creditoOtros)}
      ${filaSubtotal('Subtotal mostrador', c.totalMostrador)}

      ${seccionHeader('Delivery (local + WSP + web)', '#B7791F')}
      ${filaSimple('Efectivo · Damián', c.delivery.efectivoDamian, { sub: 'suma a caja' })}
      ${filaSimple('Transfer / Débito online', c.delivery.online)}
      ${filaSimple('Efectivo · DELIVERATE', c.delivery.efectivoDeliverate, { sub: 'rinde semanal · NO suma a caja del día', informativo: true })}
      ${filaSubtotal('Subtotal delivery', c.totalDelivery)}

      ${seccionHeader('Plataformas (RAPPI · PYA · MELI)', '#2C5A8C')}
      ${filaSimple('Cobrado por la app', c.plataformas.app)}
      ${filaSimple('Efectivo · al motoquero', c.plataformas.efectivo, { sub: 'suma a caja' })}
      ${filaSubtotal('Subtotal plataformas', c.totalPlataformas)}

      <tr style="background:#1B3A2B;color:#fff;border-top:3px double #1B3A2B;">
        <td style="padding:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;">TOTAL DEL DÍA<div style="font-size:11px;font-weight:400;font-style:italic;color:#cad7c1">excluye DELIVERATE (${fmtMoney(c.delivery.efectivoDeliverate)} a cobrar la semana)</div></td>
        <td style="padding:10px;text-align:right;font-family:monospace;font-size:16px;font-weight:600;">${fmtMoney(c.totalDelDia)}</td>
      </tr>
    </tbody>
  </table>

  <h2 style="font-size:14px;color:#1B3A2B;margin:18px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;">Aportes y egresos del turno</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tbody>
      ${
        movsAportesEgresos.length === 0
          ? `<tr><td style="padding:8px 10px;color:#999;font-style:italic;">Sin aportes ni egresos del turno fuera de empleados.</td></tr>`
          : movsAportesEgresos
              .map(
                (m) => `<tr>
                  <td style="padding:4px 10px">
                    <span style="color:${m.tipo === 'INGRESO' ? '#2C8C5A' : '#' + ROJO.slice(2)};font-weight:500">${m.tipo === 'INGRESO' ? '+' : '−'}</span>
                    <span style="color:#444;margin-left:6px">${m.categoria}</span>
                    ${m.observacion ? `<span style="color:#888;font-size:11px;font-style:italic"> · ${m.observacion}</span>` : ''}
                  </td>
                  <td style="padding:4px 10px;text-align:right;font-family:monospace;color:${m.tipo === 'INGRESO' ? '#2C8C5A' : '#' + ROJO.slice(2)}">${fmtMoney(Number(m.monto))}</td>
                </tr>`,
              )
              .join('')
      }
      ${movsAportesEgresos.length > 0 ? filaSubtotal('Aportes − Egresos (otros)', totalAportes - totalEgresosOtros) : ''}
    </tbody>
  </table>

  <h2 style="font-size:14px;color:#1B3A2B;margin:18px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;">Empleados (sueldos / adelantos / comisiones)</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tbody>
      ${
        movsEmpleados.length === 0
          ? `<tr><td style="padding:8px 10px;color:#999;font-style:italic;">Sin pagos a empleados en el turno.</td></tr>`
          : movsEmpleados
              .map(
                (m) => `<tr>
                  <td style="padding:4px 10px">
                    <span style="color:#444">${m.categoria}</span>
                    ${m.observacion ? `<span style="color:#888;font-size:11px;font-style:italic"> · ${m.observacion}</span>` : ''}
                  </td>
                  <td style="padding:4px 10px;text-align:right;font-family:monospace;color:#${ROJO.slice(2)}">${fmtMoney(Number(m.monto))}</td>
                </tr>`,
              )
              .join('')
      }
      ${movsEmpleados.length > 0 ? filaSubtotal('Total empleados', totalEmpleados) : ''}
    </tbody>
  </table>

  <h2 style="font-size:14px;color:#1B3A2B;margin:18px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;">Recaudación esperada</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tr><td style="padding:4px 8px;color:#777">Existencia inicial</td><td style="padding:4px 8px;text-align:right;font-family:monospace">${fmtMoney(data.sesion.existenciaInicial)}</td></tr>
    <tr><td style="padding:4px 8px;color:#777">+ cobrado efectivo</td><td style="padding:4px 8px;text-align:right;font-family:monospace">${fmtMoney(data.resumen.totalEfectivo)}</td></tr>
    <tr><td style="padding:4px 8px;color:#777">+ ingresos del turno</td><td style="padding:4px 8px;text-align:right;font-family:monospace">${fmtMoney(data.resumen.ingresos)}</td></tr>
    <tr><td style="padding:4px 8px;color:#777">− egresos del turno</td><td style="padding:4px 8px;text-align:right;font-family:monospace">${fmtMoney(data.resumen.egresos)}</td></tr>
    <tr style="border-top:1px solid #ddd;font-weight:600;"><td style="padding:6px 8px">= Esperada en caja</td><td style="padding:6px 8px;text-align:right;font-family:monospace">${fmtMoney(data.sesion.recaudacionEsperada ?? '0')}</td></tr>
    <tr><td style="padding:4px 8px;color:#777">Contada en cierre</td><td style="padding:4px 8px;text-align:right;font-family:monospace">${fmtMoney(data.sesion.existenciaFinal ?? '0')}</td></tr>
  </table>

  ${
    data.movimientos.length > 0
      ? `<h2 style="font-size:14px;color:#1B3A2B;margin:18px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;">Movimientos del turno (${data.movimientos.length})</h2>
  <table style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead><tr style="background:#1B3A2B;color:#fff;"><th style="padding:6px 8px;text-align:left;">Hora</th><th style="padding:6px 8px;text-align:left;">Tipo</th><th style="padding:6px 8px;text-align:left;">Categoría</th><th style="padding:6px 8px;text-align:left;">Cuenta</th><th style="padding:6px 8px;text-align:right;">Monto</th></tr></thead>
    <tbody>${filasMov}</tbody>
  </table>${data.movimientos.length > 20 ? `<div style="font-size:11px;color:#777;margin-top:6px;">+ ${data.movimientos.length - 20} más en el Excel adjunto</div>` : ''}`
      : ''
  }

  <div style="margin-top:24px;padding:12px;background:#F8F2E2;border-radius:6px;font-size:12px;color:#555;">
    📎 Excel adjunto con detalle de cada venta, pagos por método/cuenta y movimientos del turno.
  </div>

  <div style="margin-top:24px;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:12px;">
    Sesión: <code>${data.sesion.id}</code><br>
    Generado automáticamente por el sistema de Santa Teresita Pastas.
  </div>
</div>`;

  const text = `Cierre ${turnoStr} · ${fechaStr}
Total cobrado: ${fmtMoney(data.resumen.totalCobrado)} (${data.resumen.ventasFinalizadas} ventas)
Efectivo: ${fmtMoney(data.resumen.totalEfectivo)} · No efectivo: ${fmtMoney(data.resumen.totalNoEfectivo)}
Diferencia caja: ${fmtMoney(dif)}
(Detalle completo en el Excel adjunto)`;

  return { subject, html, text };
}
