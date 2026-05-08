/**
 * Aplica las migraciones de Prisma a la cloud DB de Supabase.
 *
 * Por qué no usamos `prisma migrate deploy`:
 *   - Prisma Migrate necesita una conexión "session-mode" (típicamente el
 *     puerto 5432 directo). En Supabase eso es IPv6-only y nuestra red local
 *     es IPv4 — sin add-on de IPv4 ($4/mo) no podemos.
 *   - El Shared Pooler (puerto 6543, IPv4-compatible) es transaction-mode:
 *     Prisma Migrate falla intermitente acá porque algunas operaciones
 *     necesitan estado entre statements.
 *
 * Solución: leemos cada `migration.sql` y lo aplicamos con `client.query()` —
 * PG ejecuta el archivo entero como UN BLOQUE en una transacción implícita.
 * Mantenemos compatibilidad con `prisma migrate` registrando cada migración
 * en la tabla `_prisma_migrations` (mismo schema que usa Prisma localmente),
 * para que si después llegamos a tener IPv4 add-on, `prisma migrate status`
 * vea las migraciones aplicadas y no quiera re-aplicar nada.
 */

import { Client } from 'pg';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { pooledUrl, maskUrl } from './_url.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'db', 'prisma', 'migrations');

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

function listarMigraciones() {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`No existe ${MIGRATIONS_DIR}`);
  }
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(); // los nombres tienen timestamp prefix → orden alfabético = cronológico
}

function leerMigracion(name) {
  const file = join(MIGRATIONS_DIR, name, 'migration.sql');
  if (!existsSync(file)) {
    throw new Error(`Falta ${file}`);
  }
  const sql = readFileSync(file, 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  return { sql, checksum };
}

async function main() {
  const url = pooledUrl();
  console.log(`▸ Pooler: ${maskUrl(url)}`);
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // 1) Tabla de tracking de Prisma — idempotente.
  await client.query(PRISMA_MIGRATIONS_DDL);

  // 2) Para cada migración, decidir si aplicarla.
  const migraciones = listarMigraciones();
  console.log(`▸ Encontradas ${migraciones.length} migraciones:`);
  for (const name of migraciones) console.log(`    - ${name}`);

  const aplicadas = await client.query(
    `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`,
  );
  const yaAplicadasMap = new Map(
    aplicadas.rows.map((r) => [r.migration_name, r]),
  );

  let aplicadasOk = 0;
  let saltadas = 0;
  for (const name of migraciones) {
    const ya = yaAplicadasMap.get(name);
    if (ya && ya.finished_at && !ya.rolled_back_at) {
      console.log(`  ✓ ${name} (ya aplicada)`);
      saltadas++;
      continue;
    }
    const { sql, checksum } = leerMigracion(name);
    const id = crypto.randomUUID();
    console.log(`  ▶ ${name} ...`);
    const t0 = Date.now();
    try {
      // Marcar como "started"
      await client.query(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count)
         VALUES ($1, $2, $3, now(), 0)`,
        [id, checksum, name],
      );
      // Aplicar el bloque entero
      await client.query(sql);
      // Marcar como finished
      await client.query(
        `UPDATE _prisma_migrations SET finished_at = now(), applied_steps_count = 1 WHERE id = $1`,
        [id],
      );
      console.log(`    OK (${Date.now() - t0}ms)`);
      aplicadasOk++;
    } catch (e) {
      console.error(`    FAIL: ${e.message}`);
      // Limpiar el registro started — sino queda como "in progress" para siempre
      await client.query(`DELETE FROM _prisma_migrations WHERE id = $1`, [id]).catch(() => {});
      await client.end();
      process.exit(1);
    }
  }

  console.log(`\n✓ Migraciones: ${aplicadasOk} aplicadas, ${saltadas} ya estaban`);

  // 3) Mostrar el conteo de tablas resultante para sanity check
  const tablas = await client.query(
    `SELECT count(*)::int as n FROM pg_tables WHERE schemaname = 'public'`,
  );
  console.log(`✓ Tablas en public: ${tablas.rows[0].n}`);

  await client.end();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
