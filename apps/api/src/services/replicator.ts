import { Prisma } from '@sta/db';
import { prisma, createPrismaClientForUrl, type PrismaClient } from '@sta/db/client';
import { config } from '../config.js';

/**
 * Replicator — replica local (fuente de verdad) → Supabase (mirror/backup).
 *
 * Patrón transactional-outbox: `recordAudit` ya escribió un `outbox_events`
 * en la misma tx que cada mutación (ver services/audit.ts, gated por
 * STA_OUTBOX_REPLICATION). Este worker drena esa cola en orden de
 * `secuencia` (orden total monotónico del audit) y hace upsert idempotente
 * por PK en Supabase.
 *
 * Solo arranca si STA_ROLE='server' y REPLICATE_TO_URL está configurado
 * (ver docs/SERVIDOR-LOCAL.md §3). At-least-once + idempotente =
 * exactly-once efectivo sobre el estado final. Si el mini PC se cae, los
 * eventos quedan en outbox_events y se drenan al volver — no se pierde nada.
 */

const DRAIN_INTERVAL_MS = 4000;
const BATCH = 50;
const MAX_INTENTOS = 25; // tras esto, queda con ultimo_error para revisión manual

// tabla (snake_case, @@map) → delegate del client (camelCase del modelo).
// Se arma del DMMF de Prisma → cubre TODOS los modelos sin hardcodear.
const tableToDelegate: Record<string, string> = {};
for (const m of Prisma.dmmf.datamodel.models) {
  const db = m.dbName ?? m.name;
  tableToDelegate[db] = m.name.charAt(0).toLowerCase() + m.name.slice(1);
}

let targetClient: PrismaClient | null = null;
function getTarget(): PrismaClient {
  if (targetClient) return targetClient;
  targetClient = createPrismaClientForUrl(config.REPLICATE_TO_URL!);
  return targetClient;
}

type EventoOutbox = {
  id: string;
  payload: { tabla: string; registroId: string; accion: string; secuencia: string };
  intentos: number;
};

function log(msg: string): void {
  console.log(`[replicator] ${msg}`);
}

/**
 * Aplica UN evento al target. Para DELETE borra por PK; para el resto
 * (INSERT/UPDATE/TRANSITION/APPROVAL/...) re-lee el row completo del local
 * y hace upsert por PK. Idempotente: re-aplicar el mismo evento converge
 * al mismo estado final.
 */
async function aplicarEvento(ev: EventoOutbox): Promise<void> {
  const { tabla, registroId, accion } = ev.payload;
  const delegateName = tableToDelegate[tabla];
  if (!delegateName) {
    // Tabla no mapeada (no debería pasar — el DMMF cubre todo). La saltamos
    // marcándola publicada para no trabar la cola; queda el log.
    log(`tabla no mapeada, skip: ${tabla}`);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const localDelegate = (prisma as any)[delegateName];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targetDelegate = (getTarget() as any)[delegateName];

  if (accion === 'DELETE') {
    await targetDelegate
      .delete({ where: { id: registroId } })
      .catch((e: { code?: string }) => {
        if (e?.code === 'P2025') return; // ya no existe en el target → ok
        throw e;
      });
    return;
  }

  const row = await localDelegate.findUnique({ where: { id: registroId } });
  if (!row) {
    // El row fue borrado después de este evento. Un evento DELETE posterior
    // (con secuencia mayor) lo va a limpiar. Nada que hacer acá.
    return;
  }
  await targetDelegate.upsert({
    where: { id: registroId },
    create: row,
    update: row,
  });
}

let draining = false;

async function drainOnce(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // Orden total por secuencia del audit (viene como string en el JSON).
    const pendientes = await prisma.outboxEvent.findMany({
      where: { publicadoAt: null, intentos: { lt: MAX_INTENTOS } },
      orderBy: { agregadoAt: 'asc' },
      take: BATCH,
    });
    if (pendientes.length === 0) return;

    // Ordenar por secuencia numérica (agregadoAt empata bajo carga).
    const ordenados = [...pendientes].sort((a, b) => {
      const sa = BigInt(((a.payload as { secuencia?: string })?.secuencia) ?? '0');
      const sb = BigInt(((b.payload as { secuencia?: string })?.secuencia) ?? '0');
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

    for (const ev of ordenados) {
      try {
        await aplicarEvento(ev as unknown as EventoOutbox);
        await prisma.outboxEvent.update({
          where: { id: ev.id },
          data: { publicadoAt: new Date() },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await prisma.outboxEvent.update({
          where: { id: ev.id },
          data: { intentos: { increment: 1 }, ultimoError: msg.slice(0, 500) },
        });
        // Cortamos el batch: preservar orden — no salteamos un evento
        // fallido para no aplicar uno posterior antes que su predecesor.
        log(`evento ${ev.id} falló (intento ${ev.intentos + 1}): ${msg}`);
        break;
      }
    }
  } finally {
    draining = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startReplicator(): void {
  if (config.STA_ROLE !== 'server') {
    log('skip — STA_ROLE != server');
    return;
  }
  if (!config.REPLICATE_TO_URL) {
    log('skip — REPLICATE_TO_URL no configurado');
    return;
  }
  log(`iniciado (cada ${DRAIN_INTERVAL_MS}ms, batch ${BATCH})`);
  void drainOnce();
  timer = setInterval(() => void drainOnce(), DRAIN_INTERVAL_MS);
}

export function stopReplicator(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Métricas para /sync/status (lag del replicator). */
export async function replicatorLag(): Promise<{
  pendientes: number;
  estancados: number;
  masViejoMs: number | null;
}> {
  const [pendientes, estancados, masViejo] = await Promise.all([
    prisma.outboxEvent.count({ where: { publicadoAt: null } }),
    prisma.outboxEvent.count({
      where: { publicadoAt: null, intentos: { gte: MAX_INTENTOS } },
    }),
    prisma.outboxEvent.findFirst({
      where: { publicadoAt: null },
      orderBy: { agregadoAt: 'asc' },
      select: { agregadoAt: true },
    }),
  ]);
  return {
    pendientes,
    estancados,
    masViejoMs: masViejo ? Date.now() - masViejo.agregadoAt.getTime() : null,
  };
}
