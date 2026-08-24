/**
 * API de la CAJA en modo PROXY — sin credenciales de base de datos.
 *
 * ── Por qué existe (pendiente de seguridad C4) ────────────────────────────
 * Hasta ahora cada caja levantaba la API completa con `DATABASE_URL` apuntando
 * al Postgres (LAN o Supabase). Eso pone la password de la base **en cada PC
 * del local**: cualquiera con acceso a una caja —o al `.exe`— puede leer y
 * escribir la base entera sin pasar por ninguna regla de negocio.
 *
 * En este modo la caja NO habla con Postgres. Levanta esta API mínima que
 * reenvía todo al API del servidor local (S1), que es el único que tiene las
 * credenciales. Si alguien se lleva una caja, se lleva un cliente HTTP.
 *
 * ── Por qué un proxy y no apuntar la web directo a S1 ─────────────────────
 * Porque así NADA MÁS cambia. La web sigue en `127.0.0.1:3001`, el agente de
 * impresión también, y el outbox (resiliencia offline) se queda donde estaba,
 * detrás de `/sync/*`, que es loopback-only justamente porque asume una API
 * local. Apuntar la web directo a S1 obligaría a reimplementar el encolado de
 * escrituras fuera de la API.
 *
 * ── Ojo: este archivo NO puede importar nada que llegue a `@sta/db` ───────
 * `packages/db/src/client.ts` construye el PrismaClient AL CARGAR EL MÓDULO, y
 * Prisma tira error si falta `DATABASE_URL`. Un import de más (por ejemplo
 * `routes/sync.ts`, que arrastra el replicator) hace que este proceso no
 * arranque. Por eso las rutas de sync están reescritas acá en chico sobre
 * `services/outbox.ts`, que solo depende de better-sqlite3.
 *
 * ── Contrato que reproduce (para que el frontend no cambie) ───────────────
 *   GET /health → { ok, dbState: 'PRIMARY' | 'DEGRADED', ... }
 *   En DEGRADED las lecturas siguen (contra el API de la nube, si está
 *   configurada) y las escrituras devuelven 503 { code: 'DB_DEGRADED' }, que
 *   es lo que `lib/api.ts` interpreta para encolar en el outbox.
 *   Exentos del bloqueo: /sync/*, /health, /version.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import {
  enqueue,
  pendingCount,
  abandonedCount,
  listAbandoned,
  deleteAbandoned,
} from './services/outbox.js';
import { startOutboxFlusher } from './services/outbox-flusher.js';

const PORT = Number(process.env.API_PORT ?? 3001);

/** API del servidor local (S1). Es el único que habla con Postgres. */
const UPSTREAM = (process.env.STA_UPSTREAM_URL ?? '').replace(/\/+$/, '');
/** API de la nube (Railway). Solo para LECTURAS cuando S1 no responde. */
const CLOUD = (process.env.STA_CLOUD_API_URL ?? '').replace(/\/+$/, '');

const HEALTHCHECK_MS = Number(process.env.STA_UPSTREAM_HEALTHCHECK_MS ?? 10_000);
/** Timeout de una request reenviada. Corto: una caja colgada no sirve. */
const PROXY_TIMEOUT_MS = Number(process.env.STA_PROXY_TIMEOUT_MS ?? 15_000);

if (!UPSTREAM) {
  console.error(
    '[proxy] Falta STA_UPSTREAM_URL (el API de S1, ej. http://192.168.1.10:3001). ' +
      'Sin eso esta caja no tiene contra qué hablar.',
  );
  process.exit(1);
}

type DbState = 'PRIMARY' | 'DEGRADED';
let estado: DbState = 'PRIMARY';

function log(m: string): void {
  console.log(`[proxy] ${m}`);
}

// ── Healthcheck del upstream ────────────────────────────────────────────────
// Mismo criterio que el db-router que reemplaza: si S1 no contesta, DEGRADED.
async function chequearUpstream(): Promise<void> {
  const previo = estado;
  try {
    const r = await fetch(`${UPSTREAM}/health`, { signal: AbortSignal.timeout(3000) });
    estado = r.ok ? 'PRIMARY' : 'DEGRADED';
  } catch {
    estado = 'DEGRADED';
  }
  if (estado !== previo) {
    log(
      estado === 'DEGRADED'
        ? `S1 no responde (${UPSTREAM}) → DEGRADED. Lecturas ${CLOUD ? 'por la nube' : 'sin destino'}, escrituras al outbox.`
        : 'S1 volvió → PRIMARY.',
    );
  }
}

// ── Reenvío ─────────────────────────────────────────────────────────────────
const HEADERS_QUE_NO_SE_REENVIAN = new Set([
  'host',
  'connection',
  'content-length', // lo recalcula fetch; mandarlo viejo corta el body
  'accept-encoding', // que no nos devuelva algo comprimido que después hay que re-emitir
]);

const HEADERS_QUE_NO_SE_DEVUELVEN = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]);

function esLectura(metodo: string): boolean {
  return metodo === 'GET' || metodo === 'HEAD' || metodo === 'OPTIONS';
}

async function main(): Promise<void> {
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });

  // El body se toma CRUDO para cualquier content-type: este proceso no
  // interpreta payloads, los transporta. Evita además el problema de Fastify
  // con `Content-Type: application/json` y body vacío (ver CLAUDE.md).
  //
  // `removeAllContentTypeParsers()` NO es opcional: Fastify trae un parser
  // propio para `application/json` que GANA sobre el wildcard, así que sin esto
  // `req.body` de un POST JSON llega como objeto ya parseado y `fetch` lo manda
  // como "[object Object]" — todos los POST de la caja corruptos, en silencio.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.get('/health', async () => ({
    ok: true,
    rol: 'caja-proxy',
    upstream: UPSTREAM,
    dbState: estado,
    version: process.env.STA_DESKTOP_VERSION ?? 'dev',
    outboxPendientes: pendingCount(),
    time: new Date().toISOString(),
  }));

  app.get('/version', async () => ({ version: process.env.STA_DESKTOP_VERSION ?? 'dev' }));

  // ── /sync/* — outbox local, igual que antes ──────────────────────────────
  // Gate loopback: lo usa el frontend de ESTA máquina y tiene que funcionar
  // con S1 caído, así que no puede depender de auth (que vive upstream).
  const sync = async (a: FastifyInstance): Promise<void> => {
    a.addHook('onRequest', async (req, reply) => {
      const ip = req.ip;
      if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        return reply.code(403).send({ error: 'No autorizado (solo loopback)' });
      }
    });

    a.post('/sync/queue', async (req) => {
      const crudo = req.body as Buffer | undefined;
      const b = (crudo?.length ? JSON.parse(crudo.toString('utf8')) : {}) as {
        method: string;
        url: string;
        body?: unknown;
        headers?: Record<string, string>;
      };
      const id = enqueue(b);
      return { id, queued: true };
    });

    a.get('/sync/status', async () => ({
      pending: pendingCount(),
      abandoned: abandonedCount(),
      rol: 'caja-proxy',
      // El lag de replicación es cosa del server; la caja no replica.
      replicacion: null,
      dbState: estado,
    }));

    a.get('/sync/abandoned', async (req) => {
      const q = req.query as { limit?: string };
      return { items: listAbandoned(Math.min(Number(q.limit ?? 50) || 50, 200)) };
    });

    a.delete('/sync/abandoned/:id', async (req) => {
      deleteAbandoned((req.params as { id: string }).id);
      return { ok: true };
    });
  };
  await app.register(sync, { prefix: '/api/v1' });

  // ── Catch-all: todo lo demás va a S1 ─────────────────────────────────────
  app.all('/*', async (req, reply) => {
    const destino = estado === 'PRIMARY' ? UPSTREAM : CLOUD;

    // Degradado + escritura → 503 con el MISMO código que emitía server.ts,
    // que es lo que el frontend usa para encolar en el outbox.
    if (estado === 'DEGRADED' && !esLectura(req.method)) {
      return reply.code(503).send({
        error:
          'Sin conexión con el servidor del local. Tu acción se guarda y se ' +
          'sincroniza sola cuando vuelva.',
        code: 'DB_DEGRADED',
      });
    }
    if (!destino) {
      return reply.code(503).send({
        error: 'Sin conexión con el servidor del local y sin API de respaldo configurada.',
        code: 'DB_DEGRADED',
      });
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HEADERS_QUE_NO_SE_REENVIAN.has(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }

    try {
      const r = await fetch(`${destino}${req.url}`, {
        method: req.method,
        headers,
        // El Buffer crudo va tal cual; el cast es porque los tipos de fetch de
        // Node no incluyen Buffer en BodyInit aunque en runtime lo acepta.
        body: esLectura(req.method) ? undefined : ((req.body as Buffer | undefined) as unknown as BodyInit | undefined),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });

      for (const [k, v] of r.headers.entries()) {
        if (HEADERS_QUE_NO_SE_DEVUELVEN.has(k.toLowerCase())) continue;
        void reply.header(k, v);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      return reply.code(r.status).send(buf);
    } catch (e) {
      // Una caída del upstream entre healthchecks cae acá. Se marca degradado
      // en el acto para que el chequeo siguiente no sea el que se entere, y se
      // responde con el mismo contrato de siempre.
      estado = 'DEGRADED';
      log(`fallo reenviando ${req.method} ${req.url}: ${(e as Error).message}`);
      return reply.code(503).send({
        error:
          'Sin conexión con el servidor del local. Tu acción se guarda y se ' +
          'sincroniza sola cuando vuelva.',
        code: 'DB_DEGRADED',
      });
    }
  });

  await chequearUpstream();
  setInterval(() => void chequearUpstream(), HEALTHCHECK_MS).unref();

  // Solo loopback: a esta API le hablan la web y el agente de ESTA máquina.
  // No hay motivo para exponerla a la LAN, y no exponerla es una superficie
  // menos. (Ver el invariante de IPv6 en CLAUDE.md: 127.0.0.1, no localhost.)
  await app.listen({ port: PORT, host: '127.0.0.1' });
  log(`escuchando en 127.0.0.1:${PORT} → ${UPSTREAM}${CLOUD ? ` (respaldo de lectura: ${CLOUD})` : ''}`);

  startOutboxFlusher({ apiBaseUrl: `http://127.0.0.1:${PORT}/api/v1` });
}

main().catch((e) => {
  console.error('[proxy] no pudo arrancar:', e);
  process.exit(1);
});
