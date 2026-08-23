/**
 * Writeback al Excel CASHFLOW 2026.xlsx — actualiza el archivo existente con
 * los datos del día generados por el programa. NO crea archivo nuevo: abre,
 * encuentra la hoja del mes correcto, busca la columna del día y actualiza
 * las celdas según el mapping documentado abajo.
 *
 * Mapping del CASHFLOW (validado contra ABR 26 del archivo del cliente):
 *
 *   ROW 6  → VENTA MAÑANA          = mostradorEfectivo + appsEfectivo (sesión MAÑANA)
 *   ROW 7  → VENTA TARDE           = mostradorEfectivo + appsEfectivo (sesión TARDE)
 *   ROW 8  → VENTAS CON TARJETA MAÑANA = mostradorDebito + mostradorCredito + appsTarjeta (MAÑANA)
 *   ROW 9  → VENTAS CON TARJETA TARDE  = mismo (TARDE)
 *   ROW 10 → REPARTO               = damianEfectivo (todo el día, no separa turnos)
 *   ROW 57 → DIFERENCIAS DE CAJA   = (existenciaFinal - recaudacionEsperada) MAÑANA + TARDE
 *   ROW 60 → DELIVERATE A COBRAR   = deliverateEfectivo (informativo, rinde semanal)
 *
 * Observaciones:
 *   - Las filas con fórmulas (R13 TOTAL, R14 VENTA TOTAL, R45 EGRESOS, R46 RESULTADO,
 *     R69 SALDO DEL DÍA) NO se tocan: Excel las recalcula al abrir.
 *   - Los egresos operativos (R16-R44) se quedan como están — el cliente sigue
 *     cargándolos a mano por ahora.
 */

import ExcelJS from 'exceljs';
import { exigir, abrirLibro, guardarLibro, respaldar, origenExcel } from './fuente-excel.js';
import { prisma } from '@sta/db/client';
import { ReglaNegocioError } from './errores.js';
import { cargarCierre, type CierreData, type CategoriaCobros } from './cierre-export.js';


const CASHFLOW_FILE = 'CASHFLOW 2026.xlsx';

// Filas a actualizar en el cashflow (1-indexed). Validados contra el archivo del cliente.
const ROW_VENTA_MANANA = 6;
const ROW_VENTA_TARDE = 7;
const ROW_TARJETA_MANANA = 8;
const ROW_TARJETA_TARDE = 9;
const ROW_REPARTO = 10;
const ROW_DIFERENCIAS = 57;
const ROW_DELIVERATE = 60;

// Mapeo mes → nombre de hoja en el cashflow (formato del cliente: "ENE 26", "ABR 26", etc.).
const MESES_ABREV = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

function nombreHojaCashflow(fecha: Date): string {
  const mes = MESES_ABREV[fecha.getMonth()];
  const año = String(fecha.getFullYear()).slice(-2);
  return `${mes} ${año}`;
}

/**
 * En la hoja, los días están en row 2 como fechas. Devuelve el número de
 * columna (1-indexed) que corresponde a la fecha pedida.
 */
function buscarColumnaDia(ws: ExcelJS.Worksheet, fecha: Date): number | null {
  const target = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()).getTime();
  for (let c = 2; c <= ws.columnCount; c++) {
    const v = ws.getCell(2, c).value;
    if (!v) continue;
    let cellDate: Date | null = null;
    if (v instanceof Date) cellDate = v;
    else if (typeof v === 'object' && 'result' in v && v.result instanceof Date) {
      cellDate = v.result as Date;
    }
    if (!cellDate) continue;
    const cellTime = new Date(
      cellDate.getFullYear(),
      cellDate.getMonth(),
      cellDate.getDate(),
    ).getTime();
    if (cellTime === target) return c;
  }
  return null;
}

export interface SyncResult {
  archivoPath: string;
  hoja: string;
  columna: number;
  diaLabel: string;
  cambios: Array<{ celda: string; etiqueta: string; valorAnterior: unknown; valorNuevo: number }>;
  manana: CategoriaCobros | null;
  tarde: CategoriaCobros | null;
  warnings: string[];
}

/**
 * Cargar las dos sesiones (mañana + tarde) del día desde la DB.
 */
async function cargarDia(fecha: Date): Promise<{
  manana: CierreData | null;
  tarde: CierreData | null;
}> {
  const inicio = new Date(fecha);
  inicio.setHours(0, 0, 0, 0);
  const sesiones = await prisma.sesionCaja.findMany({
    where: { fecha: inicio },
  });
  let manana: CierreData | null = null;
  let tarde: CierreData | null = null;
  for (const s of sesiones) {
    const data = await cargarCierre(s.id);
    if (s.turno === 'MANANA') manana = data;
    else tarde = data;
  }
  return { manana, tarde };
}

/**
 * ¿Está habilitado escribir el CASHFLOW?
 *
 * El candado nació cuando el archivo se bajaba de Drive en UNA sola dirección:
 * lo que escribía el servidor lo pisaba la sincronización diez minutos después,
 * en silencio. Leyendo y escribiendo el archivo VIVO de Drive ese problema
 * desaparece —se lee, se modifica y se sube la misma versión—, así que con
 * Drive configurado la escritura queda habilitada sola.
 *
 * Sobre disco el candado sigue vigente: ahí el archivo puede seguir siendo una
 * copia que algo más sobrescribe.
 */
function escrituraHabilitada(): boolean {
  if (origenExcel() === 'drive') return true;
  return /^(1|true|si|sí)$/i.test((process.env.EXCEL_CASHFLOW_ESCRITURA ?? '').trim());
}

/**
 * Escribe los datos del día al CASHFLOW. Crea un .bak antes de tocar el archivo.
 */
export async function actualizarCashflow(opts: {
  fecha: Date;
  /** Si es true, hace backup `CASHFLOW 2026.bak.xlsx` antes de modificar. */
  hacerBackup?: boolean;
}): Promise<SyncResult> {
  if (!escrituraHabilitada()) {
    throw new ReglaNegocioError(
      'La escritura del CASHFLOW está deshabilitada porque se está leyendo de un ' +
        'archivo en disco, que algo puede sobrescribir. Configurá Google Drive ' +
        '(GOOGLE_SERVICE_ACCOUNT_JSON y GOOGLE_DRIVE_FOLDER_ID) y se habilita sola.',
      423,
    );
  }

  const ref = await exigir(CASHFLOW_FILE);

  const { manana, tarde } = await cargarDia(opts.fecha);
  if (!manana && !tarde) {
    throw new Error(
      `No hay sesiones cerradas para ${opts.fecha.toISOString().slice(0, 10)}. ` +
        `Cerrá al menos una antes de sincronizar.`,
    );
  }

  // Backup. En Drive no hace nada: Drive ya guarda historial de versiones.
  if (opts.hacerBackup ?? true) await respaldar(ref);

  const wb = await abrirLibro(ref);

  const hojaNombre = nombreHojaCashflow(opts.fecha);
  const ws = wb.getWorksheet(hojaNombre);
  if (!ws) {
    throw new Error(
      `No se encontró la hoja "${hojaNombre}" en ${CASHFLOW_FILE}. ` +
        `Hojas disponibles: ${wb.worksheets.map((s) => s.name).join(', ')}`,
    );
  }

  const col = buscarColumnaDia(ws, opts.fecha);
  if (!col) {
    throw new Error(
      `No se encontró la columna del día ${opts.fecha.toISOString().slice(0, 10)} ` +
        `en la hoja "${hojaNombre}". Asegurate de que la fila 2 tenga la fecha correcta.`,
    );
  }

  const cambios: SyncResult['cambios'] = [];
  const warnings: string[] = [];

  function setCelda(row: number, etiqueta: string, valor: number) {
    const cell = ws!.getCell(row, col!);
    const before = cell.value;
    if (typeof before === 'object' && before !== null && 'formula' in before) {
      warnings.push(
        `Celda ${cell.address} (${etiqueta}) tenía fórmula — la sobreescribimos con valor numérico.`,
      );
    }
    cell.value = Number(valor.toFixed(2));
    cell.numFmt = '#,##0.00';
    cambios.push({ celda: cell.address, etiqueta, valorAnterior: before, valorNuevo: valor });
  }

  // Categorías por turno
  const catManana = manana?.categorias ?? null;
  const catTarde = tarde?.categorias ?? null;

  // VENTA MAÑANA = efectivo en caja del turno (mostrador + plataformas efectivo)
  //   Damián va aparte en R10 REPARTO.
  // TARJETA MAÑANA = todo lo no-efectivo de mostrador/plataformas/delivery online.
  if (catManana) {
    setCelda(
      ROW_VENTA_MANANA,
      'VENTA MAÑANA (efectivo)',
      catManana.mostrador.efectivo + catManana.plataformas.efectivo,
    );
    setCelda(
      ROW_TARJETA_MANANA,
      'TARJETA MAÑANA',
      catManana.mostrador.debito +
        catManana.mostrador.creditoOtros +
        catManana.plataformas.app +
        catManana.delivery.online,
    );
  }
  if (catTarde) {
    setCelda(
      ROW_VENTA_TARDE,
      'VENTA TARDE (efectivo)',
      catTarde.mostrador.efectivo + catTarde.plataformas.efectivo,
    );
    setCelda(
      ROW_TARJETA_TARDE,
      'TARJETA TARDE',
      catTarde.mostrador.debito +
        catTarde.mostrador.creditoOtros +
        catTarde.plataformas.app +
        catTarde.delivery.online,
    );
  }

  // REPARTO = efectivo de Damián durante todo el día
  const reparto =
    (catManana?.delivery.efectivoDamian ?? 0) +
    (catTarde?.delivery.efectivoDamian ?? 0);
  setCelda(ROW_REPARTO, 'REPARTO (Damián)', reparto);

  // DIFERENCIAS DE CAJA = suma de diferencias de mañana + tarde
  const difManana = manana?.sesion.diferencia ? Number(manana.sesion.diferencia) : 0;
  const difTarde = tarde?.sesion.diferencia ? Number(tarde.sesion.diferencia) : 0;
  setCelda(ROW_DIFERENCIAS, 'DIFERENCIAS DE CAJA', difManana + difTarde);

  // DELIVERATE A COBRAR = efectivo de DELIVERATE (informativo, rinde semanal)
  const deliverate =
    (catManana?.delivery.efectivoDeliverate ?? 0) +
    (catTarde?.delivery.efectivoDeliverate ?? 0);
  setCelda(ROW_DELIVERATE, 'DELIVERATE A COBRAR', deliverate);

  await guardarLibro(ref, wb);

  return {
    // Con Drive no hay ruta de disco: se informa de dónde salió, que es lo que
    // la pantalla necesita mostrar ("se guardó en Drive" vs una ruta local).
    archivoPath: ref.origen === 'disco' ? ref.ruta : `Google Drive · ${ref.nombre}`,
    hoja: hojaNombre,
    columna: col,
    diaLabel: opts.fecha.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }),
    cambios,
    manana: catManana,
    tarde: catTarde,
    warnings,
  };
}
