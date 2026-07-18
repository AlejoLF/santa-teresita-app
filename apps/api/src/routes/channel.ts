import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { config } from '../config.js';
import { FueraDeHorarioError } from '../services/sesion-caja.js';
import {
  crearVentaCanal,
  MapeoIncompletoError,
  type OrdenCanal,
} from '../services/venta-canal.js';

/**
 * Ingesta de ÓRDENES de canal (integradores RAPPI / Pedidos YA / Mercado Libre).
 * Auth: Bearer = CHANNEL_INGEST_TOKEN (token de máquina, NO una sesión de
 * usuario). Distinto del token de facturas → blast radius separado.
 *
 * El contrato del body es NORMALIZADO (platform-neutral): cada integrador
 * traduce el payload de su plataforma a este shape. El SKU de cada item es
 * `Producto.codigo`. Ver services/venta-canal.ts.
 */

const ModificadorSchema = z.object({
  grupoId: z.string(),
  grupoNombre: z.string(),
  opcionId: z.string(),
  opcionNombre: z.string(),
  deltaPrecio: z.string(),
});

const OrdenCanalSchema = z.object({
  canal: z.enum(['RAPPI', 'PEDIDOS_YA', 'MERCADO_LIBRE']),
  idExternoCanal: z.string().min(1).max(120),
  modalidad: z.enum(['DELIVERY_PLATAFORMA', 'TAKE_AWAY']).optional(),
  items: z
    .array(
      z.object({
        codigo: z.string().min(1).max(40),
        cantidad: z.number().positive(),
        observacion: z.string().max(500).optional(),
        modificadores: z.array(ModificadorSchema).optional(),
      }),
    )
    .min(1),
  cliente: z
    .object({
      nombre: z.string().max(120).optional(),
      telefono: z.string().max(40).optional(),
    })
    .optional(),
  entrega: z
    .object({
      direccion: z.string().max(300).optional(),
      indicaciones: z.string().max(300).optional(),
    })
    .optional(),
  observaciones: z.string().max(500).optional(),
  // Payload crudo de la plataforma — se persiste en Venta.payloadExterno.
  payloadExterno: z.unknown().optional(),
});

/** Compara el Bearer con CHANNEL_INGEST_TOKEN en tiempo constante. */
function tokenOk(req: FastifyRequest): boolean {
  const expected = config.CHANNEL_INGEST_TOKEN;
  if (!expected) return false;
  const got = req.headers['authorization']?.replace(/^Bearer\s+/i, '') ?? '';
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export default async function channelRoutes(fastify: FastifyInstance) {
  // POST /channel/orders — crea (y auto-finaliza) una venta de plataforma.
  fastify.post(
    '/channel/orders',
    { schema: { body: OrdenCanalSchema } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!config.CHANNEL_INGEST_TOKEN) {
        return reply
          .code(503)
          .send({ error: 'Ingesta de canal deshabilitada (falta CHANNEL_INGEST_TOKEN)' });
      }
      if (!tokenOk(req)) {
        return reply.code(401).send({ error: 'Token de ingesta de canal inválido' });
      }
      const orden = req.body as OrdenCanal;
      try {
        const { venta, duplicate } = await crearVentaCanal(orden);
        return reply.code(duplicate ? 200 : 201).send({
          id: venta.id,
          numero: venta.numero,
          estado: venta.estado,
          duplicate,
        });
      } catch (e) {
        if (e instanceof MapeoIncompletoError) {
          return reply
            .code(422)
            .send({ error: 'SKUs sin mapear en el catálogo', skusFaltantes: e.skusFaltantes });
        }
        if (e instanceof FueraDeHorarioError) {
          return reply.code(423).send({
            error: 'Fuera del horario de atención configurado',
            codigo: 'FUERA_DE_HORARIO',
            resolucion: e.resolucion,
          });
        }
        throw e;
      }
    },
  );

  // GET /channel/products/:codigo — sonda de alcance (reachability) que usa el
  // integrador para verificar que el POS responde y que el SKU está mapeado.
  fastify.get(
    '/channel/products/:codigo',
    { schema: { params: z.object({ codigo: z.string().min(1).max(40) }) } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!config.CHANNEL_INGEST_TOKEN) {
        return reply.code(503).send({ error: 'Ingesta de canal deshabilitada' });
      }
      if (!tokenOk(req)) {
        return reply.code(401).send({ error: 'Token de ingesta de canal inválido' });
      }
      const { codigo } = req.params as { codigo: string };
      const p = await prisma.producto.findFirst({
        where: { codigo },
        select: { codigo: true, nombre: true, precioBase: true, activo: true },
      });
      if (!p) return reply.code(404).send({ error: 'Producto no encontrado' });
      return reply.send({
        sku: p.codigo,
        name: p.nombre,
        price: Number(p.precioBase),
        enabled: p.activo,
      });
    },
  );
}
