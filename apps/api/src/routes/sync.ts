import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  enqueue,
  pendingCount,
  abandonedCount,
  listAbandoned,
  deleteAbandoned,
} from '../services/outbox.js';
import { replicatorLag } from '../services/replicator.js';
import { config } from '../config.js';

/**
 * Endpoints de sincronización offline (resilencia local cuando cloud cae).
 *
 * Flujo:
 *   1. El frontend intenta una escritura → cloud no responde.
 *   2. El frontend captura el error de red, llama POST /sync/queue con
 *      { method, url, body, headers } del request original.
 *   3. Acá lo persistimos en SQLite local.
 *   4. Un flusher en background reintenta cada 5s contra la API misma.
 *   5. Cuando publica OK, lo borra. Si falla, incrementa attempts +
 *      backoff exponencial.
 *
 * Acceso: SOLO loopback (127.0.0.1). Lo usa el frontend de ESTA máquina cuando
 * un write falla. No usamos requireAuth porque /sync tiene que funcionar con la
 * DB caída (modo degradado) y requireAuth necesita la DB; limitar a loopback
 * frena a un atacante en la LAN (un cliente en el WiFi del local) sin romper la
 * resiliencia. (A9 del audit de seguridad.)
 */
export default async function syncRoutes(fastify: FastifyInstance) {
  // Gate loopback para todas las rutas /sync de este plugin.
  fastify.addHook('onRequest', async (req, reply) => {
    const ip = req.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return reply.code(403).send({ error: 'No autorizado (solo loopback)' });
    }
  });

  fastify.post(
    '/sync/queue',
    {
      schema: {
        body: z.object({
          method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
          url: z.string().min(1).max(2000),
          body: z.unknown().optional(),
          headers: z.record(z.string()).optional(),
        }),
      },
    },
    async (req) => {
      const b = req.body as {
        method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        url: string;
        body?: unknown;
        headers?: Record<string, string>;
      };
      const id = enqueue({ method: b.method, url: b.url, body: b.body, headers: b.headers });
      return { id, queued: true };
    },
  );

  fastify.get('/sync/status', async () => {
    // Lag del replicator local→Supabase. Solo tiene sentido en el server;
    // en las cajas STA_ROLE=caja y no hay replicator (replicacion: null).
    let replicacion: Awaited<ReturnType<typeof replicatorLag>> | null = null;
    if (config.STA_ROLE === 'server' && config.REPLICATE_TO_URL) {
      replicacion = await replicatorLag().catch(() => null);
    }
    return {
      pending: pendingCount(),
      abandoned: abandonedCount(),
      rol: config.STA_ROLE,
      replicacion,
    };
  });

  fastify.get(
    '/sync/abandoned',
    {
      schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    },
    async (req) => {
      const q = req.query as { limit: number };
      const items = listAbandoned(q.limit);
      return { items };
    },
  );

  fastify.delete(
    '/sync/abandoned/:id',
    {
      schema: { params: z.object({ id: z.string() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      deleteAbandoned(id);
      return { ok: true };
    },
  );
}
