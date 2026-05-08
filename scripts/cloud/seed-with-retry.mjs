/**
 * Wrapper que ejecuta el seed local-style (`pnpm --filter @sta/db run seed`)
 * pero apuntando al cloud DB y reintentando ante errores P1001 (conexión
 * dropeada por el Supavisor pooler).
 *
 * Por qué no parchear seed.ts:
 *   - El seed.ts se usa también en el desktop bundler — modificarlo afecta
 *     producción local. Mejor wrappear desde afuera.
 *
 * Estrategia:
 *   1. Spawn `tsx prisma/seed.ts` con DATABASE_URL al cloud.
 *   2. Si falla con exit 1 y el stderr contiene "P1001" o "Can't reach",
 *      reintenta hasta MAX_RETRIES veces. El seed es idempotente (todos los
 *      modelos usan upsert/findFirst+create gating), así que cada reintento
 *      retoma desde donde se cayó.
 */

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pooledUrl } from './_url.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const MAX_RETRIES = 8;

// URL con flags de Prisma para Supavisor.
const dbUrl = `${pooledUrl()}?pgbouncer=true&connection_limit=1&pool_timeout=60&connect_timeout=30`;

console.log(`▸ Seed con retry — hasta ${MAX_RETRIES} intentos`);
let lastFailure = null;
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n━━━ Intento ${attempt}/${MAX_RETRIES}`);
  const r = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['--filter', '@sta/db', 'run', 'seed'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: dbUrl },
      // Capturamos stdio en buffers (en vez de inherit) para que el output
      // llegue al log del parent. inherit no funciona cuando esto corre como
      // background command — el buffer queda vacío hasta que muere el child.
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status === 0) {
    console.log(`\n✓ Seed completo en intento ${attempt}`);
    process.exit(0);
  }
  lastFailure = r.status;
  console.log(`  ✕ Intento ${attempt} salió con status ${r.status} — reintentando en 3s...`);
  await new Promise((res) => setTimeout(res, 3000));
}

console.error(`\n✕ Seed falló después de ${MAX_RETRIES} intentos. Último status: ${lastFailure}`);
process.exit(1);
