/**
 * Build del servidor local LAN — deliverable SEPARADO del .exe.
 *
 * Produce `apps/server/dist/` autocontenido para llevar al mini PC:
 *   dist/
 *     api/server.mjs           ─ API Fastify bundleada (esbuild ESM)
 *     api/node_modules/        ─ externals + @prisma/client + engine (ABI Node)
 *     api/package.json
 *     migrations/              ─ SQL de todas las migraciones (orden cronológico)
 *     seed/seed.mjs            ─ seed compilado + seed-data
 *     .env.example             ─ template de config del server
 *     setup-mini-pc.ps1        ─ provisión (Postgres + migraciones + servicios)
 *     README.md                ─ runbook del operador
 *
 * El server corre bajo Node PURO (no Electron) como Windows Service, así que
 * better-sqlite3 va con su prebuilt de Node (NO se rebuildea para Electron —
 * esa complejidad es solo del .exe).
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_DIR, '..', '..');
const DIST = path.join(SERVER_DIR, 'dist');

function step(m) {
  console.log(`\n══ ${m} ══`);
}
function run(cmd, cwd = REPO_ROOT) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
}
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// ── reset ──
step('Limpiando dist/');
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// ── Prisma client (engine ABI Node) ──
step('Generando Prisma client');
run('pnpm --filter @sta/db run generate');

// ── Bundle API ──
step('Bundle API con esbuild → dist/api/server.mjs');
const apiDir = path.join(REPO_ROOT, 'apps', 'api');
const apiDest = path.join(DIST, 'api');
fs.mkdirSync(apiDest, { recursive: true });

const externals = ['@prisma/client', '.prisma/client', 'bcryptjs', 'pino', 'better-sqlite3'];
const externalArgs = externals.map((e) => `--external:${e}`).join(' ');
const esbuildBin = path.join(
  SERVER_DIR,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild',
);
run(
  `"${esbuildBin}" "${path.join(apiDir, 'src', 'server.ts')}" --bundle --platform=node ` +
    `--target=node20 --format=esm --outfile="${path.join(apiDest, 'server.mjs')}" ` +
    `--banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" ` +
    externalArgs,
  REPO_ROOT,
);

// ── Externals via npm (better-sqlite3 = prebuilt Node, sin rebuild Electron) ──
step('npm install externals en dist/api/');
const apiPkg = JSON.parse(fs.readFileSync(path.join(apiDir, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(apiDest, 'package.json'),
  JSON.stringify(
    {
      name: 'sta-server-runtime',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: {
        '@prisma/client': apiPkg.dependencies['@prisma/client'] ?? '^5.22.0',
        bcryptjs: apiPkg.dependencies['bcryptjs'] ?? '^2.4.3',
        pino: apiPkg.dependencies['pino'] ?? '^9.5.0',
        'better-sqlite3': apiPkg.dependencies['better-sqlite3'] ?? '^12.9.0',
      },
    },
    null,
    2,
  ),
);
run('npm install --omit=dev --no-package-lock --no-fund --no-audit', apiDest);

// ── Copiar Prisma client generado (con engine binario) ──
step('Copiando .prisma/client con engine');
function findGeneratedPrismaClient(root) {
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (!e.isDirectory()) continue;
      if (e.name === 'client' && full.endsWith(path.join('.prisma', 'client'))) {
        const hasEngine = fs
          .readdirSync(full)
          .some((f) => /^(query_engine|libquery_engine).*\.(node|so|dylib)/.test(f));
        if (hasEngine) return full;
      }
      if (e.name === 'node_modules' || e.name === '.pnpm' || cur.includes('.pnpm')) {
        stack.push(full);
      }
    }
  }
  return null;
}
const realClient = findGeneratedPrismaClient(path.join(REPO_ROOT, 'node_modules'));
if (!realClient) throw new Error('No encontré .prisma/client con engine en node_modules/.pnpm');
// El @prisma/client de npm es el wrapper; el código generado real (con
// engine) vive en .prisma/client y el wrapper lo re-exporta. Copiamos solo
// .prisma/client sobre lo que dejó npm (mismo enfoque que el build del .exe).
const prismaDest = path.join(apiDest, 'node_modules', '.prisma', 'client');
fs.mkdirSync(prismaDest, { recursive: true });
copyDir(realClient, prismaDest);

// ── Migraciones SQL (orden cronológico por nombre) ──
step('Copiando migraciones SQL');
const migSrc = path.join(REPO_ROOT, 'packages', 'db', 'prisma', 'migrations');
const migDest = path.join(DIST, 'migrations');
fs.mkdirSync(migDest, { recursive: true });
for (const name of fs.readdirSync(migSrc).sort()) {
  const sql = path.join(migSrc, name, 'migration.sql');
  if (fs.existsSync(sql)) {
    fs.copyFileSync(sql, path.join(migDest, `${name}.sql`));
  }
}

// ── Seed compilado ──
step('Compilando seed → dist/seed/seed.mjs');
const seedDir = path.join(DIST, 'seed');
fs.mkdirSync(seedDir, { recursive: true });
run(
  `"${esbuildBin}" "${path.join(REPO_ROOT, 'packages', 'db', 'prisma', 'seed.ts')}" ` +
    `--bundle --platform=node --target=node20 --format=esm ` +
    `--outfile="${path.join(seedDir, 'seed.mjs')}" ` +
    `--banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" ` +
    `--external:@prisma/client --external:.prisma/client`,
  REPO_ROOT,
);
const seedDataSrc = path.join(REPO_ROOT, 'packages', 'db', 'prisma', 'seed-data');
if (fs.existsSync(seedDataSrc)) copyDir(seedDataSrc, path.join(seedDir, 'seed-data'));

// ── Artefactos del operador ──
step('Copiando .env.example, setup-mini-pc.ps1, README');
for (const f of ['.env.example', 'setup-mini-pc.ps1', 'README.md']) {
  const src = path.join(SERVER_DIR, f.startsWith('setup') ? path.join('scripts', f) : f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST, f));
}

step(`✓ Server build listo en ${DIST}`);
console.log('  Llevá la carpeta dist/ completa al mini PC y corré setup-mini-pc.ps1.');
