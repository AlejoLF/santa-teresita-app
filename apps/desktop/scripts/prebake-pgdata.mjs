/**
 * Pre-bakea el cluster de Postgres durante el CI build, así el primer arranque
 * en la PC del usuario salta `initdb` (4-5 min). El install pasa de ~15 min
 * a ~10 min.
 *
 * Lo que NO podemos pre-bakear (limitación del runner CI):
 *   - CREATE DATABASE teresita
 *   - applySchema()
 *   - runSeed()
 *   ...porque GitHub Actions Windows runner corre como `runneradmin` (admin)
 *   y Postgres se rehúsa a arrancar como admin por seguridad. initdb SÍ
 *   funciona porque no inicia un servidor — solo bootstrapea archivos.
 *   Esos pasos siguen ocurriendo en el primer arranque del usuario (su user
 *   NO es admin, así que Postgres arranca normal).
 *
 * Estrategia:
 *   1. mkdtemp en %TEMP% (permisos de runner user, no del workspace).
 *   2. initdb vía embedded-postgres → cluster vacío.
 *   3. cpSync al final dir `apps/desktop/build/pgdata-template/`.
 *   4. electron-builder lo bundlea como extraResources.
 *
 * En la PC del usuario, main.js detecta el template:
 *   - Lo copia al userData/data/pgdata.
 *   - Skip `pgInstance.initialise()` (ya está hecho).
 *   - Sigue con start() + CREATE DATABASE + applySchema + runSeed como antes.
 */

import { existsSync, rmSync, mkdirSync, cpSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(__dirname, '..');
const FINAL_DIR = join(DESKTOP_DIR, 'build', 'pgdata-template');

// initdb necesita poder cambiar permisos del directorio. En Windows runners
// de GitHub Actions, el workspace en `D:\a\...` tiene ACLs heredadas que
// initdb no puede modificar. Workaround: corremos initdb en %TEMP% y al final
// copiamos al destino dentro del repo.
const WORK_DIR = mkdtempSync(join(tmpdir(), 'sta-prebake-'));

// Las constantes deben coincidir con apps/desktop/main.js
const PG_USER = 'teresita';
const PG_PASSWORD = 'teresita-local-only';
const PG_PORT = 54320;

function step(msg) {
  console.log(`\n══ ${msg}`);
}

async function main() {
  step(`Trabajando en ${WORK_DIR}`);

  step('Cargando embedded-postgres');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const pg = new EmbeddedPostgres({
    databaseDir: WORK_DIR,
    user: PG_USER,
    password: PG_PASSWORD,
    port: PG_PORT,
    persistent: true,
  });

  step('initdb (cluster vacío)');
  await pg.initialise();

  // NO arrancamos Postgres ni ejecutamos schema/seed — eso falla en runners
  // CI que corren como admin. Lo hacemos en la PC del usuario al primer
  // arranque (su user NO es admin, así que Postgres arranca limpio).

  // Confirmar que el cluster tiene PG_VERSION (señal de cluster válido)
  if (!existsSync(join(WORK_DIR, 'PG_VERSION'))) {
    throw new Error('PG_VERSION no existe en el cluster — initdb falló silenciosamente');
  }

  // Copiar el cluster al destino final (dentro del repo, gitignored)
  // donde electron-builder lo va a bundlear.
  step(`Copiando cluster a ${FINAL_DIR}`);
  if (existsSync(FINAL_DIR)) {
    rmSync(FINAL_DIR, { recursive: true, force: true });
  }
  mkdirSync(dirname(FINAL_DIR), { recursive: true });
  cpSync(WORK_DIR, FINAL_DIR, { recursive: true });

  step(`Limpiando workdir ${WORK_DIR}`);
  try {
    rmSync(WORK_DIR, { recursive: true, force: true });
  } catch (e) {
    console.warn('No se pudo limpiar workdir (no fatal): ' + (e?.message ?? e));
  }

  step(`✓ Template listo en ${FINAL_DIR}`);
  console.log(
    'main.js lo va a copiar al userData en el primer arranque, salteando\n' +
      'initdb (4-5 min ahorrados).',
  );
}

main().catch((err) => {
  // Mejor serialización que `?? err` para errores sin .message ni .stack.
  const mensaje = (() => {
    if (!err) return 'Error desconocido';
    if (typeof err === 'string') return err;
    if (err.message) return String(err.message);
    if (err.stack) return String(err.stack);
    try {
      const json = JSON.stringify(err, Object.getOwnPropertyNames(err));
      if (json && json !== '{}') return json;
    } catch {}
    return `Error sin formato — type: ${typeof err}, ctor: ${err?.constructor?.name ?? 'unknown'}`;
  })();
  console.error('FATAL:', mensaje);
  process.exit(1);
});
