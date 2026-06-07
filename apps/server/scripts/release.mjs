/**
 * Release del SERVIDOR LOCAL a GitHub Releases.
 *
 * Buildea apps/server/dist, lo empaqueta en un .zip, y crea un release
 * `server-v<version>` con el zip como asset. Cada server, vía update-server.ps1
 * (tarea programada), baja ese asset y se auto-actualiza.
 *
 * Uso:
 *   pnpm --filter @sta/server release
 *
 * Requisitos:
 *   - gh CLI instalado y autenticado (`gh auth login`).
 *   - Bumpeá la "version" en apps/server/package.json antes de cada release:
 *     el tag `server-v<version>` debe ser ÚNICO (GitHub rechaza tags repetidos).
 *
 * Versionado: independiente del .exe de las cajas (que usa tags v2.0.0-alpha.N).
 * Acá el prefijo `server-` evita choques.
 */
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_DIR, '..', '..');
const DIST = path.join(SERVER_DIR, 'dist');
const REPO = 'AlejoLF/santa-teresita-app';

function step(m) {
  console.log(`\n══ ${m} ══`);
}
function run(cmd, cwd = REPO_ROOT) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd, shell: true });
}
function capture(cmd, cwd = REPO_ROOT) {
  return execSync(cmd, { cwd, shell: true }).toString().trim();
}
// execFile: args como ARRAY, sin shell → evita el quoting roto de cmd.exe con
// paths que tienen espacios ("SANTA TERESITA APP").
function execFile(file, args, cwd = REPO_ROOT) {
  console.log(`$ ${file} ${args.join(' ')}`);
  execFileSync(file, args, { stdio: 'inherit', cwd, shell: false });
}

const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `server-v${version}`;

step(`Release ${tag}`);

// 0. gh disponible + autenticado
try {
  capture('gh --version');
} catch {
  throw new Error('gh CLI no está instalado. Instalalo de https://cli.github.com');
}
try {
  capture('gh auth status');
} catch {
  throw new Error('gh no está autenticado. Corré: gh auth login');
}

// 1. ¿el tag ya existe? (evita pisar un release)
let tagExists = false;
try {
  capture(`gh release view ${tag} --repo ${REPO}`);
  tagExists = true;
} catch {
  /* no existe → seguimos */
}
if (tagExists) {
  throw new Error(
    `El release ${tag} YA existe. Bumpeá "version" en apps/server/package.json y reintentá.`,
  );
}

// 2. Build limpio del server
step('Build del server (scripts/build.mjs)');
run('node scripts/build.mjs', SERVER_DIR);
if (!fs.existsSync(path.join(DIST, 'api', 'server.mjs'))) {
  throw new Error('El build no produjo dist/api/server.mjs');
}

// 3. Empaquetar dist/ → zip (contenido al root del zip vía tar -C dist .)
step('Empaquetando dist/ → zip');
const zipName = `sta-${tag}.zip`;
const zipPath = path.join(SERVER_DIR, zipName);
fs.rmSync(zipPath, { force: true });
// Compress-Archive (no tar): el tar de Git/MSYS en el PATH no escribe zip e
// interpreta "D:" como host remoto. PowerShell zipea sin ambigüedad. -Path
// dir\* mete el CONTENIDO al root del zip (api/, migrations/, seed/...).
execFile('powershell', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${DIST}\\*' -DestinationPath '${zipPath}' -Force`,
]);
const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`  ${zipName} (${sizeMb} MB)`);

// 4. Crear el GitHub Release con el zip como asset
step('Creando GitHub Release');
const notes = `Servidor local Santa Teresita v${version}. Auto-instalable: cada server lo baja con update-server.ps1 (tarea programada 4 AM) o forzando .\\update-server.ps1 -Force`;
execFile('gh', [
  'release', 'create', tag, zipPath,
  '--repo', REPO,
  '--title', `Server v${version}`,
  '--notes', notes,
]);

// 5. Limpieza del zip local
fs.rmSync(zipPath, { force: true });

step(`✓ Release ${tag} publicado`);
console.log('  Los servers se actualizan solos (4 AM) o forzando: .\\update-server.ps1 -Force');
