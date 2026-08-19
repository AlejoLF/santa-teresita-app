/**
 * Volcar al Excel "Proveedores 2026.xlsx" lo que el sistema ya sabe de cada
 * proveedor: qué se recibió y qué se pagó en la semana.
 *
 * ── La hoja `Deudas`, tal como la lleva la encargada ─────────────────────
 *
 * Una fila por proveedor y, por cada semana, un bloque de tres columnas:
 *
 *     Arranco la          Recibido del        Pagos
 *     Semana del 02/03    02/03 al 08/03      02/03 al 08/03
 *     ────────────────    ──────────────      ──────────────
 *     =Z5+AA5-AB5         739410.75           500000
 *      ↑ FÓRMULA           ↑ a mano            ↑ a mano
 *
 * "Arranco" es fórmula (saldo anterior + recibido − pagos) y la fila TOTAL es
 * `=SUM(...)`. O sea: alcanza con llenar las dos columnas del medio y toda la
 * planilla se recalcula sola. Este servicio NO toca ninguna fórmula de ella.
 *
 * ── Por qué se escribe una fórmula y no un número ────────────────────────
 *
 * Cuando en una semana entran varias facturas del mismo proveedor, la
 * encargada no suma de cabeza: escribe `=616699.32+261295.13`. En el archivo
 * real hay 256 celdas así. Se respeta esa costumbre y se escribe igual, un
 * término por factura, porque además deja la celda AUDITABLE: se ve de qué
 * comprobantes salió el total sin abrir el sistema.
 *
 * ── Qué NO hace ──────────────────────────────────────────────────────────
 *
 * No pisa lo que ella escribió. Si una celda ya tiene algo distinto de lo que
 * calculamos, se informa como DIFERENCIA y se deja intacta. El Excel es su
 * cuaderno de trabajo: el sistema propone, ella decide. Sólo con
 * `pisarDiferencias: true` se sobrescribe, y eso lo tiene que pedir alguien
 * a propósito.
 */

import ExcelJS from 'exceljs';
import { access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '@sta/db/client';
import { editarHojaXlsx, type EdicionCelda } from './xlsx-quirurgico.js';

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.REPO_ROOT
  ? resolve(process.env.REPO_ROOT)
  : resolve(SERVICE_DIR, '../../../..');
const EXCEL_DIR = process.env.EXCEL_LOCAL_DIR ?? REPO_ROOT;

const ARCHIVO = 'Proveedores 2026.xlsx';
const HOJA = 'Deudas';
/** Fila de los sub-encabezados con los rangos ("02/03 al 08/03"). */
const FILA_RANGOS = 2;
/** Primera y última fila de proveedores (abajo de la última viene TOTAL). */
const FILA_PRIMER_PROVEEDOR = 3;
const ETIQUETA_TOTAL = 'TOTAL';

/** Comprobantes que descuentan en vez de sumar. */
const COMPROBANTES_NEGATIVOS = new Set(['NOTA_CREDITO']);

export interface SemanaExcel {
  /** Columna de "Recibido del …", ej. "AD". */
  colRecibido: string;
  /** Columna de "Pagos", ej. "AE". */
  colPagos: string;
  desde: Date;
  /** Inclusive: el rango "02/03 al 08/03" incluye el 08/03 entero. */
  hasta: Date;
  etiqueta: string;
}

/** "AG" ← 33 */
function numeroACol(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Día y mes crudos de un encabezado "02/03 al 08/03". */
export interface RangoCrudo {
  d1: number;
  m1: number;
  d2: number;
  m2: number;
}

export function parsearRangoCrudo(texto: string): RangoCrudo | null {
  const m = /(\d{1,2})\/(\d{1,2})\s*al\s*(\d{1,2})\/(\d{1,2})/i.exec(texto);
  if (!m) return null;
  return { d1: Number(m[1]), m1: Number(m[2]), d2: Number(m[3]), m2: Number(m[4]) };
}

/**
 * Parsea "02/03 al 08/03" a un rango de fechas.
 *
 * El encabezado NO lleva año, y en un archivo anual hay DOS bloques que cruzan
 * de diciembre a enero: el primero ("29/12 al 04/01" = fin de 2025 → 2026) y
 * el último ("28/12 al 03/01" = fin de 2026 → 2027). Del texto solos son
 * indistinguibles.
 *
 * Por eso `anioInicio` lo decide `leerSemanas`, que recorre los bloques EN
 * ORDEN y avanza el año cuando el mes retrocede. Acá sólo se resuelve el
 * cruce de fin de rango: si el final cae antes que el inicio, es del año
 * siguiente.
 */
export function parsearRango(
  texto: string,
  anioInicio: number,
): { desde: Date; hasta: Date } | null {
  const c = parsearRangoCrudo(texto);
  if (!c) return null;
  const desde = new Date(anioInicio, c.m1 - 1, c.d1);
  const anioFin = c.m2 < c.m1 ? anioInicio + 1 : anioInicio;
  const hasta = new Date(anioFin, c.m2 - 1, c.d2, 23, 59, 59, 999);
  return { desde, hasta };
}

function textoDeCelda(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'richText' in v) {
    return (v.richText as Array<{ text: string }>).map((t) => t.text).join('');
  }
  if (typeof v === 'object' && 'result' in v) return String(v.result ?? '');
  return String(v);
}

/**
 * Todas las semanas del archivo, leídas de los encabezados.
 *
 * El año se asigna RECORRIENDO los bloques en orden, no bloque por bloque:
 * los encabezados no lo traen, y el mismo texto "28/12 al 03/01" puede ser la
 * primera semana del archivo o la última. La regla es simple: se arranca en el
 * año del archivo (o el anterior, si el primer bloque cae en diciembre — un
 * año que empieza el 29/12 empieza en el anterior) y se suma uno cada vez que
 * el mes RETROCEDE. Sin esto, la última semana de diciembre se fechaba en
 * enero y su columna quedaba fuera de todo cálculo.
 */
export function leerSemanas(ws: ExcelJS.Worksheet, anio: number): SemanaExcel[] {
  // Primera pasada: sólo para saber en qué año arranca el archivo.
  let anioActual = anio;
  for (let c = 2; c <= ws.columnCount; c++) {
    const titulo = textoDeCelda(ws.getCell(1, c).value).trim();
    if (!titulo.toLowerCase().startsWith('recibido')) continue;
    const crudo = parsearRangoCrudo(textoDeCelda(ws.getCell(FILA_RANGOS, c).value));
    if (!crudo) continue;
    if (crudo.m1 === 12) anioActual = anio - 1;
    break;
  }

  const out: SemanaExcel[] = [];
  let mesPrevio = 0;
  for (let c = 2; c <= ws.columnCount; c++) {
    const titulo = textoDeCelda(ws.getCell(1, c).value).trim();
    if (!titulo.toLowerCase().startsWith('recibido')) continue;
    const texto = textoDeCelda(ws.getCell(FILA_RANGOS, c).value);
    const crudo = parsearRangoCrudo(texto);
    if (!crudo) continue;
    if (mesPrevio && crudo.m1 < mesPrevio) anioActual += 1;
    mesPrevio = crudo.m1;
    const rango = parsearRango(texto, anioActual);
    if (!rango) continue;
    // "Pagos" es siempre la columna de al lado: el bloque es
    // Arranco / Recibido / Pagos, en ese orden, y así está en todo el archivo.
    const tituloPagos = textoDeCelda(ws.getCell(1, c + 1).value).trim().toLowerCase();
    if (!tituloPagos.startsWith('pagos')) continue;
    out.push({
      colRecibido: numeroACol(c),
      colPagos: numeroACol(c + 1),
      desde: rango.desde,
      hasta: rango.hasta,
      etiqueta: textoDeCelda(ws.getCell(FILA_RANGOS, c).value).trim(),
    });
  }
  return out;
}

/** Etiqueta de la columna A → número de fila. */
export function leerFilasProveedor(ws: ExcelJS.Worksheet): Map<string, number> {
  const out = new Map<string, number>();
  for (let r = FILA_PRIMER_PROVEEDOR; r <= ws.rowCount; r++) {
    const etiqueta = textoDeCelda(ws.getCell(r, 1).value).trim();
    if (!etiqueta) continue;
    if (etiqueta.toUpperCase() === ETIQUETA_TOTAL) break; // de acá para abajo son totales
    if (!out.has(etiqueta)) out.set(etiqueta, r);
  }
  return out;
}

export interface DetalleCelda {
  etiqueta: string;
  fila: number;
  ref: string;
  /** Qué columna: lo recibido o lo pagado. */
  concepto: 'RECIBIDO' | 'PAGOS';
  /** Un término por comprobante/pago, para armar la fórmula y para mostrar. */
  terminos: Array<{ detalle: string; monto: number }>;
  total: number;
  /** Lo que la celda tenía antes. */
  valorPrevio: string | number | null;
  estado: 'NUEVA' | 'IGUAL' | 'DIFERENCIA';
}

export interface ResultadoVolcado {
  archivo: string;
  semana: string;
  desde: string;
  hasta: string;
  celdas: DetalleCelda[];
  escritas: number;
  diferencias: number;
  /** Filas del Excel sin ningún proveedor mapeado: no se tocan. */
  filasSinMapeo: string[];
  /** Proveedores con movimiento en la semana que no van a ninguna fila. */
  proveedoresSinFila: Array<{ id: string; nombre: string; total: number }>;
  simulado: boolean;
}

/** Redondeo a centavos, para que comparar contra el Excel no falle por flotantes. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Calcula y (opcionalmente) escribe la semana pedida.
 *
 * `fecha` puede ser cualquier día: se usa la semana del archivo que la
 * contiene. Sin `fecha` se toma hoy — que es lo que va a hacer la tarea
 * automática del lunes.
 */
export async function volcarSemanaProveedores(opts: {
  fecha?: Date;
  simular?: boolean;
  pisarDiferencias?: boolean;
}): Promise<ResultadoVolcado> {
  const fecha = opts.fecha ?? new Date();
  const ruta = join(EXCEL_DIR, ARCHIVO);
  try {
    await access(ruta);
  } catch {
    throw new Error(
      `No encuentro "${ARCHIVO}" en ${EXCEL_DIR}. ` +
        'Configurá EXCEL_LOCAL_DIR apuntando a la carpeta sincronizada de Drive.',
    );
  }

  // Lectura con exceljs (leer no rompe nada); la ESCRITURA va por el editor
  // quirúrgico, que no toca el resto del archivo. Ver xlsx-quirurgico.ts.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ruta);
  const ws = wb.getWorksheet(HOJA);
  if (!ws) throw new Error(`El archivo no tiene la hoja "${HOJA}"`);

  const semanas = leerSemanas(ws, fecha.getFullYear());
  const semana = semanas.find((s) => fecha >= s.desde && fecha <= s.hasta);
  if (!semana) {
    throw new Error(
      `El archivo no tiene una columna para la semana del ${fecha.toLocaleDateString('es-AR')}. ` +
        'Hay que agregar el bloque de esa semana en el Excel.',
    );
  }

  const filas = leerFilasProveedor(ws);

  // ── Mapeo fila ↔ proveedor ──
  const mapeos = await prisma.mapeoExcelProveedor.findMany({
    where: { activo: true },
    include: { proveedor: { select: { id: true, nombre: true } } },
  });
  const porEtiqueta = new Map<string, typeof mapeos>();
  for (const m of mapeos) {
    const arr = porEtiqueta.get(m.etiquetaExcel) ?? [];
    arr.push(m);
    porEtiqueta.set(m.etiquetaExcel, arr);
  }

  // ── Datos de la semana ──
  const facturas = await prisma.facturaRecibida.findMany({
    where: {
      fechaComputo: { gte: semana.desde, lte: semana.hasta },
      estado: { not: 'ANULADA' },
    },
    select: {
      id: true,
      proveedorId: true,
      tipoComprobante: true,
      numero: true,
      puntoVenta: true,
      total: true,
      proveedor: { select: { nombre: true } },
    },
  });
  const pagos = await prisma.pagoFactura.findMany({
    where: { pago: { fecha: { gte: semana.desde, lte: semana.hasta } } },
    select: {
      montoAplicado: true,
      factura: { select: { proveedorId: true, numero: true, proveedor: { select: { nombre: true } } } },
      pago: { select: { fecha: true, metodo: true } },
    },
  });

  // ── Armar las celdas ──
  const celdas: DetalleCelda[] = [];
  const proveedoresUsados = new Set<string>();
  const filasSinMapeo: string[] = [];

  for (const [etiqueta, fila] of filas) {
    const míos = porEtiqueta.get(etiqueta);
    if (!míos || míos.length === 0) {
      filasSinMapeo.push(etiqueta);
      continue;
    }

    /** ¿Esta factura va a esta fila? `tiposComprobante` vacío = todos. */
    const aceptaTipo = (m: (typeof mapeos)[number], tipo: string) =>
      m.tiposComprobante.length === 0 || m.tiposComprobante.includes(tipo);

    const idsFila = new Set(míos.map((m) => m.proveedorId));
    idsFila.forEach((id) => proveedoresUsados.add(id));

    // Recibido
    const termRecibido = facturas
      .filter((f) =>
        míos.some((m) => m.proveedorId === f.proveedorId && aceptaTipo(m, f.tipoComprobante)),
      )
      .map((f) => {
        const signo = COMPROBANTES_NEGATIVOS.has(f.tipoComprobante) ? -1 : 1;
        const nro = f.puntoVenta ? `${f.puntoVenta}-${f.numero}` : f.numero;
        return { detalle: `${f.tipoComprobante} ${nro}`, monto: r2(signo * Number(f.total)) };
      });

    // Pagos
    const termPagos = pagos
      .filter((p) => idsFila.has(p.factura.proveedorId))
      .map((p) => ({
        detalle: `pago ${p.pago.metodo} s/ ${p.factura.numero}`,
        monto: r2(Number(p.montoAplicado)),
      }));

    for (const [concepto, col, terminos] of [
      ['RECIBIDO', semana.colRecibido, termRecibido],
      ['PAGOS', semana.colPagos, termPagos],
    ] as const) {
      if (terminos.length === 0) continue;
      const ref = `${col}${fila}`;
      const total = r2(terminos.reduce((a, t) => a + t.monto, 0));
      const previo = ws.getCell(ref).value;
      const previoNum =
        previo == null
          ? null
          : typeof previo === 'number'
            ? previo
            : typeof previo === 'object' && 'result' in previo
              ? Number(previo.result)
              : null;
      const previoTexto =
        previo == null
          ? null
          : typeof previo === 'object' && 'formula' in previo
            ? `=${(previo as { formula: string }).formula}`
            : (previo as string | number);

      const estado: DetalleCelda['estado'] =
        previo == null || previoNum === 0
          ? 'NUEVA'
          : previoNum != null && Math.abs(previoNum - total) < 0.01
            ? 'IGUAL'
            : 'DIFERENCIA';

      celdas.push({
        etiqueta,
        fila,
        ref,
        concepto,
        terminos,
        total,
        valorPrevio: previoTexto,
        estado,
      });
    }
  }

  // Proveedores con movimiento que no entran en ninguna fila: si no se avisa,
  // su plata desaparece del Excel sin que nadie se entere.
  const totalPorProveedor = new Map<string, { nombre: string; total: number }>();
  for (const f of facturas) {
    if (proveedoresUsados.has(f.proveedorId)) continue;
    const e = totalPorProveedor.get(f.proveedorId) ?? { nombre: f.proveedor.nombre, total: 0 };
    e.total = r2(e.total + Number(f.total));
    totalPorProveedor.set(f.proveedorId, e);
  }
  const proveedoresSinFila = [...totalPorProveedor.entries()].map(([id, v]) => ({
    id,
    nombre: v.nombre,
    total: v.total,
  }));

  // ── Escribir ──
  const aEscribir = celdas.filter(
    (c) => c.estado === 'NUEVA' || (c.estado === 'DIFERENCIA' && opts.pisarDiferencias),
  );
  const ediciones: EdicionCelda[] = aEscribir.map((c) => ({
    ref: c.ref,
    valor:
      c.terminos.length > 1
        ? {
            tipo: 'formula' as const,
            // Un término por comprobante, igual que lo escribe ella a mano.
            formula: c.terminos
              .map((t, i) => (i > 0 && t.monto < 0 ? `${t.monto}` : `${i > 0 ? '+' : ''}${t.monto}`))
              .join(''),
            resultado: c.total,
          }
        : { tipo: 'numero' as const, valor: c.total },
  }));

  if (!opts.simular && ediciones.length > 0) {
    await editarHojaXlsx({ archivo: ruta, hoja: HOJA, ediciones });
  }

  return {
    archivo: ruta,
    semana: semana.etiqueta,
    desde: semana.desde.toISOString().slice(0, 10),
    hasta: semana.hasta.toISOString().slice(0, 10),
    celdas,
    escritas: opts.simular ? 0 : ediciones.length,
    diferencias: celdas.filter((c) => c.estado === 'DIFERENCIA').length,
    filasSinMapeo,
    proveedoresSinFila,
    simulado: Boolean(opts.simular),
  };
}

/** Las etiquetas de la hoja, para armar el mapeo desde el admin. */
export async function leerEtiquetasDelExcel(): Promise<{
  archivo: string;
  etiquetas: string[];
  semanas: Array<{ etiqueta: string; desde: string; hasta: string }>;
}> {
  const ruta = join(EXCEL_DIR, ARCHIVO);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ruta);
  const ws = wb.getWorksheet(HOJA);
  if (!ws) throw new Error(`El archivo no tiene la hoja "${HOJA}"`);
  const semanas = leerSemanas(ws, new Date().getFullYear());
  return {
    archivo: ruta,
    etiquetas: [...leerFilasProveedor(ws).keys()],
    semanas: semanas.map((s) => ({
      etiqueta: s.etiqueta,
      desde: s.desde.toISOString().slice(0, 10),
      hasta: s.hasta.toISOString().slice(0, 10),
    })),
  };
}
