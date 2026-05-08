/**
 * Reset completo del schema en cloud — drop & recreate desde el schema.prisma.
 *
 * USO: pnpm cloud:reset-schema
 *
 * Cuándo usarlo:
 *   - Bootstrap inicial (la primera vez que armás la cloud DB).
 *   - Schema drift: cuando agregamos columnas al `schema.prisma` sin generar
 *     migración Prisma (porque la pipeline del desktop genera schema.sql al
 *     vuelo y no necesita `prisma migrate`).
 *
 * Cuándo NO usarlo:
 *   - Si la cloud ya tiene datos productivos. Esto BORRA TODO. El script pide
 *     confirmación explícita por flag `--yes` para no ejecutarlo por accidente.
 *
 * Por qué no `prisma db push`:
 *   - Necesita session-mode (advisory locks). El Shared Pooler de Supabase es
 *     transaction-mode → se cuelga indefinidamente. Sin IPv4 add-on no podemos
 *     usar la conexión direct.
 *
 * Estrategia:
 *   1. DROP SCHEMA public CASCADE; CREATE SCHEMA public;
 *   2. Generar SQL del schema.prisma con `prisma migrate diff` (entrada vacía).
 *   3. Aplicarlo en una sola transacción vía pg.
 *   4. Re-marcar las migraciones como aplicadas en `_prisma_migrations` para
 *      mantener compatibilidad con `prisma migrate status`.
 */

import { Client } from 'pg';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pooledUrl, maskUrl } from './_url.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA_FILE = join(REPO_ROOT, 'packages', 'db', 'prisma', 'schema.prisma');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'db', 'prisma', 'migrations');

if (!process.argv.includes('--yes')) {
  console.error('⚠ Esto BORRA toda la cloud DB. Si estás seguro, corré con --yes:');
  console.error('  pnpm cloud:reset-schema --yes');
  process.exit(1);
}

console.log('▸ Generando SQL completo del schema.prisma...');
const fullSql = execSync(
  `pnpm exec prisma migrate diff --from-empty --to-schema-datamodel "${SCHEMA_FILE}" --script`,
  { cwd: join(REPO_ROOT, 'packages', 'db'), encoding: 'utf8' },
);
console.log(`  ✓ ${fullSql.split('\n').length} líneas`);

const PRISMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id"                    VARCHAR(36) PRIMARY KEY,
  "checksum"              VARCHAR(64) NOT NULL,
  "finished_at"           TIMESTAMPTZ,
  "migration_name"        VARCHAR(255) NOT NULL,
  "logs"                  TEXT,
  "rolled_back_at"        TIMESTAMPTZ,
  "started_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
);
`;

async function main() {
  const url = pooledUrl();
  console.log(`▸ Pooler: ${maskUrl(url)}`);
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('▸ Dropeando schema public + recreando...');
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.query('GRANT ALL ON SCHEMA public TO postgres');
  await client.query('GRANT ALL ON SCHEMA public TO public');
  // Después del DROP el search_path queda sin "public" — sin esto los CREATE
  // TABLE sin qualificar fallan con "no schema has been selected to create in".
  await client.query('SET search_path TO public');
  console.log('  ✓ public schema reseteado');

  console.log('▸ Aplicando full schema (~1300 líneas) en una transacción...');
  const t0 = Date.now();
  await client.query(fullSql);
  console.log(`  ✓ Schema aplicado (${Date.now() - t0}ms)`);

  // Re-crear _prisma_migrations y marcar las migraciones existentes como aplicadas.
  console.log('▸ Marcando migraciones existentes como aplicadas en _prisma_migrations...');
  await client.query(PRISMA_MIGRATIONS_DDL);
  const migDirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of migDirs) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await client.query(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
       VALUES ($1, $2, $3, now(), now(), 1)
       ON CONFLICT (id) DO NOTHING`,
      [crypto.randomUUID(), checksum, name],
    );
    console.log(`  ✓ ${name}`);
  }

  // Sanity
  const tablas = await client.query(
    `SELECT count(*)::int as n FROM pg_tables WHERE schemaname = 'public'`,
  );
  console.log(`\n✓ Total tablas en public: ${tablas.rows[0].n}`);

  await client.end();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
