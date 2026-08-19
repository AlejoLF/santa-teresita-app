/**
 * La hoja `Compras`: el catálogo de compra de la encargada.
 *
 * ── Cómo está armada ─────────────────────────────────────────────────────
 *
 *     A                      B              C        D         E ...
 *     ─────────────────────  ─────────────  ───────  ────────  ──────────
 *     VERDULERIA                                               SEM. 05/01   ← proveedor (NEGRITA)
 *     Calabaza               bolsa          16000    x 1,6     1            ← producto
 *     Cebollon               bolsa          18000              1
 *     FREE VEGETALES                                                        ← otro proveedor
 *     Acelga                 ...
 *
 * 22 proveedores y 338 productos, cada uno con presentación y precio, y una
 * columna por semana con la CANTIDAD pedida. Las columnas TOTAL (ENERO,
 * FEBRERO…) son fórmulas de suma — no se tocan.
 *
 * ── Tres reglas para leerla sin traer basura ─────────────────────────────
 *
 * 1. El proveedor es la fila en NEGRITA. Es el único formato que los separa;
 *    no hay columna que lo diga.
 * 2. Un encabezado en negrita cuyo texto es un NÚMERO no es un proveedor: de
 *    la fila 387 para abajo la hoja cambia de tema y pasa a costear recetas
 *    (TIRAMISU, CHEESCAKE, LEMON PIE…), donde la columna A son importes.
 * 3. Un ítem cuya columna A es un número tampoco es un producto, por lo mismo.
 *
 * Con esas tres reglas la lectura da exactamente los 22 proveedores reales y
 * descarta los 5 bloques de recetas. Sin ellas entraban al sistema insumos
 * llamados "2888.888889".
 */

import ExcelJS from 'exceljs';
import { access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '@sta/db/client';
import { CategoriaInsumo, UnidadCompra } from '@sta/db';
import { editarHojaXlsx, type EdicionCelda } from './xlsx-quirurgico.js';
import { normalizarNombre } from './proveedor-match.js';

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.REPO_ROOT
  ? resolve(process.env.REPO_ROOT)
  : resolve(SERVICE_DIR, '../../../..');
const EXCEL_DIR = process.env.EXCEL_LOCAL_DIR ?? REPO_ROOT;

const ARCHIVO = 'Proveedores 2026.xlsx';
const HOJA = 'Compras';
const COL_NOMBRE = 1;
const COL_PRESENTACION = 2;
const COL_PRECIO = 3;
/** Fila con las etiquetas de semana ("SEM. 05/01") y de mes ("ENERO"). */
const FILA_SEMANAS = 2;
const FILA_TITULOS = 1;

export interface ProductoCompras {
  fila: number;
  nombre: string;
  presentacion: string | null;
  precio: number | null;
}
export interface BloqueProveedor {
  proveedor: string;
  filaEncabezado: number;
  productos: ProductoCompras[];
}
export interface SemanaCompras {
  col: string;
  etiqueta: string;
  desde: Date;
  hasta: Date;
}

function esNumero(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'number') return true;
  const s = String(v).trim().replace(',', '.');
  return s !== '' && Number.isFinite(Number(s));
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

function numeroDeCelda(v: ExcelJS.CellValue): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'result' in v && typeof v.result === 'number') return v.result;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function numeroACol(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Proveedores y sus productos, tal como están en la hoja. */
export function leerBloques(ws: ExcelJS.Worksheet): BloqueProveedor[] {
  const out: BloqueProveedor[] = [];
  let actual: BloqueProveedor | null = null;

  for (let r = 3; r <= ws.rowCount; r++) {
    const celda = ws.getCell(r, COL_NOMBRE);
    const texto = textoDeCelda(celda.value).trim();
    if (!texto) continue;

    if (celda.font?.bold) {
      // Regla 2: un encabezado numérico es un costo de receta, no un proveedor.
      actual = esNumero(texto) ? null : { proveedor: texto, filaEncabezado: r, productos: [] };
      if (actual) out.push(actual);
      continue;
    }
    // Regla 3: un ítem numérico es un ingrediente costeado, no un producto.
    if (!actual || esNumero(texto)) continue;

    actual.productos.push({
      fila: r,
      nombre: texto,
      presentacion: textoDeCelda(ws.getCell(r, COL_PRESENTACION).value).trim() || null,
      precio: numeroDeCelda(ws.getCell(r, COL_PRECIO).value),
    });
  }

  // Un bloque sin un solo precio no es una lista de compra. Filtra los restos
  // de la zona de recetas que igual hubieran pasado los dos filtros de arriba.
  return out.filter((b) => b.productos.some((p) => p.precio != null));
}

/**
 * Las columnas semanales ("SEM. 05/01").
 *
 * Se saltean las columnas TOTAL (ENERO, FEBRERO…): son fórmulas de suma y
 * escribir ahí rompería el total del mes.
 *
 * El año se resuelve como en la hoja `Deudas`: recorriendo en orden y sumando
 * uno cuando el mes retrocede, porque el encabezado no lo trae.
 */
export function leerSemanasCompras(ws: ExcelJS.Worksheet, anio: number): SemanaCompras[] {
  const out: SemanaCompras[] = [];
  let anioActual = anio;
  let mesPrevio = 0;

  for (let c = 2; c <= ws.columnCount; c++) {
    const titulo = textoDeCelda(ws.getCell(FILA_TITULOS, c).value).trim().toUpperCase();
    if (titulo !== 'PEDIDO') continue; // TOTAL y demás quedan afuera

    const bruto = ws.getCell(FILA_SEMANAS, c).value;
    let dia: number;
    let mes: number;
    let etiqueta: string;

    // Las últimas once columnas —todo diciembre— tienen el encabezado
    // guardado como FECHA en vez de como texto "SEM. 22/12": alguien lo
    // tipeó de una forma que Excel interpretó como fecha. Y los años que
    // quedaron son basura (2024 y 2025 mezclados en el mismo diciembre).
    //
    // Se toma el día y el mes, que sí son correctos, y el año lo pone la
    // secuencia igual que para el resto. Sin esto, diciembre entero quedaba
    // sin columna reconocida y no se podía volcar una sola compra del mes.
    const comoFecha =
      bruto instanceof Date
        ? bruto
        : bruto && typeof bruto === 'object' && 'result' in bruto && bruto.result instanceof Date
          ? (bruto.result as Date)
          : null;

    if (comoFecha) {
      dia = comoFecha.getDate();
      mes = comoFecha.getMonth() + 1;
      etiqueta = `SEM. ${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}`;
    } else {
      etiqueta = textoDeCelda(bruto).trim();
      const m = /(\d{1,2})\/(\d{1,2})/.exec(etiqueta);
      if (!m) continue;
      dia = Number(m[1]);
      mes = Number(m[2]);
    }

    if (mesPrevio && mes < mesPrevio) anioActual += 1;
    mesPrevio = mes;
    const desde = new Date(anioActual, mes - 1, dia);
    // La semana va del lunes rotulado hasta el domingo siguiente. La hoja
    // rotula el inicio; el fin se deduce sumando 6 días.
    const hasta = new Date(anioActual, mes - 1, dia + 6, 23, 59, 59, 999);
    out.push({ col: numeroACol(c), etiqueta, desde, hasta });
  }
  return out;
}

/** Categoría razonable a partir del nombre del proveedor/rubro. */
function categoriaDe(proveedor: string, producto: string): CategoriaInsumo {
  const t = `${proveedor} ${producto}`.toLowerCase();
  if (/verduler|verdura|vegetal/.test(t)) return CategoriaInsumo.VERDULERIA;
  if (/queso|lacte|crema|leche|muzzarel|manteca/.test(t)) return CategoriaInsumo.LACTEOS;
  if (/carnicer|carne|bondiola|panceta|jamon|fiambre/.test(t)) return CategoriaInsumo.CARNES;
  if (/pollo|avicola/.test(t)) return CategoriaInsumo.POLLO;
  if (/huevo/.test(t)) return CategoriaInsumo.HUEVOS;
  if (/harina|semol|masa/.test(t)) return CategoriaInsumo.HARINAS;
  if (/condiment|especia/.test(t)) return CategoriaInsumo.CONDIMENTOS;
  if (/envase|grafipack|polibol|bandeja|film/.test(t)) return CategoriaInsumo.ENVASES;
  if (/limpieza|detergente|lavandina/.test(t)) return CategoriaInsumo.LIMPIEZA;
  if (/bebida|vino|cerveza|gaseosa|agua/.test(t)) return CategoriaInsumo.BEBIDAS;
  if (/sin tacc|celia/.test(t)) return CategoriaInsumo.SIN_TACC;
  if (/postre|pastelera|torta|tiramisu/.test(t)) return CategoriaInsumo.POSTRES;
  return CategoriaInsumo.OTROS;
}

/** Unidad de compra a partir de la presentación ("bolsa", "5 Lts.", "kgs."). */
export function unidadDe(presentacion: string | null): UnidadCompra {
  const t = (presentacion ?? '').toLowerCase();
  if (/\bkgs?\b|\bkilo/.test(t)) return UnidadCompra.KG;
  if (/\bgr\b|\bgrs\b|gramo/.test(t)) return UnidadCompra.GRAMOS;
  if (/\blts?\b|litro/.test(t)) return UnidadCompra.LITRO;
  if (/caja/.test(t)) return UnidadCompra.CAJA;
  if (/bolsa/.test(t)) return UnidadCompra.BOLSA;
  if (/paq/.test(t)) return UnidadCompra.PAQUETE;
  if (/docena|maple/.test(t)) return UnidadCompra.DOCENA;
  if (/unidad|atado/.test(t)) return UnidadCompra.UNIDAD;
  return UnidadCompra.OTRO;
}

export interface ResultadoImportacion {
  proveedoresNuevos: string[];
  proveedoresExistentes: string[];
  insumosCreados: number;
  insumosActualizados: number;
  preciosCargados: number;
  sinPrecio: string[];
  /**
   * Productos que figuran DOS VECES en la hoja bajo el mismo proveedor. Se
   * importa uno solo (el de más arriba), pero hay que decirlo: la fila de
   * abajo nunca va a recibir cantidades y la encargada la va a ver siempre
   * vacía sin entender por qué.
   */
  duplicadosEnExcel: string[];
  simulado: boolean;
}

/**
 * Trae a los proveedores y sus productos de la hoja `Compras` al sistema.
 *
 * Idempotente: se identifica cada insumo por (proveedor, nombre en el Excel),
 * así que correrlo dos veces actualiza en vez de duplicar. Es a propósito —
 * la encargada agrega productos a la hoja seguido y esto se va a correr cada
 * tanto, no una sola vez.
 *
 * El precio de la hoja se carga como `precioUltimo` del vínculo
 * insumo-proveedor: es el punto de comparación con el que después se detecta
 * un aumento cuando llega una factura.
 */
export async function importarCompras(opts: {
  simular?: boolean;
}): Promise<ResultadoImportacion> {
  const ruta = join(EXCEL_DIR, ARCHIVO);
  try {
    await access(ruta);
  } catch {
    throw new Error(
      `No encuentro "${ARCHIVO}" en ${EXCEL_DIR}. ` +
        'Configurá EXCEL_LOCAL_DIR apuntando a la carpeta sincronizada de Drive.',
    );
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ruta);
  const ws = wb.getWorksheet(HOJA);
  if (!ws) throw new Error(`El archivo no tiene la hoja "${HOJA}"`);

  const bloques = leerBloques(ws);
  const res: ResultadoImportacion = {
    proveedoresNuevos: [],
    proveedoresExistentes: [],
    insumosCreados: 0,
    insumosActualizados: 0,
    preciosCargados: 0,
    sinPrecio: [],
    duplicadosEnExcel: [],
    simulado: Boolean(opts.simular),
  };

  const proveedores = await prisma.proveedor.findMany({
    select: { id: true, nombre: true, razonSocial: true },
  });
  // Índice por nombre normalizado: en la hoja están en MAYÚSCULAS
  // ("CAMPODONICO") y en el sistema con el nombre de todos los días
  // ("Campodonico"). Sin normalizar se duplicaba cada proveedor.
  const porNombre = new Map(proveedores.map((p) => [normalizarNombre(p.nombre), p]));

  for (const bloque of bloques) {
    const vistos = new Set<string>();
    for (const p of bloque.productos) {
      if (vistos.has(p.nombre)) res.duplicadosEnExcel.push(`${bloque.proveedor} / ${p.nombre}`);
      vistos.add(p.nombre);
    }
    const clave = normalizarNombre(bloque.proveedor);
    let prov = porNombre.get(clave);
    if (prov) {
      res.proveedoresExistentes.push(bloque.proveedor);
    } else {
      res.proveedoresNuevos.push(bloque.proveedor);
      if (!opts.simular) {
        const creado = await prisma.proveedor.create({
          data: { nombre: bloque.proveedor, categoriaPrincipal: bloque.proveedor },
        });
        prov = { id: creado.id, nombre: creado.nombre, razonSocial: creado.razonSocial };
        porNombre.set(clave, prov);
      }
    }
    if (!prov) continue; // simulación: no hay id todavía

    for (const p of bloque.productos) {
      if (p.precio == null) res.sinPrecio.push(`${bloque.proveedor} / ${p.nombre}`);

      const existente = await prisma.insumo.findFirst({
        where: { proveedorPrincipalId: prov.id, nombreExcelCompras: p.nombre },
        select: { id: true },
      });

      if (existente) {
        res.insumosActualizados += 1;
        if (!opts.simular) {
          await prisma.insumo.update({
            where: { id: existente.id },
            data: {
              presentacion: p.presentacion,
              unidadCompra: unidadDe(p.presentacion),
            },
          });
        }
      } else {
        res.insumosCreados += 1;
      }

      if (opts.simular) continue;

      const insumoId =
        existente?.id ??
        (
          await prisma.insumo.create({
            data: {
              nombre: p.nombre,
              nombreExcelCompras: p.nombre,
              categoria: categoriaDe(bloque.proveedor, p.nombre),
              unidadCompra: unidadDe(p.presentacion),
              presentacion: p.presentacion,
              proveedorPrincipalId: prov.id,
            },
          })
        ).id;

      // El vínculo insumo-proveedor se crea SIEMPRE, tenga precio o no.
      //
      // Antes se creaba sólo si la hoja traía precio, y eso dejaba un
      // catch-22: el producto sin precio no aparecía en la pestaña "Insumos"
      // del proveedor —que filtra por vínculo— o sea justo en la pantalla
      // donde alguien iría a cargarle el precio que le falta.
      if (p.precio != null) res.preciosCargados += 1;
      await prisma.insumoProveedor.upsert({
        where: { insumoId_proveedorId: { insumoId, proveedorId: prov.id } },
        create: {
          insumoId,
          proveedorId: prov.id,
          precioUltimo: p.precio != null ? p.precio.toFixed(2) : null,
          fechaUltimoPrecio: p.precio != null ? new Date() : null,
          esPrincipal: true,
        },
        // El precio del Excel NO pisa uno que ya venga de una factura: la
        // factura es el dato duro y la hoja puede estar desactualizada.
        update: {},
      });
    }
  }
  return res;
}

export interface CeldaCantidad {
  insumo: string;
  proveedor: string;
  ref: string;
  cantidad: number;
  valorPrevio: number | null;
  estado: 'NUEVA' | 'IGUAL' | 'DIFERENCIA';
}

/**
 * Escribe en la hoja `Compras` las cantidades compradas de la semana.
 *
 * Sale de los ítems de las facturas del período que ya estén vinculados a un
 * insumo (`FacturaItemRecibida.insumoId`). Los ítems sueltos —los que el OCR
 * no supo a qué insumo corresponden— se informan aparte en vez de inventarles
 * una fila: escribir una cantidad en el renglón equivocado es peor que no
 * escribirla.
 *
 * Igual que en `Deudas`, no pisa lo que ella cargó a mano.
 */
export async function volcarCantidadesCompras(opts: {
  fecha?: Date;
  simular?: boolean;
  pisarDiferencias?: boolean;
}): Promise<{
  semana: string;
  celdas: CeldaCantidad[];
  escritas: number;
  diferencias: number;
  itemsSinInsumo: Array<{ descripcion: string; proveedor: string; cantidad: number }>;
  simulado: boolean;
}> {
  const fecha = opts.fecha ?? new Date();
  const ruta = join(EXCEL_DIR, ARCHIVO);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ruta);
  const ws = wb.getWorksheet(HOJA);
  if (!ws) throw new Error(`El archivo no tiene la hoja "${HOJA}"`);

  const semanas = leerSemanasCompras(ws, fecha.getFullYear());
  const semana = semanas.find((s) => fecha >= s.desde && fecha <= s.hasta);
  if (!semana) {
    throw new Error(
      `La hoja Compras no tiene columna para la semana del ${fecha.toLocaleDateString('es-AR')}.`,
    );
  }

  const items = await prisma.facturaItemRecibida.findMany({
    where: {
      factura: {
        fechaComputo: { gte: semana.desde, lte: semana.hasta },
        estado: { not: 'ANULADA' },
      },
    },
    select: {
      insumoId: true,
      descripcion: true,
      cantidad: true,
      factura: { select: { proveedorId: true, proveedor: { select: { nombre: true } } } },
    },
  });

  const itemsSinInsumo = items
    .filter((i) => !i.insumoId)
    .map((i) => ({
      descripcion: i.descripcion,
      proveedor: i.factura.proveedor.nombre,
      cantidad: Number(i.cantidad),
    }));

  // Sumar por insumo: una semana puede traer dos facturas del mismo producto.
  const porInsumo = new Map<string, number>();
  for (const i of items) {
    if (!i.insumoId) continue;
    porInsumo.set(i.insumoId, (porInsumo.get(i.insumoId) ?? 0) + Number(i.cantidad));
  }

  const insumos = await prisma.insumo.findMany({
    where: { id: { in: [...porInsumo.keys()] } },
    select: {
      id: true,
      nombre: true,
      nombreExcelCompras: true,
      proveedorPrincipal: { select: { nombre: true } },
    },
  });

  // Índice nombre-en-el-Excel → fila, sobre los bloques leídos.
  const filaPorNombre = new Map<string, number>();
  for (const b of leerBloques(ws)) {
    for (const p of b.productos) {
      const k = `${normalizarNombre(b.proveedor)}|${p.nombre}`;
      if (!filaPorNombre.has(k)) filaPorNombre.set(k, p.fila);
    }
  }

  const celdas: CeldaCantidad[] = [];
  for (const ins of insumos) {
    if (!ins.nombreExcelCompras || !ins.proveedorPrincipal) continue;
    const fila = filaPorNombre.get(
      `${normalizarNombre(ins.proveedorPrincipal.nombre)}|${ins.nombreExcelCompras}`,
    );
    if (fila == null) continue;
    const ref = `${semana.col}${fila}`;
    const cantidad = Math.round((porInsumo.get(ins.id) ?? 0) * 1000) / 1000;
    const previo = numeroDeCelda(ws.getCell(ref).value);
    const estado: CeldaCantidad['estado'] =
      previo == null || previo === 0
        ? 'NUEVA'
        : Math.abs(previo - cantidad) < 0.001
          ? 'IGUAL'
          : 'DIFERENCIA';
    celdas.push({
      insumo: ins.nombre,
      proveedor: ins.proveedorPrincipal.nombre,
      ref,
      cantidad,
      valorPrevio: previo,
      estado,
    });
  }

  const aEscribir = celdas.filter(
    (c) => c.estado === 'NUEVA' || (c.estado === 'DIFERENCIA' && opts.pisarDiferencias),
  );
  const ediciones: EdicionCelda[] = aEscribir.map((c) => ({
    ref: c.ref,
    valor: { tipo: 'numero' as const, valor: c.cantidad },
  }));

  if (!opts.simular && ediciones.length > 0) {
    await editarHojaXlsx({ archivo: ruta, hoja: HOJA, ediciones });
  }

  return {
    semana: semana.etiqueta,
    celdas,
    escritas: opts.simular ? 0 : ediciones.length,
    diferencias: celdas.filter((c) => c.estado === 'DIFERENCIA').length,
    itemsSinInsumo,
    simulado: Boolean(opts.simular),
  };
}

/**
 * Escribe el precio nuevo de un insumo en la columna C de la hoja `Compras`.
 * Lo usa la aprobación de una alerta de aumento: el sistema y el Excel tienen
 * que quedar diciendo lo mismo, si no la encargada sigue pidiendo con el
 * precio viejo.
 */
/**
 * Con qué reemplazar la celda de precio, respetando cómo la escribió ella.
 *
 * La encargada no carga el precio final: carga el neto y le suma el IVA en la
 * misma celda (`=115850*1.21`). Pisar eso con el número pelado le saca de la
 * vista el neto —el número con el que realmente negocia con el proveedor— y
 * cada aumento aprobado degradaría una celda más, hasta que la columna entera
 * queda sin rastro de cómo se formó.
 *
 * Así que si la celda tenía una fórmula `neto * coeficiente`, se reescribe con
 * el mismo coeficiente y el neto nuevo. Sólo si el neto da exacto a los
 * centavos: si no cierra, vale más el número correcto que la forma linda, y se
 * escribe el precio pelado.
 */
export function valorParaPrecio(
  valorPrevio: ExcelJS.CellValue,
  precioNuevo: number,
): EdicionCelda['valor'] {
  const formula =
    valorPrevio && typeof valorPrevio === 'object' && 'formula' in valorPrevio
      ? String((valorPrevio as { formula: string }).formula)
      : null;
  const m = formula?.match(/^\s*=?\s*([0-9]+(?:\.[0-9]+)?)\s*\*\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
  if (m) {
    const coef = Number(m[2]);
    if (coef > 0) {
      const neto = Math.round((precioNuevo / coef) * 100) / 100;
      // Round-trip: si el neto redondeado no reproduce el precio al centavo,
      // la fórmula mentiría por una fracción y eso es peor que perder la forma.
      if (Math.abs(neto * coef - precioNuevo) < 0.005) {
        return { tipo: 'formula', formula: `${neto}*${m[2]}`, resultado: precioNuevo };
      }
    }
  }
  return { tipo: 'numero', valor: precioNuevo };
}

export async function actualizarPrecioEnExcel(args: {
  proveedorNombre: string;
  nombreExcel: string;
  precioNuevo: number;
}): Promise<{ ref: string } | null> {
  const ruta = join(EXCEL_DIR, ARCHIVO);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ruta);
  const ws = wb.getWorksheet(HOJA);
  if (!ws) return null;

  for (const b of leerBloques(ws)) {
    if (normalizarNombre(b.proveedor) !== normalizarNombre(args.proveedorNombre)) continue;
    const p = b.productos.find((x) => x.nombre === args.nombreExcel);
    if (!p) continue;
    const ref = `${numeroACol(COL_PRECIO)}${p.fila}`;
    await editarHojaXlsx({
      archivo: ruta,
      hoja: HOJA,
      ediciones: [{ ref, valor: valorParaPrecio(ws.getCell(ref).value, args.precioNuevo) }],
    });
    return { ref };
  }
  return null;
}
