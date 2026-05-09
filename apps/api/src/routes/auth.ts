import type { FastifyInstance } from 'fastify';
import { LoginSchema, ApprovalSchema } from '@sta/shared/schemas';
import { login, logout, aprobarConPinAdmin, AuthError } from '../services/auth.js';
import { config } from '../config.js';

export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/auth/login',
    {
      schema: {
        body: LoginSchema,
      },
    },
    async (req, reply) => {
      const body = LoginSchema.parse(req.body);
      try {
        const result = await login(body.pin, {
          pcOrigen: body.pcOrigen,
          ipOrigen: body.ipOrigen ?? req.ip,
          userAgent: body.userAgent ?? req.headers['user-agent'],
        });
        reply.setCookie('sta_session', result.token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: config.NODE_ENV === 'production',
          expires: result.expiraAt,
        });
        // Devolvemos el token en el body además del cookie. Esto habilita
        // el flujo cross-origin (web servido por Vercel ↔ API local en
        // 127.0.0.1): el frontend guarda el token en localStorage y lo
        // manda en `Authorization: Bearer <token>`. Para el flujo
        // tradicional (mismo origen) la cookie sigue funcionando — el
        // requireAuth acepta cualquiera de las dos vías.
        return reply.send({
          usuario: result.usuario,
          token: result.token,
          expiraAt: result.expiraAt.toISOString(),
        });
      } catch (e) {
        if (e instanceof AuthError) {
          return reply.code(401).send({ error: e.message, code: e.code, meta: e.meta });
        }
        throw e;
      }
    },
  );

  fastify.post(
    '/auth/logout',
    { preHandler: fastify.requireAuth() },
    async (req, reply) => {
      if (req.sessionId && req.usuario) {
        await logout(req.sessionId, req.usuario.id);
      }
      reply.clearCookie('sta_session', { path: '/' });
      return reply.send({ ok: true });
    },
  );

  fastify.get(
    '/auth/me',
    { preHandler: fastify.requireAuth() },
    async (req) => {
      return {
        usuario: {
          id: req.usuario!.id,
          nombre: req.usuario!.nombre,
          rol: req.usuario!.rol,
        },
      };
    },
  );

  fastify.post(
    '/auth/approve',
    {
      preHandler: fastify.requireAuth(),
      schema: { body: ApprovalSchema },
    },
    async (req, reply) => {
      const body = ApprovalSchema.parse(req.body);
      try {
        const result = await aprobarConPinAdmin({
          pin: body.pin,
          accion: body.accion,
          contexto: body.contexto,
          usuarioSolicitanteId: req.usuario!.id,
          pcOrigen: req.headers['x-pc-origen'] as string | undefined ?? 'unknown',
          ipOrigen: req.ip,
        });
        return reply.send({ ok: true, aprobador: result.usuarioAprobador });
      } catch (e) {
        if (e instanceof AuthError) {
          return reply.code(401).send({ error: e.message, code: e.code });
        }
        throw e;
      }
    },
  );
}
