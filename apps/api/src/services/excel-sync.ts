/**
 * Sincronización de Excels — detección de cambios + aprobación.
 *
 * Flujo:
 *   1. detectarCambios* lee el archivo Excel (vía parsers Python en tools/)
 *      y produce un diff contra el estado actual de la DB.
 *   2. El diff se guarda en AprobacionExcel.diff (JSONB) con estado PENDIENTE.
 *   3. La encargada/admin revisa el diff en /admin/precios y aplica/rechaza.
 *
 * v1: solo lectura local. La integración con Google Drive (poll por
 *     cambios remotos) se enchufa en v2 reusando este mismo servicio.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { stat, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prisma } from '@sta/db/client';
import {
  EstadoAprobacionExcel,
  FuenteSyncExcel,
  type AprobacionExcel,
} from '@sta/db';

const execFileAsync = promisify(execFile);

// ────────────────────────────────────────────────────────────────────────
//   Paths y config
// ────────────────────────────────────────────────────────────────────────

// __dirname para ESM
const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));

// Resolver el root del repo:
//   - en dev (tsx): este archivo está en apps/api/src/services → ../../../..
//   - en build (dist): apps/api/dist/services → ../../../..
// En ambos casos, 4 niveles arriba = repo root.
const REPO_ROOT = process.env.REPO_ROOT
  ? resolve(process.env.REPO_ROOT)
  : resolve(SERVICE_DIR, '../../../..');

const TOOLS_DIR = process.env.TOOLS_DIR ?? join(REPO_ROOT, 'tools');
const EXCEL_DIR = process.env.EXCEL_LOCAL_DIR ?? REPO_ROOT;
const PYTHON_CMD = process.env.PYTHON_CMD ?? 'python';

// Sanity check al boot: si los paths no resuelven, mejor fallar temprano.
async function verificarPaths(): Promise<void> {
  try {
    await access(TOOLS_DIR);
  } catch {
    console.warn(
      `[excel-sync] TOOLS_DIR no existe: ${TOOLS_DIR}. ` +
        `Setealo via TOOLS_DIR si los Excels y scripts están en otro path.`,
    );
  }
}
void verificarPaths();

// ────────────────────────────────────────────────────────────────────────
//   Tipos del diff
// ────────────────────────────────────────────────────────────────────────

export interface CambioPrecio {
  tipo: 'PRECIO_CAMBIA';
  productoId: string;
  codigo: string | null;
  nombreProducto: string;
  categoria: string;
  precioAnterior: string;
  precioNuevo: string;
  deltaPct: number;
  /** Identificador único dentro del diff para el UI (selecciones parciales). */
  cambioId: string;
}

export interface ProductoSospechoso {
  tipo: 'PRODUCTO_NO_ENCONTRADO';
  codigo: string | null;
  nombreSugerido: string;
  categoria: string | null;
  precioPropuesto: string;
  formaVenta: string;
  unidadPrecio: string;
  /** Match aproximado por nombre, si lo hay (typo del LLM, etc.). */
  posibleMatchId: string | null;
  posibleMatchNombre: string | null;
  cambioId: string;
}

export interface ErrorExcel {
  tipo: 'PRECIO_NEGATIVO' | 'PRECIO_VACIO' | 'CODIGO_DUPLICADO' | 'OTRO';
  mensaje: string;
  contexto: Record<string, unknown> | null;
}

export interface DiffExcel {
  fuente: FuenteSyncExcel;
  archivoNombre: string;
  /** Cambios aplicables: producto en DB, precio cambia. */
  cambios: CambioPrecio[];
  /** Productos en Excel que no matchean con el catálogo. */
  sospechosos: ProductoSospechoso[];
  /** Filas con problemas que no se aplican. */
  errores: ErrorExcel[];
  /** Resumen para mostrar en headers / contadores. */
  resumen: {
    cambiosAplicables: number;
    sospechosos: number;
    errores: number;
    sinCambios: number;
  };
}

// ────────────────────────────────────────────────────────────────────────
//   Runner del parser Python
// ────────────────────────────────────────────────────────────────────────

interface ProductoParseado {
  codigo: string | null;
  tipo_categoria: string;
  tipo_nombre: string;
  nombre: string;
  marca?: string | null;
  presentacion?: string | null;
  forma_venta: string;
  unidad_precio: string;
  precio_base: string;
  cantidad_default: number | null;
}

interface SeedJSON {
  productos: ProductoParseado[];
  _meta?: Record<string, unknown>;
}

async function runPythonParser(scriptName: string, excelPath: string): Promise<SeedJSON> {
  const tmpOutput = join(tmpdir(), `sta-excel-${randomUUID()}.json`);
  const scriptPath = join(TOOLS_DIR, scriptName);
  try {
    await execFileAsync(
      PYTHON_CMD,
      [scriptPath, '--excel', excelPath, '--output', tmpOutput],
      { cwd: REPO_ROOT, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err) {
    const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message: string };
    const stderr = e.stderr?.toString() ?? '';
    throw new Error(
      `Parser ${scriptName} falló: ${stderr.trim() || e.message}. ` +
        `¿Está python instalado y openpyxl en el PYTHONPATH?`,
    );
  }
  const raw = await readFile(tmpOutput, 'utf-8');
  return JSON.parse(raw) as SeedJSON;
}

// ────────────────────────────────────────────────────────────────────────
//   Helpers de matching
// ────────────────────────────────────────────────────────────────────────

interface ProductoDB {
  id: string;
  codigo: string | null;
  nombre: string;
  precioBase: { toString(): string };
  categoria: string;
}

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function similitud(a: string, b: string): number {
  // Jaccard simple sobre tokens normalizados.
  const ta = new Set(normalizar(a).split(' ').filter((t) => t.length > 1));
  const tb = new Set(normalizar(b).split(' ').filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / new Set([...ta, ...tb]).size;
}

function buscarMatchAproximado(
  nombre: string,
  productosDB: ProductoDB[],
): { id: string; nombre: string } | null {
  let best: { id: string; nombre: string; score: number } | null = null;
  for (const p of productosDB) {
    const s = similitud(nombre, p.nombre);
    if (s > (best?.score ?? 0.55)) {
      best = { id: p.id, nombre: p.nombre, score: s };
    }
  }
  return best ? { id: best.id, nombre: best.nombre } : null;
}

// ────────────────────────────────────────────────────────────────────────
//   Detección de cambios — pipeline genérico
// ────────────────────────────────────────────────────────────────────────

async function detectarCambiosGenerico(opts: {
  fuente: FuenteSyncExcel;
  archivoNombre: string;
  archivoPath: string;
  scriptName: string;
  /** Filtra productos del Excel que no aplican a esta fuente (categorías). */
  filtroCategoria?: (categoria: string) => boolean;
  modificadoPor?: string | null;
}): Promise<{ aprobacion: AprobacionExcel; diff: DiffExcel }> {
  // 1. Validar que el archivo exista
  try {
    await stat(opts.archivoPath);
  } catch {
    throw new Error(`No se encontró ${opts.archivoNombre} en ${opts.archivoPath}`);
  }

  // 2. Parsear con Python
  const parsed = await runPythonParser(opts.scriptName, opts.archivoPath);

  // 3. Cargar productos actuales de DB para comparar
  const productosDB = await prisma.producto.findMany({
    where: { activo: true },
    include: { tipoProducto: { include: { categoria: true } } },
  });
  const dbPorCodigo = new Map(
    productosDB.filter((p) => p.codigo).map((p) => [p.codigo as string, p]),
  );
  const dbLight: ProductoDB[] = productosDB.map((p) => ({
    id: p.id,
    codigo: p.codigo,
    nombre: p.nombre,
    precioBase: p.precioBase,
    categoria: p.tipoProducto.categoria.nombre,
  }));

  // 4. Iterar productos del Excel y construir el diff
  const cambios: CambioPrecio[] = [];
  const sospechosos: ProductoSospechoso[] = [];
  const errores: ErrorExcel[] = [];
  let sinCambios = 0;

  for (const pe of parsed.productos) {
    if (opts.filtroCategoria && !opts.filtroCategoria(pe.tipo_categoria)) continue;

    const precioNuevo = Number(pe.precio_base);
    if (!Number.isFinite(precioNuevo)) {
      errores.push({
        tipo: 'PRECIO_VACIO',
        mensaje: `${pe.nombre}: precio inválido (${pe.precio_base})`,
        contexto: { codigo: pe.codigo, categoria: pe.tipo_categoria },
      });
      continue;
    }
    if (precioNuevo < 0) {
      errores.push({
        tipo: 'PRECIO_NEGATIVO',
        mensaje: `${pe.nombre}: precio negativo (${pe.precio_base})`,
        contexto: { codigo: pe.codigo, categoria: pe.tipo_categoria },
      });
      continue;
    }

    // Buscar producto en DB por código
    const enDB = pe.codigo ? dbPorCodigo.get(pe.codigo) : null;

    if (enDB) {
      const precioAnterior = Number(enDB.precioBase);
      if (Math.abs(precioAnterior - precioNuevo) < 0.01) {
        sinCambios += 1;
        continue;
      }
      const deltaPct =
        precioAnterior > 0 ? ((precioNuevo - precioAnterior) / precioAnterior) * 100 : 0;
      cambios.push({
        tipo: 'PRECIO_CAMBIA',
        cambioId: randomUUID(),
        productoId: enDB.id,
        codigo: enDB.codigo,
        nombreProducto: enDB.nombre,
        categoria: enDB.tipoProducto.categoria.nombre,
        precioAnterior: precioAnterior.toFixed(2),
        precioNuevo: precioNuevo.toFixed(2),
        deltaPct: Number(deltaPct.toFixed(2)),
      });
    } else {
      // No matchea por código — sospechoso. Probamos match por nombre.
      const aprox = buscarMatchAproximado(pe.nombre, dbLight);
      sospechosos.push({
        tipo: 'PRODUCTO_NO_ENCONTRADO',
        cambioId: randomUUID(),
        codigo: pe.codigo,
        nombreSugerido: pe.nombre,
        categoria: pe.tipo_categoria,
        precioPropuesto: precioNuevo.toFixed(2),
        formaVenta: pe.forma_venta,
        unidadPrecio: pe.unidad_precio,
        posibleMatchId: aprox?.id ?? null,
        posibleMatchNombre: aprox?.nombre ?? null,
      });
    }
  }

  const diff: DiffExcel = {
    fuente: opts.fuente,
    archivoNombre: opts.archivoNombre,
    cambios,
    sospechosos,
    errores,
    resumen: {
      cambiosAplicables: cambios.length,
      sospechosos: sospechosos.length,
      errores: errores.length,
      sinCambios,
    },
  };

  // 5. Guardar la aprobación. Si ya existe una PENDIENTE para esta fuente, la
  //    pisamos: la encargada siempre ve el diff más reciente.
  const fileStat = await stat(opts.archivoPath);

  await prisma.aprobacionExcel.updateMany({
    where: { fuente: opts.fuente, estado: EstadoAprobacionExcel.PENDIENTE },
    data: { estado: EstadoAprobacionExcel.POSPUESTA },
  });

  const aprobacion = await prisma.aprobacionExcel.create({
    data: {
      fuente: opts.fuente,
      archivoNombre: opts.archivoNombre,
      archivoDriveFileId: 'local', // placeholder — v2 traerá el fileId real de Drive
      modificadoEn: fileStat.mtime,
      modificadoPor: opts.modificadoPor ?? null,
      cambiosTotal: cambios.length + sospechosos.length + errores.length,
      cambiosAplicables: cambios.length,
      cambiosSospechosos: sospechosos.length,
      cambiosErrores: errores.length,
      estado: EstadoAprobacionExcel.PENDIENTE,
      // Prisma JsonValue acepta el shape de DiffExcel — casteamos al tipo del cliente.
      diff: diff as unknown as object as never,
    },
  });

  return { aprobacion, diff };
}

// ────────────────────────────────────────────────────────────────────────
//   Detectores específicos
// ────────────────────────────────────────────────────────────────────────

const CATEGORIAS_LISTA_PRECIOS = new Set([
  'Pastas frescas',
  'Pizzas',
  'Tartas',
  'Salsas',
  'Empanadas',
  'Porciones calientes',
  'Otros',
]);

const CATEGORIAS_PROVEEDORES = new Set(['Estantería', 'Bebidas']);

export function detectarCambiosListaPrecios(opts: {
  archivoPath?: string;
  modificadoPor?: string | null;
} = {}) {
  return detectarCambiosGenerico({
    fuente: FuenteSyncExcel.LISTA_PRECIOS,
    archivoNombre: 'Lista de Precios.xlsx',
    archivoPath: opts.archivoPath ?? join(EXCEL_DIR, 'Lista de Precios.xlsx'),
    scriptName: 'parse_lista_precios.py',
    filtroCategoria: (cat) => CATEGORIAS_LISTA_PRECIOS.has(cat),
    modificadoPor: opts.modificadoPor ?? null,
  });
}

export function detectarCambiosProveedores(opts: {
  archivoPath?: string;
  modificadoPor?: string | null;
} = {}) {
  return detectarCambiosGenerico({
    fuente: FuenteSyncExcel.PROVEEDORES,
    archivoNombre: 'Proveedores 2026.xlsx',
    archivoPath: opts.archivoPath ?? join(EXCEL_DIR, 'Proveedores 2026.xlsx'),
    scriptName: 'parse_estanteria_bebidas.py',
    filtroCategoria: (cat) => CATEGORIAS_PROVEEDORES.has(cat),
    modificadoPor: opts.modificadoPor ?? null,
  });
}

// ────────────────────────────────────────────────────────────────────────
//   Aplicar / rechazar / posponer
// ────────────────────────────────────────────────────────────────────────

/**
 * Aplica los cambios marcados de una aprobación PENDIENTE.
 * @param cambioIds Si es null, aplica todos los cambios (no los sospechosos).
 *                  Si es un array de cambioId, aplica sólo esos.
 */
export async function aplicarAprobacion(opts: {
  aprobacionId: string;
  cambioIds: string[] | null;
  usuarioId: string;
}): Promise<{ aplicados: number; total: number }> {
  const aprobacion = await prisma.aprobacionExcel.findUnique({
    where: { id: opts.aprobacionId },
  });
  if (!aprobacion) throw new Error('Aprobación no encontrada');
  if (aprobacion.estado !== EstadoAprobacionExcel.PENDIENTE) {
    throw new Error(`No se puede aplicar una aprobación en estado ${aprobacion.estado}`);
  }

  const diff = aprobacion.diff as unknown as DiffExcel;
  const cambiosAplicar =
    opts.cambioIds === null
      ? diff.cambios
      : diff.cambios.filter((c) => opts.cambioIds!.includes(c.cambioId));

  let aplicados = 0;
  await prisma.$transaction(async (tx) => {
    for (const cambio of cambiosAplicar) {
      const before = await tx.producto.findUnique({ where: { id: cambio.productoId } });
      if (!before) continue;
      await tx.producto.update({
        where: { id: cambio.productoId },
        data: { precioBase: cambio.precioNuevo },
      });
      await tx.historialPrecio.create({
        data: {
          productoId: cambio.productoId,
          precioAnterior: before.precioBase,
          precioNuevo: cambio.precioNuevo,
          usuarioId: opts.usuarioId,
          motivo: `Sync ${aprobacion.archivoNombre}`,
        },
      });
      aplicados += 1;
    }

    const totalEnDiff = diff.cambios.length;
    const aplicadoTodo =
      opts.cambioIds === null || cambiosAplicar.length === totalEnDiff;
    await tx.aprobacionExcel.update({
      where: { id: opts.aprobacionId },
      data: {
        estado: aplicadoTodo
          ? EstadoAprobacionExcel.APROBADA
          : EstadoAprobacionExcel.APLICADA_PARCIAL,
        aprobadaAt: new Date(),
        aprobadaPorId: opts.usuarioId,
      },
    });
  });

  return { aplicados, total: cambiosAplicar.length };
}

export async function rechazarAprobacion(opts: {
  aprobacionId: string;
  usuarioId: string;
  observaciones?: string;
}) {
  await prisma.aprobacionExcel.update({
    where: { id: opts.aprobacionId },
    data: {
      estado: EstadoAprobacionExcel.RECHAZADA,
      aprobadaAt: new Date(),
      aprobadaPorId: opts.usuarioId,
      observaciones: opts.observaciones ?? null,
    },
  });
}

export async function posponerAprobacion(opts: { aprobacionId: string }) {
  await prisma.aprobacionExcel.update({
    where: { id: opts.aprobacionId },
    data: { estado: EstadoAprobacionExcel.POSPUESTA },
  });
}
