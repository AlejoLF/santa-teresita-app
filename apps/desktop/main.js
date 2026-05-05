/**
 * Santa Teresita — Desktop App
 * Orquesta todo el stack local: Postgres embebido + API Fastify + Next.js standalone.
 * El usuario solo ve una ventana — el WebView apunta a 127.0.0.1:3000.
 */

// IMPORTANTE: si ELECTRON_RUN_AS_NODE=1 está seteado, Electron corre como Node puro
// y require('electron') devuelve un string (path al binario), no la API.
// El proceso main NO debe tener esa env. Los child processes (API/Next) SÍ.
if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  delete process.env.ELECTRON_RUN_AS_NODE;
}
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

// Nombre de la app (controla %APPDATA%/<name>/) — antes de cualquier otra cosa
app.setName('Santa Teresita');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
// embedded-postgres es ESM puro → import dinámico al usar
let EmbeddedPostgres = null;
async function loadEmbeddedPostgres() {
  if (EmbeddedPostgres) return EmbeddedPostgres;
  const mod = await import('embedded-postgres');
  EmbeddedPostgres = mod.default ?? mod;
  return EmbeddedPostgres;
}
const { Client } = require('pg');

// ═══ Configuración ═══════════════════════════════════════════════════════

const APP_NAME = 'SantaTeresita';
const PG_PORT = 54320;
const API_PORT = 3001;
const WEB_PORT = 3000;
const PG_USER = 'teresita';
const PG_PASSWORD = 'teresita-local-only';
const PG_DB = 'teresita';

// Directorio de recursos: en dev → ./resources, packageado → process.resourcesPath/app/resources
function isDev() {
  return !app.isPackaged;
}

function resourcesDir() {
  if (isDev()) return path.join(__dirname, 'resources');
  return path.join(process.resourcesPath, 'resources');
}

// Directorio de datos persistente: %APPDATA%/SantaTeresita
function dataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function dbDir() {
  return path.join(dataDir(), 'pgdata');
}

function logsDir() {
  return path.join(dataDir(), 'logs');
}

function logFile() {
  return path.join(logsDir(), `app-${new Date().toISOString().slice(0, 10)}.log`);
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(logFile(), line + '\n');
  } catch {
    /* ignore */
  }
}

// ═══ Estado global ═══════════════════════════════════════════════════════

let mainWindow = null;
let splashWindow = null;
let pgInstance = null;
let apiProcess = null;
let webProcess = null;
let shuttingDown = false;

// ═══ Splash window ════════════════════════════════════════════════════════

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#FAF8F3',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.center();
}

function setSplashStatus(text) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(text)};`)
      .catch(() => {});
  }
}

// ═══ Postgres ═════════════════════════════════════════════════════════════

async function startPostgres() {
  setSplashStatus('Iniciando base de datos...');
  log('Iniciando Postgres embebido en ' + dbDir());

  const isFirstRun = !fs.existsSync(path.join(dbDir(), 'PG_VERSION'));
  const EP = await loadEmbeddedPostgres();

  pgInstance = new EP({
    databaseDir: dbDir(),
    user: PG_USER,
    password: PG_PASSWORD,
    port: PG_PORT,
    persistent: true,
  });

  if (isFirstRun) {
    log('Primer arranque: inicializando cluster Postgres');
    setSplashStatus('Inicializando base de datos (solo primera vez)...');
    fs.mkdirSync(path.dirname(dbDir()), { recursive: true });
    await pgInstance.initialise();
  }

  await pgInstance.start();
  log('Postgres arriba en puerto ' + PG_PORT);

  // Crear DB con encoding UTF8 (Windows usa WIN1252 por default y el seed tiene emojis 🍝)
  // Nos conectamos a "postgres" (que existe siempre) y creamos teresita con template0+UTF8.
  const adminClient = new Client({
    host: '127.0.0.1',
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: 'postgres',
  });
  await adminClient.connect();
  try {
    const exists = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [PG_DB]);
    if (exists.rows.length === 0) {
      await adminClient.query(`CREATE DATABASE ${PG_DB} WITH ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
      log('Base "' + PG_DB + '" creada (UTF8)');
    } else {
      log('Base "' + PG_DB + '" ya existe');
    }
  } finally {
    await adminClient.end();
  }

  if (isFirstRun) {
    setSplashStatus('Aplicando esquema...');
    await applySchema();
    setSplashStatus('Cargando datos iniciales (productos, sabores, etc.)...');
    await runSeed();
    log('Seed completo');
  } else {
    // Upgrade-path: aplicar migraciones idempotentes para columnas/tablas nuevas
    // que se agregaron entre versiones. Cada bloque debe ser seguro de re-ejecutar.
    setSplashStatus('Verificando actualizaciones de base...');
    await upgradeSchema();
  }
}

/**
 * Migraciones idempotentes para versiones que se instalan sobre instalaciones
 * previas. Cada `ALTER TABLE ... IF NOT EXISTS` y `CREATE INDEX ... IF NOT EXISTS`
 * es seguro re-ejecutar en cada arranque.
 */
async function upgradeSchema() {
  const client = new Client({
    host: '127.0.0.1',
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DB,
  });
  await client.connect();
  try {
    // v1.15 — sub-categorías reales (filtra los TipoProducto que se muestran en cajero)
    await client.query(`
      ALTER TABLE "tipos_producto"
      ADD COLUMN IF NOT EXISTS "es_subcategoria" boolean NOT NULL DEFAULT false
    `);
    // v1.18 — contador atómico de numeroOrdenTurno por sesión (race condition fix)
    await client.query(`
      ALTER TABLE "sesiones_caja"
      ADD COLUMN IF NOT EXISTS "ultimo_numero_orden" integer NOT NULL DEFAULT 0
    `);
    // Sincronizar el contador con el MAX existente para no pisar números ya asignados
    await client.query(`
      UPDATE "sesiones_caja" s
      SET "ultimo_numero_orden" = COALESCE(
        (SELECT MAX(v."numero_orden_turno") FROM "ventas" v WHERE v."sesion_caja_id" = s."id"),
        0
      )
      WHERE "ultimo_numero_orden" = 0
    `);
    log('upgradeSchema OK');
  } catch (e) {
    log('upgradeSchema error (no fatal): ' + (e?.message || e));
  } finally {
    await client.end();
  }
}

async function applySchema() {
  const schemaSql = fs.readFileSync(path.join(resourcesDir(), 'schema.sql'), 'utf8');
  log('Aplicando schema (' + schemaSql.length + ' chars)');
  const client = new Client({
    host: '127.0.0.1',
    port: PG_PORT,
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DB,
  });
  await client.connect();
  try {
    await client.query(schemaSql);
  } finally {
    await client.end();
  }
}

function dbUrl() {
  return `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}?schema=public`;
}

async function runSeed() {
  log('Ejecutando seed...');
  const seedPath = path.join(resourcesDir(), 'seed', 'seed.mjs');
  const apiNodeModules = path.join(resourcesDir(), 'api', 'node_modules');

  await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [seedPath], {
      env: {
        ...process.env,
        DATABASE_URL: dbUrl(),
        NODE_PATH: apiNodeModules,
        ELECTRON_RUN_AS_NODE: '1',
      },
      cwd: path.join(resourcesDir(), 'seed'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => log('[seed] ' + d.toString().trim()));
    proc.stderr.on('data', (d) => log('[seed:err] ' + d.toString().trim()));
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('seed exit ' + code));
    });
  });
}

// ═══ API server ════════════════════════════════════════════════════════════

function startApi() {
  setSplashStatus('Iniciando servidor de la app...');
  const apiEntry = path.join(resourcesDir(), 'api', 'server.mjs');
  log('Spawning API: ' + apiEntry);

  apiProcess = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      DATABASE_URL: dbUrl(),
      API_HOST: '127.0.0.1',
      API_PORT: String(API_PORT),
      API_CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}`,
      AUTH_SECRET: 'desktop-local-secret-32chars-ok-12345',
      AUDIT_HASH_SALT: 'desktop-local-salt-16-chars',
      LOG_LEVEL: 'info',
    },
    cwd: path.join(resourcesDir(), 'api'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiProcess.stdout.on('data', (d) => log('[api] ' + d.toString().trim()));
  apiProcess.stderr.on('data', (d) => log('[api:err] ' + d.toString().trim()));
  apiProcess.on('exit', (code) => {
    log('[api] exited code=' + code);
    if (!shuttingDown) gracefulShutdown('API crashed');
  });
}

// ═══ Web server (Next standalone) ══════════════════════════════════════════

function startWeb() {
  setSplashStatus('Iniciando interfaz web...');
  // Lanzamos Next vía su CLI bundleada: resources/web/node_modules/next/dist/bin/next
  const webDir = path.join(resourcesDir(), 'web');
  const nextBin = path.join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  log('Spawning Next: ' + nextBin + ' start');

  webProcess = spawn(process.execPath, [nextBin, 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: String(WEB_PORT),
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${API_PORT}`,
      NEXT_PUBLIC_DEMO_MODE: 'false',
    },
    cwd: webDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  webProcess.stdout.on('data', (d) => log('[web] ' + d.toString().trim()));
  webProcess.stderr.on('data', (d) => log('[web:err] ' + d.toString().trim()));
  webProcess.on('exit', (code) => {
    log('[web] exited code=' + code);
    if (!shuttingDown) gracefulShutdown('Web crashed');
  });
}

// ═══ Health checks ═════════════════════════════════════════════════════════

async function waitForPort(host, port, name, timeoutMs = 60000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(`http://${host}:${port}/`, { method: 'HEAD' }).catch(() => null);
      if (res) return;
    } catch {
      /* ignore */
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${name} no respondió en ${timeoutMs}ms en ${host}:${port}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function waitForApiHealth(timeoutMs = 60000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/health`).catch(() => null);
      if (res && res.ok) return;
    } catch {
      /* ignore */
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`API no respondió /health en ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ═══ Main window ═══════════════════════════════════════════════════════════

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Santa Teresita',
    backgroundColor: '#FAF8F3',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.loadURL(`http://127.0.0.1:${WEB_PORT}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  });

  // Atajos
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'f5' || (input.control && key === 'r')) {
      mainWindow.reload();
      event.preventDefault();
    } else if (key === 'f11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    } else if (input.control && key === 'q') {
      app.quit();
      event.preventDefault();
    } else if (input.control && input.shift && key === 'i') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

// ═══ Lifecycle ═════════════════════════════════════════════════════════════

async function bootstrap() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.mkdirSync(logsDir(), { recursive: true });
    log('═════════════════════════════════════════');
    log('Santa Teresita Desktop — booting');
    log('Data dir: ' + dataDir());
    log('Resources: ' + resourcesDir());

    createSplash();
    await startPostgres();

    setSplashStatus('Iniciando servicios...');
    startApi();
    startWeb();

    await waitForApiHealth(90000);
    log('API OK');
    await waitForPort('127.0.0.1', WEB_PORT, 'Web', 90000);
    log('Web OK');

    setSplashStatus('Listo. Cargando interfaz...');
    createMainWindow();
  } catch (err) {
    log('FATAL: ' + (err && err.stack ? err.stack : err));
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    dialog.showErrorBox(
      'Santa Teresita — Error de arranque',
      `No se pudo iniciar la aplicación.\n\nError: ${err && err.message ? err.message : err}\n\nLog: ${logFile()}`,
    );
    app.quit();
  }
}

async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutdown: ' + reason);
  try { if (apiProcess) apiProcess.kill(); } catch {}
  try { if (webProcess) webProcess.kill(); } catch {}
  try { if (pgInstance) await pgInstance.stop(); } catch (e) { log('pg stop err: ' + e); }
  app.quit();
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  void gracefulShutdown('all windows closed');
});

app.on('before-quit', () => {
  shuttingDown = true;
});

process.on('exit', () => {
  try { if (apiProcess) apiProcess.kill(); } catch {}
  try { if (webProcess) webProcess.kill(); } catch {}
});
