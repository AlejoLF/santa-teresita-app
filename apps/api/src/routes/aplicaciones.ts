import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { Prisma } from '@sta/db';
import { getRappiConfig } from '../services/rappi/config.js';
import { RappiApagadoError, RappiError } from '../services/rappi/cliente.js';
import { CANCEL_TYPES, listaParaRetiro, rechazarOrden, tomarOrden, type CancelType } from '../services/rappi/ordenes.js';
import { CANALES_PLATAFORMA, USUARIO_CANALES_ID } from '../services/venta-canal.js';
import { ReglaNegocioError } from '../services/errores.js';

/**
 * La pestaña APLICACIONES del POS: los pedidos que entran por las apps
 * (RAPPI hoy; PedidosYa y MELI cuando se conecten), para el personal del
 * mostrador — no sólo para el admin. Cada pedido se muestra con los DOS
 * números: el id de la plataforma (para buscarlo en su portal) y el número de
 * orden nuestro (para buscarlo en el POS), más todo lo que la plataforma
 * mandó (cliente, dirección, cómo pagó, tiempo de cocina…), que vive en
 * `Venta.payloadExterno`.
 *
 * Las acciones (tomar / listo / rechazar) son las mismas que en el panel de
 * Integraciones, con el mismo servicio; acá las puede hacer cualquier usuario
 * logueado porque son parte de atender el mostrador.
 */

const ESTADO_PLATAFORMA = ['SIN_RESPUESTA', 'TOMADA', 'RECHAZADA', 'LISTA'] as const;
type EstadoPlataforma = (typeof ESTADO_PLATAFORMA)[number];

interface ExtrasRappi {
  metodoEntrega?: string;
  medioPago?: string;
  tiempoCocinaMin?: number;
  creadoEnRappi?: string;
  agendadoPara?: string | null;
  totalRappi?: number;
  totalAPagar?: number;
  envio?: number;
  propina?: number;
  cliente?: { nombre?: string; telefono?: string; email?: string };
  entrega?: Record<string, string | number | boolean>;
}

/** Lo útil del cuerpo crudo de RAPPI, aplanado para la pantalla. */
function extrasDeRappi(payload: unknown): ExtrasRappi | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as {
    order_detail?: Record<string, unknown>;
    customer?: { first_name?: string; last_name?: string; phone_number?: string; email?: string } | null;
  };
  const od = p.order_detail ?? {};
  const totals = (od.totals ?? {}) as Record<string, unknown>;
  const charges = (totals.charges ?? {}) as Record<string, unknown>;
  const otros = (totals.other_totals ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const entrega: Record<string, string | number | boolean> = {};
  const di = od.delivery_information;
  if (di && typeof di === 'object') {
    for (const [k, v] of Object.entries(di as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) entrega[k] = v.trim().slice(0, 300);
      else if (typeof v === 'number' || typeof v === 'boolean') entrega[k] = v;
    }
  }
  const nombre = [p.customer?.first_name, p.customer?.last_name].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
  return {
    metodoEntrega: str(od.delivery_method),
    medioPago: str(od.payment_method),
    tiempoCocinaMin: num(od.cooking_time),
    creadoEnRappi: str(od.created_at),
    agendadoPara: str(od.place_at) ?? null,
    totalRappi: num(totals.total_order),
    totalAPagar: num(totals.total_to_pay),
    envio: num(charges.shipping),
    propina: num(otros.tip),
    ...((nombre || p.customer?.phone_number || p.customer?.email) && {
      cliente: { ...(nombre && { nombre }), ...(str(p.customer?.phone_number) && { telefono: str(p.customer?.phone_number) }), ...(str(p.customer?.email) && { email: str(p.customer?.email) }) },
    }),
    ...(Object.keys(entrega).length && { entrega }),
  };
}

export default async function aplicacionesRoutes(fastify: FastifyInstance) {
  const logueado = { preHandler: fastify.requireAuth() };

  fastify.setErrorHandler((err, req, reply) => {
    if (err instanceof RappiApagadoError) return reply.code(503).send({ error: err.message, codigo: 'RAPPI_APAGADO' });
    if (err instanceof RappiError) return reply.code(502).send({ error: err.message, status: err.status, cuerpo: err.cuerpo ?? null });
    throw err;
  });

  /** La tabla del registro puede no existir todavía (Cloud Migrate sin correr). */
  async function conRegistro<T>(fn: () => Promise<T>, vacio: T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') return vacio;
      throw e;
    }
  }

  // GET /aplicaciones/pedidos — los pedidos de plataforma, lo último primero.
  fastify.get(
    '/aplicaciones/pedidos',
    {
      ...logueado,
      schema: {
        querystring: z.object({
          limite: z.coerce.number().int().min(1).max(100).default(40),
          /** 'activos' = de las últimas 24 h y no anulados; 'todos' = los últimos N. */
          vista: z.enum(['activos', 'todos']).default('activos'),
        }),
      },
    },
    async (req) => {
      const { limite, vista } = req.query as { limite: number; vista: 'activos' | 'todos' };
      const ventas = await prisma.venta.findMany({
        where: {
          canal: { in: [...CANALES_PLATAFORMA] },
          idExternoCanal: { not: null },
          usuarioAperturaId: USUARIO_CANALES_ID,
          ...(vista === 'activos' && { fechaApertura: { gte: new Date(Date.now() - 24 * 3_600_000) } }),
        },
        orderBy: { fechaApertura: 'desc' },
        take: limite,
        select: {
          id: true, numero: true, numeroOrdenTurno: true, canal: true, modalidad: true, estado: true,
          total: true, fechaApertura: true, fechaAnulacion: true, motivoAnulacion: true, idExternoCanal: true,
          observaciones: true, payloadExterno: true, tieneCocina: true, comandaImpresa: true,
          cliente: { select: { id: true, nombre: true, apellido: true, telefono: true } },
          deliveryInfo: { select: { direccionSnapshot: true, estado: true } },
          items: {
            orderBy: { orden: 'asc' },
            select: { id: true, nombreSnapshot: true, cantidad: true, unidad: true, precioUnitario: true, totalLinea: true, observacion: true, modificadoresAplicados: true },
          },
        },
      });
      const llamadas = await conRegistro(
        () =>
          prisma.llamadaCanal.findMany({
            where: { ok: true, ventaId: { in: ventas.map((v) => v.id) } },
            select: { ventaId: true, contexto: true },
            orderBy: { hechoAt: 'asc' },
          }),
        [] as Array<{ ventaId: string | null; contexto: string | null }>,
      );
      const estadoPlataforma = new Map<string, EstadoPlataforma>();
      for (const l of llamadas) {
        if (!l.ventaId) continue;
        if (l.contexto?.startsWith('tomar')) estadoPlataforma.set(l.ventaId, 'TOMADA');
        else if (l.contexto?.startsWith('rechazar')) estadoPlataforma.set(l.ventaId, 'RECHAZADA');
        else if (l.contexto?.includes('lista para retiro')) estadoPlataforma.set(l.ventaId, 'LISTA');
      }
      const cfg = await getRappiConfig();
      return {
        tomarAutomatico: cfg.tomarAutomatico,
        pedidos: ventas.map((v) => {
          const snap = (v.deliveryInfo?.direccionSnapshot ?? null) as { direccion?: string | null; indicaciones?: string | null; clienteNombre?: string | null; clienteTelefono?: string | null } | null;
          const extras = v.canal === 'RAPPI' ? extrasDeRappi(v.payloadExterno) : null;
          return {
            id: v.id,
            numero: v.numero,
            numeroOrdenTurno: v.numeroOrdenTurno,
            canal: v.canal,
            idPlataforma: v.idExternoCanal,
            modalidad: v.modalidad,
            estado: v.estado,
            enPlataforma: estadoPlataforma.get(v.id) ?? 'SIN_RESPUESTA',
            total: v.total.toFixed(2),
            fechaApertura: v.fechaApertura,
            fechaAnulacion: v.fechaAnulacion,
            motivoAnulacion: v.motivoAnulacion,
            observaciones: v.observaciones,
            tieneCocina: v.tieneCocina,
            comandaImpresa: v.comandaImpresa,
            cliente: v.cliente
              ? { id: v.cliente.id, nombre: [v.cliente.nombre, v.cliente.apellido].filter(Boolean).join(' '), telefono: v.cliente.telefono }
              : snap?.clienteNombre
                ? { id: null, nombre: snap.clienteNombre, telefono: snap.clienteTelefono ?? null }
                : extras?.cliente
                  ? { id: null, nombre: extras.cliente.nombre ?? null, telefono: extras.cliente.telefono ?? null }
                  : null,
            entrega: snap?.direccion || snap?.indicaciones
              ? { direccion: snap.direccion ?? null, indicaciones: snap.indicaciones ?? null, estado: v.deliveryInfo?.estado ?? null }
              : null,
            items: v.items.map((i) => ({
              id: i.id,
              nombre: i.nombreSnapshot,
              cantidad: i.cantidad.toString(),
              unidad: i.unidad,
              precioUnitario: i.precioUnitario.toFixed(2),
              total: i.totalLinea.toFixed(2),
              observacion: i.observacion,
              modificadores: Array.isArray(i.modificadoresAplicados)
                ? (i.modificadoresAplicados as Array<{ grupoNombre?: string; opcionNombre?: string }>).map((m) => ({ grupo: m.grupoNombre ?? '', opcion: m.opcionNombre ?? '' }))
                : [],
            })),
            extras,
          };
        }),
      };
    },
  );

  async function pedidoRappi(ventaId: string) {
    const v = await prisma.venta.findUnique({ where: { id: ventaId }, select: { id: true, canal: true, idExternoCanal: true, estado: true } });
    if (!v || !v.idExternoCanal) throw new ReglaNegocioError('Ese pedido no es de una plataforma.');
    if (v.canal !== 'RAPPI') throw new ReglaNegocioError(`Las acciones sobre pedidos de ${v.canal} todavía no están conectadas.`);
    return v;
  }

  fastify.post(
    '/aplicaciones/pedidos/:ventaId/tomar',
    { ...logueado, schema: { params: z.object({ ventaId: z.string().uuid() }) } },
    async (req) => {
      const v = await pedidoRappi((req.params as { ventaId: string }).ventaId);
      const cfg = await getRappiConfig();
      return tomarOrden(v.idExternoCanal!, { tiempoCocinaMin: cfg.tiempoCocinaMin, ventaId: v.id, usuarioId: req.usuario!.id });
    },
  );

  fastify.post(
    '/aplicaciones/pedidos/:ventaId/lista',
    { ...logueado, schema: { params: z.object({ ventaId: z.string().uuid() }) } },
    async (req) => {
      const v = await pedidoRappi((req.params as { ventaId: string }).ventaId);
      const cfg = await getRappiConfig();
      return listaParaRetiro(v.idExternoCanal!, { ventaId: v.id, usuarioId: req.usuario!.id, storeId: cfg.storeId ?? null });
    },
  );

  fastify.post(
    '/aplicaciones/pedidos/:ventaId/rechazar',
    {
      ...logueado,
      schema: {
        params: z.object({ ventaId: z.string().uuid() }),
        body: z.object({
          cancelType: z.enum(CANCEL_TYPES),
          reason: z.string().min(1).max(300),
          itemsSkus: z.array(z.string()).optional(),
        }),
      },
    },
    async (req) => {
      const v = await pedidoRappi((req.params as { ventaId: string }).ventaId);
      const body = req.body as { cancelType: CancelType; reason: string; itemsSkus?: string[] };
      return rechazarOrden(v.idExternoCanal!, { ...body, ventaId: v.id, usuarioId: req.usuario!.id });
    },
  );
}
