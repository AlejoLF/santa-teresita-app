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
const { app, BrowserWindow, Menu, shell, dialog, screen } = require('electron');

// Nombre de la app (controla %APPDATA%/<name>/) — antes de cualquier otra cosa
app.setName('Santa Teresita');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
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

/**
 * Devuelve el secret pedido (AUTH_SECRET / AUDIT_HASH_SALT). Lo genera
 * aleatoriamente al primer arranque y lo persiste en `userData/secrets.json`,
 * para que cada instalación tenga sus propios secrets — los del .exe no son
 * extraíbles (a diferencia de strings hardcodeadas).
 *
 * Si el archivo de secrets no es legible/escribible, fallback a un derivado
 * del nombre del usuario + machineId para no bloquear el arranque, pero loggea
 * un warning. NO usamos un default hardcodeado porque sería un downgrade.
 */
function getOrCreateSecret(name) {
  const secretsPath = path.join(app.getPath('userData'), 'secrets.json');
  let store = {};
  try {
    if (fs.existsSync(secretsPath)) {
      store = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    }
  } catch (e) {
    log(`secrets.json no se pudo leer: ${e?.message || e}`);
    store = {};
  }
  if (typeof store[name] === 'string' && store[name].length >= 32) {
    return store[name];
  }
  // Generar nuevo secret
  const secret = crypto.randomBytes(32).toString('hex');
  store[name] = secret;
  try {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    log(`secret "${name}" generado y persistido en secrets.json`);
  } catch (e) {
    log(`WARNING: no se pudo persistir secret "${name}": ${e?.message || e}. Continuamos en memoria.`);
  }
  return secret;
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
let agentProcess = null;
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

/**
 * Verifica si un puerto local está ocupado intentando un connect rápido.
 * Si conecta en menos de 500ms, hay alguien escuchando.
 */
async function puertoOcupado(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    let resolved = false;
    const done = (ocupado) => {
      if (resolved) return;
      resolved = true;
      try { socket.destroy(); } catch {}
      resolve(ocupado);
    };
    socket.setTimeout(500);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Pre-cleanup antes de arrancar Postgres:
 *   1. Si el puerto está libre PERO existe `postmaster.pid` → es stale,
 *      lo borramos para que initdb no se queje.
 *   2. Si el puerto está OCUPADO → tiramos error amigable explicando
 *      que probablemente hay otra instancia corriendo, en vez de dejar
 *      que embedded-postgres falle con "undefined".
 *
 * No matamos procesos huérfanos automáticamente porque podría ser otra app
 * legítima del usuario usando ese puerto. Solo informamos.
 */
async function precheckPostgres() {
  const ocupado = await puertoOcupado(PG_PORT);
  if (ocupado) {
    throw new Error(
      `El puerto ${PG_PORT} ya está en uso. Probablemente hay otra instancia ` +
        `de Santa Teresita corriendo. Cerrá la app desde la bandeja del sistema ` +
        `(o desde el Administrador de Tareas → "Santa Teresita" + "postgres") ` +
        `e intentá de nuevo.`,
    );
  }
  // Puerto libre + postmaster.pid presente → stale, hay que limpiarlo o
  // initdb tira "another server might be running".
  const pidFile = path.join(dbDir(), 'postmaster.pid');
  if (fs.existsSync(pidFile)) {
    try {
      fs.unlinkSync(pidFile);
      log('Limpieza: postmaster.pid stale removido');
    } catch (e) {
      log('No se pudo borrar postmaster.pid stale: ' + (e?.message ?? e));
    }
  }
}

async function startPostgres() {
  setSplashStatus('Iniciando base de datos...');
  log('Iniciando Postgres embebido en ' + dbDir());

  // Sanity check antes de spawnear pg — si el puerto está tomado por una
  // instancia previa, fallamos con un mensaje accionable en vez de el
  // críptico "FATAL: undefined" que daba embedded-postgres antes.
  await precheckPostgres();

  const isFirstRun = !fs.existsSync(path.join(dbDir(), 'PG_VERSION'));
  const EP = await loadEmbeddedPostgres();

  pgInstance = new EP({
    databaseDir: dbDir(),
    user: PG_USER,
    password: PG_PASSWORD,
    port: PG_PORT,
    persistent: true,
  });

  // En el primer arranque, intentamos copiar el cluster pre-baked (template
  // generado en CI con initdb + schema + seed ya aplicados). Eso ahorra
  // ~10 min de wall-clock de cara al usuario en la primera instalación.
  // Si por algún motivo el template no existe (build viejo, dev mode, etc.)
  // caemos al flow tradicional con `initialise()`.
  let templateAplicado = false;
  if (isFirstRun) {
    const templatePath = path.join(resourcesDir(), 'pgdata-template');
    if (fs.existsSync(path.join(templatePath, 'PG_VERSION'))) {
      log('Primer arranque: copiando cluster pre-baked desde ' + templatePath);
      setSplashStatus('Inicializando base de datos (template pre-baked)...');
      fs.mkdirSync(path.dirname(dbDir()), { recursive: true });
      copiarDirectorio(templatePath, dbDir());
      log('Cluster pre-baked copiado');
      templateAplicado = true;
    } else {
      log('Primer arranque: template no encontrado, fallback a initdb tradicional');
      setSplashStatus('Inicializando base de datos (solo primera vez)...');
      fs.mkdirSync(path.dirname(dbDir()), { recursive: true });
      await pgInstance.initialise();
    }
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
    // Tanto con template como sin: schema + seed los aplicamos en la PC del
    // user. El template solo nos ahorró el initdb (los CI runners no pueden
    // pre-bakear schema/seed porque Postgres rehúsa arrancar como admin).
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
 * Copia un directorio recursivamente. Usamos fs.cpSync (Node 16.7+) que es
 * la API nativa de Node. Si más adelante hace falta progreso o resumibilidad,
 * cambiar por una lib (ej. fs-extra) — por ahora KISS.
 */
function copiarDirectorio(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
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
    // v1.19 — indexes faltantes para queries de cashflow + KPIs
    await client.query(`
      CREATE INDEX IF NOT EXISTS "movimientos_cuenta_origen_id_idx"
      ON "movimientos" ("cuenta_origen_id")
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "movimientos_cuenta_destino_id_idx"
      ON "movimientos" ("cuenta_destino_id")
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "pagos_cuenta_id_idx"
      ON "pagos" ("cuenta_id")
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "ventas_estado_fecha_finalizacion_idx"
      ON "ventas" ("estado", "fecha_finalizacion")
    `);
    // v1.22 — rename destinos de impresión: KITCHEN→COCINA, COUNTER→MOSTRADOR
    // (DELIVERY se mantiene). Actualiza tanto los jobs históricos como las
    // claves de configuración_sistema. Idempotente: si ya están renombrados,
    // los UPDATE no afectan filas.
    await client.query(`
      UPDATE "trabajos_impresion" SET "destino" = 'COCINA' WHERE "destino" = 'KITCHEN'
    `);
    await client.query(`
      UPDATE "trabajos_impresion" SET "destino" = 'MOSTRADOR' WHERE "destino" = 'COUNTER'
    `);
    await client.query(`
      UPDATE "configuracion_sistema" SET "clave" = 'impresora_cocina' WHERE "clave" = 'impresora_kitchen'
    `);
    await client.query(`
      UPDATE "configuracion_sistema" SET "clave" = 'impresora_mostrador' WHERE "clave" = 'impresora_counter'
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

/**
 * Lee la URL de la cloud DB en orden de precedencia:
 *
 *   1. ENV var `SUPABASE_DB_URL` (override para dev / CI)
 *   2. `userData/config.json` → `cloudDbUrl` (configurable desde la UI admin)
 *   3. Bundle compilado: `resources/cloud-config.json` → `cloudDbUrl`
 *      (default que ship con el .exe)
 *   4. null (la app va a fallar al boot con mensaje claro)
 *
 * Por qué este orden: queremos que el .exe pueda venir con un default
 * (apuntando a la Supabase de Santa Teresita) pero permitir override
 * para testing / dev / staging sin recompilar.
 *
 * Si la URL es del pooler de Supabase, automáticamente le agregamos los
 * flags `?pgbouncer=true&connection_limit=1` que necesita Prisma para
 * funcionar bien en transaction-mode pooling. Si ya los tiene, no los
 * duplicamos.
 */
function leerCloudDbUrl() {
  let raw = process.env.SUPABASE_DB_URL;
  if (!raw) {
    const userConfigPath = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(userConfigPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
        if (typeof cfg.cloudDbUrl === 'string' && cfg.cloudDbUrl) raw = cfg.cloudDbUrl;
      } catch (e) {
        log('Error leyendo config.json: ' + (e?.message ?? e));
      }
    }
  }
  if (!raw) {
    const bundleConfigPath = path.join(resourcesDir(), 'cloud-config.json');
    if (fs.existsSync(bundleConfigPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(bundleConfigPath, 'utf8'));
        if (typeof cfg.cloudDbUrl === 'string' && cfg.cloudDbUrl) raw = cfg.cloudDbUrl;
      } catch (e) {
        log('Error leyendo cloud-config.json bundle: ' + (e?.message ?? e));
      }
    }
  }
  if (!raw) return null;

  // Agregar flags de pgbouncer si la URL es del pooler de Supabase y no
  // los trae ya. Esto hace que Prisma desactive prepared statements y
  // limite conexiones — necesario en transaction-mode pooling.
  const hasFlags = raw.includes('pgbouncer=') || raw.includes('connection_limit=');
  if (raw.includes('.pooler.supabase.com') && !hasFlags) {
    const sep = raw.includes('?') ? '&' : '?';
    raw = `${raw}${sep}pgbouncer=true&connection_limit=1`;
  }
  return raw;
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
        TZ: 'America/Argentina/Buenos_Aires',
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

function startApi(cloudDbUrl) {
  setSplashStatus('Iniciando servidor de la app...');
  const apiEntry = path.join(resourcesDir(), 'api', 'server.mjs');
  log('Spawning API: ' + apiEntry);
  log('API → cloud DB (Supabase) — sin Postgres local');

  apiProcess = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      // Forzamos timezone Argentina para que `new Date()` y los buckets de KPIs
      // (inicio del día, agrupaciones por hora, "hoy/ayer") sean consistentes
      // independiente del locale regional de Windows. AR no observa DST desde
      // 2009, valor estable.
      TZ: 'America/Argentina/Buenos_Aires',
      // ── v2.x ── La API ya NO se conecta a Postgres local (no existe más).
      // Apunta directamente al pooler de Supabase. Si en Fase 2 se instala
      // el server local, las PCs cliente cambian este URL al server LAN.
      DATABASE_URL: cloudDbUrl,
      API_HOST: '127.0.0.1',
      API_PORT: String(API_PORT),
      API_CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}`,
      // Path del SQLite que persiste el outbox (writes pendientes cuando
      // cloud cae). Vive en data/ del usuario, sobrevive uninstall si
      // deleteAppDataOnUninstall=false.
      OUTBOX_DB_PATH: path.join(dataDir(), 'outbox.sqlite'),
      AUTH_SECRET: getOrCreateSecret('AUTH_SECRET'),
      AUDIT_HASH_SALT: getOrCreateSecret('AUDIT_HASH_SALT'),
      // Token compartido con el local-agent para que pueda autenticar
      // contra la API local sin tener una sesión de usuario.
      AGENT_API_TOKEN: getOrCreateSecret('AGENT_API_TOKEN'),
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

// ═══ Auto-update (electron-updater + GitHub Releases) ═══════════════════

function setupAutoUpdater() {
  if (!app.isPackaged) {
    log('autoUpdater: skip — modo dev');
    return;
  }

  // Logging del autoUpdater al mismo archivo que el resto. Reemplaza el
  // logger interno.
  autoUpdater.logger = {
    info: (m) => log('[autoUpdater] ' + m),
    warn: (m) => log('[autoUpdater:warn] ' + m),
    error: (m) => log('[autoUpdater:err] ' + m),
    debug: () => {},
  };

  autoUpdater.autoDownload = true; // descarga sola si hay update
  autoUpdater.autoInstallOnAppQuit = true; // instala al cerrar si descargó

  autoUpdater.on('update-available', (info) => {
    log(`[autoUpdater] update-available: ${info.version}`);
  });
  autoUpdater.on('update-not-available', () => {
    log('[autoUpdater] sin updates pendientes');
  });
  autoUpdater.on('error', (err) => {
    log('[autoUpdater] error: ' + (err?.message ?? err));
  });
  autoUpdater.on('download-progress', (p) => {
    log(`[autoUpdater] descargando: ${p.percent.toFixed(0)}% (${(p.bytesPerSecond / 1024).toFixed(0)} KB/s)`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    log(`[autoUpdater] update-downloaded: ${info.version}`);
    // Mostramos diálogo modal para que Nancy decida cuándo reiniciar.
    // Si elige "Después", se aplica al próximo cierre (autoInstallOnAppQuit).
    if (mainWindow && !mainWindow.isDestroyed()) {
      void dialog
        .showMessageBox(mainWindow, {
          type: 'info',
          buttons: ['Reiniciar ahora', 'Más tarde'],
          defaultId: 0,
          cancelId: 1,
          title: 'Actualización lista',
          message: `Versión ${info.version} disponible`,
          detail:
            'Se descargó una nueva versión de Santa Teresita. ' +
            'Para aplicarla hay que reiniciar la app. ' +
            '¿Reiniciás ahora? (los datos no se pierden — viven aparte en %APPDATA%/Santa Teresita)',
        })
        .then(({ response }) => {
          if (response === 0) {
            log('[autoUpdater] instalando ahora por elección del usuario');
            autoUpdater.quitAndInstall();
          } else {
            log('[autoUpdater] postpuesto — se aplica al próximo cierre');
          }
        })
        .catch((e) => log('[autoUpdater] dialog error: ' + (e?.message ?? e)));
    }
  });

  // Trigger inicial — chequea al arrancar
  autoUpdater.checkForUpdates().catch((e) => {
    log('[autoUpdater] checkForUpdates error inicial: ' + (e?.message ?? e));
  });

  // Re-chequear cada 4 horas mientras la app está abierta
  setInterval(
    () => {
      autoUpdater.checkForUpdates().catch((e) => {
        log('[autoUpdater] re-check error: ' + (e?.message ?? e));
      });
    },
    4 * 60 * 60 * 1000,
  );
}

// ═══ Local agent (impresión térmica) ═════════════════════════════════════

function startAgent() {
  const agentEntry = path.join(resourcesDir(), 'agent', 'agent.mjs');
  if (!fs.existsSync(agentEntry)) {
    log('[agent] resources/agent/agent.mjs no existe — saltando arranque del agent');
    return;
  }
  log('Spawning local-agent: ' + agentEntry);

  agentProcess = spawn(process.execPath, [agentEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      TZ: 'America/Argentina/Buenos_Aires',
      API_PUBLIC_URL: `http://127.0.0.1:${API_PORT}`,
      AGENT_API_TOKEN: getOrCreateSecret('AGENT_API_TOKEN'),
      AGENT_POLL_INTERVAL_MS: '3000',
      LOG_LEVEL: 'info',
    },
    cwd: path.join(resourcesDir(), 'agent'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agentProcess.stdout.on('data', (d) => log('[agent] ' + d.toString().trim()));
  agentProcess.stderr.on('data', (d) => log('[agent:err] ' + d.toString().trim()));
  agentProcess.on('exit', (code) => {
    log('[agent] exited code=' + code);
    // El agent cayendo NO es crítico: el resto de la app sigue funcionando.
    // Las comandas se acumulan en la cola y se imprimen cuando vuelva a
    // arrancar (manualmente desde el panel admin si hace falta).
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

/**
 * Calcula el zoom factor del renderer según el ancho efectivo de la pantalla.
 *
 * El UI fue diseñado pensando en monitores 1920×1080 con DPI 100%. En pantallas
 * más chicas (1366×768 típico de notebooks de la encargada, 1440×900 de iMac
 * antiguos, etc.) los elementos se veían "gigantes" porque ocupaban un %
 * mayor del ancho disponible. Con un zoom adaptativo todo encaja proporcional.
 *
 * El `workAreaSize` ya tiene aplicado el DPI scaling de Windows (si la pantalla
 * está al 125% / 150%, ese ancho viene reducido). Por eso no necesitamos un
 * factor extra: lo que medimos acá ya es lo que el browser ve como viewport.
 */
function calcularZoomFactor() {
  try {
    const { width } = screen.getPrimaryDisplay().workAreaSize;
    if (width <= 1024) return 0.75;   // notebooks viejos / pantallas chicas
    if (width <= 1366) return 0.85;   // notebooks típicos (1366x768)
    if (width <= 1600) return 0.92;   // monitores HD intermedios
    return 1.0;                        // 1920x1080 y up — diseño nativo
  } catch (e) {
    log('zoom factor fallback (screen no disponible): ' + (e?.message ?? e));
    return 1.0;
  }
}

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

  // Zoom adaptativo según ancho de pantalla — calculado UNA vez al crear la
  // ventana y aplicado cuando termina de cargar el renderer (antes de eso no
  // hay webContents listo para recibir setZoomFactor).
  const zoomFactor = calcularZoomFactor();
  log(`Zoom factor calculado: ${zoomFactor} (workArea ancho: ${screen.getPrimaryDisplay().workAreaSize.width}px)`);
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(zoomFactor);
  });

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
    } else if (input.control && (key === '+' || key === '=')) {
      // Ctrl+= zoom in (subir 5% por step). Cap a 1.5 para no romper layout.
      const next = Math.min(1.5, mainWindow.webContents.getZoomFactor() + 0.05);
      mainWindow.webContents.setZoomFactor(next);
      event.preventDefault();
    } else if (input.control && key === '-') {
      // Ctrl+- zoom out (bajar 5% por step). Floor a 0.5 para que no se evapore.
      const next = Math.max(0.5, mainWindow.webContents.getZoomFactor() - 0.05);
      mainWindow.webContents.setZoomFactor(next);
      event.preventDefault();
    } else if (input.control && key === '0') {
      // Ctrl+0 reset al auto-zoom calculado al inicio.
      mainWindow.webContents.setZoomFactor(zoomFactor);
      event.preventDefault();
    } else if (input.control && key === 'q') {
      app.quit();
      event.preventDefault();
    } else if (input.control && input.shift && key === 'i' && !app.isPackaged) {
      // DevTools solo accesible en dev mode — en producción está bloqueado
      // para evitar que un usuario accidentalmente exponga el renderer.
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Whitelist de URLs externas que SE PERMITEN abrir en el browser del SO.
  // Cualquier otra URL (XSS injection, attacker-controlled link en delivery
  // address, etc.) se deniega silenciosamente.
  //
  // Loopback (127.0.0.1 / localhost) la cerramos siempre — son páginas internas
  // de la app, nunca debería abrirse una nueva ventana del SO con esas URLs.
  const ALLOWED_EXTERNAL_HOSTS = [
    'github.com',                       // links a docs, releases del proyecto
    'docs.google.com',                  // Excel sync, comprobantes
    'drive.google.com',
    'mercadopago.com.ar',               // panel MP
    'wa.me',                            // chats WhatsApp
    'api.whatsapp.com',
  ];

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { action: 'deny' };
    }
    // Bloquear loopback explícitamente — no debería intentar abrirse
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      return { action: 'deny' };
    }
    const allowed = ALLOWED_EXTERNAL_HOSTS.some(
      (h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h),
    );
    if (allowed) {
      void shell.openExternal(url);
    } else {
      log(`shell.openExternal bloqueado por whitelist: ${url}`);
    }
    return { action: 'deny' };
  });
}

// ═══ Lifecycle ═════════════════════════════════════════════════════════════

async function bootstrap() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.mkdirSync(logsDir(), { recursive: true });
    log('═════════════════════════════════════════');
    log('Santa Teresita Desktop v2.x — booting (cloud-first)');
    log('Data dir: ' + dataDir());
    log('Resources: ' + resourcesDir());

    createSplash();

    // Validar que tengamos config de cloud DB. Sin esto la app no puede arrancar.
    const cloudUrl = leerCloudDbUrl();
    if (!cloudUrl) {
      throw new Error(
        'No hay config de Supabase. Esperaba SUPABASE_DB_URL en variables de entorno o en data/config.json. ' +
          'Pedile al admin que la configure (Settings → Cloud).',
      );
    }
    log('Cloud DB URL configurada (host: ' + cloudUrl.replace(/:[^:@/]+@/, ':***@').slice(0, 80) + '...)');

    setSplashStatus('Iniciando servicios...');
    startApi(cloudUrl);
    startWeb();

    await waitForApiHealth(90000);
    log('API OK');
    await waitForPort('127.0.0.1', WEB_PORT, 'Web', 90000);
    log('Web OK');

    // Local-agent (impresión térmica) — arranca en cuanto la API responde.
    // No esperamos health check: si el agent crashea, el resto sigue OK.
    startAgent();

    setSplashStatus('Listo. Cargando interfaz...');
    createMainWindow();

    // Auto-update desde GitHub Releases. Solo en builds packageados (en dev
    // electron-updater devuelve error). Si hay update disponible, se descarga
    // en background y al detectarse "downloaded" preguntamos a Nancy si
    // reiniciar ahora o después.
    setupAutoUpdater();
  } catch (err) {
    // Serializar el error de forma robusta — algunos throws de embedded-postgres
    // y otras libs nativas tiran objetos sin .message ni .stack, lo que daba
    // como resultado el infame "FATAL: undefined" que no le decía nada al usuario.
    const mensaje = (() => {
      if (!err) return 'Error desconocido (no se recibió objeto de error)';
      if (typeof err === 'string') return err;
      if (err.message) return String(err.message);
      if (err.stack) return String(err.stack);
      // Último recurso: enumerar las propias keys del error.
      try {
        const json = JSON.stringify(err, Object.getOwnPropertyNames(err));
        if (json && json !== '{}') return json;
      } catch {}
      return `Error sin formato — type: ${typeof err}, ctor: ${err?.constructor?.name ?? 'unknown'}`;
    })();
    log('FATAL: ' + mensaje);
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    dialog.showErrorBox(
      'Santa Teresita — Error de arranque',
      `No se pudo iniciar la aplicación.\n\nError: ${mensaje}\n\nLog: ${logFile()}`,
    );
    app.quit();
  }
}

async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutdown: ' + reason);
  try { if (agentProcess) agentProcess.kill(); } catch {}
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
  try { if (agentProcess) agentProcess.kill(); } catch {}
  try { if (apiProcess) apiProcess.kill(); } catch {}
  try { if (webProcess) webProcess.kill(); } catch {}
});
