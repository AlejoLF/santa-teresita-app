import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EncargoNuevoSchema, EncargoEditarSchema } from '@sta/shared/schemas';
import { crearEncargo, listarEncargos } from '../services/encargo.js';
import { getVentaCompleta } from '../services/venta.js';
import { FueraDeHorarioError } from '../services/sesion-caja.js';
import { recordAudit } from '../services/audit.js';
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
      if (venta.estado !== EstadoVenta.PROCESADA || venta.estadoCobroEncargo !== 'A_PAGAR') {
        return reply.code(400).send({
          error: 'Solo se pueden editar encargos pendientes (A_PAGAR, sin cobrar).',
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
      });

      return reply.send(await getVentaCompleta(venta.id));
    },
  );
}
