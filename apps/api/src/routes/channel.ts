import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { config } from '../config.js';
import { FueraDeHorarioError } from '../services/sesion-caja.js';
import {
  crearVentaCanal,
  simularOrdenCanal,
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

  // POST /channel/orders/dry-run — MODO DE PRUEBA. Mismo body y mismo token que
  // /channel/orders, pero NO escribe nada: ni venta, ni sesión de caja, ni pago,
  // ni comanda impresa. Devuelve el diagnóstico de lo que pasaría en vivo.
  //
  // Es el pre-flight del integrador: con esto se valida el mapeo del menú y el
  // shape del payload sin ensuciar el cierre de caja ni imprimir papel en la
  // cocina. Siempre 200 — el veredicto está en `ok` y `problemas`, porque un
  // dry-run que "falla" no es un error HTTP: es información.
  fastify.post(
    '/channel/orders/dry-run',
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
      const diagnostico = await simularOrdenCanal(req.body as OrdenCanal);
      return reply.send({ dryRun: true, ...diagnostico });
    },
  );

  // GET /channel/products — catálogo publicable, para que el integrador arme el
  // menú de la plataforma (RAPPI/PYA/MELI publican el menú: no lo bajan de ahí).
  //
  // El SKU de la plataforma ES `Producto.codigo`, así que un producto SIN código
  // no se puede publicar NI se puede matchear cuando entra un pedido (daría 422).
  // Por eso la respuesta separa `productos` (publicables) de `sinCodigo`, y el
  // resumen sirve de diagnóstico antes de conectar en vivo.
  //
  // Sólo lectura. Mismo token que el resto del módulo de canal.
  fastify.get(
    '/channel/products',
    {
      schema: {
        querystring: z.object({
          // Por defecto sólo los activos: es lo que se publica. `todos=1`
          // incluye los inactivos para auditar el catálogo completo.
          todos: z.enum(['0', '1']).optional(),
        }),
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!config.CHANNEL_INGEST_TOKEN) {
        return reply.code(503).send({ error: 'Ingesta de canal deshabilitada' });
      }
      if (!tokenOk(req)) {
        return reply.code(401).send({ error: 'Token de ingesta de canal inválido' });
      }
      const { todos } = req.query as { todos?: '0' | '1' };
      const filas = await prisma.producto.findMany({
        where: todos === '1' ? {} : { activo: true },
        select: {
          codigo: true,
          nombre: true,
          descripcion: true,
          precioBase: true,
          activo: true,
          tipoProducto: {
            select: { nombre: true, categoria: { select: { nombre: true } } },
          },
        },
        orderBy: { nombre: 'asc' },
      });

      const productos = filas
        .filter((p) => p.codigo)
        .map((p) => ({
          sku: p.codigo as string,
          name: p.nombre,
          description: p.descripcion ?? null,
          price: Number(p.precioBase),
          enabled: p.activo,
          category: p.tipoProducto?.categoria?.nombre ?? null,
          subcategory: p.tipoProducto?.nombre ?? null,
        }));
      // Sin código no hay SKU posible: los devolvemos aparte para que el
      // operador sepa qué cargar antes de publicar, en vez de descubrirlo
      // cuando una orden real rebote.
      const sinCodigo = filas.filter((p) => !p.codigo).map((p) => p.nombre);

      return reply.send({
        resumen: {
          total: filas.length,
          publicables: productos.length,
          sinCodigo: sinCodigo.length,
        },
        productos,
        sinCodigo,
      });
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
