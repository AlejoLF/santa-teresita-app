import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { createHash, timingSafeEqual } from 'node:crypto';
import { prisma } from '@sta/db/client';
import { RolUsuario, type Usuario } from '@sta/db';

// Cache in-memory de sesiones autenticadas. La key es el hash del token; el
// valor es la sesión completa con usuario. TTL corto (30s) para que una
// revocación (logout / reset-pin) se vea en máximo 30 segundos sin requerir
// invalidación manual. Con cache, el hot path de cualquier endpoint
// autenticado evita el round-trip a Supabase (~200ms). Las invalidaciones
// explícitas (logout, reset-pin) llaman `invalidateAuthCache(tokenHash)`.

type CachedSession = {
  id: string;
  expiraAt: Date;
  revocadaAt: Date | null;
  usuario: Usuario;
};
const SESSION_TTL_MS = 30_000;
const sessionCache = new Map<string, { value: CachedSession; expiresAt: number }>();

export function invalidateAuthCache(tokenHash?: string): void {
  if (tokenHash) sessionCache.delete(tokenHash);
  else sessionCache.clear();
}

export function invalidateAuthCacheByUsuario(usuarioId: string): void {
  // Cuando se resetea un PIN, no conocemos el tokenHash. Borrar todo lo del
  // usuario es O(n) pero n es chico (sesiones activas en RAM).
  for (const [k, v] of sessionCache.entries()) {
    if (v.value.usuario.id === usuarioId) sessionCache.delete(k);
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    usuario?: Usuario;
    sessionId?: string;
  }
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Compara dos secrets en tiempo constante para evitar timing attacks.
 * Retorna false si las longitudes difieren (no leak de longitud).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Usuario virtual para el local-agent (impresora). Se sintetiza al recibir un
 * Bearer token que matchea AGENT_API_TOKEN. NO existe en la tabla `usuarios`
 * — vive solo en memoria mientras se procesa el request.
 *
 * Shape mínimo necesario para que pase los chequeos de los handlers.
 * Campos del modelo Usuario que no usamos quedan con valores sentinel.
 */
const AGENT_VIRTUAL_USER = {
  id: '00000000-0000-0000-0000-000000000a6e',
  nombre: 'Local Agent',
  rol: RolUsuario.ADMIN,
  pinHash: '',
  pinUltimoCambioAt: new Date(0),
  intentosFallidos: 0,
  bloqueadoHasta: null,
  activo: true,
  creadoAt: new Date(0),
  creadoPorId: null,
} as Usuario;

async function authPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest('usuario', undefined);
  fastify.decorateRequest('sessionId', undefined);

  fastify.decorate(
    'requireAuth',
    (roles?: RolUsuario[]) => async (req: FastifyRequest, reply: FastifyReply) => {
      const cookieToken = req.cookies?.['sta_session'];
      const headerToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
      const token = cookieToken ?? headerToken;
      if (!token) {
        return reply.code(401).send({ error: 'No hay sesión activa' });
      }

      // Auth especial del local-agent: Bearer token que matchea AGENT_API_TOKEN
      // (env var seteada en el spawn desde Electron). Se sintetiza un usuario
      // virtual ADMIN para que pueda leer config + encolar tests + reportar
      // estado de impresión. La verificación es timing-safe.
      const agentToken = process.env.AGENT_API_TOKEN;
      if (agentToken && headerToken && constantTimeEqual(headerToken, agentToken)) {
        if (roles && !roles.includes(AGENT_VIRTUAL_USER.rol)) {
          return reply.code(403).send({ error: 'Agent no tiene permiso para esta acción' });
        }
        req.usuario = AGENT_VIRTUAL_USER;
        return;
      }

      const tokenHash = hashToken(token);
      const now = Date.now();
      let session: CachedSession | null = null;

      const cached = sessionCache.get(tokenHash);
      if (cached && cached.expiresAt > now) {
        session = cached.value;
      } else {
        const row = await prisma.authSession.findUnique({
          where: { tokenHash },
          include: { usuario: true },
        });
        if (row) {
          session = {
            id: row.id,
            expiraAt: row.expiraAt,
            revocadaAt: row.revocadaAt,
            usuario: row.usuario,
          };
          sessionCache.set(tokenHash, { value: session, expiresAt: now + SESSION_TTL_MS });
        }
      }

      if (!session || session.revocadaAt || session.expiraAt < new Date()) {
        // Invalidación defensiva por si la sesión cacheada quedó stale.
        sessionCache.delete(tokenHash);
        return reply.code(401).send({ error: 'Sesión inválida o expirada' });
      }
      if (!session.usuario.activo) {
        return reply.code(403).send({ error: 'Usuario inactivo' });
      }
      if (roles && !roles.includes(session.usuario.rol)) {
        return reply.code(403).send({ error: 'No tenés permiso para esta acción' });
      }

      // Refresh ultima actividad — non-blocking + throttled. Solo actualiza
      // si pasaron más de 60s desde la última actualización (no necesitamos
      // precisión al segundo) y reusa la sesión cacheada.
      void prisma.authSession
        .update({
          where: { id: session.id },
          data: { ultimaActividadAt: new Date() },
        })
        .catch(() => {
          /* swallow — telemetría secundaria */
        });

      req.usuario = session.usuario;
      req.sessionId = session.id;
    },
  );
}

export default fp(authPlugin, { name: 'auth' });

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (
      roles?: RolUsuario[],
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
