import {
  getPrimaryPrisma,
  setActivePrisma,
  createPrismaClientForUrl,
  type PrismaClient,
} from '@sta/db/client';
import { config } from '../config.js';

/**
 * DB router de la CAJA (failover Fase 1B, ver docs/SERVIDOR-LOCAL.md §4).
 *
 * DATABASE_URL apunta al Postgres LAN del mini PC (fuente de verdad).
 * STA_FALLBACK_DB_URL apunta a Supabase (mirror, read-only por política).
 *
 * Un healthcheck pinguea el LAN cada STA_DB_HEALTHCHECK_MS:
 *   - LAN responde  → estado PRIMARY  → prisma activo = LAN (lecturas y
 *     escrituras normales).
 *   - LAN no responde → estado DEGRADED → prisma activo = Supabase para que
 *     las LECTURAS sigan vivas (UI no se cae). Las ESCRITURAS las bloquea
 *     server.ts (preHandler) y el frontend las encola en outbox.sqlite;
 *     el outbox-flusher las reproduce al volver el LAN. Supabase NUNCA
 *     recibe escrituras autoritativas → cero conflictos.
 *
 * Inerte si STA_FALLBACK_DB_URL no está: queda PRIMARY siempre (el .exe
 * cloud-first legacy, con un solo DATABASE_URL, no cambia su comportamiento).
 */

export type DbState = 'PRIMARY' | 'DEGRADED';

let state: DbState = 'PRIMARY';
let fallback: PrismaClient | null = null;
let timer: NodeJS.Timeout | null = null;

export function dbRouterEnabled(): boolean {
  return Boolean(config.STA_FALLBACK_DB_URL);
}

export function dbState(): DbState {
  return state;
}

function log(m: string): void {
  console.log(`[db-router] ${m}`);
}

async function pingPrimary(): Promise<boolean> {
  try {
    // Timeout corto: si el LAN está caído no queremos colgar el tick.
    await Promise.race([
      getPrimaryPrisma().$queryRawUnsafe('SELECT 1'),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function tick(): Promise<void> {
  const ok = await pingPrimary();
  if (ok && state === 'DEGRADED') {
    setActivePrisma(getPrimaryPrisma());
    state = 'PRIMARY';
    log('LAN recuperado → PRIMARY (las escrituras encoladas las drena el outbox-flusher)');
  } else if (!ok && state === 'PRIMARY') {
    if (fallback) {
      setActivePrisma(fallback);
      state = 'DEGRADED';
      log('LAN caído → DEGRADED (lecturas desde Supabase mirror; escrituras → outbox)');
    } else {
      log('LAN caído pero sin fallback configurado — sigue PRIMARY (va a fallar)');
    }
  }
}

export function startDbRouter(): void {
  if (!dbRouterEnabled()) {
    log('skip — STA_FALLBACK_DB_URL no configurado (modo single-DB legacy)');
    return;
  }
  fallback = createPrismaClientForUrl(config.STA_FALLBACK_DB_URL!);
  log(`iniciado (healthcheck cada ${config.STA_DB_HEALTHCHECK_MS}ms)`);
  void tick();
  timer = setInterval(() => void tick(), config.STA_DB_HEALTHCHECK_MS);
}

export function stopDbRouter(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
