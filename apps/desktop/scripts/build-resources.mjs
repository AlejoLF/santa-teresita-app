/**
 * Build pipeline para el bundle de escritorio.
 * Produce ./resources con todo lo necesario para correr el stack en máquina del cliente:
 *   - schema.sql      — DDL completo del schema Prisma
 *   - api/            — apps/api compilado a JS (con node_modules)
 *   - web/            — apps/web Next.js standalone build
 *   - seed/           — packages/db seed compilado + seed-data + parsed Excel JSON
 *   - prisma-engine/  — binario nativo de Prisma para Windows
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');
const RESOURCES = path.join(DESKTOP_DIR, 'resources');

function step(msg) {
  console.log(`\n══ ${msg} ══`);
}

function run(cmd, cwd = REPO_ROOT) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Recursivamente borra archivos que son solo dev artifacts dentro de un
 * directorio node_modules: source maps, TypeScript definitions, READMEs,
 * CHANGELOGs, tests, examples, etc. El .exe en runtime NO los lee.
 *
 * Filosofía: si te equivocás y borrás algo que SÍ se necesita, en runtime
 * vas a ver un error de require. Los patrones de abajo son conservadores
 * (.map y .d.ts son los que más pesan y son 100% safe).
 */
function pruneDevArtifacts(root) {
  if (!fs.existsSync(root)) return;
  let deleted = 0;
  let savedBytes = 0;
  const dropExt = new Set(['.map', '.ts']); // .d.ts cae acá; .ts puro no debería existir en node_modules
  const dropName = new Set([
    'README.md',
    'README',
    'README.markdown',
    'CHANGELOG.md',
    'CHANGELOG',
    'HISTORY.md',
    'LICENSE.md',
    '.npmignore',
    '.eslintrc',
    '.eslintrc.json',
    '.editorconfig',
    'tsconfig.json',
    'tsconfig.build.json',
  ]);
  const dropDir = new Set([
    '__tests__',
    'test',
    'tests',
    'example',
    'examples',
    'docs',
    '.github',
    'man',
  ]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dropDir.has(entry.name)) {
          try {
            const size = dirSize(p);
            fs.rmSync(p, { recursive: true, force: true });
            savedBytes += size;
          } catch {}
        } else {
          walk(p);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (dropExt.has(ext) || dropName.has(entry.name)) {
          try {
            const sz = fs.statSync(p).size;
            fs.unlinkSync(p);
            deleted++;
            savedBytes += sz;
          } catch {}
        }
      }
    }
  };
  walk(root);
  console.log(`  Pruned ${deleted} files, ${(savedBytes / 1024 / 1024).toFixed(1)} MB ahorrados`);
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += dirSize(p);
      else if (entry.isFile()) {
        try { total += fs.statSync(p).size; } catch {}
      }
    }
  } catch {}
  return total;
}

function reset() {
  step('Limpiando resources/');
  fs.rmSync(RESOURCES, { recursive: true, force: true });
  fs.mkdirSync(RESOURCES, { recursive: true });
}

function generateSchemaSql() {
  step('Generando schema.sql desde Prisma');
  const dbDir = path.join(REPO_ROOT, 'packages', 'db');
  const schemaPath = path.join(dbDir, 'prisma', 'schema.prisma');
  const out = path.join(RESOURCES, 'schema.sql');
  run(
    `pnpm exec prisma migrate diff --from-empty --to-schema-datamodel "${schemaPath}" --script > "${out}"`,
    dbDir,
  );
  const stat = fs.statSync(out);
  if (stat.size < 100) throw new Error(`schema.sql está vacío (${stat.size} bytes)`);
  console.log(`  → schema.sql (${(stat.size / 1024).toFixed(1)} KB)`);

  // El schema.sql usa CREATE EXTENSION para Postgres con extensions disponibles.
  // El binario embedded-postgres trae btree_gin, pg_trgm, pgcrypto, unaccent y uuid-ossp por default.
  // Si alguna falla podemos comentarla acá.
}

function buildApi() {
  step('Generando Prisma client');
  run('pnpm --filter @sta/db run generate');

  step('Bundle API con esbuild → resources/api/server.cjs');
  const apiDir = path.join(REPO_ROOT, 'apps', 'api');
  const dest = path.join(RESOURCES, 'api');
  fs.mkdirSync(dest, { recursive: true });

  const entry = path.join(apiDir, 'src', 'server.ts');
  // Bundleamos todo a un único CJS, dejando como external los nativos (Prisma engine + bcryptjs)
  // y deps que se resolverán desde resources/api/node_modules.
  const externals = [
    '@prisma/client',
    '.prisma/client',
    'bcryptjs',
    'pino',
    // better-sqlite3 tiene binding nativo (.node) — esbuild no puede bundlearlo,
    // tiene que ir como dep real en resources/api/node_modules. Se usa para
    // el outbox local de writes pendientes (offline resilience).
    'better-sqlite3',
    // Fastify y plugins son ESM "modernos" — bundlearlos a CJS suele funcionar pero
    // ante la duda los dejamos external y los traemos por npm install plano.
    // pino-pretty NO se incluye: solo se usa en dev (server.ts línea 33-36 lo
    // monta sólo cuando NODE_ENV !== 'production', y el desktop corre con
    // NODE_ENV=production).
  ];
  const externalArgs = externals.map((e) => `--external:${e}`).join(' ');
  const esbuildBin = path.join(DESKTOP_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  // El código usa import.meta.url → bundleamos como ESM
  run(
    `"${esbuildBin}" "${entry}" --bundle --platform=node --target=node20 --format=esm --outfile="${path.join(dest, 'server.mjs')}" --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" ${externalArgs}`,
    REPO_ROOT,
  );

  step('Instalando deps externals de la API en resources/api/');
  // Generamos un package.json mínimo para que npm install resuelva solo lo external.
  const apiPkg = JSON.parse(fs.readFileSync(path.join(apiDir, 'package.json'), 'utf8'));
  const pkgPlano = {
    name: 'sta-api-runtime',
    version: '0.1.0',
    private: true,
    dependencies: {
      '@prisma/client': apiPkg.dependencies['@prisma/client'] ?? '^5.22.0',
      bcryptjs: apiPkg.dependencies['bcryptjs'] ?? '^2.4.3',
      pino: apiPkg.dependencies['pino'] ?? '^9.5.0',
      // better-sqlite3: backend del outbox local. Native binding, ship con
      // prebuild para Win x64 (incluido en el paquete npm).
      'better-sqlite3': apiPkg.dependencies['better-sqlite3'] ?? '^11.6.0',
      // pino-pretty solo se usa en dev — no se bundlea en el .exe
    },
  };
  // Si @sta/db expone @prisma/client desde packages/db, agarramos también los archivos generados
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(pkgPlano, null, 2));
  run('npm install --omit=dev --no-package-lock --no-fund --no-audit', dest);

  // ── better-sqlite3: rebuild contra la ABI de Electron ──
  // npm install baja el prebuilt compilado para Node estándar (ABI 127).
  // Pero la API corre como child process de Electron (ELECTRON_RUN_AS_NODE),
  // que usa la ABI de Electron 33 (130). Sin esto, al cargar el .node tira
  // ERR_DLOPEN_FAILED y se rompe el outbox (/sync/*). Forzamos a
  // prebuild-install a bajar el binario de Electron con runtime/target.
  const electronVer = JSON.parse(
    fs.readFileSync(path.join(DESKTOP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8'),
  ).version;
  step(`Rebuild better-sqlite3 para Electron ${electronVer} (ABI nativa)`);
  // Invocamos el prebuild-install bundleado de better-sqlite3 con flags CLI
  // (-r electron -t <ver>). NO usar `npm rebuild` + npm_config_* env vars:
  // npm moderno los ignora/warnea y termina bajando el binario de Node
  // (ABI 137) en vez del de Electron (ABI 130) → ERR_DLOPEN_FAILED en
  // runtime y se rompe el outbox (/sync/*). Con prebuild-install directo y
  // cwd en el dir del paquete, baja el tarball electron-v130 correcto.
  const bsqDir = path.join(dest, 'node_modules', 'better-sqlite3');
  const prebuildBin = path.join(
    dest,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install',
  );
  execSync(`"${prebuildBin}" -r electron -t ${electronVer} --tag-prefix v`, {
    stdio: 'inherit',
    cwd: bsqDir,
    shell: process.platform === 'win32',
  });

  step('Limpiando archivos dev de resources/api/node_modules');
  pruneDevArtifacts(path.join(dest, 'node_modules'));

  step('Copiando cliente Prisma generado (con engine binario)');
  // pnpm guarda el .prisma/client real en .pnpm/<hash>/node_modules/.prisma/client
  // Buscamos cualquier carpeta que tenga query_engine y la copiamos sobre lo que dejó npm.
  const prismaDest = path.join(dest, 'node_modules', '.prisma', 'client');
  fs.mkdirSync(prismaDest, { recursive: true });

  function findGeneratedPrismaClient(root) {
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (!e.isDirectory()) continue;
        if (e.name === 'client' && full.endsWith(path.join('.prisma', 'client'))) {
          // Verificar que tenga el engine binario
          const hasEngine = fs.readdirSync(full).some((f) => /^(query_engine|libquery_engine).*\.(node|so|dylib)/.test(f));
          if (hasEngine) return full;
        }
        // Solo recursar en .pnpm o node_modules
        if (e.name === 'node_modules' || e.name === '.pnpm' || cur.includes('.pnpm')) {
          stack.push(full);
        }
      }
    }
    return null;
  }

  const realClient = findGeneratedPrismaClient(path.join(REPO_ROOT, 'node_modules'));
  if (!realClient) throw new Error('No encontré .prisma/client con engine binario en node_modules/.pnpm');
  console.log('  Cliente real:', realClient);
  copyDir(realClient, prismaDest);
  const engines = fs.readdirSync(prismaDest).filter((f) => f.includes('query_engine'));
  console.log('  Engines:', engines);
}

function buildSeed() {
  step('Compilando seed.ts → resources/seed/seed.mjs (esbuild ESM)');
  const seedSrc = path.join(REPO_ROOT, 'packages', 'db', 'prisma', 'seed.ts');
  const seedDir = path.join(RESOURCES, 'seed');
  fs.mkdirSync(seedDir, { recursive: true });
  const esbuildBin = path.join(DESKTOP_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  // El seed usa import.meta.url → bundleamos como ESM (igual que la API).
  // bcryptjs es JS puro, lo bundleamos. Solo @prisma/client queda external (binary engine).
  run(
    `"${esbuildBin}" "${seedSrc}" --bundle --platform=node --target=node20 --format=esm --outfile="${path.join(seedDir, 'seed.mjs')}" --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" --external:@prisma/client --external:.prisma/client`,
    REPO_ROOT,
  );

  // Symlink/copy de node_modules para que el seed encuentre @prisma/client (con engine)
  step('Linkeando @prisma/client en seed/node_modules');
  const seedNm = path.join(seedDir, 'node_modules');
  fs.mkdirSync(seedNm, { recursive: true });
  // Copia @prisma/client desde lo que ya está en resources/api
  const apiPrisma = path.join(RESOURCES, 'api', 'node_modules', '@prisma');
  if (fs.existsSync(apiPrisma)) {
    copyDir(apiPrisma, path.join(seedNm, '@prisma'));
  }
  const apiDotPrisma = path.join(RESOURCES, 'api', 'node_modules', '.prisma');
  if (fs.existsSync(apiDotPrisma)) {
    copyDir(apiDotPrisma, path.join(seedNm, '.prisma'));
  }

  step('Copiando seed-data');
  const seedDataSrc = path.join(REPO_ROOT, 'packages', 'db', 'prisma', 'seed-data');
  if (fs.existsSync(seedDataSrc)) {
    copyDir(seedDataSrc, path.join(seedDir, 'seed-data'));
  }
}

function buildWeb() {
  step('Build Next.js (standard, sin standalone — los symlinks de pnpm rompen en Windows)');
  // En vez de output:'standalone', hacemos build normal y bundleamos node_modules.
  const env = { ...process.env, NEXT_PUBLIC_DEMO_MODE: 'false' };
  // STA_BUILD_TARGET sin valor → standalone se desactiva
  execSync('pnpm --filter @sta/web run build', {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env,
    shell: process.platform === 'win32',
  });

  step('Copiando .next + public + package.json a resources/web');
  const webDir = path.join(REPO_ROOT, 'apps', 'web');
  const dest = path.join(RESOURCES, 'web');
  fs.mkdirSync(dest, { recursive: true });
  copyDir(path.join(webDir, '.next'), path.join(dest, '.next'));
  if (fs.existsSync(path.join(webDir, 'public'))) {
    copyDir(path.join(webDir, 'public'), path.join(dest, 'public'));
  }
  // Copiamos también next.config.mjs para que `next start` lo lea
  fs.copyFileSync(path.join(webDir, 'next.config.mjs'), path.join(dest, 'next.config.mjs'));

  step('Generando package.json plano y npm install en resources/web');
  const webPkg = JSON.parse(fs.readFileSync(path.join(webDir, 'package.json'), 'utf8'));
  // Reemplazamos workspace:* por las versiones reales hard-coded
  const sharedPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', 'shared', 'package.json'), 'utf8'));
  const cleanDeps = {};
  for (const [name, ver] of Object.entries(webPkg.dependencies || {})) {
    if (typeof ver === 'string' && ver.startsWith('workspace:')) continue; // los traemos por copia
    cleanDeps[name] = ver;
  }
  fs.writeFileSync(
    path.join(dest, 'package.json'),
    JSON.stringify({
      name: 'sta-web-runtime',
      version: '0.1.0',
      private: true,
      scripts: { start: 'next start -p 3000 -H 127.0.0.1' },
      dependencies: cleanDeps,
    }, null, 2),
  );
  run('npm install --omit=dev --no-package-lock --no-fund --no-audit', dest);

  // Limpieza post-install: borra archivos que SOLO sirven para dev / debug
  // y que en runtime el .exe NO lee. En medición previa esto ahorra ~80-150
  // MB del bundle final (source maps + TypeScript defs + READMEs + tests).
  step('Limpiando archivos dev de resources/web/node_modules');
  pruneDevArtifacts(path.join(dest, 'node_modules'));

  // Copiar @sta/shared (workspace dep) que la app necesita en runtime
  step('Copiando @sta/shared a node_modules/@sta/shared');
  const sharedSrc = path.join(REPO_ROOT, 'packages', 'shared');
  const sharedDest = path.join(dest, 'node_modules', '@sta', 'shared');
  fs.mkdirSync(sharedDest, { recursive: true });
  copyDir(path.join(sharedSrc, 'src'), path.join(sharedDest, 'src'));
  fs.copyFileSync(path.join(sharedSrc, 'package.json'), path.join(sharedDest, 'package.json'));
}

function copyExcels() {
  step('Copiando Excels del cliente (input para parser)');
  const dest = path.join(RESOURCES, 'excels');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(REPO_ROOT)) {
    if (f.toLowerCase().endsWith('.xlsx') || f.toLowerCase().endsWith('.xls')) {
      fs.copyFileSync(path.join(REPO_ROOT, f), path.join(dest, f));
    }
  }
}

function buildAgent() {
  step('Compilando local-agent → resources/agent/agent.mjs (esbuild ESM)');
  const agentSrc = path.join(REPO_ROOT, 'apps', 'local-agent', 'src', 'agent.ts');
  const agentDir = path.join(RESOURCES, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const esbuildBin = path.join(
    DESKTOP_DIR,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild',
  );

  // node-thermal-printer tiene deps nativas/dinámicas — lo dejamos external
  // y lo traemos por npm install. dotenv y pino también van como dependencias
  // resolvibles, no bundleados.
  const externals = ['node-thermal-printer', 'pino', 'pino-pretty', 'dotenv'];
  const externalArgs = externals.map((e) => `--external:${e}`).join(' ');

  run(
    `"${esbuildBin}" "${agentSrc}" --bundle --platform=node --target=node20 --format=esm --outfile="${path.join(agentDir, 'agent.mjs')}" --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" ${externalArgs}`,
    REPO_ROOT,
  );

  step('Instalando deps del agent en resources/agent/');
  const agentPkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'apps', 'local-agent', 'package.json'), 'utf8'),
  );
  const pkgPlano = {
    name: 'sta-agent-runtime',
    version: '0.1.0',
    private: true,
    dependencies: {
      'node-thermal-printer':
        agentPkg.dependencies?.['node-thermal-printer'] ?? '^4.4.4',
      pino: agentPkg.dependencies?.['pino'] ?? '^9.5.0',
      dotenv: agentPkg.dependencies?.['dotenv'] ?? '^16.4.7',
    },
  };
  fs.writeFileSync(path.join(agentDir, 'package.json'), JSON.stringify(pkgPlano, null, 2));
  run('npm install --omit=dev --no-package-lock --no-fund --no-audit', agentDir);
  step('Limpiando archivos dev de resources/agent/node_modules');
  pruneDevArtifacts(path.join(agentDir, 'node_modules'));
}

function copyCloudConfig() {
  step('Copiando cloud-config.json (URL de Supabase)');
  const src = path.join(DESKTOP_DIR, 'cloud-config.json');
  if (!fs.existsSync(src)) {
    console.log('  ⚠ cloud-config.json no existe — el .exe va a fallar al boot.');
    console.log('  Generalo con: cp apps/desktop/cloud-config.example.json apps/desktop/cloud-config.json');
    console.log('  Y completalo con la connection string del pooler de Supabase.');
    return;
  }
  fs.copyFileSync(src, path.join(RESOURCES, 'cloud-config.json'));
  console.log('  ✓ cloud-config.json copiado a resources/');
}

async function main() {
  reset();
  // v2.x: ya NO generamos schema.sql ni bundlemos el seed. La cloud DB ya
  // tiene todo aplicado. Las PCs cliente solo corren API + Web + Agent
  // contra cloud.
  buildApi();
  buildWeb();
  buildAgent();
  copyExcels();
  copyCloudConfig();
  step('✓ Resources listas en ' + RESOURCES);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
