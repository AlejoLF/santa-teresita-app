import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().default(3001),
  API_CORS_ORIGINS: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET debe tener al menos 32 chars'),
  AUTH_SESSION_TTL_HOURS_VENDEDOR: z.coerce.number().default(12),
  AUTH_SESSION_TTL_HOURS_ADMIN: z.coerce.number().default(2),
  AUTH_PIN_LOCKOUT_THRESHOLD: z.coerce.number().default(5),
  AUTH_PIN_LOCKOUT_MINUTES: z.coerce.number().default(15),
  AUDIT_HASH_SALT: z.string().min(16),

  // ── Servidor local LAN (ver docs/SERVIDOR-LOCAL.md) ──
  // STA_ROLE: 'caja' (default — el .exe de cada caja) vs 'server' (el mini PC
  //   que es fuente de verdad y corre el replicator). Solo 'server' arranca
  //   el worker de replicación.
  STA_ROLE: z.enum(['caja', 'server']).default('caja'),
  // STA_OUTBOX_REPLICATION: si true, recordAudit escribe también un
  //   outbox_events en la MISMA tx (patrón transactional-outbox). Se prende
  //   en el server Y en las cajas que apuntan al Postgres LAN (sus writes
  //   también deben replicarse). Default false → comportamiento legacy
  //   cloud-first sin cambios.
  STA_OUTBOX_REPLICATION: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === 'true' || v === '1'),
  // REPLICATE_TO_URL: destino del replicator (Supabase pooler aws-1). Solo
  //   se usa cuando STA_ROLE='server'. Si falta, el replicator no arranca.
  REPLICATE_TO_URL: z.string().optional(),
  // STA_FALLBACK_DB_URL: en la CAJA, la URL de Supabase (read-only) a la que
  //   cae si el Postgres LAN del server no responde. DATABASE_URL apunta al
  //   LAN; este al cloud. Si falta, no hay failover (comportamiento legacy:
  //   un solo DATABASE_URL, sin router).
  STA_FALLBACK_DB_URL: z.string().optional(),
  // STA_DB_HEALTHCHECK_MS: cada cuánto el db-router pinguea el LAN.
  STA_DB_HEALTHCHECK_MS: z.coerce.number().default(10_000),
});

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Variables de entorno inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type AppConfig = typeof config;
