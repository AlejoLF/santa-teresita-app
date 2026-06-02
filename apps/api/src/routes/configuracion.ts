import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '@sta/db/client';
import { RolUsuario, TipoCuenta } from '@sta/db';
import { PinSchema, pinEsDebil } from '@sta/shared/schemas';
import { recordAudit } from '../services/audit.js';
import { invalidateAuthCacheByUsuario } from '../plugins/auth.js';
import { invalidate as invalidateCache } from '../lib/cache.js';
import { resetDeliveryRepartidorDefaultCache } from '../services/impresion.js';
import { getMailerStatus } from '../services/mailer.js';
import {
  DEFAULT_CONFIG,
  getConfigHorarios,
  invalidateHorariosCache,
  validarConfig,
  type ConfigHorarios,
} from '../services/horarios.js';

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
  //   PÚBLICO (sin admin) — valores que el vendedor necesita en el flujo
  // ──────────────────────────────────────────────────────────────────────

  // GET /configuracion/publico — devuelve un subset de keys que el vendedor
  // necesita en el flujo de cobro (montos de envío). Cualquier usuario auth
  // puede leer esto — no expone passwords ni secretos.
  fastify.get(
    '/configuracion/publico',
    { preHandler: fastify.requireAuth() },
    async () => {
      const keys = ['envio_simple_monto', 'envio_doble_monto'];
      const rows = await prisma.configuracionSistema.findMany({
        where: { clave: { in: keys } },
        select: { clave: true, valor: true },
      });
      return Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
    },
  );

  // GET /configuracion/envios — lista de tipos de envío activos para los
  // botones de la pantalla de cobro. Cada uno es un producto del tipo "Envío".
  // Cualquier usuario auth puede leerlo (lo usa el vendedor).
  fastify.get(
    '/configuracion/envios',
    { preHandler: fastify.requireAuth() },
    async () => {
      const envios = await listarEnviosActivos();
      return { envios };
    },
  );

  // ────────────────────────────────────────────────────────────────────
  //   LISTAS Y OPCIONES — listas blandas configurables (patrón genérico)
  //   dominio + etiqueta + atributos. Reglas duras (métodos de pago, canales,
  //   tipos de cuenta) NO van acá — viven cableadas en el código.
  // ────────────────────────────────────────────────────────────────────

  // Dominios "de sistema" conocidos (la UI los lista siempre). Las listas
  // propias que cree la encargada se registran como filas del dominio meta
  // `_listas_propias_` y sus ítems viven en dominio `propia:<slug>`.
  const DOMINIO_RE = /^[a-z0-9_]+(:[a-z0-9_-]+)?$/;

  // GET /configuracion/opciones/:dominio — opciones ACTIVAS de un dominio.
  // Cualquier usuario auth (lo consumen el vendedor/encargada en los modales).
  fastify.get(
    '/configuracion/opciones/:dominio',
    {
      preHandler: fastify.requireAuth(),
      schema: { params: z.object({ dominio: z.string().min(1).max(80) }) },
    },
    async (req) => {
      const { dominio } = req.params as { dominio: string };
      const opciones = await prisma.opcionConfigurable.findMany({
        where: { dominio, activo: true },
        orderBy: [{ orden: 'asc' }, { etiqueta: 'asc' }],
      });
      return {
        opciones: opciones.map((o) => ({
          id: o.id,
          etiqueta: o.etiqueta,
          valor: o.valor,
          atributos: o.atributos,
        })),
      };
    },
  );

  // GET /admin/opciones/:dominio — todas (activas e inactivas) para el ABM.
  fastify.get(
    '/admin/opciones/:dominio',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ dominio: z.string().min(1).max(80) }) },
    },
    async (req) => {
      const { dominio } = req.params as { dominio: string };
      const opciones = await prisma.opcionConfigurable.findMany({
        where: { dominio },
        orderBy: [{ orden: 'asc' }, { etiqueta: 'asc' }],
      });
      return { opciones };
    },
  );

  // POST /admin/opciones/:dominio — crear opción
  fastify.post(
    '/admin/opciones/:dominio',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ dominio: z.string().min(1).max(80) }),
        body: z.object({
          etiqueta: z.string().min(1).max(120),
          valor: z.string().max(120).optional(),
          atributos: z.record(z.unknown()).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { dominio } = req.params as { dominio: string };
      if (!DOMINIO_RE.test(dominio)) {
        return reply.code(400).send({ error: 'Dominio inválido' });
      }
      const body = req.body as { etiqueta: string; valor?: string; atributos?: Record<string, unknown> };
      const etiqueta = body.etiqueta.trim();
      const existente = await prisma.opcionConfigurable.findFirst({
        where: { dominio, etiqueta: { equals: etiqueta, mode: 'insensitive' } },
      });
      if (existente) {
        if (!existente.activo) {
          const r = await prisma.opcionConfigurable.update({
            where: { id: existente.id },
            data: { activo: true },
          });
          return reply.code(200).send(r);
        }
        return reply.code(409).send({ error: 'Ya existe esa opción en la lista' });
      }
      const max = await prisma.opcionConfigurable.aggregate({
        where: { dominio },
        _max: { orden: true },
      });
      const created = await prisma.opcionConfigurable.create({
        data: {
          dominio,
          etiqueta,
          valor: body.valor ?? null,
          atributos: (body.atributos ?? undefined) as never,
          orden: (max._max.orden ?? -1) + 1,
        },
      });
      await recordAudit({
        tabla: 'opciones_configurables',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { dominio, etiqueta },
      });
      return reply.code(201).send(created);
    },
  );

  // PATCH /admin/opciones/:id — editar etiqueta/valor/atributos/orden/activo
  fastify.patch(
    '/admin/opciones/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          etiqueta: z.string().min(1).max(120).optional(),
          valor: z.string().max(120).nullable().optional(),
          atributos: z.record(z.unknown()).nullable().optional(),
          orden: z.number().int().optional(),
          activo: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.opcionConfigurable.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Opción no encontrada' });
      const updated = await prisma.opcionConfigurable.update({
        where: { id: params.id },
        data: req.body as Record<string, unknown>,
      });
      await recordAudit({
        tabla: 'opciones_configurables',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { etiqueta: before.etiqueta },
        valorNuevo: { etiqueta: updated.etiqueta, activo: updated.activo },
      });
      return updated;
    },
  );

  // DELETE /admin/opciones/:id — eliminar. Las de sistema se desactivan (soft);
  // las propias se borran de verdad.
  fastify.delete(
    '/admin/opciones/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.opcionConfigurable.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Opción no encontrada' });
      if (before.esSistema) {
        await prisma.opcionConfigurable.update({ where: { id: params.id }, data: { activo: false } });
      } else {
        await prisma.opcionConfigurable.delete({ where: { id: params.id } });
      }
      await recordAudit({
        tabla: 'opciones_configurables',
        registroId: params.id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { dominio: before.dominio, etiqueta: before.etiqueta },
      });
      return { ok: true };
    },
  );

  // GET /configuracion/delivery-empresas — empresas activas para el selector
  // de repartidor del vendedor. Cualquier usuario auth (no solo admin).
  fastify.get(
    '/configuracion/delivery-empresas',
    { preHandler: fastify.requireAuth() },
    async () => {
      const empresas = await prisma.empresaDelivery.findMany({
        where: { activo: true },
        orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
        select: { id: true, nombre: true, comisionPct: true, esInterno: true },
      });
      return {
        empresas: empresas.map((e) => ({
          id: e.id,
          nombre: e.nombre,
          comisionPct: e.comisionPct.toString(),
          esInterno: e.esInterno,
        })),
      };
    },
  );

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
      // Limpiar cache de auth del usuario (sus sesiones cacheadas dejan de servir).
      invalidateAuthCacheByUsuario(target.id);

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
          // Si true, los movimientos contra esta cuenta no afectan al
          // esperado del cierre de caja (ej: cuenta "Efectivo acumulado"
          // del dueño con plata de cajas pasadas).
          excluidaDeCierreCaja: z.boolean().optional(),
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
        excluidaDeCierreCaja?: boolean;
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
          excluidaDeCierreCaja: body.excluidaDeCierreCaja ?? false,
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
          excluidaDeCierreCaja: z.boolean().optional(),
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

  // POST /admin/configuracion/cuentas/:id/reset-saldo — pone el saldo en 0
  // (o en un valor dado). Útil para bypassear errores de saldo arrastrados
  // hasta que entre la conciliación automática. Queda auditado.
  fastify.post(
    '/admin/configuracion/cuentas/:id/reset-saldo',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({ saldo: z.string().regex(/^-?\d+(\.\d{1,2})?$/).optional() })
          .optional(),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = (req.body ?? {}) as { saldo?: string };
      const before = await prisma.cuenta.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Cuenta no encontrada' });
      const nuevoSaldo = body.saldo ?? '0';
      const updated = await prisma.cuenta.update({
        where: { id: params.id },
        data: { saldoActual: nuevoSaldo },
      });
      await recordAudit({
        tabla: 'cuentas',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { saldoActual: before.saldoActual.toString() },
        valorNuevo: { saldoActual: updated.saldoActual.toString() },
        contexto: { accion: 'reset-saldo' },
      });
      return updated;
    },
  );

  // DELETE /admin/configuracion/cuentas/:id — soft delete (activa=false).
  // No borramos físico: los movimientos/pagos históricos la referencian.
  fastify.delete(
    '/admin/configuracion/cuentas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.cuenta.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Cuenta no encontrada' });
      await prisma.cuenta.update({ where: { id: params.id }, data: { activa: false } });
      await recordAudit({
        tabla: 'cuentas',
        registroId: params.id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre },
      });
      return { ok: true };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   DELIVERY — empresas/repartidores con comisión (CRUD)
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/configuracion/delivery-empresas — listado (activas e inactivas)
  fastify.get(
    '/admin/configuracion/delivery-empresas',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const empresas = await prisma.empresaDelivery.findMany({
        orderBy: [{ activo: 'desc' }, { orden: 'asc' }, { nombre: 'asc' }],
      });
      return { empresas };
    },
  );

  // POST /admin/configuracion/delivery-empresas — crear
  fastify.post(
    '/admin/configuracion/delivery-empresas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(80),
          comisionPct: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
          esInterno: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as { nombre: string; comisionPct?: string; esInterno?: boolean };
      const nombre = body.nombre.trim();
      const existente = await prisma.empresaDelivery.findFirst({
        where: { nombre: { equals: nombre, mode: 'insensitive' } },
      });
      if (existente) {
        if (!existente.activo) {
          const reactivada = await prisma.empresaDelivery.update({
            where: { id: existente.id },
            data: { activo: true },
          });
          return reply.code(200).send(reactivada);
        }
        return reply.code(409).send({ error: 'Ya existe una empresa con ese nombre' });
      }
      const max = await prisma.empresaDelivery.aggregate({ _max: { orden: true } });
      const created = await prisma.empresaDelivery.create({
        data: {
          nombre,
          comisionPct: body.comisionPct ?? '0',
          esInterno: body.esInterno ?? false,
          orden: (max._max.orden ?? 0) + 1,
        },
      });
      await recordAudit({
        tabla: 'empresas_delivery',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: created.nombre, comisionPct: created.comisionPct.toString() },
      });
      return reply.code(201).send(created);
    },
  );

  // PATCH /admin/configuracion/delivery-empresas/:id — editar
  fastify.patch(
    '/admin/configuracion/delivery-empresas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(80).optional(),
          comisionPct: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
          esInterno: z.boolean().optional(),
          activo: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.empresaDelivery.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Empresa no encontrada' });
      const updated = await prisma.empresaDelivery.update({
        where: { id: params.id },
        data: req.body as Record<string, unknown>,
      });
      await recordAudit({
        tabla: 'empresas_delivery',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre, comisionPct: before.comisionPct.toString(), activo: before.activo },
        valorNuevo: { nombre: updated.nombre, comisionPct: updated.comisionPct.toString(), activo: updated.activo },
      });
      return updated;
    },
  );

  // DELETE /admin/configuracion/delivery-empresas/:id — soft delete (activo=false)
  fastify.delete(
    '/admin/configuracion/delivery-empresas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.empresaDelivery.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Empresa no encontrada' });
      await prisma.empresaDelivery.update({
        where: { id: params.id },
        data: { activo: false },
      });
      await recordAudit({
        tabla: 'empresas_delivery',
        registroId: params.id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre },
      });
      return { ok: true };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   ENVÍOS — tipos de envío con nombre + precio (CRUD)
  //   Cada tipo de envío es un producto del tipoProducto "Envío". El precio
  //   es el precioBase del producto (fuente de verdad). El botón en cobrar
  //   se genera dinámicamente desde esta lista.
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/configuracion/envios — listado (activos e inactivos)
  fastify.get(
    '/admin/configuracion/envios',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const tipoEnvio = await getTipoEnvioId();
      if (!tipoEnvio) return { envios: [] };
      const productos = await prisma.producto.findMany({
        where: { tipoProductoId: tipoEnvio },
        orderBy: [{ activo: 'desc' }, { nombre: 'asc' }],
        select: { id: true, codigo: true, nombre: true, precioBase: true, activo: true },
      });
      return {
        envios: productos.map((p) => ({
          id: p.id,
          codigo: p.codigo,
          nombre: p.nombre,
          monto: p.precioBase.toString(),
          activo: p.activo,
        })),
      };
    },
  );

  // POST /admin/configuracion/envios — crear tipo de envío
  fastify.post(
    '/admin/configuracion/envios',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(80),
          monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as { nombre: string; monto: string };
      const tipoEnvio = await getOrCreateTipoEnvio();
      // Código autogenerado ENVxx incremental para no chocar con ENV01/ENV02.
      const ultimo = await prisma.producto.findFirst({
        where: { codigo: { startsWith: 'ENV' } },
        orderBy: { codigo: 'desc' },
        select: { codigo: true },
      });
      const n = ultimo?.codigo ? parseInt(ultimo.codigo.replace('ENV', ''), 10) + 1 : 1;
      const codigo = `ENV${String(n).padStart(2, '0')}`;
      const created = await prisma.producto.create({
        data: {
          codigo,
          tipoProductoId: tipoEnvio,
          nombre: body.nombre.trim(),
          formaVenta: 'UNIDAD',
          unidadPrecio: 'POR_UNIDAD',
          precioBase: body.monto,
        },
        select: { id: true, codigo: true, nombre: true, precioBase: true, activo: true },
      });
      await recordAudit({
        tabla: 'productos',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { tipo: 'envio', nombre: created.nombre, monto: created.precioBase.toString() },
      });
      return reply.code(201).send({
        id: created.id,
        codigo: created.codigo,
        nombre: created.nombre,
        monto: created.precioBase.toString(),
        activo: created.activo,
      });
    },
  );

  // PATCH /admin/configuracion/envios/:id — editar nombre/monto/activo
  fastify.patch(
    '/admin/configuracion/envios/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(80).optional(),
          monto: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          activo: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { nombre?: string; monto?: string; activo?: boolean };
      const before = await prisma.producto.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Envío no encontrado' });
      const updated = await prisma.producto.update({
        where: { id: params.id },
        data: {
          ...(body.nombre !== undefined && { nombre: body.nombre.trim() }),
          ...(body.monto !== undefined && { precioBase: body.monto }),
          ...(body.activo !== undefined && { activo: body.activo }),
        },
        select: { id: true, codigo: true, nombre: true, precioBase: true, activo: true },
      });
      // Mantener sincronizadas las viejas config keys por compatibilidad
      // (si alguien todavía lee envio_simple_monto/doble).
      if (before.codigo === 'ENV01' && body.monto) {
        await prisma.configuracionSistema.updateMany({
          where: { clave: 'envio_simple_monto' },
          data: { valor: body.monto },
        });
      } else if (before.codigo === 'ENV02' && body.monto) {
        await prisma.configuracionSistema.updateMany({
          where: { clave: 'envio_doble_monto' },
          data: { valor: body.monto },
        });
      }
      await recordAudit({
        tabla: 'productos',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre, monto: before.precioBase.toString() },
        valorNuevo: { nombre: updated.nombre, monto: updated.precioBase.toString() },
      });
      return {
        id: updated.id,
        codigo: updated.codigo,
        nombre: updated.nombre,
        monto: updated.precioBase.toString(),
        activo: updated.activo,
      };
    },
  );

  // DELETE /admin/configuracion/envios/:id — soft delete (activo=false)
  fastify.delete(
    '/admin/configuracion/envios/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.producto.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Envío no encontrado' });
      await prisma.producto.update({ where: { id: params.id }, data: { activo: false } });
      await recordAudit({
        tabla: 'productos',
        registroId: params.id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { tipo: 'envio', nombre: before.nombre },
      });
      return { ok: true };
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

  // DELETE /admin/configuracion/posnets/:id — soft delete (activo=false).
  fastify.delete(
    '/admin/configuracion/posnets/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.posnet.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Posnet no encontrado' });
      await prisma.posnet.update({ where: { id: params.id }, data: { activo: false } });
      await recordAudit({
        tabla: 'posnets',
        registroId: params.id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre },
      });
      return { ok: true };
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
      // Invalidar caches en proceso de servicios que cachean por clave.
      if (params.clave === 'delivery_repartidor_default') {
        resetDeliveryRepartidorDefaultCache();
      }
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

  // ────────────────────────────────────────────────────────────────────
  //   EMAILS DESTINATARIOS DE CIERRES DE CAJA
  // ────────────────────────────────────────────────────────────────────
  // La encargada configura desde /admin/configuracion/usuarios qué emails
  // reciben los cierres. Antes solo se podía vía env var ADMIN_EMAIL_
  // RECIPIENTS — requería rebuildear el .exe para cambiar.

  fastify.get(
    '/admin/configuracion/cierre-emails',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const row = await prisma.configuracionSistema.findUnique({
        where: { clave: 'cierre_email_recipients' },
      });
      const emails = row?.valor
        ? row.valor.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      return { emails };
    },
  );

  fastify.put(
    '/admin/configuracion/cierre-emails',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          emails: z.array(z.string().email()).max(10),
        }),
      },
    },
    async (req) => {
      const body = req.body as { emails: string[] };
      const valor = body.emails.join(',');
      const before = await prisma.configuracionSistema.findUnique({
        where: { clave: 'cierre_email_recipients' },
      });
      const row = await prisma.configuracionSistema.upsert({
        where: { clave: 'cierre_email_recipients' },
        create: {
          clave: 'cierre_email_recipients',
          valor,
          tipo: 'string',
          categoria: 'email',
          descripcion: 'Emails que reciben los cierres de caja (separados por coma)',
          editable: true,
          actualizadoPor: req.usuario?.nombre ?? null,
        },
        update: {
          valor,
          actualizadoPor: req.usuario?.nombre ?? null,
        },
      });
      await recordAudit({
        tabla: 'configuracion_sistema',
        registroId: row.id,
        accion: before ? 'UPDATE' : 'INSERT',
        usuarioId: req.usuario!.id,
        valorAnterior: before ? { valor: before.valor } : null,
        valorNuevo: { valor },
        contexto: { clave: 'cierre_email_recipients' },
      });
      return { ok: true, emails: body.emails };
    },
  );

  // ────────────────────────────────────────────────────────────────────
  //   SMTP — servidor de email para envíos de cierre
  // ────────────────────────────────────────────────────────────────────
  // Antes vivía sólo en .env (no llegaba al .exe del local). Ahora la
  // encargada lo configura desde /admin/configuracion/usuarios. Storage en
  // configuracion_sistema (claves smtp_*). El password se guarda plano en
  // la DB local (acceso sólo desde la red del local) y se enmascara en
  // todas las responses de la API.

  const SMTP_KEYS = [
    'smtp_host',
    'smtp_port',
    'smtp_secure',
    'smtp_user',
    'smtp_pass',
    'smtp_from',
    'email_auto_envio_cierre',
  ] as const;

  fastify.get(
    '/admin/configuracion/smtp',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const rows = await prisma.configuracionSistema.findMany({
        where: { clave: { in: [...SMTP_KEYS] } },
      });
      const map = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
      const status = await getMailerStatus();
      return {
        host: map.smtp_host ?? '',
        port: map.smtp_port ?? '587',
        secure: map.smtp_secure === 'true',
        user: map.smtp_user ?? '',
        // Enmascaramos el pass: nunca devolvemos el valor. Pero sí su LONGITUD
        // (sin espacios) para que la UI muestre "guardada (16 caracteres)" y se
        // vea que quedó completa — un App Password de Gmail son 16.
        passConfigurado: !!(map.smtp_pass && map.smtp_pass.length > 0),
        passLength: map.smtp_pass ? map.smtp_pass.replace(/\s+/g, '').length : 0,
        from: map.smtp_from ?? '',
        autoEnvioCierre: map.email_auto_envio_cierre === 'true',
        // Estado actual del mailer (incluye fallback al .env si la DB no tiene).
        status,
      };
    },
  );

  fastify.put(
    '/admin/configuracion/smtp',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          host: z.string().max(200).optional(),
          port: z.union([z.number().int().min(1).max(65535), z.string().regex(/^\d+$/)]).optional(),
          secure: z.boolean().optional(),
          user: z.string().max(200).optional(),
          // Si pass viene undefined o "" → NO se actualiza. Para limpiar el
          // pass guardado, mandar { pass: '__CLEAR__' }.
          pass: z.string().max(200).optional(),
          from: z.string().max(200).optional(),
          autoEnvioCierre: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const body = req.body as {
        host?: string;
        port?: number | string;
        secure?: boolean;
        user?: string;
        pass?: string;
        from?: string;
        autoEnvioCierre?: boolean;
      };
      const updates: Array<{ clave: string; valor: string }> = [];
      if (body.host !== undefined) updates.push({ clave: 'smtp_host', valor: body.host });
      if (body.port !== undefined) updates.push({ clave: 'smtp_port', valor: String(body.port) });
      if (body.secure !== undefined) updates.push({ clave: 'smtp_secure', valor: body.secure ? 'true' : 'false' });
      if (body.user !== undefined) updates.push({ clave: 'smtp_user', valor: body.user });
      if (body.pass !== undefined && body.pass !== '') {
        updates.push({ clave: 'smtp_pass', valor: body.pass === '__CLEAR__' ? '' : body.pass });
      }
      if (body.from !== undefined) updates.push({ clave: 'smtp_from', valor: body.from });
      if (body.autoEnvioCierre !== undefined) {
        updates.push({ clave: 'email_auto_envio_cierre', valor: body.autoEnvioCierre ? 'true' : 'false' });
      }
      for (const u of updates) {
        const before = await prisma.configuracionSistema.findUnique({ where: { clave: u.clave } });
        const row = await prisma.configuracionSistema.upsert({
          where: { clave: u.clave },
          create: {
            clave: u.clave,
            valor: u.valor,
            tipo: u.clave === 'smtp_port' ? 'number' : u.clave === 'smtp_secure' || u.clave === 'email_auto_envio_cierre' ? 'boolean' : 'string',
            categoria: 'email',
            editable: true,
            actualizadoPor: req.usuario?.nombre ?? null,
          },
          update: { valor: u.valor, actualizadoPor: req.usuario?.nombre ?? null },
        });
        await recordAudit({
          tabla: 'configuracion_sistema',
          registroId: row.id,
          accion: before ? 'UPDATE' : 'INSERT',
          usuarioId: req.usuario!.id,
          // Enmascaramos el pass en el audit log para no leakear.
          valorAnterior: before
            ? { valor: u.clave === 'smtp_pass' ? '***' : before.valor }
            : null,
          valorNuevo: { valor: u.clave === 'smtp_pass' ? '***' : u.valor },
          contexto: { clave: u.clave },
        });
      }
      return { ok: true, applied: updates.length };
    },
  );

  // ────────────────────────────────────────────────────────────────────
  //   HORARIOS DE ATENCION (sesiones configurables)
  // ────────────────────────────────────────────────────────────────────
  // Reemplaza el hardcode anterior de "mañana hasta 14:30, tarde después".
  // Configurable por día de la semana + soporte de feriados + ventana de
  // cierre (grace period). Ver services/horarios.ts.

  fastify.get(
    '/admin/configuracion/horarios',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const config = await getConfigHorarios();
      return { config, defaultConfig: DEFAULT_CONFIG };
    },
  );

  fastify.put(
    '/admin/configuracion/horarios',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          version: z.number().int().min(1),
          horarios: z.array(
            z.object({
              id: z.string().min(1).max(40),
              diasSemana: z.array(z.number().int().min(0).max(6)).min(1),
              turno: z.enum(['MANANA', 'TARDE']),
              horaInicio: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
              horaFin: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
              ventanaCierreMin: z.number().int().min(0).max(180),
            }),
          ),
          feriados: z
            .array(
              z.object({
                fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                label: z.string().min(1).max(80),
                cerrado: z.boolean(),
                horarios: z
                  .array(
                    z.object({
                      id: z.string().min(1).max(40),
                      diasSemana: z.array(z.number().int().min(0).max(6)),
                      turno: z.enum(['MANANA', 'TARDE']),
                      horaInicio: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
                      horaFin: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
                      ventanaCierreMin: z.number().int().min(0).max(180),
                    }),
                  )
                  .optional(),
              }),
            )
            .max(50)
            .optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as ConfigHorarios;

      try {
        validarConfig(body);
      } catch (e) {
        return reply
          .code(400)
          .send({ error: e instanceof Error ? e.message : 'Configuración inválida' });
      }

      const valor = JSON.stringify(body);
      const before = await prisma.configuracionSistema.findUnique({
        where: { clave: 'sesiones_horarios' },
      });
      const row = await prisma.configuracionSistema.upsert({
        where: { clave: 'sesiones_horarios' },
        create: {
          clave: 'sesiones_horarios',
          valor,
          tipo: 'json',
          categoria: 'caja',
          descripcion:
            'Horarios de atención por día de semana + feriados + ventana de cierre. JSON.',
          editable: true,
          actualizadoPor: req.usuario?.nombre ?? null,
        },
        update: { valor, actualizadoPor: req.usuario?.nombre ?? null },
      });
      await recordAudit({
        tabla: 'configuracion_sistema',
        registroId: row.id,
        accion: before ? 'UPDATE' : 'INSERT',
        usuarioId: req.usuario!.id,
        valorAnterior: before ? { valor: before.valor } : null,
        valorNuevo: { valor },
        contexto: { clave: 'sesiones_horarios' },
      });
      // El cache de horarios queda invalidado para que el próximo
      // resolverSlotActivo lea la config nueva.
      invalidateHorariosCache();

      return { ok: true, config: body };
    },
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Helpers de envíos (productos del tipoProducto "Envío")
// ────────────────────────────────────────────────────────────────────────

/** Devuelve el id del tipoProducto "Envío" (o null si no existe todavía). */
async function getTipoEnvioId(): Promise<string | null> {
  const tipo = await prisma.tipoProducto.findFirst({
    where: { nombre: 'Envío' },
    select: { id: true },
  });
  return tipo?.id ?? null;
}

/** Como getTipoEnvioId pero lo crea si falta (categoría Servicios + tipo Envío). */
async function getOrCreateTipoEnvio(): Promise<string> {
  const existente = await getTipoEnvioId();
  if (existente) return existente;
  const catServicios = await prisma.categoria.upsert({
    where: { nombre: 'Servicios' },
    create: { nombre: 'Servicios', orden: 999, icono: '🛵', color: '#9CA3AF' },
    update: {},
  });
  const tipo = await prisma.tipoProducto.create({
    data: {
      categoriaId: catServicios.id,
      nombre: 'Envío',
      cocinaInterviene: false,
      descripcion: 'Costo de envío del pedido (no interviene cocina).',
    },
  });
  return tipo.id;
}

/** Lista de tipos de envío activos para los botones de cobro. */
async function listarEnviosActivos(): Promise<
  Array<{ id: string; codigo: string | null; nombre: string; monto: string }>
> {
  const tipoEnvio = await getTipoEnvioId();
  if (!tipoEnvio) return [];
  const productos = await prisma.producto.findMany({
    where: { tipoProductoId: tipoEnvio, activo: true },
    orderBy: { nombre: 'asc' },
    select: { id: true, codigo: true, nombre: true, precioBase: true },
  });
  return productos.map((p) => ({
    id: p.id,
    codigo: p.codigo,
    nombre: p.nombre,
    monto: p.precioBase.toString(),
  }));
}
