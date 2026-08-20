import './env-loader.js';
import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import { ZodError } from 'zod';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import {
  categoriaDeStatus,
  clasificar,
  nuevoCodigo,
  mensajeParaPantalla,
  registrarError,
  type ErrorRegistrado,
} from './services/errores.js';
import { config } from './config.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import catalogoRoutes from './routes/catalogo.js';
import ventasRoutes from './routes/ventas.js';
import encargosRoutes from './routes/encargos.js';
import adminRoutes from './routes/admin.js';
import analyticsRoutes from './routes/analytics.js';
import syncRoutes from './routes/sync.js';
import { startOutboxFlusher } from './services/outbox-flusher.js';
import { startReplicator } from './services/replicator.js';
import { startGeocoder } from './services/geocoder.js';
import { runCatchUp } from './services/catch-up.js';
import { runMirrorSyncOnce } from './services/mirror-sync.js';
import { startDbRouter, dbRouterEnabled, dbState } from './services/db-router.js';
import proveedoresRoutes from './routes/proveedores.js';
import empleadosRoutes from './routes/empleados.js';
import configuracionRoutes from './routes/configuracion.js';
import clientesRoutes from './routes/clientes.js';
import mayoristasRoutes from './routes/mayoristas.js';
import listasRoutes from './routes/listas.js';
import impresionRoutes from './routes/impresion.js';
import ingestRoutes from './routes/ingest.js';
import channelRoutes from './routes/channel.js';
import { invalidate as cacheInvalidate } from './lib/cache.js';

const isProd = config.NODE_ENV === 'production';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
    },
    // trustProxy: por env (API_TRUST_PROXY). Default 0 = DIRECTO (loopback en el
    // .exe, LAN en el server) — req.ip = socket, sin confiar en X-Forwarded-For
    // (que el cliente falsifica para esquivar rate-limit/lockout). En la nube
    // detrás de Railway/Caddy se setea en 1 (confía solo 1 hop = el proxy real).
    trustProxy: config.API_TRUST_PROXY > 0 ? config.API_TRUST_PROXY : false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Red de seguridad: Fastify por defecto rechaza requests con
  // `Content-Type: application/json` y body vacío con
  // FST_ERR_CTP_EMPTY_JSON_BODY (400). Eso rompía los DELETE sin body
  // (quitar item del pedido, eliminar producto). El fix principal está en
  // el cliente (no manda Content-Type si no hay body), pero parseamos el
  // body vacío como `undefined` para tolerar cualquier cliente.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, bodyStr, done) => {
      const s = (bodyStr as string).trim();
      if (s.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(s));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  // Gzip/deflate de respuestas: con cajeros en conexión común argentina y
  // payloads grandes (catálogo de 2000 productos = ~200KB JSON), comprimir
  // ahorra 50-70% del transfer. threshold de 1024 evita comprimir respuestas
  // chicas donde la compresión cuesta más que el ahorro.
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['gzip', 'deflate'],
  });
  // CORS: SOLO la lista explícita de API_CORS_ORIGINS. Seguridad (audit): antes
  // se aceptaba cualquier `*.vercel.app` con `credentials:true` — y cualquiera
  // puede deployar un proyecto a *.vercel.app, así que un atacante hospedaba
  // `evil.vercel.app` y hacía requests con credenciales al API. Si necesitás un
  // preview deploy, agregá su origen exacto a API_CORS_ORIGINS.
  const allowedExact = config.API_CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => {
      // Sin Origin = request no-browser (server-to-server, el propio .exe). CORS
      // sólo aplica a browsers; no es un vector de ataque.
      if (!origin) return cb(null, true);
      if (allowedExact.includes(origin)) return cb(null, true);
      cb(new Error(`Origin no permitido: ${origin}`), false);
    },
    credentials: true,
    // Cachear el preflight CORS 24h. Sin esto, cada request cross-origin
    // dispara un OPTIONS adicional. Con maxAge, una vez aceptado el preflight
    // el browser reusa el resultado para todos los requests del mismo origen
    // durante 24h.
    maxAge: 86400,
  });
  await app.register(cookie, { secret: config.AUTH_SECRET });
  await app.register(sensible);
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    keyGenerator: (req) => `${req.ip}:${req.routeOptions.url ?? req.url}`,
  });

  // Rate limit estricto de /auth/login y /auth/approve: ahora va por-ruta vía
  // `config.rateLimit` en routes/auth.ts (el bloque anterior se registraba en
  // un scope vacío y no aplicaba a ninguna ruta).

  await app.register(authPlugin);

  app.get('/health', async () => ({
    ok: true,
    name: 'santa-teresita-api',
    // Versión del .exe (la pasa Electron al spawnear el API). En modo dev
    // local sin Electron, sale como "dev".
    version: process.env.STA_DESKTOP_VERSION ?? 'dev',
    env: config.NODE_ENV,
    dbState: dbRouterEnabled() ? dbState() : 'PRIMARY',
    time: new Date().toISOString(),
  }));

  // Failover Fase 1B: si el router está en DEGRADED (LAN caído), las
  // LECTURAS pasan (el prisma activo apunta a Supabase mirror y la UI
  // sigue viva) pero las ESCRITURAS se rechazan con 503 DB_DEGRADED. El
  // frontend (lib/api.ts) interpreta ese código igual que un error de red:
  // encola el write en outbox.sqlite y el outbox-flusher lo reproduce
  // cuando vuelve el LAN. Supabase nunca recibe escrituras autoritativas.
  // Exento: /sync/* (outbox, backend SQLite — debe funcionar degradado) y
  // /health, /version.
  app.addHook('onRequest', async (req, reply) => {
    if (!dbRouterEnabled() || dbState() !== 'DEGRADED') return;
    const m = req.method;
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return;
    const u = typeof req.url === 'string' ? req.url : '';
    if (u.includes('/sync/') || u.endsWith('/health') || u.endsWith('/version')) return;
    return reply.code(503).send({
      error:
        'Sin conexión con el servidor del local. Tu acción se guarda y se ' +
        'sincroniza sola cuando vuelva.',
      code: 'DB_DEGRADED',
    });
  });

  // Hook global: invalidar el cache del catálogo después de mutaciones
  // exitosas en /admin/productos, /admin/categorias, /admin/tipos-producto,
  // /admin/precios y /admin/listas-precios. Sin esto, una actualización
  // de precio tarda hasta el TTL en propagar (60s para productos). Con el
  // hook, propaga al instante en la PC que hizo el cambio (las otras PCs
  // siguen viendo cache hasta su propio TTL — aceptable).
  app.addHook('onResponse', async (req, reply) => {
    if (
      reply.statusCode >= 200 &&
      reply.statusCode < 300 &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      typeof req.url === 'string' &&
      /\/admin\/(productos|categorias|tipos-producto|precios|listas-precios|grupos-modificador|opciones-modificador|cuentas)\b/.test(
        req.url,
      )
    ) {
      cacheInvalidate('catalogo:');
    }
  });

  // Rutas montadas bajo /api/v1
  // El handler de errores va ANTES de registrar las rutas: si se declara
  // después, las rutas de `/api/v1` quedan en un contexto que no lo hereda y
  // los errores de validación salen con el "Bad Request" pelado de Fastify,
  // sin código y sin decir qué campo falló.
  /** Guarda el error en el registro reciente, con quién y desde dónde. */
  const anotar = (
    req: FastifyRequest,
    e: Omit<ErrorRegistrado, 'metodo' | 'ruta' | 'usuario' | 'pcOrigen' | 'at'>,
  ) => {
    const pc = req.headers['x-pc-origen'];
    registrarError({
      ...e,
      metodo: req.method,
      ruta: req.url,
      usuario: req.usuario?.nombre ?? null,
      pcOrigen: typeof pc === 'string' ? pc : null,
      at: new Date().toISOString(),
    });
  };

  /**
   * Red de seguridad: cualquier respuesta de error que NO pase por el
   * manejador de arriba también sale con código.
   *
   * Un `reply.code(401).send({ error: 'Sesión inválida' })` no tira una
   * excepción, así que el manejador de errores ni se entera — y ésos son
   * justamente los que más se reportan ("no me deja entrar"). Lo mismo con el
   * 404 de una ruta que no existe, que es el síntoma típico de una caja
   * quedada en una versión vieja. Este hook los agarra a todos en la salida.
   */
  app.addHook('onSend', async (req, reply, payload) => {
    const status = reply.statusCode;
    if (status < 400) return payload;
    if (typeof payload !== 'string' || !payload.startsWith('{')) return payload;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return payload;
    }
    // Ya tiene código: vino del manejador de errores, no lo tocamos.
    if (typeof body.codigo === 'string') return payload;

    const categoria = categoriaDeStatus(status);
    const codigo = nuevoCodigo(categoria);
    // Fastify arma `{ error: 'Not Found', message: 'Route ... not found' }`:
    // ahí el texto útil es `message`. Lo nuestro manda sólo `error`.
    const propio =
      typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string'
          ? body.error
          : undefined;
    const mensaje = mensajeParaPantalla(categoria, codigo, propio);

    anotar(req, {
      codigo,
      categoria,
      status,
      mensaje,
      detalle: propio ?? `(sin detalle) HTTP ${status}`,
      stack: null,
    });
    return JSON.stringify({ ...body, error: mensaje, codigo, categoria });
  });

  app.setErrorHandler((err, req, reply) => {
    // Errores de validación Zod via fastify-type-provider-zod. Antes los
    // matcheábamos con `instanceof ZodError` pero el provider los wrappea
    // en un FastifyError, así que `instanceof` falla y caíamos en el branch
    // genérico que devolvía solo "Bad Request" sin info útil. Con el helper
    // del provider extraemos el path + razón de cada issue y los devolvemos
    // legibles al cliente.
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((i) => {
        // params.issue es el ZodIssue rico (path: [...], code, message); el
        // i.instancePath de fastify viene normalizado tipo "/items/0/cantidad"
        // pero podemos armar uno mejor desde el ZodIssue.
        const issue = i.params?.issue;
        const path =
          issue && Array.isArray(issue.path) && issue.path.length > 0
            ? issue.path.join('.')
            : i.instancePath || '(root)';
        return {
          path,
          message: issue?.message ?? i.message ?? 'invalid',
          code: issue?.code,
        };
      });
      const summary = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
      const codigo = nuevoCodigo('VAL');
      app.log.warn({ url: req.url, issues, codigo }, 'validation failed');
      anotar(req, { codigo, categoria: 'VAL', status: 400, mensaje: summary, detalle: summary, stack: null });
      return reply.code(400).send({
        error: `Validación fallida — ${summary} (código ${codigo})`,
        codigo,
        issues,
      });
    }
    if (err instanceof ZodError) {
      const codigo = nuevoCodigo('VAL');
      const detalle = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      app.log.warn({ url: req.url, issues: err.issues, codigo }, 'validation failed');
      anotar(req, { codigo, categoria: 'VAL', status: 400, mensaje: detalle, detalle, stack: null });
      return reply
        .code(400)
        .send({ error: `Validación fallida (código ${codigo})`, codigo, issues: err.issues });
    }

    // Todo lo demás pasa por el clasificador: sale con un código que se puede
    // leer por teléfono y que queda en Admin → Errores junto al stack. Antes
    // esto respondía "Error interno" a secas y no había con qué distinguir una
    // base caída de un bug nuestro.
    const { categoria, status, detalle } = clasificar(err);
    const codigo = nuevoCodigo(categoria);
    const e = err as { message?: string; stack?: string };
    // El mensaje propio se muestra sólo cuando alguien lo escribió a propósito
    // (las reglas de negocio, status < 500). Un texto de Prisma en pantalla no
    // le dice nada a nadie.
    const mensajePropio = status < 500 && typeof e.message === 'string' ? e.message : undefined;
    const mensaje = mensajeParaPantalla(categoria, codigo, mensajePropio);

    app.log.error(
      { codigo, categoria, status, detalle, url: req.url, metodo: req.method, err },
      'request falló',
    );
    anotar(req, { codigo, categoria, status, mensaje, detalle, stack: e.stack ?? null });

    return reply.code(status).send({ error: mensaje, codigo, categoria });
  });

  await app.register(
    async (api) => {
      // /api/v1/version — duplicado público de /health para que el web pueda
      // consultar la versión del .exe via api.getCached() (que prefija /api/v1).
      api.get('/version', async () => ({
        version: process.env.STA_DESKTOP_VERSION ?? 'dev',
        time: new Date().toISOString(),
      }));
      await api.register(authRoutes);
      await api.register(catalogoRoutes);
      await api.register(ventasRoutes);
      await api.register(encargosRoutes);
      await api.register(adminRoutes);
      await api.register(analyticsRoutes);
      await api.register(syncRoutes);
      await api.register(proveedoresRoutes);
      await api.register(empleadosRoutes);
      await api.register(configuracionRoutes);
      await api.register(clientesRoutes);
      await api.register(mayoristasRoutes);
      await api.register(listasRoutes);
      await api.register(impresionRoutes);
      await api.register(ingestRoutes);
      await api.register(channelRoutes);
    },
    { prefix: '/api/v1' },
  );


  return app;
}

// Entry point: levantar el server. (Si en el futuro hace falta importar `buildServer`
// desde tests sin auto-arrancar, agregar guard tipo `if (process.env.SKIP_LISTEN !== '1')`).
const app = await buildServer();
try {
  // Mirror-sync nube → local (espejo de solo lectura). Corre ANTES del listen
  // para que al abrir el .exe ya se vean los datos frescos. Con timeout: si la
  // nube no responde, no cuelga el arranque — sigue con el último espejo local.
  // Solo activo si STA_MIRROR_SOURCE_URL está seteado (la máquina del dueño).
  if (config.STA_MIRROR_SOURCE_URL) {
    const TIMEOUT_MS = 60_000;
    await Promise.race([
      runMirrorSyncOnce(),
      new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS)),
    ]);
  }

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  app.log.info(
    `🍝 API Santa Teresita escuchando en http://${config.API_HOST}:${config.API_PORT}`,
  );

  // Iniciar el flusher del outbox — reintenta writes que se acumularon mientras
  // la cloud estaba caída. Cada 5s procesa el siguiente evento pendiente.
  // Si nunca se cae la cloud, el flusher es un no-op (idle ticks).
  startOutboxFlusher({
    apiBaseUrl: `http://${config.API_HOST}:${config.API_PORT}/api/v1`,
    agentToken: process.env.AGENT_API_TOKEN,
  });
  app.log.info('Outbox flusher iniciado (interval 5s)');

  // Catch-up Supabase → local: ANTES de reanudar la replicación forward,
  // el server absorbe las ventas que la PWA cargó durante un corte de luz
  // (audit origen='cloud'). Idempotente, no bloquea el listen (corre en
  // background; el replicator forward igual no pisa nada porque el import
  // no genera outbox_events). Solo STA_ROLE=server. Ver §5.2.
  void runCatchUp().then((n) => {
    if (n > 0) app.log.info(`Catch-up: ${n} ventas del corte absorbidas`);
  });

  // Replicator local → Supabase. Solo arranca si STA_ROLE=server +
  // REPLICATE_TO_URL configurado (el mini PC). En las cajas es no-op.
  startReplicator();

  // Geocoder batch (Nominatim): resuelve lat/lng de direcciones de delivery
  // pendientes. Solo en el server (única instancia, 1 req/seg) — los updates
  // van con audit→outbox y el replicator los empuja a Supabase. No-op en cajas.
  startGeocoder();

  // DB router de la caja (failover LAN→Supabase). Solo activo si
  // STA_FALLBACK_DB_URL está configurado. En el server / .exe legacy: no-op.
  startDbRouter();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
