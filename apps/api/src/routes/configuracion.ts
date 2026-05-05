import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@sta/db/client';
import { RolUsuario, TipoCuenta } from '@sta/db';
import { PinSchema, pinEsDebil } from '@sta/shared/schemas';
import { recordAudit } from '../services/audit.js';

const BCRYPT_ROUNDS = 12;

/**
 * Endpoints de configuración del sistema:
 *   - Usuarios y PINs
 *   - Cuentas (CRUD)
 *   - Posnets (CRUD)
 *   - Parámetros (key-value)
 *   - Datos del local
 */
export default async function configuracionRoutes(fastify: FastifyInstance) {
  // ──────────────────────────────────────────────────────────────────────
  //   USUARIOS
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/usuarios — lista (sin pinHash)
  fastify.get(
    '/admin/usuarios',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const usuarios = await prisma.usuario.findMany({
        select: {
          id: true,
          nombre: true,
          rol: true,
          activo: true,
          pinUltimoCambioAt: true,
          intentosFallidos: true,
          bloqueadoHasta: true,
          creadoAt: true,
        },
        orderBy: [{ activo: 'desc' }, { rol: 'asc' }, { nombre: 'asc' }],
      });
      return { usuarios };
    },
  );

  // POST /admin/usuarios — crear usuario nuevo
  fastify.post(
    '/admin/usuarios',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(120),
          rol: z.enum(['VENDEDOR', 'ADMIN']),
          pin: PinSchema,
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as { nombre: string; rol: 'VENDEDOR' | 'ADMIN'; pin: string };

      if (pinEsDebil(body.pin)) {
        return reply.code(400).send({
          error: 'Ese PIN es muy débil. Probá con uno menos predecible.',
        });
      }

      // Evitar duplicados de PIN entre usuarios activos (defensivo)
      const activos = await prisma.usuario.findMany({ where: { activo: true } });
      for (const u of activos) {
        if (await bcrypt.compare(body.pin, u.pinHash)) {
          return reply.code(409).send({
            error: 'Ese PIN ya está en uso por otro usuario activo. Elegí uno distinto.',
          });
        }
      }

      const created = await prisma.usuario.create({
        data: {
          nombre: body.nombre,
          rol: body.rol,
          pinHash: await bcrypt.hash(body.pin, BCRYPT_ROUNDS),
          creadoPorId: req.usuario!.id,
        },
        select: { id: true, nombre: true, rol: true, activo: true },
      });

      await recordAudit({
        tabla: 'usuarios',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: created.nombre, rol: created.rol },
      });
      return reply.code(201).send(created);
    },
  );

  // PATCH /admin/usuarios/:id — editar nombre / activar / desactivar
  fastify.patch(
    '/admin/usuarios/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(120).optional(),
          activo: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { nombre?: string; activo?: boolean };
      const before = await prisma.usuario.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Usuario no encontrado' });

      // Evitar que un admin se desactive a sí mismo
      if (body.activo === false && params.id === req.usuario!.id) {
        return reply.code(400).send({ error: 'No podés desactivar tu propio usuario' });
      }

      const updated = await prisma.usuario.update({
        where: { id: params.id },
        data: body,
        select: { id: true, nombre: true, rol: true, activo: true },
      });

      await recordAudit({
        tabla: 'usuarios',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre, activo: before.activo },
        valorNuevo: updated,
      });

      return updated;
    },
  );

  // POST /admin/usuarios/:id/reset-pin — un admin resetea el PIN de otro usuario
  fastify.post(
    '/admin/usuarios/:id/reset-pin',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ pinNuevo: PinSchema }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { pinNuevo: string };

      if (pinEsDebil(body.pinNuevo)) {
        return reply.code(400).send({ error: 'Ese PIN es muy débil' });
      }

      const target = await prisma.usuario.findUnique({ where: { id: params.id } });
      if (!target) return reply.code(404).send({ error: 'Usuario no encontrado' });

      // Defensivo: no permitir colisión con otro PIN activo
      const activos = await prisma.usuario.findMany({
        where: { activo: true, id: { not: params.id } },
      });
      for (const u of activos) {
        if (await bcrypt.compare(body.pinNuevo, u.pinHash)) {
          return reply.code(409).send({
            error: 'Ese PIN ya está en uso por otro usuario activo',
          });
        }
      }

      await prisma.usuario.update({
        where: { id: params.id },
        data: {
          pinHash: await bcrypt.hash(body.pinNuevo, BCRYPT_ROUNDS),
          pinUltimoCambioAt: new Date(),
          intentosFallidos: 0,
          bloqueadoHasta: null,
        },
      });
      await prisma.loginAudit.create({
        data: {
          tipo: 'RESET_PIN',
          usuarioId: target.id,
          usuarioSolicitanteId: req.usuario!.id,
        },
      });
      await recordAudit({
        tabla: 'usuarios',
        registroId: target.id,
        accion: 'RESET_PIN',
        usuarioId: req.usuario!.id,
        contexto: { targetUsuario: target.nombre },
      });

      // También revocar todas las sesiones activas del usuario
      await prisma.authSession.updateMany({
        where: { usuarioId: target.id, revocadaAt: null },
        data: { revocadaAt: new Date(), motivoRevocacion: 'pin_reset' },
      });

      return { ok: true };
    },
  );

  // POST /auth/cambiar-pin — el usuario logueado cambia su propio PIN
  fastify.post(
    '/auth/cambiar-pin',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        body: z.object({
          pinActual: PinSchema,
          pinNuevo: PinSchema,
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as { pinActual: string; pinNuevo: string };

      if (body.pinActual === body.pinNuevo) {
        return reply.code(400).send({ error: 'El PIN nuevo debe ser distinto al actual' });
      }
      if (pinEsDebil(body.pinNuevo)) {
        return reply.code(400).send({ error: 'Ese PIN es muy débil' });
      }

      const usuario = await prisma.usuario.findUnique({ where: { id: req.usuario!.id } });
      if (!usuario) return reply.code(404).send({ error: 'Usuario no encontrado' });
      const ok = await bcrypt.compare(body.pinActual, usuario.pinHash);
      if (!ok) return reply.code(401).send({ error: 'PIN actual incorrecto' });

      await prisma.usuario.update({
        where: { id: usuario.id },
        data: {
          pinHash: await bcrypt.hash(body.pinNuevo, BCRYPT_ROUNDS),
          pinUltimoCambioAt: new Date(),
          intentosFallidos: 0,
        },
      });
      await prisma.loginAudit.create({
        data: { tipo: 'CAMBIO_PIN', usuarioId: usuario.id },
      });
      await recordAudit({
        tabla: 'usuarios',
        registroId: usuario.id,
        accion: 'CAMBIO_PIN',
        usuarioId: usuario.id,
      });

      return { ok: true };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   CUENTAS (CRUD)
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/configuracion/cuentas — todas las cuentas con saldos
  fastify.get(
    '/admin/configuracion/cuentas',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const cuentas = await prisma.cuenta.findMany({
        orderBy: [{ activa: 'desc' }, { nombre: 'asc' }],
      });
      return { cuentas };
    },
  );

  // POST /admin/configuracion/cuentas — crear cuenta nueva
  fastify.post(
    '/admin/configuracion/cuentas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(80),
          tipo: z.enum(['EFECTIVO', 'BANCO', 'WALLET']),
          banco: z.string().max(80).optional(),
          cbuCvu: z.string().max(40).optional(),
          alias: z.string().max(40).optional(),
          metodoActualizacion: z
            .enum(['MANUAL', 'API_MP', 'BELVO', 'IMPORT_EXTRACTO'])
            .default('MANUAL'),
          comisionMensual: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        tipo: 'EFECTIVO' | 'BANCO' | 'WALLET';
        banco?: string;
        cbuCvu?: string;
        alias?: string;
        metodoActualizacion: 'MANUAL' | 'API_MP' | 'BELVO' | 'IMPORT_EXTRACTO';
        comisionMensual?: string;
      };
      const created = await prisma.cuenta.create({
        data: {
          nombre: body.nombre,
          tipo: body.tipo as TipoCuenta,
          banco: body.banco ?? null,
          cbuCvu: body.cbuCvu ?? null,
          alias: body.alias ?? null,
          metodoActualizacion: body.metodoActualizacion,
          comisionMensual: body.comisionMensual ?? null,
        },
      });
      await recordAudit({
        tabla: 'cuentas',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: created.nombre, tipo: created.tipo },
      });
      return reply.code(201).send(created);
    },
  );

  // PATCH /admin/configuracion/cuentas/:id — editar
  fastify.patch(
    '/admin/configuracion/cuentas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(80).optional(),
          banco: z.string().max(80).nullable().optional(),
          cbuCvu: z.string().max(40).nullable().optional(),
          alias: z.string().max(40).nullable().optional(),
          metodoActualizacion: z
            .enum(['MANUAL', 'API_MP', 'BELVO', 'IMPORT_EXTRACTO'])
            .optional(),
          comisionMensual: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
          activa: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.cuenta.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Cuenta no encontrada' });
      const updated = await prisma.cuenta.update({
        where: { id: params.id },
        data: req.body as Record<string, unknown>,
      });
      await recordAudit({
        tabla: 'cuentas',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre, activa: before.activa },
        valorNuevo: { nombre: updated.nombre, activa: updated.activa },
      });
      return updated;
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   POSNETS (CRUD)
  // ──────────────────────────────────────────────────────────────────────

  fastify.get(
    '/admin/configuracion/posnets',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const posnets = await prisma.posnet.findMany({
        include: {
          cuentaACobrarDebito: { select: { id: true, nombre: true } },
          cuentaACobrarCredito: { select: { id: true, nombre: true } },
          cuentaDestino: { select: { id: true, nombre: true } },
        },
        orderBy: [{ activo: 'desc' }, { nombre: 'asc' }],
      });
      const cuentas = await prisma.cuenta.findMany({
        where: { activa: true },
        select: { id: true, nombre: true, tipo: true },
        orderBy: { nombre: 'asc' },
      });
      const cuentasACobrar = await prisma.cuentaACobrar.findMany({
        where: { activa: true },
        select: { id: true, nombre: true, tipo: true },
        orderBy: { nombre: 'asc' },
      });
      return { posnets, cuentas, cuentasACobrar };
    },
  );

  fastify.post(
    '/admin/configuracion/posnets',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(80),
          marca: z.string().min(1).max(80),
          modelo: z.string().max(80).optional(),
          adquirente: z.string().max(80).optional(),
          ubicacion: z.string().max(80).optional(),
          cuentaDestinoId: z.string().uuid().optional(),
          cuentaACobrarDebitoId: z.string().uuid().optional(),
          cuentaACobrarCreditoId: z.string().uuid().optional(),
          soportaIntegracion: z.boolean().default(false),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        marca: string;
        modelo?: string;
        adquirente?: string;
        ubicacion?: string;
        cuentaDestinoId?: string;
        cuentaACobrarDebitoId?: string;
        cuentaACobrarCreditoId?: string;
        soportaIntegracion?: boolean;
      };
      const created = await prisma.posnet.create({
        data: {
          nombre: body.nombre,
          marca: body.marca,
          modelo: body.modelo ?? null,
          adquirente: body.adquirente ?? null,
          ubicacion: body.ubicacion ?? null,
          cuentaDestinoId: body.cuentaDestinoId ?? null,
          cuentaACobrarDebitoId: body.cuentaACobrarDebitoId ?? null,
          cuentaACobrarCreditoId: body.cuentaACobrarCreditoId ?? null,
          soportaIntegracion: body.soportaIntegracion ?? false,
        },
      });
      await recordAudit({
        tabla: 'posnets',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: created.nombre, marca: created.marca },
      });
      return reply.code(201).send(created);
    },
  );

  fastify.patch(
    '/admin/configuracion/posnets/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(80).optional(),
          marca: z.string().min(1).max(80).optional(),
          modelo: z.string().max(80).nullable().optional(),
          adquirente: z.string().max(80).nullable().optional(),
          ubicacion: z.string().max(80).nullable().optional(),
          cuentaDestinoId: z.string().uuid().nullable().optional(),
          cuentaACobrarDebitoId: z.string().uuid().nullable().optional(),
          cuentaACobrarCreditoId: z.string().uuid().nullable().optional(),
          soportaIntegracion: z.boolean().optional(),
          activo: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.posnet.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Posnet no encontrado' });
      const updated = await prisma.posnet.update({
        where: { id: params.id },
        data: req.body as Record<string, unknown>,
      });
      await recordAudit({
        tabla: 'posnets',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre, activo: before.activo },
        valorNuevo: { nombre: updated.nombre, activo: updated.activo },
      });
      return updated;
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   PARAMETROS DEL SISTEMA (key-value)
  // ──────────────────────────────────────────────────────────────────────

  fastify.get(
    '/admin/configuracion/parametros',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const parametros = await prisma.configuracionSistema.findMany({
        orderBy: [{ categoria: 'asc' }, { clave: 'asc' }],
      });
      return { parametros };
    },
  );

  fastify.patch(
    '/admin/configuracion/parametros/:clave',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ clave: z.string().max(80) }),
        body: z.object({ valor: z.string().max(2000) }),
      },
    },
    async (req, reply) => {
      const params = req.params as { clave: string };
      const body = req.body as { valor: string };
      const before = await prisma.configuracionSistema.findUnique({
        where: { clave: params.clave },
      });
      if (!before) return reply.code(404).send({ error: 'Parámetro no encontrado' });
      if (!before.editable) {
        return reply.code(400).send({ error: 'Este parámetro no es editable' });
      }
      // Validar tipo
      if (before.tipo === 'number' && Number.isNaN(Number(body.valor))) {
        return reply.code(400).send({ error: 'El valor debe ser numérico' });
      }
      if (before.tipo === 'boolean' && body.valor !== 'true' && body.valor !== 'false') {
        return reply.code(400).send({ error: 'El valor debe ser true o false' });
      }
      const updated = await prisma.configuracionSistema.update({
        where: { clave: params.clave },
        data: { valor: body.valor, actualizadoPor: req.usuario!.nombre },
      });
      await recordAudit({
        tabla: 'configuracion_sistema',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { valor: before.valor },
        valorNuevo: { valor: updated.valor },
        contexto: { clave: params.clave },
      });
      return updated;
    },
  );
}
