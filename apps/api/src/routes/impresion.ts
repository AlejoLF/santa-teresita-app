import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { EstadoTrabajoImpresion, RolUsuario } from '@sta/db';
import { recordAudit } from '../services/audit.js';
import { encolarTrabajoTest, getConfigImpresion } from '../services/impresion.js';

/**
 * Endpoints de la cola de impresión.
 *
 * Flujo:
 *   1. La API encola trabajos (`TrabajoImpresion`) cuando se crea/anula una venta.
 *   2. El local-agent polea cada N seg `GET /impresion/pendientes` para retirar
 *      trabajos PENDIENTE → EN_PROCESO atómicamente.
 *   3. El agent imprime y reporta vía `POST /impresion/:id/estado`
 *      (IMPRESO o ERROR + mensaje).
 *   4. Si ERROR y `intentos < maxIntentos`, vuelve a PENDIENTE para retry.
 *
 * Auth: el agent usa el mismo cookie/token de auth que el resto. Para deploy
 * VPS habrá que generar un AGENT_TOKEN dedicado, pero en el desktop local
 * (mismo proceso) basta con la auth normal de admin.
 */
export default async function impresionRoutes(fastify: FastifyInstance) {
  // GET /impresion/pendientes
  // Retorna trabajos PENDIENTE y los marca como EN_PROCESO atómicamente.
  // Si el agent crashea entre EN_PROCESO y reportar, un job de timeout
  // (ver más abajo) los devuelve a PENDIENTE.
  fastify.get(
    '/impresion/pendientes',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(10),
        }),
      },
    },
    async (req) => {
      const q = req.query as { limit: number };
      // Trabajos pendientes ordenados por fecha de encolado (FIFO).
      // Update masivo + return en una sola query usando $queryRaw para que
      // dos agents corriendo en paralelo no agarren el mismo job.
      const pendientes = await prisma.$transaction(async (tx) => {
        const ids = await tx.trabajoImpresion.findMany({
          where: { estado: EstadoTrabajoImpresion.PENDIENTE },
          orderBy: { encoladoAt: 'asc' },
          take: q.limit,
          select: { id: true },
        });
        if (ids.length === 0) return [];
        const idList = ids.map((x) => x.id);
        await tx.trabajoImpresion.updateMany({
          where: { id: { in: idList } },
          data: { estado: EstadoTrabajoImpresion.EN_PROCESO, procesadoAt: new Date() },
        });
        return tx.trabajoImpresion.findMany({
          where: { id: { in: idList } },
          orderBy: { encoladoAt: 'asc' },
        });
      });

      return pendientes.map((t) => ({
        id: t.id,
        tipo: t.tipo,
        destino: t.destino,
        payload: t.payload,
        intentos: t.intentos,
      }));
    },
  );

  // POST /impresion/:id/estado
  // El agent reporta resultado: IMPRESO (ok) o ERROR (con mensaje).
  // Si ERROR e `intentos < MAX`, vuelve a PENDIENTE para retry.
  // Si ERROR y se agotaron los intentos, queda en ERROR permanente.
  const MAX_INTENTOS = 5;

  fastify.post(
    '/impresion/:id/estado',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          estado: z.enum(['IMPRESO', 'ERROR']),
          error: z.string().max(500).optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { estado: 'IMPRESO' | 'ERROR'; error?: string };

      const trabajo = await prisma.trabajoImpresion.findUnique({
        where: { id: params.id },
      });
      if (!trabajo) return reply.code(404).send({ error: 'Trabajo no encontrado' });

      if (body.estado === 'IMPRESO') {
        await prisma.trabajoImpresion.update({
          where: { id: params.id },
          data: {
            estado: EstadoTrabajoImpresion.IMPRESO,
            impresoAt: new Date(),
            ultimoError: null,
          },
        });
        return { ok: true };
      }

      // ERROR: incrementar intentos, decidir si retry o final
      const nuevoIntentos = trabajo.intentos + 1;
      const final = nuevoIntentos >= MAX_INTENTOS;
      await prisma.trabajoImpresion.update({
        where: { id: params.id },
        data: {
          estado: final ? EstadoTrabajoImpresion.ERROR : EstadoTrabajoImpresion.PENDIENTE,
          intentos: nuevoIntentos,
          ultimoError: body.error ?? 'Error sin mensaje',
        },
      });
      return { ok: true, retried: !final, intentos: nuevoIntentos };
    },
  );

  // GET /admin/impresion/jobs — listado para que el admin vea el estado de la cola
  fastify.get(
    '/admin/impresion/jobs',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          estado: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query as { estado?: string; limit: number };
      const where = q.estado
        ? { estado: q.estado as EstadoTrabajoImpresion }
        : {};
      const jobs = await prisma.trabajoImpresion.findMany({
        where,
        orderBy: { encoladoAt: 'desc' },
        take: q.limit,
      });
      // KPIs rápidos
      const counts = await prisma.trabajoImpresion.groupBy({
        by: ['estado'],
        _count: { _all: true },
        where: { encoladoAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      });
      return {
        jobs,
        counts: Object.fromEntries(counts.map((c) => [c.estado, c._count._all])),
      };
    },
  );

  // POST /admin/impresion/test — encola un trabajo TEST para una impresora puntual
  fastify.post(
    '/admin/impresion/test',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          destino: z.enum(['MOSTRADOR', 'DELIVERY', 'COCINA']),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as { destino: 'MOSTRADOR' | 'DELIVERY' | 'COCINA' };
      const trabajo = await encolarTrabajoTest(body.destino);
      await recordAudit({
        tabla: 'trabajos_impresion',
        registroId: trabajo.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { tipo: 'TEST', destino: body.destino },
      });
      return reply.code(201).send({ trabajoId: trabajo.id });
    },
  );

  // POST /admin/impresion/:id/reintentar — re-encola un trabajo en estado ERROR
  fastify.post(
    '/admin/impresion/:id/reintentar',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const trabajo = await prisma.trabajoImpresion.findUnique({
        where: { id: params.id },
      });
      if (!trabajo) return reply.code(404).send({ error: 'Trabajo no encontrado' });
      if (trabajo.estado !== EstadoTrabajoImpresion.ERROR) {
        return reply.code(400).send({ error: 'Solo se pueden reintentar trabajos en ERROR' });
      }
      await prisma.trabajoImpresion.update({
        where: { id: params.id },
        data: {
          estado: EstadoTrabajoImpresion.PENDIENTE,
          intentos: 0,
          ultimoError: null,
        },
      });
      return { ok: true };
    },
  );

  // GET /admin/impresion/config — devuelve la config actual de impresoras
  fastify.get(
    '/admin/impresion/config',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      return getConfigImpresion();
    },
  );

  // PUT /admin/impresion/config — actualiza config de impresoras
  fastify.put(
    '/admin/impresion/config',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          MOSTRADOR: z
            .object({
              host: z.string().min(1).max(80),
              port: z.coerce.number().int().min(1).max(65535).default(9100),
              width: z.coerce.number().int().min(20).max(80).default(42),
              activa: z.boolean().default(true),
            })
            .optional(),
          DELIVERY: z
            .object({
              host: z.string().min(1).max(80),
              port: z.coerce.number().int().min(1).max(65535).default(9100),
              width: z.coerce.number().int().min(20).max(80).default(42),
              activa: z.boolean().default(true),
            })
            .optional(),
          COCINA: z
            .object({
              host: z.string().min(1).max(80),
              port: z.coerce.number().int().min(1).max(65535).default(9100),
              width: z.coerce.number().int().min(20).max(80).default(42),
              activa: z.boolean().default(true),
            })
            .optional(),
        }),
      },
    },
    async (req) => {
      const body = req.body as Record<string, unknown>;
      // Persistimos cada destino como su propio item de configuración_sistema
      // bajo la categoría 'impresoras' para que sea fácil leer/editar.
      const updates: Array<{ destino: string; config: unknown }> = [];
      for (const destino of ['MOSTRADOR', 'DELIVERY', 'COCINA'] as const) {
        if (body[destino]) {
          await prisma.configuracionSistema.upsert({
            where: { clave: `impresora_${destino.toLowerCase()}` },
            create: {
              clave: `impresora_${destino.toLowerCase()}`,
              valor: JSON.stringify(body[destino]),
              tipo: 'json',
              categoria: 'impresoras',
              descripcion: `Configuración de impresora ${destino}`,
              actualizadoPor: req.usuario!.nombre,
            },
            update: {
              valor: JSON.stringify(body[destino]),
              actualizadoPor: req.usuario!.nombre,
            },
          });
          updates.push({ destino, config: body[destino] });
        }
      }
      await recordAudit({
        tabla: 'configuracion_sistema',
        registroId: 'impresoras',
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorNuevo: { updates },
      });
      return { ok: true, updates };
    },
  );
}
