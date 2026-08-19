/**
 * Excel de un resultado de búsqueda — el mismo formato para las cuatro tablas
 * pesadas (ventas, movimientos, encargos, facturas).
 *
 * ── Dos decisiones que importan ───────────────────────────────────────────
 *
 * 1. LA PLATA VA COMO NÚMERO, no como texto. El export del cierre
 *    (`cierre-export.ts`) escribe `fmtMoney(...)`, que se ve bien pero llega a
 *    Excel como cadena: no se puede sumar, ni filtrar por monto, ni meter en
 *    una tabla dinámica. Acá cada celda de dinero es un número con `numFmt` de
 *    moneda, así que se ve igual Y sirve para trabajar.
 *
 * 2. LOS TOTALES VAN ARRIBA Y GRANDES, en celdas propias. Es lo primero que
 *    mira quien abre el archivo, y son fórmulas SUM() sobre la columna — no un
 *    número calculado acá. Si alguien filtra o borra filas, el total se
 *    recalcula solo en vez de mentir.
 *
 * El archivo se explica a sí mismo: título, qué filtros se aplicaron y cuándo
 * se generó. Un Excel suelto en el escritorio, tres semanas después, sin eso
 * no se sabe de qué período es.
 */

import ExcelJS from 'exceljs';

export type TipoColumna = 'texto' | 'numero' | 'dinero' | 'fecha';

export interface ColumnaExport {
  header: string;
  key: string;
  tipo?: TipoColumna;
  width?: number;
}

/** Un total al pie/encabezado: sobre qué columna suma y cómo se llama. */
export interface TotalExport {
  etiqueta: string;
  /** `key` de la columna a sumar. Si no está, se usa `valor`. */
  columna?: string;
  /** Valor fijo, para totales que no salen de sumar una columna (ej. cantidad). */
  valor?: number;
  /** Formatea como dinero. Default: true si viene de una columna de dinero. */
  dinero?: boolean;
}

const FMT_MONEDA = '"$"#,##0.00';
const FMT_FECHA = 'dd/mm/yyyy hh:mm';

const VERDE = 'FF1B4332'; // verde Teresita, para encabezados
const CREMA = 'FFFAF8F3';
const DORADO = 'FFD4A574';

function letraColumna(indice: number): string {
  let n = indice;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function construirExcelBusqueda(opts: {
  /** Ej. "Ventas" — va en el título y da nombre a la hoja. */
  titulo: string;
  /** Qué se buscó: período, texto, filtros. Para que el archivo se explique solo. */
  filtros?: string;
  columnas: ColumnaExport[];
  filas: Array<Record<string, unknown>>;
  totales?: TotalExport[];
  /**
   * Si la búsqueda se cortó por el tope, cuántas filas hay en total. Se avisa
   * EN el archivo: un export truncado en silencio se lee como "esto es todo".
   */
  hayMas?: { exportadas: number; totales: number };
}): Promise<Buffer> {
  const { titulo, columnas, filas } = opts;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Santa Teresita';
  wb.created = new Date();
  const ws = wb.addWorksheet(titulo.slice(0, 31));

  ws.columns = columnas.map((c) => ({
    key: c.key,
    width: c.width ?? (c.tipo === 'fecha' ? 18 : c.tipo === 'dinero' ? 16 : 22),
  }));

  // ── Encabezado ───────────────────────────────────────────────────────────
  const rTitulo = ws.addRow([titulo]);
  rTitulo.font = { size: 16, bold: true, color: { argb: VERDE } };
  rTitulo.height = 24;

  if (opts.filtros) {
    const r = ws.addRow([opts.filtros]);
    r.font = { size: 10, italic: true, color: { argb: 'FF6B7280' } };
  }
  const rGen = ws.addRow([`Generado el ${new Date().toLocaleString('es-AR')}`]);
  rGen.font = { size: 9, color: { argb: 'FF9CA3AF' } };

  if (opts.hayMas) {
    const r = ws.addRow([
      `⚠ Se exportaron las primeras ${opts.hayMas.exportadas} filas de ${opts.hayMas.totales}. ` +
        `Afiná el filtro para que entren todas.`,
    ]);
    r.font = { size: 11, bold: true, color: { argb: 'FFB45309' } };
  }
  ws.addRow([]);

  // ── Totales (arriba, grandes) ────────────────────────────────────────────
  // Se reservan las filas ahora y las fórmulas se escriben al final, cuando ya
  // se sabe en qué fila arrancan y terminan los datos.
  const filasTotales: Array<{ fila: number; t: TotalExport }> = [];
  if (opts.totales?.length) {
    for (const t of opts.totales) {
      const r = ws.addRow([t.etiqueta, null]);
      r.font = { size: 13, bold: true };
      r.height = 22;
      r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREMA } };
      const celda = r.getCell(2);
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREMA } };
      celda.font = { size: 14, bold: true, color: { argb: VERDE } };
      celda.border = { bottom: { style: 'medium', color: { argb: DORADO } } };
      filasTotales.push({ fila: r.number, t });
    }
    ws.addRow([]);
  }

  // ── Encabezado de la tabla ───────────────────────────────────────────────
  const rHead = ws.addRow(columnas.map((c) => c.header));
  rHead.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  rHead.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERDE } };
  rHead.alignment = { vertical: 'middle' };
  rHead.height = 20;
  const filaHead = rHead.number;

  // ── Datos ────────────────────────────────────────────────────────────────
  for (const f of filas) {
    const r = ws.addRow(columnas.map((c) => f[c.key] ?? null));
    columnas.forEach((c, i) => {
      const celda = r.getCell(i + 1);
      if (c.tipo === 'dinero') celda.numFmt = FMT_MONEDA;
      else if (c.tipo === 'fecha') celda.numFmt = FMT_FECHA;
    });
  }
  const primeraFila = filaHead + 1;
  const ultimaFila = filaHead + filas.length;

  // Congelar el encabezado y activar autofiltro: con miles de filas, sin esto
  // no se puede trabajar.
  ws.views = [{ state: 'frozen', ySplit: filaHead }];
  if (filas.length > 0) {
    ws.autoFilter = {
      from: { row: filaHead, column: 1 },
      to: { row: ultimaFila, column: columnas.length },
    };
  }

  // ── Fórmulas de los totales ──────────────────────────────────────────────
  for (const { fila, t } of filasTotales) {
    const celda = ws.getRow(fila).getCell(2);
    if (t.columna && filas.length > 0) {
      const idx = columnas.findIndex((c) => c.key === t.columna);
      if (idx >= 0) {
        const L = letraColumna(idx + 1);
        celda.value = { formula: `SUM(${L}${primeraFila}:${L}${ultimaFila})` };
        const esDinero = t.dinero ?? columnas[idx]!.tipo === 'dinero';
        if (esDinero) celda.numFmt = FMT_MONEDA;
        continue;
      }
    }
    celda.value = t.valor ?? 0;
    if (t.dinero) celda.numFmt = FMT_MONEDA;
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

const NOMBRE_PERIODO: Record<string, string> = {
  todo: 'Toda la base',
  hoy: 'Hoy',
  ayer: 'Ayer',
  semana: 'Últimos 7 días',
  mes: 'Últimos 30 días',
  sesion_actual: 'Sesión actual',
  sesion_anterior: 'Sesión anterior',
  custom: 'Rango personalizado',
};

/**
 * Una línea que dice qué se buscó, para meter en el encabezado del archivo.
 * Sin esto, un Excel suelto en el escritorio tres semanas después no se sabe
 * de qué período es ni qué filtros tenía puestos.
 */
export function descripcionFiltros(args: {
  periodo?: string;
  desde?: Date | null;
  hasta?: Date | null;
  texto?: string;
  extra?: string;
}): string {
  const partes: string[] = [];
  const p = args.periodo ? (NOMBRE_PERIODO[args.periodo] ?? args.periodo) : null;
  if (p) partes.push(`Período: ${p}`);
  if (args.desde || args.hasta) {
    const f = (d?: Date | null) => (d ? d.toLocaleDateString('es-AR') : '…');
    partes.push(`(${f(args.desde)} a ${f(args.hasta)})`);
  }
  if (args.texto) partes.push(`Búsqueda: "${args.texto}"`);
  if (args.extra) partes.push(args.extra);
  return partes.join(' · ');
}

/** Nombre de archivo seguro y con fecha, para que no se pisen en Descargas. */
export function nombreArchivoExport(base: string): string {
  const hoy = new Date()
    .toLocaleDateString('es-AR')
    .split('/')
    .reverse()
    .map((p) => p.padStart(2, '0'))
    .join('-');
  return `${base.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${hoy}.xlsx`;
}
