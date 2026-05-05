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

export type { PrismaClient };
