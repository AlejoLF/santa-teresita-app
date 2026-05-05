import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { RolUsuario, EstadoVenta } from '@sta/db';
import { recordAudit } from '../services/audit.js';

/**
 * CRUD de clientes y direcciones.
 * Vendedor también puede crear clientes en contexto de venta — por eso varios endpoints
 * permiten ambos roles.
 */
export default async function clientesRoutes(fastify: FastifyInstance) {
  // GET /admin/clientes — lista con stats
  fastify.get(
    '/admin/clientes',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          q: z.string().optional(),
          tipo: z.enum(['CASUAL', 'REGISTRADO', 'CORPORATIVO', 'PLATAFORMA']).optional(),
          incluirInactivos: z.coerce.boolean().default(false),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query as {
        q?: string;
        tipo?: 'CASUAL' | 'REGISTRADO' | 'CORPORATIVO' | 'PLATAFORMA';
        incluirInactivos: boolean;
        page: number;
        pageSize: number;
      };
      const where = {
        ...(q.q && {
          OR: [
            { nombre: { contains: q.q, mode: 'insensitive' as const } },
            { apellido: { contains: q.q, mode: 'insensitive' as const } },
            { telefono: { contains: q.q } },
            { cuitCuil: { contains: q.q } },
          ],
        }),
        ...(q.tipo && { tipo: q.tipo }),
        ...(q.incluirInactivos ? {} : { activo: true }),
      };

      const [clientes, total] = await Promise.all([
        prisma.cliente.findMany({
          where,
          include: {
            _count: { select: { direcciones: true, ventas: true } },
          },
          orderBy: [{ tipo: 'asc' }, { nombre: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        prisma.cliente.count({ where }),
      ]);

      // Stats: total comprado por cliente (ventas finalizadas)
      const stats = await prisma.venta.groupBy({
        by: ['clienteId'],
        _sum: { total: true },
        _count: { _all: true },
        where: {
          estado: EstadoVenta.FINALIZADA,
          clienteId: { in: clientes.map((c) => c.id) },
        },
      });
      const statsMap = new Map(
        stats.map((s) => [s.clienteId, { total: Number(s._sum.total ?? 0), ventas: s._count._all }]),
      );

      return {
        clientes: clientes.map((c) => ({
          ...c,
          totalComprado: (statsMap.get(c.id)?.total ?? 0).toFixed(2),
          ventasFinalizadas: statsMap.get(c.id)?.ventas ?? 0,
        })),
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
    },
  );

  // GET /admin/clientes/:id — detalle con direcciones + historial de ventas
  fastify.get(
    '/admin/clientes/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const cliente = await prisma.cliente.findUnique({
        where: { id: params.id },
        include: {
          direcciones: { orderBy: [{ esDefault: 'desc' }, { etiqueta: 'asc' }] },
        },
      });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

      const ventas = await prisma.venta.findMany({
        where: { clienteId: params.id },
        select: {
          id: true,
          numero: true,
          numeroOrdenTurno: true,
          canal: true,
          modalidad: true,
          estado: true,
          total: true,
          fechaApertura: true,
          fechaFinalizacion: true,
        },
        orderBy: { fechaApertura: 'desc' },
        take: 50,
      });

      // Stats
      const finalizadas = ventas.filter((v) => v.estado === EstadoVenta.FINALIZADA);
      const totalComprado = finalizadas.reduce((acc, v) => acc + Number(v.total), 0);
      const ticketPromedio = finalizadas.length > 0 ? totalComprado / finalizadas.length : 0;

      return {
        cliente,
        ventas,
        stats: {
          totalComprado: totalComprado.toFixed(2),
          ventasFinalizadas: finalizadas.length,
          ticketPromedio: ticketPromedio.toFixed(2),
          ultimaVenta: finalizadas[0]?.fechaFinalizacion ?? null,
        },
      };
    },
  );

  // POST /admin/clientes — crear cliente (admin o vendedor)
  fastify.post(
    '/admin/clientes',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        body: z.object({
          tipo: z.enum(['CASUAL', 'REGISTRADO', 'CORPORATIVO', 'PLATAFORMA']).default('REGISTRADO'),
          nombre: z.string().min(1).max(120),
          apellido: z.string().max(120).optional(),
          telefono: z.string().max(40).optional(),
          email: z.string().email().optional(),
          cuitCuil: z.string().max(20).optional(),
          fechaNacimiento: z.string().optional(),
          observaciones: z.string().max(500).optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        tipo: 'CASUAL' | 'REGISTRADO' | 'CORPORATIVO' | 'PLATAFORMA';
        nombre: string;
        apellido?: string;
        telefono?: string;
        email?: string;
        cuitCuil?: string;
        fechaNacimiento?: string;
        observaciones?: string;
      };
      const created = await prisma.cliente.create({
        data: {
          tipo: body.tipo,
          nombre: body.nombre,
          apellido: body.apellido ?? null,
          telefono: body.telefono ?? null,
          email: body.email ?? null,
          cuitCuil: body.cuitCuil ?? null,
          fechaNacimiento: body.fechaNacimiento ? new Date(body.fechaNacimiento) : null,
          observaciones: body.observaciones ?? null,
        },
      });
      await recordAudit({
        tabla: 'clientes',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: created.nombre, telefono: created.telefono, tipo: created.tipo },
      });
      return reply.code(201).send(created);
    },
  );

  // PATCH /admin/clientes/:id
  fastify.patch(
    '/admin/clientes/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          tipo: z.enum(['CASUAL', 'REGISTRADO', 'CORPORATIVO', 'PLATAFORMA']).optional(),
          nombre: z.string().min(1).max(120).optional(),
          apellido: z.string().max(120).nullable().optional(),
          telefono: z.string().max(40).nullable().optional(),
          email: z.string().email().nullable().optional(),
          cuitCuil: z.string().max(20).nullable().optional(),
          fechaNacimiento: z.string().nullable().optional(),
          observaciones: z.string().max(500).nullable().optional(),
          activo: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      const before = await prisma.cliente.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Cliente no encontrado' });

      const data: Record<string, unknown> = { ...body };
      if (body.fechaNacimiento && typeof body.fechaNacimiento === 'string') {
        data.fechaNacimiento = new Date(body.fechaNacimiento);
      }

      const updated = await prisma.cliente.update({
        where: { id: params.id },
        data,
      });
      await recordAudit({
        tabla: 'clientes',
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
  //   DIRECCIONES
  // ──────────────────────────────────────────────────────────────────────

  // POST /admin/clientes/:id/direcciones
  fastify.post(
    '/admin/clientes/:id/direcciones',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          etiqueta: z.string().min(1).max(40).default('Casa'),
          calle: z.string().min(1).max(120),
          numero: z.string().min(1).max(20),
          piso: z.string().max(10).optional(),
          depto: z.string().max(10).optional(),
          entreCalles: z.string().max(160).optional(),
          localidad: z.string().max(80).default('La Plata'),
          codigoPostal: z.string().max(20).optional(),
          indicaciones: z.string().max(500).optional(),
          esDefault: z.boolean().default(false),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as {
        etiqueta: string;
        calle: string;
        numero: string;
        piso?: string;
        depto?: string;
        entreCalles?: string;
        localidad: string;
        codigoPostal?: string;
        indicaciones?: string;
        esDefault: boolean;
      };

      const created = await prisma.$transaction(async (tx) => {
        // Si la nueva es default, desmarcar las otras
        if (body.esDefault) {
          await tx.direccion.updateMany({
            where: { clienteId: params.id, esDefault: true },
            data: { esDefault: false },
          });
        }
        return tx.direccion.create({
          data: {
            clienteId: params.id,
            etiqueta: body.etiqueta,
            calle: body.calle,
            numero: body.numero,
            piso: body.piso ?? null,
            depto: body.depto ?? null,
            entreCalles: body.entreCalles ?? null,
            localidad: body.localidad,
            codigoPostal: body.codigoPostal ?? null,
            indicaciones: body.indicaciones ?? null,
            esDefault: body.esDefault,
          },
        });
      });
      await recordAudit({
        tabla: 'direcciones',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        contexto: { clienteId: params.id, etiqueta: created.etiqueta },
      });
      return reply.code(201).send(created);
    },
  );

  // PATCH /admin/clientes/:id/direcciones/:direccionId
  fastify.patch(
    '/admin/clientes/:id/direcciones/:direccionId',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({
          id: z.string().uuid(),
          direccionId: z.string().uuid(),
        }),
        body: z.object({
          etiqueta: z.string().min(1).max(40).optional(),
          calle: z.string().min(1).max(120).optional(),
          numero: z.string().min(1).max(20).optional(),
          piso: z.string().max(10).nullable().optional(),
          depto: z.string().max(10).nullable().optional(),
          entreCalles: z.string().max(160).nullable().optional(),
          localidad: z.string().max(80).optional(),
          codigoPostal: z.string().max(20).nullable().optional(),
          indicaciones: z.string().max(500).nullable().optional(),
          esDefault: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string; direccionId: string };
      const body = req.body as Record<string, unknown>;
      const updated = await prisma.$transaction(async (tx) => {
        if (body.esDefault === true) {
          await tx.direccion.updateMany({
            where: { clienteId: params.id, esDefault: true, id: { not: params.direccionId } },
            data: { esDefault: false },
          });
        }
        return tx.direccion.update({
          where: { id: params.direccionId },
          data: body,
        });
      });
      await recordAudit({
        tabla: 'direcciones',
        registroId: params.direccionId,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        contexto: { clienteId: params.id },
      });
      return updated;
    },
  );

  // DELETE /admin/clientes/:id/direcciones/:direccionId
  fastify.delete(
    '/admin/clientes/:id/direcciones/:direccionId',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({
          id: z.string().uuid(),
          direccionId: z.string().uuid(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string; direccionId: string };
      try {
        await prisma.direccion.delete({ where: { id: params.direccionId } });
      } catch {
        return reply.code(409).send({
          error:
            'No se puede eliminar la dirección — está referenciada en una venta o entrega histórica',
        });
      }
      await recordAudit({
        tabla: 'direcciones',
        registroId: params.direccionId,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        contexto: { clienteId: params.id },
      });
      return { ok: true };
    },
  );
}
