/**
 * De dónde salen los Excels de la encargada.
 *
 * Los servicios que parsean (`excel-proveedores`, `excel-compras`,
 * `excel-writeback`) no tienen por qué saberlo: piden un archivo por nombre y
 * reciben bytes. Cambiar el origen fue agregar esta capa, no reescribir el
 * parseo.
 *
 * **Producción usa Google Drive.** El disco queda sólo como fallback para
 * desarrollo: sin él no se podría trabajar en la app sin credenciales de
 * Google. En un servidor de verdad, si Drive no está configurado, es un error
 * de configuración y conviene que se note.
 */

import ExcelJS from 'exceljs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, access } from 'node:fs/promises';
import { ReglaNegocioError } from './errores.js';
import { editarHojaEnBuffer, type EdicionCelda } from './xlsx-quirurgico.js';
import {
  configuracionIncompleta,
  driveConfigurado,
  buscarArchivo,
  descargarXlsx,
  subirXlsx,
  type ArchivoDrive,
} from './drive.js';

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.REPO_ROOT
  ? resolve(process.env.REPO_ROOT)
  : resolve(SERVICE_DIR, '../../../..');
const EXCEL_DIR = process.env.EXCEL_LOCAL_DIR ?? REPO_ROOT;

/** Referencia opaca a un archivo, sea de Drive o del disco. */
export type RefExcel =
  | { origen: 'drive'; archivo: ArchivoDrive; nombre: string }
  | { origen: 'disco'; ruta: string; nombre: string };

/** Dónde se está leyendo, para poder decirlo en los mensajes de error. */
export function origenExcel(): 'drive' | 'disco' {
  return driveConfigurado() ? 'drive' : 'disco';
}

/**
 * Media configuración de Drive es un error, no un fallback.
 *
 * Sin esto, olvidarse una de las dos variables haría que la app leyera
 * calladamente un archivo local viejo y todos los números salieran
 * desactualizados sin ningún síntoma.
 */
function exigirConfiguracionCoherente(): void {
  const falta = configuracionIncompleta();
  if (falta) throw new ReglaNegocioError(falta, 503);
}

/**
 * Ubica un archivo por nombre. Devuelve null si no existe — quien llama decide
 * si eso es un error o simplemente "todavía no lo subieron".
 */
export async function ubicar(nombre: string): Promise<RefExcel | null> {
  exigirConfiguracionCoherente();
  if (driveConfigurado()) {
    const archivo = await buscarArchivo(nombre);
    return archivo ? { origen: 'drive', archivo, nombre } : null;
  }
  const ruta = join(EXCEL_DIR, nombre);
  try {
    await access(ruta);
  } catch {
    return null;
  }
  return { origen: 'disco', ruta, nombre };
}

/** Igual que `ubicar`, pero explota con un mensaje que se entiende. */
export async function exigir(nombre: string): Promise<RefExcel> {
  const ref = await ubicar(nombre);
  if (ref) return ref;
  throw new ReglaNegocioError(
    driveConfigurado()
      ? `No se encontró "${nombre}" en la carpeta de Drive. Fijate que el nombre sea exacto y que el archivo esté compartido con la cuenta del sistema.`
      : `No se encontró "${nombre}". Configurá GOOGLE_SERVICE_ACCOUNT_JSON y GOOGLE_DRIVE_FOLDER_ID para leerlo de Drive, o dejá el archivo en ${EXCEL_DIR}.`,
    404,
  );
}

/** Abre el archivo con exceljs, venga de donde venga. */
export async function abrirLibro(ref: RefExcel): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  if (ref.origen === 'drive') {
    const buf = await descargarXlsx(ref.archivo);
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } else {
    await wb.xlsx.readFile(ref.ruta);
  }
  return wb;
}

/**
 * Guarda el libro donde estaba.
 *
 * En Drive queda como versión nueva del mismo archivo — el historial de
 * versiones de Drive sirve de red si algo sale mal, que es más de lo que daba
 * el `.bak` al lado del archivo en disco.
 */
export async function guardarLibro(ref: RefExcel, wb: ExcelJS.Workbook): Promise<void> {
  if (ref.origen === 'drive') {
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await subirXlsx(ref.archivo, buf);
  } else {
    await wb.xlsx.writeFile(ref.ruta);
  }
}

/** Copia de resguardo antes de escribir. Sólo aplica en disco. */
export async function respaldar(ref: RefExcel): Promise<void> {
  // En Drive no hace falta: guarda historial de versiones por su cuenta, y
  // dejar un "CASHFLOW 2026.bak.xlsx" al lado ensuciaría la carpeta de ella.
  if (ref.origen !== 'disco') return;
  try {
    const bak = ref.ruta.replace(/\.xlsx$/i, '.bak.xlsx');
    await writeFile(bak, await readFile(ref.ruta));
  } catch (e) {
    console.warn('[fuente-excel] no se pudo hacer backup:', e);
  }
}

/**
 * Edición quirúrgica: cambia sólo las celdas indicadas y deja el resto del
 * archivo intacto, venga de Drive o del disco.
 *
 * Importa más con Drive que con el disco: acá se reemplaza el archivo VIVO de
 * la encargada, así que reescribir el libro entero con exceljs —perdiendo
 * formato, gráficos o lo que exceljs no entienda— sería mucho peor que en una
 * copia local.
 */
export async function editarCeldas(
  ref: RefExcel,
  hoja: string,
  ediciones: EdicionCelda[],
  simular = false,
): Promise<{ celdasEscritas: number }> {
  if (ref.origen === 'disco') {
    const { editarHojaXlsx } = await import('./xlsx-quirurgico.js');
    const r = await editarHojaXlsx({ archivo: ref.ruta, hoja, ediciones, simular });
    return { celdasEscritas: r.celdasEscritas };
  }
  const contenido = await descargarXlsx(ref.archivo);
  const r = await editarHojaEnBuffer({ contenido, hoja, ediciones, simular });
  if (!simular && r.salida) await subirXlsx(ref.archivo, r.salida);
  return { celdasEscritas: r.celdasEscritas };
}
