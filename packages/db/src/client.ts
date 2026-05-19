import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined;
}

const logLevels =
  process.env.NODE_ENV === 'production'
    ? (['error', 'warn'] as const)
    : (['error', 'warn', 'info'] as const);

export const prisma =
  globalThis.__prismaClient ??
  new PrismaClient({
    log: logLevels.map((level) => ({ emit: 'event', level })),
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prismaClient = prisma;
}

/**
 * Crea un PrismaClient nuevo apuntado a una URL arbitraria. Lo usa el
 * replicator del servidor local para abrir una conexión SEPARADA a Supabase
 * (destino del mirror) sin tocar el `prisma` principal (que apunta al
 * Postgres local, fuente de verdad). Ver docs/SERVIDOR-LOCAL.md §3.
 *
 * Vive acá (no en apps/api) porque @sta/db tiene @prisma/client como dep
 * real; el barrel lo re-exporta como type-only y no se puede `new` desde
 * apps/api.
 */
export function createPrismaClientForUrl(url: string): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url } },
    log: [{ emit: 'event', level: 'error' }],
  });
}

export type { PrismaClient };
