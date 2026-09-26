import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { RolUsuario, Prisma } from '@sta/db';
import { config } from '../config.js';
import {
  ambienteRappi,
  credencialesRappi,
  dominiosRappi,
  getRappiConfig,
  secretoWebhookRappi,
  setRappiConfig,
} from '../services/rappi/config.js';
import { probarCredenciales, RappiApagadoError, RappiError } from '../services/rappi/cliente.js';
import {
  enviarHorarios,
  estadoTiendas,
  listarTiendas,
  setTiendaHabilitada,
  setTiendaIntegrada,
} from '../services/rappi/tiendas.js';
import { armarMenuRappi, enviarMenu, estadoMenu, setDisponibilidad } from '../services/rappi/menu.js';
import {
  CANCEL_TYPES,
  listaParaRetiro,
  rechazarOrden,
  tomarOrden,
  type CancelType,
} from '../services/rappi/ordenes.js';
import {
  aprovisionarTienda,
  EVENTOS_WEBHOOK,
  suscribirWebhookIntegracion,
  ultimoPing,
  type EventoWebhook,
} from '../services/rappi/webhooks.js';
import { ReglaNegocioError } from '../services/errores.js';

/**
 * El panel de RAPPI: Admin → Configuración → Integraciones.
 *
 * Todo lo SALIENTE hacia RAPPI se dispara desde acá, con sesión de ADMIN. Cada
 * botón de la pantalla es un endpoint de éstos, y cada endpoint es una
 * capacidad del checklist de certificación (docs/RAPPI-INTEGRACION.md).
 *
 * Los errores de RAPPI no son 500 nuestros: se devuelven como 502 con el
 * detalle, para que la pantalla diga "RAPPI respondió X" y no "la base de
 * datos rechazó la operación".
 */

/** Las URLs por evento que hay que cargar en RAPPI, con el host con el que llegó el request. */
function urlsWebhook(req: { headers: Record<string, unknown> }): {
  base: string;
  esLocal: boolean;
  porEvento: Record<string, string> | null;
} {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
  const host = (req.headers['x-forwarded-host'] as string) ?? (req.headers.host as string) ?? '';
  const base = `${proto}://${host}/api/v1`;
  const esLocal = /^(127\.0\.0\.1|localhost|\[?::1\]?)(:|$)/.test(host);
  const token = config.CHANNEL_INGEST_TOKEN;
  if (!token) return { base, esLocal, porEvento: null };
  const raiz = `${base}/channel/webhook/rappi/${token}`;
  return {
    base,
    esLocal,
    porEvento: {
      NEW_ORDER: `${raiz}/new-order`,
      NEW_ORDER_SCHEDULED: `${raiz}/new-order`,
      NEW_ORDER_SCHEDULED_CANCELLED: `${raiz}/cancel`,
      ORDER_EVENT_CANCEL: `${raiz}/cancel`,
      PING: `${raiz}/ping`,
      MENU_APPROVED: `${raiz}/menu`,
      MENU_REJECTED: `${raiz}/menu`,
      STORE_CONNECTIVITY: `${raiz}/store`,
      STORE_PROVISIONING_STATUS: `${raiz}/provisioning`,
      ORDER_OTHER_EVENT: `${raiz}/other`,
      ORDER_RT_TRACKING: `${raiz}/other`,
    },
  };
}

export default async function rappiRoutes(fastify: FastifyInstance) {
  const admin = { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) };

  // Los errores contra RAPPI se traducen acá, una sola vez.
  fastify.setErrorHandler((err, req, reply) => {
    if (err instanceof RappiApagadoError) {
      return reply.code(503).send({ error: err.message, codigo: 'RAPPI_APAGADO' });
    }
    if (err instanceof RappiError) {
      return reply.code(502).send({ error: err.message, status: err.status, cuerpo: err.cuerpo ?? null });
    }
    // Lo demás sigue por el manejador global (códigos STA-*).
    throw err;
  });

  async function storeIdElegido(): Promise<string> {
    const cfg = await getRappiConfig();
    if (!cfg.storeId) throw new ReglaNegocioError('Primero elegí la tienda de RAPPI (botón "Listar tiendas").');
    return cfg.storeId;
  }

  // ── Estado general ─────────────────────────────────────────────────────
  fastify.get('/admin/rappi/estado', admin, async (req) => {
    const cfg = await getRappiConfig();
    const urls = urlsWebhook(req);
    const [totalProductos, sinCodigo, porPesoSinCantidad, ultimasLlamadas] = await Promise.all([
      prisma.producto.count({ where: { activo: true } }),
      prisma.producto.count({ where: { activo: true, OR: [{ codigo: null }, { codigo: '' }] } }),
      prisma.producto.count({
        where: {
          activo: true,
          unidadPrecio: { in: ['POR_KILO', 'POR_GRAMO'] },
          OR: [{ cantidadDefault: null }, { cantidadDefault: { lte: 0 } }],
        },
      }),
      conRegistro(() =>
        prisma.llamadaCanal.findMany({
          where: { plataforma: 'RAPPI' },
          orderBy: { hechoAt: 'desc' },
          take: 1,
          select: { hechoAt: true, ok: true, contexto: true, status: true },
        }),
      ),
    ]);
    return {
      ambiente: ambienteRappi(),
      dominios: dominiosRappi(),
      credencialesConfiguradas: Boolean(credencialesRappi()),
      firmaConfigurada: Boolean(secretoWebhookRappi()),
      ingestaConfigurada: Boolean(config.CHANNEL_INGEST_TOKEN),
      config: cfg,
      webhooks: { ...urls, ultimoPingAt: ultimoPing() },
      catalogo: { publicables: totalProductos - sinCodigo, sinCodigo, porPesoSinCantidad },
      ultimaLlamada: ultimasLlamadas[0]?.[0] ?? null,
      registroListo: ultimasLlamadas[1],
    };
  });

  fastify.put(
    '/admin/rappi/config',
    {
      ...admin,
      schema: {
        body: z.object({
          storeId: z.string().min(1).max(60).nullable().optional(),
          storeNombre: z.string().max(160).nullable().optional(),
          storeIntegrationId: z.string().max(60).nullable().optional(),
          clientIntegrationId: z.string().max(120).nullable().optional(),
          tomarAutomatico: z.boolean().optional(),
          tiempoCocinaMin: z.number().int().min(1).max(180).nullable().optional(),
        }),
      },
    },
    async (req) => setRappiConfig(req.body as never, req.usuario?.nombre),
  );

  fastify.get(
    '/admin/rappi/llamadas',
    {
      ...admin,
      schema: {
        querystring: z.object({
          limite: z.coerce.number().int().min(1).max(100).default(30),
          soloErrores: z.coerce.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query as { limite: number; soloErrores?: boolean };
      const [llamadas, registroListo] = await conRegistro(() =>
        prisma.llamadaCanal.findMany({
          where: { plataforma: 'RAPPI', ...(q.soloErrores ? { ok: false } : {}) },
          orderBy: { hechoAt: 'desc' },
          take: q.limite,
        }),
      );
      return { llamadas, registroListo };
    },
  );

  fastify.post('/admin/rappi/credenciales/probar', admin, async () => probarCredenciales());

  // ── Tiendas ────────────────────────────────────────────────────────────
  fastify.post('/admin/rappi/tiendas/listar', admin, async () => {
    const tiendas = await listarTiendas();
    const cfg = await getRappiConfig();
    // Si hay una sola y no hay elegida, se elige sola: es el caso del local.
    if (!cfg.storeId && tiendas.length === 1) {
      const t = tiendas[0]!;
      await setRappiConfig({ storeId: t.rappiId, storeNombre: t.name, storeIntegrationId: t.integrationId });
    }
    return { tiendas };
  });

  fastify.get('/admin/rappi/tiendas/estado', admin, async () => {
    const storeId = await storeIdElegido();
    const abiertas = await estadoTiendas([storeId]);
    return { storeId, abierta: abiertas[storeId] ?? abiertas[String(Number(storeId))] ?? null };
  });

  fastify.put(
    '/admin/rappi/tiendas/:storeId/integrada',
    { ...admin, schema: { params: z.object({ storeId: z.string() }), body: z.object({ integrada: z.boolean() }) } },
    async (req) => {
      const { storeId } = req.params as { storeId: string };
      const { integrada } = req.body as { integrada: boolean };
      return setTiendaIntegrada(storeId, integrada);
    },
  );

  fastify.put(
    '/admin/rappi/tiendas/:storeId/habilitada',
    { ...admin, schema: { params: z.object({ storeId: z.string() }), body: z.object({ habilitada: z.boolean() }) } },
    async (req) => {
      const { storeId } = req.params as { storeId: string };
      const { habilitada } = req.body as { habilitada: boolean };
      return setTiendaHabilitada(storeId, habilitada);
    },
  );

  fastify.post(
    '/admin/rappi/tiendas/:storeId/horarios',
    { ...admin, schema: { params: z.object({ storeId: z.string() }) } },
    async (req) => enviarHorarios((req.params as { storeId: string }).storeId),
  );

  fastify.post(
    '/admin/rappi/tiendas/:storeId/aprovisionar',
    {
      ...admin,
      schema: { params: z.object({ storeId: z.string() }), body: z.object({ nombre: z.string().min(1).max(160) }) },
    },
    async (req) => {
      const { storeId } = req.params as { storeId: string };
      const { nombre } = req.body as { nombre: string };
      const cfg = await getRappiConfig();
      return aprovisionarTienda({ storeId, nombre, storeIntegrationId: cfg.storeIntegrationId });
    },
  );

  // ── Menú ───────────────────────────────────────────────────────────────
  fastify.get('/admin/rappi/menu/vista-previa', admin, async () => {
    const storeId = (await getRappiConfig()).storeId ?? 'SIN-TIENDA';
    return armarMenuRappi(storeId);
  });

  fastify.post('/admin/rappi/menu/enviar', admin, async () => enviarMenu(await storeIdElegido()));

  fastify.get('/admin/rappi/menu/estado', admin, async () => estadoMenu(await storeIdElegido()));

  fastify.put(
    '/admin/rappi/menu/disponibilidad',
    {
      ...admin,
      schema: {
        body: z.object({
          prender: z.array(z.string().min(1).max(40)).default([]),
          apagar: z.array(z.string().min(1).max(40)).default([]),
        }),
      },
    },
    async (req) => setDisponibilidad(req.body as { prender: string[]; apagar: string[] }),
  );

  // ── Órdenes ────────────────────────────────────────────────────────────
  async function ventaDe(idExterno: string) {
    return prisma.venta.findFirst({
      where: { canal: 'RAPPI', idExternoCanal: idExterno },
      select: { id: true, numero: true, estado: true },
    });
  }

  fastify.get(
    '/admin/rappi/ordenes',
    { ...admin, schema: { querystring: z.object({ limite: z.coerce.number().int().min(1).max(100).default(20) }) } },
    async (req) => {
      const { limite } = req.query as { limite: number };
      const ventas = await prisma.venta.findMany({
        where: { canal: 'RAPPI' },
        orderBy: { fechaApertura: 'desc' },
        take: limite,
        select: {
          id: true, numero: true, estado: true, total: true, fechaApertura: true, idExternoCanal: true,
          items: { select: { nombreSnapshot: true, cantidad: true } },
        },
      });
      // Qué se le dijo a RAPPI de cada una, según el registro de llamadas.
      const [llamadas] = await conRegistro(() =>
        prisma.llamadaCanal.findMany({
          where: { plataforma: 'RAPPI', ok: true, ventaId: { in: ventas.map((v) => v.id) } },
          select: { ventaId: true, contexto: true, hechoAt: true },
          orderBy: { hechoAt: 'asc' },
        }),
      );
      const estadoRappi = new Map<string, string>();
      for (const l of llamadas) {
        if (!l.ventaId) continue;
        if (l.contexto?.startsWith('tomar')) estadoRappi.set(l.ventaId, 'TOMADA');
        else if (l.contexto?.startsWith('rechazar')) estadoRappi.set(l.ventaId, 'RECHAZADA');
        else if (l.contexto?.includes('lista para retiro')) estadoRappi.set(l.ventaId, 'LISTA');
      }
      return {
        ordenes: ventas.map((v) => ({
          ...v,
          total: v.total.toFixed(2),
          enRappi: estadoRappi.get(v.id) ?? 'SIN_RESPUESTA',
        })),
      };
    },
  );

  fastify.post(
    '/admin/rappi/ordenes/:idExterno/tomar',
    {
      ...admin,
      schema: {
        params: z.object({ idExterno: z.string().min(1).max(120) }),
        body: z.object({ tiempoCocinaMin: z.number().int().min(1).max(180).nullable().optional() }).default({}),
      },
    },
    async (req) => {
      const { idExterno } = req.params as { idExterno: string };
      const body = (req.body ?? {}) as { tiempoCocinaMin?: number | null };
      const cfg = await getRappiConfig();
      const venta = await ventaDe(idExterno);
      return tomarOrden(idExterno, {
        tiempoCocinaMin: body.tiempoCocinaMin ?? cfg.tiempoCocinaMin,
        ventaId: venta?.id,
        usuarioId: req.usuario!.id,
      });
    },
  );

  fastify.post(
    '/admin/rappi/ordenes/:idExterno/rechazar',
    {
      ...admin,
      schema: {
        params: z.object({ idExterno: z.string().min(1).max(120) }),
        body: z.object({
          cancelType: z.enum(CANCEL_TYPES),
          reason: z.string().min(1).max(300),
          itemsSkus: z.array(z.string()).optional(),
        }),
      },
    },
    async (req) => {
      const { idExterno } = req.params as { idExterno: string };
      const body = req.body as { cancelType: CancelType; reason: string; itemsSkus?: string[] };
      const venta = await ventaDe(idExterno);
      return rechazarOrden(idExterno, { ...body, ventaId: venta?.id, usuarioId: req.usuario!.id });
    },
  );

  fastify.post(
    '/admin/rappi/ordenes/:idExterno/lista',
    { ...admin, schema: { params: z.object({ idExterno: z.string().min(1).max(120) }) } },
    async (req) => {
      const { idExterno } = req.params as { idExterno: string };
      const venta = await ventaDe(idExterno);
      return listaParaRetiro(idExterno, { ventaId: venta?.id, usuarioId: req.usuario!.id });
    },
  );

  // ── Webhooks a nivel integración (auto-onboarding) ─────────────────────
  fastify.post(
    '/admin/rappi/webhooks/suscribir',
    { ...admin, schema: { body: z.object({ evento: z.enum(EVENTOS_WEBHOOK) }) } },
    async (req) => {
      const { evento } = req.body as { evento: EventoWebhook };
      const cfg = await getRappiConfig();
      if (!cfg.clientIntegrationId) {
        throw new ReglaNegocioError('Falta el clientId de la integración (lo da RAPPI). Cargalo en la configuración.');
      }
      const urls = urlsWebhook(req);
      if (!urls.porEvento) throw new ReglaNegocioError('Falta CHANNEL_INGEST_TOKEN en el server: no hay URL a la que suscribir.');
      if (urls.esLocal) {
        throw new ReglaNegocioError('Esta URL es la de esta computadora; suscribí desde la versión en la nube.');
      }
      return suscribirWebhookIntegracion({
        clientId: cfg.clientIntegrationId,
        evento,
        url: urls.porEvento[evento]!,
        secret: secretoWebhookRappi(),
      });
    },
  );
}

/** La tabla del registro puede no existir todavía (Cloud Migrate sin correr). */
async function conRegistro<T>(fn: () => Promise<T>): Promise<[T, boolean]> {
  try {
    return [await fn(), true];
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') {
      return [[] as unknown as T, false];
    }
    throw e;
  }
}
