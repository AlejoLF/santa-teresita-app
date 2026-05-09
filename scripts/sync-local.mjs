#!/usr/bin/env node
/**
 * Sincroniza el repo local con origin/main + DB local con schema + seed.
 * Idempotente. Uso: pnpm sync-local
 */
import { execSync } from 'node:child_process';

const C = { reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', cyan: '\x1b[36m' };
let stashed = false;

function step(n, total, title) { console.log(`\n${C.cyan}${C.bold}[${n}/${total}]${C.reset} ${title}`); }
function run(cmd, opts = {}) {
  console.log(`${C.dim}  $ ${cmd}${C.reset}`);
  try {
    const out = execSync(cmd, { stdio: opts.silent ? 'pipe' : 'inherit', encoding: 'utf8' });
    return { ok: true, out: out ?? '' };
  } catch (e) {
    if (opts.allowFail) return { ok: false, err: e };
    console.error(`${C.red}  X Falló: ${e.message ?? e}${C.reset}`);
    process.exit(1);
  }
}
const tryRun = (cmd) => run(cmd, { silent: true, allowFail: true });

step(1, 6, 'Verificando cambios locales');
const status = tryRun('git status --porcelain');
if (status.ok && status.out.trim().length > 0) {
  console.log(`${C.yellow}  Stash temporal de cambios sin commitear...${C.reset}`);
  const r = tryRun('git stash push -u -m "sync-local autosave"');
  if (!r.ok) { console.error(`${C.red}  X No pude stashear. Commiteá manual.${C.reset}`); process.exit(1); }
  stashed = true;
} else { console.log(`${C.green}  OK Working tree limpio${C.reset}`); }

step(2, 6, 'Pull desde origin/main');
run('git fetch origin --prune');
const branch = tryRun('git rev-parse --abbrev-ref HEAD').out.trim();
if (branch !== 'main') { console.log(`${C.yellow}  Cambio de '${branch}' a main...${C.reset}`); run('git checkout main'); }
run('git pull --ff-only origin main');

step(3, 6, 'pnpm install');
run('pnpm install');

step(4, 6, 'Generar Prisma client');
run('pnpm --filter @sta/db run generate');

step(5, 6, 'Sync schema con DB local (Docker)');
const docker = tryRun('docker ps --format "{{.Names}}"');
if (docker.ok && !docker.out.includes('teresita-postgres')) {
  console.log(`${C.yellow}  ! teresita-postgres no corre. Levantalo: pnpm docker:up${C.reset}`);
} else {
  run('pnpm --filter @sta/db exec prisma db push --skip-generate --accept-data-loss');
  step(6, 6, 'Re-correr seed (idempotente)');
  run('pnpm db:seed');
}

if (stashed) {
  const pop = tryRun('git stash pop');
  if (!pop.ok) console.log(`${C.yellow}  ! Conflicto al pop stash — está en git stash list${C.reset}`);
  else console.log(`${C.green}  OK Stash restaurado${C.reset}`);
}
console.log(`\n${C.green}${C.bold}=== Sync completo ===${C.reset}`);
console.log(`${C.dim}Si tenías 'pnpm dev' corriendo, agarra los cambios solo (hot reload).${C.reset}`);
console.log(`${C.dim}Si no, arrancá: pnpm dev${C.reset}\n`);
