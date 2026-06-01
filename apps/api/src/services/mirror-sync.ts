import { Prisma } from '@sta/db';
import { prisma, createPrismaClientForUrl, type PrismaClient } from '@sta/db/client';
import { config } from '../config.js';

/**
 * Mirror-sync — espejo de SOLO LECTURA: nube (Supabase) → local.
 *
 * Corre UNA VEZ al arrancar el .exe (no en loop): baja lo último de la nube
 * a la base local. El bootstrap (clon inicial) ya dejó el local con los
 * MISMOS UUIDs que la nube, así que acá solo pegamos deltas idempotentes por
 * PK y todo encastra.
 *
 * Estrategia por tabla (ver TABLAS abajo):
 *   - 'reference'   → full upsert. Tablas chicas/mutables (catálogo, cuentas,
 *                     config, proveedores, clientes…). Se traen enteras y se
 *                     upsertean: barato y refleja ediciones.
 *   - 'incremental' → solo lo nuevo + reciente. Tablas que crecen a diario
 *                     (ventas, movimientos, pagos…). Se trae lo que tenga
 *                     timestamp > el máximo local, MÁS una ventana de re-pull
 *                     de los últimos REPULL_DIAS (para captar cambios de estado
 *                     en filas ya bajadas, ej. venta PROCESADA→FINALIZADA).
 *   - 'append'      → append-only puro (audit_log): trae secuencia > máx local.
 *
 * Sólo se activa si STA_MIRROR_SOURCE_URL está seteado y distinto de
 * DATABASE_URL. En las cajas reales NO se setea → no hace nada.
 */

const REPULL_DIAS = 3;

type Modo = 'reference' | 'incremental' | 'append';
interface TablaCfg {
  /** delegate del client (camelCase) */
  delegate: string;
  modo: Modo;
  /** campo timestamp Prisma para incremental (camelCase) */
  tsField?: string;
}

// Orden de aplicación: primero referencia (padres), luego transaccional.
const TABLAS: TablaCfg[] = [
  // ── Referencia / catálogo / config (full upsert) ──
  { delegate: 'usuario', modo: 'reference' },
  { delegate: 'categoria', modo: 'reference' },
  { delegate: 'tipoProducto', modo: 'reference' },
  { delegate: 'producto', modo: 'reference' },
  { delegate: 'grupoModificador', modo: 'reference' },
  { delegate: 'opcionModificador', modo: 'reference' },
  { delegate: 'modificadorAplicable', modo: 'reference' },
  { delegate: 'combo', modo: 'reference' },
  { delegate: 'componenteCombo', modo: 'reference' },
  { delegate: 'opcionComponenteCombo', modo: 'reference' },
  { delegate: 'listaPrecios', modo: 'reference' },
  { delegate: 'precioPorLista', modo: 'reference' },
  { delegate: 'historialPrecio', modo: 'reference' },
  { delegate: 'cuenta', modo: 'reference' },
  { delegate: 'cuentaACobrar', modo: 'reference' },
  { delegate: 'categoriaMovimiento', modo: 'reference' },
  { delegate: 'posnet', modo: 'reference' },
  { delegate: 'empresaDelivery', modo: 'reference' },
  { delegate: 'proveedor', modo: 'reference' },
  { delegate: 'insumo', modo: 'reference' },
  { delegate: 'insumoProveedor', modo: 'reference' },
  { delegate: 'cliente', modo: 'reference' },
  { delegate: 'direccion', modo: 'reference' },
  { delegate: 'empleado', modo: 'reference' },
  { delegate: 'configuracionSistema', modo: 'reference' },
  { delegate: 'aprobacionExcel', modo: 'reference' },
  // ── Transaccional (incremental por timestamp) ──
  { delegate: 'sesionCaja', modo: 'incremental', tsField: 'horarioApertura' },
  { delegate: 'venta', modo: 'incremental', tsField: 'fechaApertura' },
  { delegate: 'itemVenta', modo: 'incremental', tsField: 'creadoAt' },
  { delegate: 'pago', modo: 'incremental', tsField: 'fecha' },
  { delegate: 'movimiento', modo: 'incremental', tsField: 'fechaAlta' },
  { delegate: 'deliveryInfo', modo: 'reference' }, // sin timestamp propio; bajo volumen → full
  { delegate: 'facturaRecibida', modo: 'reference' },
  { delegate: 'movimientoFactura', modo: 'reference' },
  { delegate: 'pagoFactura', modo: 'reference' },
  { delegate: 'liquidacionPendiente', modo: 'reference' },
  { delegate: 'facturaEmitida', modo: 'reference' },
  // ── Append-only ──
  { delegate: 'auditLog', modo: 'append', tsField: 'secuencia' },
];

let sourceClient: PrismaClient | null = null;
function getSource(): PrismaClient {
  if (!sourceClient) sourceClient = createPrismaClientForUrl(config.STA_MIRROR_SOURCE_URL!);
  return sourceClient;
}

function log(msg: string): void {
  console.log(`[mirror-sync] ${msg}`);
}

/** Upsert idempotente por PK de un lote de filas en el destino local. */
async function upsertLote(delegateName: string, rows: Record<string, unknown>[]): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dest = (prisma as any)[delegateName];
  for (const row of rows) {
    await dest.upsert({ where: { id: row.id }, create: row, update: row });
  }
}

async function syncReference(cfg: TablaCfg): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const src = (getSource() as any)[cfg.delegate];
  const rows = await src.findMany();
  await upsertLote(cfg.delegate, rows);
  return rows.length;
}

async function syncIncremental(cfg: TablaCfg): Promise<number> {
  const tsField = cfg.tsField!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const srcDelegate = (getSource() as any)[cfg.delegate];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const localDelegate = (prisma as any)[cfg.delegate];

  // Máximo timestamp ya presente en local.
  const localMaxRow = await localDelegate.findFirst({
    orderBy: { [tsField]: 'desc' },
    select: { [tsField]: true },
  });
  const localMax: Date | null = localMaxRow ? (localMaxRow[tsField] as Date) : null;

  // Ventana de re-pull (para captar updates a filas ya bajadas).
  const ventana = new Date(Date.now() - REPULL_DIAS * 24 * 60 * 60 * 1000);

  // Traemos: lo más nuevo que el máx local, O lo de la ventana reciente.
  const where =
    localMax === null
      ? {}
      : { OR: [{ [tsField]: { gt: localMax } }, { [tsField]: { gte: ventana } }] };

  const rows = await srcDelegate.findMany({ where });
  await upsertLote(cfg.delegate, rows);
  return rows.length;
}

async function syncAppend(cfg: TablaCfg): Promise<number> {
  const tsField = cfg.tsField!; // 'secuencia' (BigInt, monotónico)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const srcDelegate = (getSource() as any)[cfg.delegate];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const localDelegate = (prisma as any)[cfg.delegate];
  const localMaxRow = await localDelegate.findFirst({
    orderBy: { [tsField]: 'desc' },
    select: { [tsField]: true },
  });
  const localMax = localMaxRow ? localMaxRow[tsField] : null;
  const where = localMax === null ? {} : { [tsField]: { gt: localMax } };
  const rows = await srcDelegate.findMany({ where });
  await upsertLote(cfg.delegate, rows);
  return rows.length;
}

let yaCorrio = false;

/**
 * Ejecuta el mirror-sync una vez. No-op si no hay STA_MIRROR_SOURCE_URL o si
 * apunta al mismo DATABASE_URL. Nunca tira (loguea y sigue) — si la nube no
 * responde, el local sigue con el último espejo.
 */
export async function runMirrorSyncOnce(): Promise<void> {
  const source = config.STA_MIRROR_SOURCE_URL;
  if (!source) return;
  if (source === config.DATABASE_URL) {
    log('STA_MIRROR_SOURCE_URL == DATABASE_URL — skip (no me espejo a mí mismo)');
    return;
  }
  if (yaCorrio) return;
  yaCorrio = true;

  const t0 = Date.now();
  log('Iniciando espejo nube → local…');
  let total = 0;
  try {
    for (const cfg of TABLAS) {
      try {
        const n =
          cfg.modo === 'reference'
            ? await syncReference(cfg)
            : cfg.modo === 'append'
              ? await syncAppend(cfg)
              : await syncIncremental(cfg);
        total += n;
        if (n > 0) log(`  ${cfg.delegate}: ${n}`);
      } catch (e) {
        log(`  ⚠ ${cfg.delegate}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    log(`✓ Espejo listo (${total} filas, ${Date.now() - t0}ms)`);
  } catch (e) {
    log(`✗ Falló el espejo: ${e instanceof Error ? e.message : String(e)} — sigo con el último estado local`);
  } finally {
    if (sourceClient) {
      await sourceClient.$disconnect().catch(() => {});
      sourceClient = null;
    }
  }
}
