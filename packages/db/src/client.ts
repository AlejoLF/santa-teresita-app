import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined;
}

const logLevels =
  process.env.NODE_ENV === 'production'
    ? (['error', 'warn'] as const)
    : (['error', 'warn', 'info'] as const);

/**
 * Cuánto puede durar una transacción interactiva antes de que Prisma la corte.
 *
 * El default de Prisma son 5 s y acá NO estaba configurado. Una venta de
 * treinta renglones encadenaba decenas de viajes a la base dentro de una sola
 * transacción; contra la base en la nube eso cruzaba los 5 s, Prisma cortaba
 * (P2028, `Transaction already closed`) y a la cajera le salía "la base de
 * datos rechazó la operación" sin más pista. Incidente real: 24/09/2026.
 *
 * El arreglo de fondo es que el audit NO cueste un viaje por renglón (ver
 * `services/audit.ts`, `recordAuditBatch`). Esto es la red de seguridad: que
 * un pico de latencia no vuelva a cortar un pedido por la mitad.
 */
const TX_TIMEOUT_MS = Number(process.env.STA_TX_TIMEOUT_MS ?? 30_000);

const primaryClient =
  globalThis.__prismaClient ??
  new PrismaClient({
    log: logLevels.map((level) => ({ emit: 'event', level })),
    transactionOptions: { timeout: TX_TIMEOUT_MS, maxWait: 10_000 },
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prismaClient = primaryClient;
}

/**
 * Cliente activo. En modo normal = primaryClient (DATABASE_URL). En la caja,
 * cuando el server LAN se cae, el db-router lo cambia al cliente de Supabase
 * (read-only) vía setActivePrisma() para que las LECTURAS sigan vivas. Las
 * ESCRITURAS en modo degradado las intercepta server.ts (no llegan acá).
 * Ver docs/SERVIDOR-LOCAL.md §4.
 */
let activeClient: PrismaClient = primaryClient;

export function setActivePrisma(c: PrismaClient): void {
  activeClient = c;
}
export function getPrimaryPrisma(): PrismaClient {
  return primaryClient;
}

/**
 * `prisma` es un Proxy que reenvía SIEMPRE al `activeClient` actual. Permite
 * conmutar LAN↔Supabase en runtime sin reinstanciar ni reiniciar la API ni
 * cambiar los ~cientos de `import { prisma }`. Las funciones se bindean al
 * cliente activo para preservar `this` ($transaction, $queryRaw, etc.).
 * Riesgo bajo: nadie hace `prisma.$on(...)` ni `instanceof PrismaClient`.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop: string | symbol) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (activeClient as any)[prop];
    return typeof v === 'function' ? v.bind(activeClient) : v;
  },
});

/**
 * Crea un PrismaClient nuevo apuntado a una URL arbitraria. Lo usa el
 * replicator del servidor local (conexión SEPARADA a Supabase) y el db-router
 * de la caja (cliente de fallback). Vive acá porque @sta/db tiene
 * @prisma/client como dep real; el barrel lo re-exporta type-only y no se
 * puede `new` desde apps/api.
 */
export function createPrismaClientForUrl(url: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url } },
    log: [{ emit: 'event', level: 'error' }],
  });
}

export type { PrismaClient };
