/**
 * Editar celdas de UN .xlsx sin tocar nada más del archivo.
 *
 * ── Por qué no alcanza con exceljs ───────────────────────────────────────
 *
 * El writeback del CASHFLOW usa exceljs y está bien: ese archivo es nuestro.
 * "Proveedores 2026.xlsx" NO — es el cuaderno de trabajo de la encargada, con
 * diez hojas y notas suyas pegadas a las celdas.
 *
 * Se probó el round-trip de exceljs contra el archivo real: de 22.375 celdas
 * con valor no se perdió NINGUNA, y las fórmulas quedaron intactas. Pero al
 * comparar las PARTES del zip aparecieron las bajas:
 *
 *     xl/threadedComments/threadedComment1.xml   "a partir del 1/05/26"
 *     xl/threadedComments/threadedComment2.xml   "Los 88867 son para ajustar
 *                                                 una diferencia"
 *     xl/persons/person.xml
 *
 * Es decir: exceljs habría borrado en silencio las notas de la encargada.
 * Poco volumen, sí, pero es información que ella escribió y que nadie le
 * avisaría que desapareció. Un archivo ajeno no se reescribe entero.
 *
 * ── Qué hace esto en cambio ──────────────────────────────────────────────
 *
 * Un .xlsx es un zip. Se copian TODAS las entradas tal cual y se reemplaza
 * únicamente el XML de la hoja pedida, cambiando en él sólo las celdas
 * indicadas. Comentarios, dibujos, estilos, hojas vecinas y metadatos quedan
 * exactamente como estaban.
 *
 * Alcance a propósito limitado: sólo se escriben NÚMEROS y FÓRMULAS. No hace
 * falta más (lo que se vuelca son importes) y así se evita tener que tocar
 * `sharedStrings.xml`, que es donde esto se pondría frágil.
 */

import JSZip from 'jszip';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

/** Una celda a escribir: número suelto o fórmula (sin el `=` inicial). */
export type ValorCelda =
  | { tipo: 'numero'; valor: number }
  | { tipo: 'formula'; formula: string; resultado: number };

export interface EdicionCelda {
  /** Referencia A1, ej. "AG5". */
  ref: string;
  valor: ValorCelda;
}

function escaparXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "AG5" → { col: "AG", fila: 5 } */
export function partirRef(ref: string): { col: string; fila: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`Referencia de celda inválida: ${ref}`);
  return { col: m[1]!, fila: Number(m[2]) };
}

/** "AG" → 33 (1-indexed), para ordenar celdas dentro de una fila. */
export function colANumero(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** El XML de una celda ya armada. */
function xmlCelda(ref: string, valor: ValorCelda, atributosPrevios: string): string {
  // Se conservan los atributos que ya tenía la celda (sobre todo `s`, el
  // índice de estilo): si se pierden, el número aparece sin formato de moneda
  // y con otra tipografía, y la planilla se ve rota aunque el dato esté bien.
  //
  // El tipo `t` sí se saca: la celda pasa a ser numérica, y un `t="s"`
  // heredado de un texto anterior haría que Excel lea el número como índice
  // de sharedStrings y muestre cualquier cosa.
  const attrs = atributosPrevios.replace(/\s+t="[^"]*"/g, '').trim();
  const cabecera = `<c r="${ref}"${attrs ? ' ' + attrs : ''}>`;
  if (valor.tipo === 'formula') {
    return `${cabecera}<f>${escaparXml(valor.formula)}</f><v>${valor.resultado}</v></c>`;
  }
  return `${cabecera}<v>${valor.valor}</v></c>`;
}

/**
 * Aplica las ediciones sobre el XML de una hoja.
 *
 * Tres casos, y los tres importan:
 *   - la celda existe            → se reemplaza conservando sus atributos;
 *   - la celda no existe pero sí su fila → se inserta EN ORDEN de columna;
 *   - la fila no existe          → se inserta la fila entera, en orden.
 *
 * El orden no es cosmético: Excel exige que las celdas de una fila estén por
 * columna creciente y las filas por número creciente. Fuera de orden, Excel
 * declara el archivo dañado y ofrece "reparar" — que es perder cosas.
 */
export function aplicarEdiciones(xml: string, ediciones: EdicionCelda[]): string {
  let out = xml;

  for (const ed of ediciones) {
    const { fila } = partirRef(ed.ref);

    // ¿Existe la celda?
    const reCelda = new RegExp(`<c r="${ed.ref}"([^>]*?)(/>|>[\\s\\S]*?</c>)`);
    const mCelda = reCelda.exec(out);
    if (mCelda) {
      const attrs = mCelda[1] ?? '';
      out = out.slice(0, mCelda.index) + xmlCelda(ed.ref, ed.valor, attrs) +
        out.slice(mCelda.index + mCelda[0].length);
      continue;
    }

    // ¿Existe la fila?
    const reFila = new RegExp(`<row r="${fila}"([^>]*?)(/>|>([\\s\\S]*?)</row>)`);
    const mFila = reFila.exec(out);
    const nuevaCelda = xmlCelda(ed.ref, ed.valor, '');
    if (mFila) {
      const attrs = mFila[1] ?? '';
      const cuerpo = mFila[3] ?? '';
      // Insertar la celda en su posición por número de columna.
      const refs = [...cuerpo.matchAll(/<c r="([A-Z]+\d+)"/g)].map((m) => m[1]!);
      const miNum = colANumero(partirRef(ed.ref).col);
      const siguiente = refs.find((r) => colANumero(partirRef(r).col) > miNum);
      let cuerpoNuevo: string;
      if (siguiente) {
        const idx = cuerpo.indexOf(`<c r="${siguiente}"`);
        cuerpoNuevo = cuerpo.slice(0, idx) + nuevaCelda + cuerpo.slice(idx);
      } else {
        cuerpoNuevo = cuerpo + nuevaCelda;
      }
      out = out.slice(0, mFila.index) +
        `<row r="${fila}"${attrs}>${cuerpoNuevo}</row>` +
        out.slice(mFila.index + mFila[0].length);
      continue;
    }

    // No existe la fila: insertarla en orden dentro de <sheetData>.
    const filas = [...out.matchAll(/<row r="(\d+)"/g)].map((m) => ({
      n: Number(m[1]),
      idx: m.index!,
    }));
    const nuevaFila = `<row r="${fila}">${nuevaCelda}</row>`;
    const posterior = filas.find((f) => f.n > fila);
    if (posterior) {
      out = out.slice(0, posterior.idx) + nuevaFila + out.slice(posterior.idx);
    } else {
      const cierre = out.lastIndexOf('</sheetData>');
      if (cierre < 0) throw new Error('La hoja no tiene <sheetData>');
      out = out.slice(0, cierre) + nuevaFila + out.slice(cierre);
    }
  }

  // Los valores cacheados de las fórmulas que dependen de lo que tocamos
  // quedan viejos. Con fullCalcOnLoad, Excel recalcula todo al abrir y las
  // columnas "Arranco la…" y la fila TOTAL muestran el número correcto.
  // Sin esto se vería el saldo viejo hasta que alguien editara una celda.
  if (/<sheetCalcPr\b/.test(out)) {
    out = out.replace(/<sheetCalcPr\b[^>]*\/>/, '<sheetCalcPr fullCalcOnLoad="1"/>');
  } else {
    out = out.replace('</worksheet>', '<sheetCalcPr fullCalcOnLoad="1"/></worksheet>');
  }
  return out;
}

/** Nombre de hoja → ruta del XML dentro del zip (`xl/worksheets/sheetN.xml`). */
export async function rutaDeHoja(zip: JSZip, nombreHoja: string): Promise<string | null> {
  const wb = await zip.file('xl/workbook.xml')?.async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!wb || !rels) return null;

  const mapaRel = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const attrs = m[1]!;
    const id = /Id="([^"]+)"/.exec(attrs)?.[1];
    const target = /Target="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) mapaRel.set(id, target);
  }

  for (const m of wb.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = m[1]!;
    const nombre = /name="([^"]+)"/.exec(attrs)?.[1];
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1];
    if (nombre !== nombreHoja || !rid) continue;
    const target = mapaRel.get(rid);
    if (!target) return null;
    return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  return null;
}

/**
 * Lee el .xlsx, cambia sólo las celdas pedidas de una hoja y lo guarda.
 *
 * La escritura va a un temporal y recién después se renombra sobre el
 * original: si el proceso se muere a mitad, el archivo de la encargada sigue
 * entero en vez de quedar truncado. En una carpeta sincronizada esto además
 * evita que Drive suba un archivo a medio escribir.
 */
export async function editarHojaXlsx(opts: {
  archivo: string;
  hoja: string;
  ediciones: EdicionCelda[];
  /** Si es true, calcula todo pero NO escribe. */
  simular?: boolean;
}): Promise<{ hojaXml: string; celdasEscritas: number }> {
  const buf = await readFile(opts.archivo);
  const zip = await JSZip.loadAsync(buf);

  const ruta = await rutaDeHoja(zip, opts.hoja);
  if (!ruta) throw new Error(`El archivo no tiene una hoja llamada "${opts.hoja}"`);

  const xml = await zip.file(ruta)!.async('string');
  const nuevo = aplicarEdiciones(xml, opts.ediciones);

  if (opts.simular) return { hojaXml: ruta, celdasEscritas: opts.ediciones.length };

  zip.file(ruta, nuevo);
  // DEFLATE como el original: sin compresión el archivo se triplica y la
  // sincronización de Drive se vuelve pesada al pedo.
  const salida = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const tmp = join(dirname(opts.archivo), `.~${basename(opts.archivo)}.tmp`);
  await writeFile(tmp, salida);
  await rename(tmp, opts.archivo);

  return { hojaXml: ruta, celdasEscritas: opts.ediciones.length };
}
