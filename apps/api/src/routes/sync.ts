import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  enqueue,
  pendingCount,
  abandonedCount,
  listAbandoned,
  deleteAbandoned,
} from '../services/outbox.js';

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
 * No requiere auth — quien tenga acceso a la API local ya tiene acceso
 * al sistema. El sync queue solo guarda en disco local, no escribe a cloud.
 */
export default async function syncRoutes(fastify: FastifyInstance) {
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
    return {
      pending: pendingCount(),
      abandoned: abandonedCount(),
      // El timestamp del último flush exitoso es estado runtime — lo dejo
      // para más adelante (no lo necesitamos para el badge inicial).
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
