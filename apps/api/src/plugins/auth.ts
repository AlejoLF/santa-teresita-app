import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';
import { prisma } from '@sta/db/client';
import type { Usuario, RolUsuario } from '@sta/db';

declare module 'fastify' {
  interface FastifyRequest {
    usuario?: Usuario;
    sessionId?: string;
  }
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

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
      const session = await prisma.authSession.findUnique({
        where: { tokenHash: hashToken(token) },
        include: { usuario: true },
      });
      if (!session || session.revocadaAt || session.expiraAt < new Date()) {
        return reply.code(401).send({ error: 'Sesión inválida o expirada' });
      }
      if (!session.usuario.activo) {
        return reply.code(403).send({ error: 'Usuario inactivo' });
      }
      if (roles && !roles.includes(session.usuario.rol)) {
        return reply.code(403).send({ error: 'No tenés permiso para esta acción' });
      }

      // Refresh ultima actividad (no-blocking, sin await detiene el hot path).
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
