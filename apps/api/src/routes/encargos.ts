import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EncargoNuevoSchema, EncargoEditarSchema, ItemNuevoSchema } from '@sta/shared/schemas';
import { crearEncargo, crearAdicionEncargo, listarEncargos, buscarEncargos } from '../services/encargo.js';
import { getVentaCompleta } from '../services/venta.js';
import { FueraDeHorarioError } from '../services/sesion-caja.js';
import { recordAudit } from '../services/audit.js';
import { encolarComandaEncargo, esDestinoImpresion } from '../services/impresion.js';
import {
  construirExcelBusqueda,
  descripcionFiltros,
  nombreArchivoExport,
} from '../services/export-busqueda.js';
import {
  periodoBusquedaSchema,
  paginacionSchema,
  resolverFiltroTemporal,
  armarPaginacion,
  type PeriodoBusqueda,
} from '../services/filtro-temporal.js';
import { prisma } from '@sta/db/client';
import { EstadoVenta } from '@sta/db';

/** Hoy en formato YYYY-MM-DD, en hora de Argentina. */
function hoyAR(): string {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

export default async function encargosRoutes(fastify: FastifyInstance) {
  // POST /encargos — alta de un encargo (pedido para un día futuro).
  fastify.post(
    '/encargos',
    {
      preHandler: fastify.requireAuth(),
      schema: { body: EncargoNuevoSchema },
    },
    async (req, reply) => {
      const data = EncargoNuevoSchema.parse(req.body);

      // Validación cruzada (no se puede expresar limpio en el schema de Fastify):
      // 1) exactamente una de hora exacta / franja.
      const tieneHora = !!data.horaEntregaExacta;
      const tieneFranja = !!data.franjaEntrega;
      if (tieneHora === tieneFranja) {
        return reply.code(400).send({
          error: 'Indicá una hora exacta O una franja (mañana/tarde/noche), exactamente una.',
          codigo: 'HORA_O_FRANJA',
        });
      }
      // 2) dirección obligatoria si es envío.
      if (data.tipoEntrega === 'ENVIO' && !data.direccionEntrega?.trim()) {
        return reply.code(400).send({
          error: 'La dirección es obligatoria para los encargos con envío.',
          codigo: 'FALTA_DIRECCION',
        });
      }
      // 3) el día de entrega no puede ser anterior a hoy.
      if (data.fechaEntrega < hoyAR()) {
        return reply.code(400).send({
          error: 'El día de entrega no puede ser anterior a hoy.',
          codigo: 'FECHA_PASADA',
        });
      }

      try {
        const encargo = await crearEncargo({ data, usuarioId: req.usuario!.id });
        return reply.code(201).send(await getVentaCompleta(encargo.id));
      } catch (e) {
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

  // GET /encargos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD — listado por día de entrega
  // (para el calendario de 30 días y las tarjetas de hoy). Sin filtro = hoy.
  fastify.get(
    '/encargos',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        querystring: z.object({
          desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query as { desde?: string; hasta?: string };
      const desde = q.desde ?? hoyAR();
      const hasta = q.hasta ?? desde;
      const encargos = await listarEncargos({ desde, hasta });
      return { encargos };
    },
  );

  // GET /encargos/buscar?q=...&entrega=todos|entregados|pendientes — buscador
  // AMPLIO sobre TODOS los encargos (futuros y pasados): nombre, teléfono, día
  // de entrega, total exacto, nº de pedido/orden.
  fastify.get(
    '/encargos/buscar',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        querystring: z.object({
          // Opcional: sin texto lista todos los del período elegido.
          q: z.string().trim().min(1).max(80).optional(),
          entrega: z.enum(['todos', 'entregados', 'pendientes']).optional(),
          periodo: periodoBusquedaSchema.optional(),
          desde: z.string().datetime().optional(),
          hasta: z.string().datetime().optional(),
          ...paginacionSchema,
          // Mismo resultado en Excel, sin paginar. Ver la nota en /admin/movimientos.
          formato: z.enum(['json', 'xlsx']).optional(),
        }),
      },
    },
    async (req, reply) => {
      const q = req.query as {
        q?: string;
        entrega?: 'todos' | 'entregados' | 'pendientes';
        periodo?: PeriodoBusqueda;
        desde?: string;
        hasta?: string;
        page: number;
        pageSize: number;
        formato?: 'json' | 'xlsx';
      };
      const filtroTemporal = await resolverFiltroTemporal({
        periodo: q.periodo,
        desde: q.desde,
        hasta: q.hasta,
      });

      if (q.formato === 'xlsx') {
        const TOPE = 5000;
        // Se reusa la MISMA búsqueda, pidiendo una sola página grande: así el
        // export no puede diferir de lo que muestra la pantalla.
        const res = await buscarEncargos({
          q: q.q,
          entrega: q.entrega,
          filtroTemporal,
          page: 1,
          pageSize: TOPE,
        });
        const buf = await construirExcelBusqueda({
          titulo: 'Encargos',
          filtros: descripcionFiltros({
            periodo: q.periodo,
            desde: filtroTemporal.desde,
            hasta: filtroTemporal.hasta,
            texto: q.q,
            extra: q.entrega && q.entrega !== 'todos' ? `Entrega: ${q.entrega}` : undefined,
          }),
          columnas: [
            { header: 'N° encargo', key: 'numero', tipo: 'numero', width: 12 },
            { header: 'N° orden', key: 'orden', tipo: 'numero', width: 11 },
            { header: 'Fecha de entrega', key: 'fechaEntrega', width: 16 },
            { header: 'Hora', key: 'hora', width: 10 },
            { header: 'Franja', key: 'franja', width: 14 },
            { header: 'Cliente', key: 'cliente', width: 26 },
            { header: 'Teléfono', key: 'telefono', width: 16 },
            { header: 'Entrega', key: 'tipoEntrega', width: 14 },
            { header: 'Estado', key: 'estado', width: 14 },
            { header: 'Cobro', key: 'estadoCobro', width: 12 },
            { header: 'Retirado', key: 'retirado', width: 12 },
            { header: 'Ítems', key: 'items', tipo: 'numero', width: 8 },
            { header: 'Total', key: 'total', tipo: 'dinero' },
          ],
          filas: res.encargos.map((e) => ({
            numero: e.numero,
            orden: e.numeroOrdenTurno,
            fechaEntrega: e.fechaEntrega ?? '',
            hora: e.horaEntregaExacta ?? '',
            franja: e.franjaEntrega ?? '',
            cliente: e.cliente ?? '',
            telefono: e.telefono ?? '',
            tipoEntrega: e.tipoEntrega ?? '',
            estado: e.estado,
            estadoCobro: e.estadoCobro,
            retirado: e.retiradoAt ? 'Sí' : 'No',
            items: e.itemsCount,
            total: Number(e.total),
          })),
          totales: [
            { etiqueta: 'TOTAL EN ENCARGOS', columna: 'total' },
            { etiqueta: 'Cantidad de encargos', valor: res.encargos.length },
          ],
          hayMas:
            res.total > res.encargos.length
              ? { exportadas: res.encargos.length, totales: res.total }
              : undefined,
        });
        return reply
          .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header('Content-Disposition', `attachment; filename="${nombreArchivoExport('encargos')}"`)
          .send(buf);
      }

      const res = await buscarEncargos({
        q: q.q,
        entrega: q.entrega,
        filtroTemporal,
        page: q.page,
        pageSize: q.pageSize,
      });
      return {
        encargos: res.encargos,
        ...armarPaginacion(res.total, res.page, res.pageSize),
      };
    },
  );

  // PATCH /encargos/:id — editar los datos de entrega de un encargo A_PAGAR.
  // (Los items se editan con los endpoints normales de /ventas/:id/items.)
  fastify.patch(
    '/encargos/:id',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: EncargoEditarSchema,
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = EncargoEditarSchema.parse(req.body);

      const venta = await prisma.venta.findUnique({
        where: { id: params.id },
        include: { deliveryInfo: true },
      });
      if (!venta || !venta.esEncargo) {
        return reply.code(404).send({ error: 'Encargo no encontrado' });
      }
      // Los encargos COBRADOS también se editan (el cliente cambia dirección,
      // horario, etc. después de pagar). Solo se bloquean los anulados y las
      // adiciones (los datos de entrega viven en el encargo principal).
      if (venta.estado === EstadoVenta.ANULADA) {
        return reply.code(400).send({ error: 'El encargo está anulado.' });
      }
      if (venta.encargoPadreId) {
        return reply.code(400).send({
          error: 'Las adiciones se editan desde el encargo principal.',
        });
      }

      // XOR hora/franja si vino alguno de los dos.
      const horaFinal =
        body.horaEntregaExacta !== undefined ? body.horaEntregaExacta : venta.horaEntregaExacta;
      const franjaFinal =
        body.franjaEntrega !== undefined ? body.franjaEntrega : venta.franjaEntrega;
      if (!!horaFinal === !!franjaFinal) {
        return reply.code(400).send({
          error: 'Indicá una hora exacta O una franja, exactamente una.',
          codigo: 'HORA_O_FRANJA',
        });
      }

      const esEnvio =
        body.tipoEntrega !== undefined
          ? body.tipoEntrega === 'ENVIO'
          : venta.tipoEntregaEncargo === 'ENVIO';

      await prisma.$transaction(async (tx) => {
        await tx.venta.update({
          where: { id: venta.id },
          data: {
            ...(body.fechaEntrega && {
              fechaEntregaPromesa: new Date(`${body.fechaEntrega}T00:00:00.000Z`),
            }),
            ...(body.horaEntregaExacta !== undefined && {
              horaEntregaExacta: body.horaEntregaExacta,
            }),
            ...(body.franjaEntrega !== undefined && { franjaEntrega: body.franjaEntrega }),
            ...(body.tipoEntrega !== undefined && { tipoEntregaEncargo: body.tipoEntrega }),
          },
        });

        // Actualizar el snapshot de contacto en DeliveryInfo.
        const snap =
          (venta.deliveryInfo?.direccionSnapshot as Record<string, unknown> | null) ?? {};
        const nuevoSnap: Record<string, unknown> = { ...snap };
        if (body.clienteNombre !== undefined) nuevoSnap.clienteNombre = body.clienteNombre;
        if (body.clienteTelefono !== undefined) nuevoSnap.clienteTelefono = body.clienteTelefono;
        if (body.direccionEntrega !== undefined) {
          nuevoSnap.direccion = esEnvio ? body.direccionEntrega : null;
        }
        if (body.indicacionesEntrega !== undefined) {
          nuevoSnap.indicaciones = body.indicacionesEntrega;
        }
        if (body.tipoEntrega !== undefined) nuevoSnap._retiro = !esEnvio;

        await tx.deliveryInfo.upsert({
          where: { ventaId: venta.id },
          create: { ventaId: venta.id, direccionSnapshot: nuevoSnap as never },
          update: { direccionSnapshot: nuevoSnap as never },
        });

        await recordAudit({
          tabla: 'ventas',
          registroId: venta.id,
          accion: 'UPDATE',
          usuarioId: req.usuario!.id,
          valorNuevo: { encargoEditado: true },
          contexto: { campos: Object.keys(body) },
          tx,
        });

        // Toda modificación re-imprime la comanda del encargo (fusionada, con
        // el estado real: A PAGAR / COBRADO / PAGO PARCIAL), por la comandera
        // con la que se cargó el encargo.
        await encolarComandaEncargo(
          venta.id,
          'A_PAGAR',
          tx,
          esDestinoImpresion(venta.destinoImpresionEncargo)
            ? venta.destinoImpresionEncargo
            : 'MOSTRADOR',
        );
      });

      return reply.send(await getVentaCompleta(venta.id));
    },
  );

  // POST /encargos/:id/adicion — "modificación adicional al pedido X": items
  // agregados a un encargo ya cargado (pagado o no). Crea una venta hija con su
  // propia secuencia de pago. accion 'cobrar' → el front va al cobro (marrón);
  // 'cargar' → queda a pagar y sale la comanda fusionada (PAGO PARCIAL si
  // el encargo original ya estaba pagado).
  fastify.post(
    '/encargos/:id/adicion',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          pcOrigen: z.string().min(1).max(40),
          items: z.array(ItemNuevoSchema).min(1),
          accion: z.enum(['cargar', 'cobrar']),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as {
        pcOrigen: string;
        items: Array<z.infer<typeof ItemNuevoSchema>>;
        accion: 'cargar' | 'cobrar';
      };
      try {
        const adicion = await crearAdicionEncargo({
          padreId: params.id,
          items: body.items,
          pcOrigen: body.pcOrigen,
          usuarioId: req.usuario!.id,
          accion: body.accion,
        });
        return reply.code(201).send(await getVentaCompleta(adicion.id));
      } catch (e) {
        if (e instanceof FueraDeHorarioError) {
          return reply.code(423).send({
            error: 'Fuera del horario de atención configurado',
            codigo: 'FUERA_DE_HORARIO',
            resolucion: e.resolucion,
          });
        }
        if (e instanceof Error && e.message.includes('no encontrado')) {
          return reply.code(404).send({ error: e.message });
        }
        if (e instanceof Error && e.message.includes('anulado')) {
          return reply.code(400).send({ error: e.message });
        }
        throw e;
      }
    },
  );

  // POST /encargos/:id/retirar — marca (o desmarca) el encargo como RETIRADO.
  // Es ortogonal al cobro: un encargo se puede retirar pagado o impago, así que
  // no toca `estadoCobroEncargo` ni la caja — solo registra la entrega.
  fastify.post(
    '/encargos/:id/retirar',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ retirado: z.boolean().default(true) }).optional(),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const retirado = (req.body as { retirado?: boolean } | undefined)?.retirado ?? true;

      const venta = await prisma.venta.findUnique({
        where: { id: params.id },
        select: { id: true, esEncargo: true, estado: true, encargoPadreId: true },
      });
      if (!venta || !venta.esEncargo) {
        return reply.code(404).send({ error: 'Encargo no encontrado' });
      }
      if (venta.estado === EstadoVenta.ANULADA) {
        return reply.code(400).send({ error: 'El encargo está anulado.' });
      }
      if (venta.encargoPadreId) {
        return reply.code(400).send({
          error: 'El retiro se marca sobre el encargo principal.',
        });
      }

      await prisma.venta.update({
        where: { id: venta.id },
        data: {
          retiradoAt: retirado ? new Date() : null,
          usuarioRetiroEncargoId: retirado ? req.usuario!.id : null,
        },
      });
      await recordAudit({
        tabla: 'ventas',
        registroId: venta.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorNuevo: { encargoRetirado: retirado },
      });
      return reply.send(await getVentaCompleta(venta.id));
    },
  );

  // POST /encargos/:id/reimprimir — re-encola la comanda del encargo (fusionada
  // con sus adiciones, estado real). Disponible en cualquier estado no anulado.
  fastify.post(
    '/encargos/:id/reimprimir',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        // Comandera elegida por el usuario al re-imprimir (default Mostrador).
        body: z
          .object({
            destino: z.enum(['MOSTRADOR', 'DELIVERY', 'COCINA']).default('MOSTRADOR'),
          })
          .optional(),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const venta = await prisma.venta.findUnique({
        where: { id: params.id },
        select: {
          id: true,
          esEncargo: true,
          estado: true,
          destinoImpresionEncargo: true,
          fechaEntregaPromesa: true,
        },
      });
      if (!venta || !venta.esEncargo) {
        return reply.code(404).send({ error: 'Encargo no encontrado' });
      }
      if (venta.estado === EstadoVenta.ANULADA) {
        return reply.code(400).send({ error: 'El encargo está anulado.' });
      }
      // Sin destino explícito, re-imprime por la comandera con la que se cargó.
      const destino =
        (req.body as { destino?: 'MOSTRADOR' | 'DELIVERY' | 'COCINA' } | undefined)?.destino ??
        (esDestinoImpresion(venta.destinoImpresionEncargo)
          ? venta.destinoImpresionEncargo
          : 'MOSTRADOR');
      // Encargo con día de entrega YA PASADO: la única acción permitida es
      // re-imprimir, y el ticket sale marcado como COPIA (no se puede modificar
      // — tocaría la lógica de cajas ya cerradas). El rótulo lo agrega el
      // renderer cuando `copia=true`.
      const esPasado =
        !!venta.fechaEntregaPromesa &&
        venta.fechaEntregaPromesa.toISOString().slice(0, 10) < hoyAR();
      await encolarComandaEncargo(venta.id, 'A_PAGAR', undefined, destino, esPasado);
      await recordAudit({
        tabla: 'ventas',
        registroId: venta.id,
        accion: 'REIMPRESION',
        usuarioId: req.usuario!.id,
        valorNuevo: { comandaEncargo: true, destino, copia: esPasado },
      });
      return { ok: true, destino, copia: esPasado };
    },
  );
}
