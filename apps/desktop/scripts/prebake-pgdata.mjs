/**
 * Pre-bakea el cluster de Postgres durante el CI build, así el primer arranque
 * en la PC del usuario salta `initdb` (4-5 min), `CREATE DATABASE` + apply
 * schema.sql + seed (~3-4 min más). En total el install pasa de ~15 min a ~5 min.
 *
 * Lo que hace:
 *   1. Crea un pgdata fresco en `apps/desktop/build/pgdata-template/`.
 *   2. Corre initdb vía embedded-postgres → cluster vacío.
 *   3. Levanta Postgres temporalmente.
 *   4. CREATE DATABASE teresita con UTF8 + LC_COLLATE C.
 *   5. Aplica schema.sql (generado por build-resources.mjs).
 *   6. Corre el seed (usuarios PIN default, categorías, productos, etc.).
 *   7. Para Postgres limpio.
 *   8. Deja `pgdata-template/` listo para que electron-builder lo bundle como
 *      extraResources.
 *
 * En el primer arranque, main.js detecta el template y lo copia a userData/data/pgdata,
 * salteando initdb/schema/seed.
 *
 * Si más adelante el schema cambia, el template se regenera en CI cada release —
 * no hay que mantener nada manual.
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(__dirname, '..');
const REPO_ROOT = join(DESKTOP_DIR, '..', '..');
const TEMPLATE_DIR = join(DESKTOP_DIR, 'build', 'pgdata-template');
const RESOURCES_DIR = join(DESKTOP_DIR, 'resources');
const SEED_FILE = join(RESOURCES_DIR, 'seed', 'seed.mjs');

// Las constantes deben coincidir con apps/desktop/main.js
const PG_USER = 'teresita';
const PG_PASSWORD = 'teresita-local-only';
const PG_DB = 'teresita';
const PG_PORT = 54320;

function step(msg) {
  console.log(`\n══ ${msg}`);
}

async function main() {
  // Limpieza: si quedó un template viejo, lo borramos. Postgres no soporta
  // initdb sobre un dir no vacío.
  if (existsSync(TEMPLATE_DIR)) {
    step(`Limpiando template anterior en ${TEMPLATE_DIR}`);
    rmSync(TEMPLATE_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEMPLATE_DIR, { recursive: true });

  step('Cargando embedded-postgres');
  // Esta carga es lazy porque el require puede tirar warnings sobre native deps.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const pg = new EmbeddedPostgres({
    databaseDir: TEMPLATE_DIR,
    user: PG_USER,
    password: PG_PASSWORD,
    port: PG_PORT,
    persistent: true,
  });

  step('initdb (cluster vacío)');
  await pg.initialise();

  step('Levantando Postgres temporal');
  await pg.start();

  // Conectarse como admin (DB postgres) para crear la DB teresita.
  step('Creando database teresita (UTF8 + LC C)');
  const { Client } = await import('pg');
  const adminClient = new Client({
    host: '127.0.0.1',
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: 'postgres',
  });
  await adminClient.connect();
  try {
    await adminClient.query(
      `CREATE DATABASE ${PG_DB} WITH ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
  } finally {
    await adminClient.end();
  }

  // Aplicar schema.sql (generado por build-resources.mjs antes de este step)
  const schemaSqlPath = join(RESOURCES_DIR, 'schema.sql');
  if (!existsSync(schemaSqlPath)) {
    throw new Error(
      `Falta resources/schema.sql — corré build-resources.mjs antes (debería invocarte como último paso).`,
    );
  }
  step(`Aplicando schema.sql desde ${schemaSqlPath}`);
  const { readFileSync } = await import('node:fs');
  const schemaSql = readFileSync(schemaSqlPath, 'utf-8');
  const teresitaClient = new Client({
    host: '127.0.0.1',
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DB,
  });
  await teresitaClient.connect();
  try {
    await teresitaClient.query(schemaSql);
  } finally {
    await teresitaClient.end();
  }

  // Correr el seed bundleado (resources/seed/seed.mjs)
  if (!existsSync(SEED_FILE)) {
    throw new Error(`Falta ${SEED_FILE} — corré build-resources.mjs primero.`);
  }
  step(`Corriendo seed desde ${SEED_FILE}`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SEED_FILE], {
      cwd: dirname(SEED_FILE),
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}?schema=public`,
        NODE_PATH: join(RESOURCES_DIR, 'api', 'node_modules'),
        TZ: 'America/Argentina/Buenos_Aires',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => process.stdout.write('[seed] ' + d));
    child.stderr.on('data', (d) => process.stderr.write('[seed:err] ' + d));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('seed exit ' + code));
    });
  });

  step('Parando Postgres temporal');
  await pg.stop();

  // Confirmar que el template tiene PG_VERSION (señal de cluster válido)
  if (!existsSync(join(TEMPLATE_DIR, 'PG_VERSION'))) {
    throw new Error('PG_VERSION no existe en el template — initdb falló silenciosamente');
  }

  step(`✓ Template listo en ${TEMPLATE_DIR}`);
  console.log(
    'Este directorio se va a bundlear como extraResources y main.js lo copia\n' +
      'al userData en el primer arranque, salteando initdb + schema + seed.',
  );
}

main().catch((err) => {
  console.error('FATAL:', err?.message ?? err);
  process.exit(1);
});
