import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { RolUsuario, Prisma } from '@sta/db';
import { config } from '../config.js';
import { FueraDeHorarioError, getSesionActualReadOnly } from '../services/sesion-caja.js';
import {
  crearVentaCanal,
  simularOrdenCanal,
  anularVentaCanal,
  MapeoIncompletoError,
  type OrdenCanal,
  type CanalPlataforma,
} from '../services/venta-canal.js';
import { registrarRecepcion } from '../services/recepcion-canal.js';

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

/** Compara dos secretos en tiempo constante, sin filtrar el largo por el timing. */
function secretoOk(got: string, expected: string | undefined): boolean {
  if (!expected) return false;
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** Compara el Bearer con CHANNEL_INGEST_TOKEN en tiempo constante. */
function tokenOk(req: FastifyRequest): boolean {
  const got = req.headers['authorization']?.replace(/^Bearer\s+/i, '') ?? '';
  return secretoOk(got, config.CHANNEL_INGEST_TOKEN);
}

/**
 * Traduce los errores de zod a algo que se entienda desde el panel.
 *
 * "items.0.codigo: Required" leído en el celular a las 8 de la noche no dice
 * nada; "al item 1 le falta `codigo`" sí. Es lo que va a leer quien esté
 * conectando el integrador, no un stack.
 */
function explicarZod(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((i) => {
      const donde = i.path.length ? i.path.join('.') : '(raíz)';
      return `${donde}: ${i.message}`;
    })
    .join(' · ');
}

/**
 * ¿Existe ya la tabla del buzón?
 *
 * La migración que la crea viaja en el repo, pero el código llega a producción
 * (Vercel/Railway deployan solos en cada push) ANTES de que alguien corra Cloud
 * Migrate. En esa ventana la tabla no existe y Postgres rechaza la consulta.
 *
 * Sin este chequeo, esa consulta tiraba abajo TODA la pantalla de Integraciones
 * con un "la base de datos rechazó la operación" — justo la pantalla cuyo
 * trabajo es explicar qué está mal configurado. Incidente real: 02/09/2026.
 *
 * `P2021` es el código de Prisma para "la tabla no existe". Cualquier otro
 * error se propaga: un problema de conexión NO se disfraza de "falta migrar".
 */
async function conBuzon<T>(fn: () => Promise<T>, siNoExiste: T): Promise<[T, boolean]> {
  try {
    return [await fn(), true];
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021') {
      return [siNoExiste, false];
    }
    throw e;
  }
}

export default async function channelRoutes(fastify: FastifyInstance) {
  /**
   * Procesa una orden ya autenticada, dejando constancia de CÓMO terminó.
   *
   * Compartido por `/channel/orders` (Bearer) y `/channel/webhook/...` (token en
   * la URL): son dos puertas de entrada al mismo trámite, y el registro tiene
   * que salir igual por las dos.
   *
   * OJO con la validación: acá se valida el body A MANO con `safeParse` en vez
   * de declarar `schema.body` en la ruta. No es capricho — con el schema
   * declarado, Fastify rechaza el body ANTES de entrar al handler, así que un
   * payload con la forma equivocada (el caso más probable al conectar un
   * integrador nuevo) devolvía 400 sin dejar ni un renglón de qué había
   * llegado. Justamente lo que hacía falta ver.
   */
  async function procesarOrden(
    req: FastifyRequest,
    reply: FastifyReply,
    cuerpo: unknown,
  ): Promise<FastifyReply> {
    const parsed = OrdenCanalSchema.safeParse(cuerpo);
    if (!parsed.success) {
      const detalle = explicarZod(parsed.error);
      await registrarRecepcion(req, {
        resultado: 'BODY_INVALIDO',
        status: 400,
        detalle,
      });
      return reply.code(400).send({
        error: 'El pedido no tiene el formato que espera el sistema',
        detalle,
        ayuda:
          'El contrato esperado está en docs/RAPPI-INTEGRACION.md. Si la plataforma ' +
          'no puede mandar este formato, hace falta un adaptador.',
      });
    }
    const orden = parsed.data as OrdenCanal;

    try {
      const { venta, duplicate } = await crearVentaCanal(orden);
      await registrarRecepcion(req, {
        resultado: duplicate ? 'DUPLICADO' : 'OK',
        status: duplicate ? 200 : 201,
        detalle: duplicate
          ? `Ya existía la venta #${venta.numero} para ese pedido — no se duplicó`
          : `Venta #${venta.numero} creada y enviada a la comandera`,
        canal: orden.canal,
        idExternoCanal: orden.idExternoCanal,
        ventaId: venta.id,
      });
      return reply.code(duplicate ? 200 : 201).send({
        id: venta.id,
        numero: venta.numero,
        estado: venta.estado,
        duplicate,
      });
    } catch (e) {
      if (e instanceof MapeoIncompletoError) {
        const detalle = `SKUs que no existen en el catálogo: ${e.skusFaltantes.join(', ')}`;
        await registrarRecepcion(req, {
          resultado: 'SKU_FALTANTE',
          status: 422,
          detalle,
          canal: orden.canal,
          idExternoCanal: orden.idExternoCanal,
        });
        return reply
          .code(422)
          .send({ error: 'SKUs sin mapear en el catálogo', skusFaltantes: e.skusFaltantes });
      }
      if (e instanceof FueraDeHorarioError) {
        await registrarRecepcion(req, {
          resultado: 'FUERA_DE_HORARIO',
          status: 423,
          detalle:
            'Llegó fuera del horario de atención configurado, así que no había turno ' +
            'abierto donde imputar la venta',
          canal: orden.canal,
          idExternoCanal: orden.idExternoCanal,
        });
        return reply.code(423).send({
          error: 'Fuera del horario de atención configurado',
          codigo: 'FUERA_DE_HORARIO',
          resolucion: e.resolucion,
        });
      }
      await registrarRecepcion(req, {
        resultado: 'ERROR',
        status: 500,
        detalle: e instanceof Error ? e.message : String(e),
        canal: orden.canal,
        idExternoCanal: orden.idExternoCanal,
      });
      throw e;
    }
  }

  // POST /channel/orders — crea (y auto-finaliza) una venta de plataforma.
  // Auth por header. Es la puerta para un integrador que pueda mandar
  // `Authorization: Bearer`; el que no puede entra por /channel/webhook/...
  fastify.post('/channel/orders', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.CHANNEL_INGEST_TOKEN) {
      await registrarRecepcion(req, {
        resultado: 'SIN_TOKEN_CONFIGURADO',
        status: 503,
        detalle:
          'CHANNEL_INGEST_TOKEN no está seteado en el server: la ingesta de plataformas ' +
          'está apagada y rechaza TODO lo que llega.',
      });
      return reply
        .code(503)
        .send({ error: 'Ingesta de canal deshabilitada (falta CHANNEL_INGEST_TOKEN)' });
    }
    if (!tokenOk(req)) {
      await registrarRecepcion(req, {
        resultado: 'TOKEN_INVALIDO',
        status: 401,
        detalle:
          'El token que mandó no es el configurado. Mirá el header `authorization` ' +
          'de esta recepción: dice el largo del que llegó, para comparar con el nuestro.',
      });
      return reply.code(401).send({ error: 'Token de ingesta de canal inválido' });
    }
    return procesarOrden(req, reply, req.body);
  });

  /**
   * POST /channel/webhook/:plataforma/:token — la MISMA ingesta, con el token
   * en la URL.
   *
   * POR QUÉ EXISTE: muchos integradores (el de RAPPI entre ellos) sólo dejan
   * cargar una URL de destino — no hay dónde poner un header. Contra
   * `/channel/orders` eso es un 401 garantizado, sin importar qué mande el
   * cuerpo. Con el token en el path, la plataforma puede autenticarse con lo
   * único que sabe configurar.
   *
   * El token en la URL es más débil que en un header —queda en logs de proxies
   * y en el historial del navegador de quien lo pegue—, así que: es un token
   * de máquina distinto del de usuarios, sólo habilita crear ventas de canal, y
   * se rota cambiando la env var. A cambio, es la diferencia entre integrar y
   * no integrar.
   *
   * Acepta CUALQUIER body. Si no tiene la forma del contrato neutral, queda
   * registrado igual —que es el punto: para escribir el adaptador de una
   * plataforma hay que ver lo que manda de verdad, no lo que uno supone.
   */
  fastify.post(
    '/channel/webhook/:plataforma/:token',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { plataforma, token } = req.params as { plataforma: string; token: string };

      if (!config.CHANNEL_INGEST_TOKEN) {
        await registrarRecepcion(req, {
          resultado: 'SIN_TOKEN_CONFIGURADO',
          status: 503,
          detalle:
            'CHANNEL_INGEST_TOKEN no está seteado en el server: la ingesta de plataformas ' +
            'está apagada y rechaza TODO lo que llega.',
          canal: plataforma.toUpperCase(),
        });
        return reply.code(503).send({ error: 'Ingesta de canal deshabilitada' });
      }
      if (!secretoOk(token, config.CHANNEL_INGEST_TOKEN)) {
        await registrarRecepcion(req, {
          resultado: 'TOKEN_INVALIDO',
          status: 401,
          detalle: `El token de la URL no es el configurado (llegaron ${token.length} chars).`,
          canal: plataforma.toUpperCase(),
        });
        return reply.code(401).send({ error: 'Token inválido' });
      }

      // ¿Ya viene en el contrato neutral? Entonces es una orden y se procesa.
      if (OrdenCanalSchema.safeParse(req.body).success) {
        return procesarOrden(req, reply, req.body);
      }

      // No lo es: se guarda crudo y se dice claramente que falta el adaptador.
      // NO devolvemos 200: sería mentirle a la plataforma —que daría el pedido
      // por aceptado— y ese pedido no existiría en el local. Un pedido que la
      // plataforma marca como fallido se puede reintentar; uno que cree
      // entregado, no.
      await registrarRecepcion(req, {
        resultado: 'SIN_ADAPTADOR',
        status: 501,
        detalle:
          `Llegó bien y con el token correcto, pero el cuerpo no tiene el formato ` +
          `neutral que espera el sistema. Falta escribir el adaptador de ` +
          `${plataforma.toUpperCase()}: el cuerpo quedó guardado acá para poder hacerlo.`,
        canal: plataforma.toUpperCase(),
      });
      return reply.code(501).send({
        error: `Todavía no hay adaptador para ${plataforma.toUpperCase()}`,
        recibido: true,
        ayuda:
          'El pedido llegó y quedó guardado en Admin → Configuración → Integraciones. ' +
          'Con ese cuerpo se escribe el adaptador y esta misma URL empieza a andar.',
      });
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

  // POST /channel/orders/cancel — la plataforma canceló la orden.
  //
  // Sin esto, un ORDER_EVENT_CANCEL de Rappi no hacía nada: la venta quedaba
  // FINALIZADA y entraba al cierre de caja como facturada aunque el cliente
  // nunca pagó. Descuadraba el turno.
  //
  // Va por body (no `/:id`) porque `idExternoCanal` es texto libre de la
  // plataforma: puede traer barras y romper el ruteo.
  //
  // SIEMPRE 200 cuando el token es válido — mismo criterio que el dry-run: que
  // la venta no exista es información, no un error. Pasa de verdad (la orden se
  // rechazó, o entró con RAPPI_DRY_RUN), y devolver 404 haría que el integrador
  // lo loguee como falla y reintente algo que no tiene arreglo.
  fastify.post(
    '/channel/orders/cancel',
    {
      schema: {
        body: z.object({
          canal: z.enum(['RAPPI', 'PEDIDOS_YA', 'MERCADO_LIBRE']),
          idExternoCanal: z.string().min(1).max(120),
          motivo: z.string().max(500).optional(),
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
      const body = req.body as {
        canal: CanalPlataforma;
        idExternoCanal: string;
        motivo?: string;
      };
      const out = await anularVentaCanal({
        canal: body.canal,
        idExternoCanal: body.idExternoCanal,
        motivo: body.motivo?.trim() || `Cancelada por ${body.canal}`,
      });

      if (out.resultado === 'NO_ENCONTRADA') {
        req.log.info(
          { canal: body.canal, idExternoCanal: body.idExternoCanal },
          'channel_cancel_venta_inexistente',
        );
        return reply.send({ resultado: out.resultado });
      }
      return reply.send({
        resultado: out.resultado,
        ventaId: out.venta.id,
        numero: out.venta.numero,
        total: out.venta.total,
        pagosReversados: out.resultado === 'ANULADA' ? out.pagosReversados : 0,
      });
    },
  );

  // ══════════════════════════════════════════════════════════════════════
  //   Panel: estado de la integración y buzón de recepciones
  // ══════════════════════════════════════════════════════════════════════

  /**
   * GET /admin/channel/estado — ¿está la integración lista para recibir?
   *
   * Contesta desde el celular las preguntas que hoy sólo se podían responder
   * mirando las variables de entorno de Railway: si el token está puesto, cuál
   * es la URL exacta que hay que cargar en la plataforma, cuántos productos no
   * se pueden matchear todavía, y si en este momento hay turno abierto.
   *
   * Son, una por una, las cuatro razones por las que un pedido rebota. Verlas
   * juntas ANTES de la prueba evita el viaje de ida y vuelta.
   *
   * NUNCA devuelve el token. Sí devuelve la URL con el token adentro, que es lo
   * que hay que pegar en la plataforma — por eso el endpoint pide sesión de
   * ADMIN, igual que el resto del panel.
   */
  fastify.get(
    '/admin/channel/estado',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async (req) => {
      const token = config.CHANNEL_INGEST_TOKEN;
      // El host con el que llegó el request ES el que la plataforma tiene que
      // usar: si esto se ve desde el .exe (127.0.0.1) la URL de ahí no le sirve
      // a RAPPI, y decirlo es más útil que inventar un dominio.
      const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
      const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? '';
      const base = `${proto}://${host}/api/v1`;
      const esLocal = /^(127\.0\.0\.1|localhost|\[?::1\]?)(:|$)/.test(host);

      const [totalProductos, sinCodigo, sesion] = await Promise.all([
        prisma.producto.count({ where: { activo: true } }),
        prisma.producto.count({ where: { activo: true, OR: [{ codigo: null }, { codigo: '' }] } }),
        getSesionActualReadOnly(),
      ]);

      // El buzón puede no existir todavía (código deployado, Cloud Migrate sin
      // correr). Que falte NO puede tapar lo demás: la URL para pegar en RAPPI
      // es justamente lo que hace falta en ese momento.
      const [ultimas, buzonListo] = await conBuzon(
        () =>
          prisma.recepcionCanal.findMany({
            orderBy: { recibidoAt: 'desc' },
            take: 1,
            select: { recibidoAt: true, resultado: true, detalle: true },
          }),
        [] as Array<{ recibidoAt: Date; resultado: string; detalle: string | null }>,
      );

      return {
        tokenConfigurado: Boolean(token),
        // Sólo la forma, nunca el valor.
        tokenLargo: token?.length ?? 0,
        urls: {
          // La que usa un integrador que puede mandar headers.
          conHeader: `${base}/channel/orders`,
          // La que usa uno que sólo deja cargar una URL (el caso de RAPPI).
          webhookRappi: token ? `${base}/channel/webhook/rappi/${token}` : null,
          webhookPedidosYa: token ? `${base}/channel/webhook/pedidos_ya/${token}` : null,
        },
        // Si esto está en true, la URL de arriba es la de ESTA máquina y no le
        // sirve a la plataforma: hay que sacarla del deploy de la nube.
        urlEsLocal: esLocal,
        catalogo: {
          publicables: totalProductos - sinCodigo,
          sinCodigo,
          // Un producto sin `codigo` no se puede publicar NI matchear: si la
          // plataforma manda su SKU, el pedido rebota con 422.
          advertencia:
            sinCodigo > 0
              ? `Hay ${sinCodigo} productos activos sin código. Si un pedido incluye alguno, rebota.`
              : null,
        },
        horario: {
          hayTurnoAbierto: Boolean(sesion.sesion),
          // Un pedido que llega fuera de horario rebota con 423 aunque todo lo
          // demás esté bien — y es fácil que la prueba caiga justo ahí.
          advertencia: sesion.sesion
            ? null
            : 'Ahora mismo no hay turno abierto: un pedido que llegue en este momento rebota.',
        },
        ultimaRecepcion: ultimas[0] ?? null,
        // false = falta correr Cloud Migrate. Se guarda lo que llega igual
        // (services/recepcion-canal.ts nunca tira), pero no queda registrado.
        buzonListo,
      };
    },
  );

  /** GET /admin/channel/recepciones — el buzón, lo último primero. */
  fastify.get(
    '/admin/channel/recepciones',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          limite: z.coerce.number().int().min(1).max(100).default(30),
          soloErrores: z.coerce.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query as { limite: number; soloErrores?: boolean };
      const [recepciones, buzonListo] = await conBuzon(
        () =>
          prisma.recepcionCanal.findMany({
            where: q.soloErrores ? { resultado: { notIn: ['OK', 'DUPLICADO'] } } : {},
            orderBy: { recibidoAt: 'desc' },
            take: q.limite,
          }),
        [] as Awaited<ReturnType<typeof prisma.recepcionCanal.findMany>>,
      );
      return { recepciones, buzonListo };
    },
  );

}
