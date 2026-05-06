/**
 * Descarga el Microsoft Visual C++ Redistributable 2015-2022 (x64) a
 * `build/vc_redist.x64.exe` si no existe ya. Ese .exe se bundlea dentro
 * del NSIS installer y se ejecuta silenciosamente durante la instalación
 * para garantizar que `postgres.exe` / `initdb.exe` tengan las DLLs que
 * necesitan (vcruntime140.dll, msvcp140.dll, etc.).
 *
 * Por qué no commitear el binario directo: 25MB de blob no aporta a la
 * historia de git, mejor descargarlo on-demand en cada build (local + CI).
 *
 * URL oficial Microsoft (estática, redirige a la última versión 14.X):
 *   https://aka.ms/vs/17/release/vc_redist.x64.exe
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(DESKTOP_DIR, 'build');
const TARGET = path.join(BUILD_DIR, 'vc_redist.x64.exe');
const URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

async function downloadFollowingRedirects(url, dest, hops = 0) {
  if (hops > 5) throw new Error('Demasiados redirects siguiendo ' + url);
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          downloadFollowingRedirects(res.headers.location, dest, hops + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} bajando ${url}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        pipeline(res, out).then(resolve, reject);
      })
      .on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  if (fs.existsSync(TARGET)) {
    const stat = fs.statSync(TARGET);
    // Sanity check — el archivo real es ~25MB
    if (stat.size > 5_000_000) {
      console.log(`[ensure-vcredist] ya existe (${(stat.size / 1024 / 1024).toFixed(1)} MB), skip`);
      return;
    }
    console.log('[ensure-vcredist] archivo existente parece corrupto, redescargando');
    fs.unlinkSync(TARGET);
  }

  console.log('[ensure-vcredist] descargando ' + URL);
  const tmp = TARGET + '.partial';
  try {
    await downloadFollowingRedirects(URL, tmp);
    fs.renameSync(tmp, TARGET);
    const sizeMB = (fs.statSync(TARGET).size / 1024 / 1024).toFixed(1);
    console.log(`[ensure-vcredist] OK → ${TARGET} (${sizeMB} MB)`);
  } catch (e) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    throw e;
  }
}

main().catch((err) => {
  console.error('[ensure-vcredist] FATAL: ' + (err?.message ?? err));
  process.exit(1);
});
