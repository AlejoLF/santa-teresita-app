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
});

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Variables de entorno inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type AppConfig = typeof config;
