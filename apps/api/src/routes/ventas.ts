import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  VentaNuevaSchema,
  FinalizarVentaSchema,
  ItemNuevoSchema,
} from '@sta/shared/schemas';
import {
  crearVenta,
  getVentaCompleta,
  listarVentasDeSesionActual,
  agregarItemsAVenta,
  quitarItemDeVenta,
  editarItemDeVenta,
} from '../services/venta.js';
import { getOrCreateSesionActual, FueraDeHorarioError } from '../services/sesion-caja.js';
import { recordAudit } from '../services/audit.js';
import { aprobarConPinAdmin } from '../services/auth.js';
import {
  encolarComandasCanceladas,
  encolarTicketClienteParaVenta,
} from '../services/impresion.js';
import { prisma } from '@sta/db/client';
import { EstadoVenta, EstadoPago } from '@sta/db';

export default async function ventasRoutes(fastify: FastifyInstance) {
  // POST /ventas — crea una venta nueva en estado PROCESADA.
  fastify.post(
    '/ventas',
    {
      preHandler: fastify.requireAuth(),
      schema: { body: VentaNuevaSchema },
    },
    async (req, reply) => {
      const data = VentaNuevaSchema.parse(req.body);
      try {
        const venta = await crearVenta({ data, usuarioId: req.usuario!.id });
        return reply.code(201).send(await getVentaCompleta(venta.id));
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

  // GET /ventas/:id
  fastify.get(
    '/ventas/:id',
    {
      preHandler: fastify.requireAuth(),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const venta = await getVentaCompleta(params.id);
      if (!venta) return reply.code(404).send({ error: 'Venta no encontrada' });
      return venta;
    },
  );

  // GET /ventas/abiertas — solo abiertas con detalle de items (para el panel del cajero).
  fastify.get(
    '/ventas/abiertas',
    { preHandler: fastify.requireAuth() },
    async (req) => {
      let sesion;
      try {
        sesion = await getOrCreateSesionActual(req.usuario!.id);
      } catch (e) {
        if (e instanceof FueraDeHorarioError) {
          return { ventas: [], fueraDeHorario: true, resolucion: e.resolucion };
        }
        throw e;
      }
      const ventas = await prisma.venta.findMany({
        where: { sesionCajaId: sesion.id, estado: EstadoVenta.PROCESADA },
        orderBy: { fechaApertura: 'desc' },
        select: {
          id: true,
          numero: true,
          numeroOrdenTurno: true,
          canal: true,
          modalidad: true,
          total: true,
          fechaApertura: true,
          pcOrigen: true,
          tieneCocina: true,
          items: {
            select: { id: true, nombreSnapshot: true, cantidad: true, unidad: true },
            orderBy: { orden: 'asc' },
          },
        },
      });
      return { ventas };
    },
  );

  // GET /ventas/historial-sesion — historial de la sesión actual (Wireframe 05).
  fastify.get(
    '/ventas/historial-sesion',
    { preHandler: fastify.requireAuth() },
    async (req) => {
      let sesion;
      try {
        sesion = await getOrCreateSesionActual(req.usuario!.id);
      } catch (e) {
        if (e instanceof FueraDeHorarioError) {
          return {
            sesion: null,
            abiertas: [],
            cerradas: [],
            anuladas: [],
            fueraDeHorario: true,
            resolucion: e.resolucion,
          };
        }
        throw e;
      }
      const ventas = await listarVentasDeSesionActual(sesion.id);
      return {
        sesion: { id: sesion.id, fecha: sesion.fecha, turno: sesion.turno },
        abiertas: ventas.filter((v) => v.estado === EstadoVenta.PROCESADA),
        cerradas: ventas.filter((v) => v.estado === EstadoVenta.FINALIZADA),
        anuladas: ventas.filter((v) => v.estado === EstadoVenta.ANULADA),
      };
    },
  );

  // PATCH /ventas/:id — editar canal/modalidad de una venta PROCESADA.
  // Cambiar de MOSTRADOR a DELIVERY_PROPIO requiere completar la info de
  // delivery después (en otra request a PUT /ventas/:id/delivery).
  fastify.patch(
    '/ventas/:id',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          canal: z
            .enum([
              'MOSTRADOR',
              'TELEFONO',
              'WHATSAPP',
              'WEB',
              'RAPPI',
              'PEDIDOS_YA',
              'MERCADO_LIBRE',
              'DELIVERATE',
            ])
            .optional(),
          modalidad: z
            .enum([
              'TAKE_AWAY',
              'DELIVERY_PROPIO',
              'DELIVERY_PLATAFORMA',
              'DELIVERY_DELIVERATE',
            ])
            .optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as {
        canal?: string;
        modalidad?: string;
      };
      const venta = await prisma.venta.findUnique({ where: { id: params.id } });
      if (!venta) return reply.code(404).send({ error: 'Venta no encontrada' });
      if (venta.estado !== EstadoVenta.PROCESADA) {
        return reply
          .code(400)
          .send({ error: 'Solo se puede editar el tipo de ventas PROCESADAS' });
      }

      const updated = await prisma.venta.update({
        where: { id: venta.id },
        data: {
          ...(body.canal && { canal: body.canal as never }),
          ...(body.modalidad && { modalidad: body.modalidad as never }),
        },
      });

      await recordAudit({
        tabla: 'ventas',
        registroId: venta.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { canal: venta.canal, modalidad: venta.modalidad },
        valorNuevo: { canal: updated.canal, modalidad: updated.modalidad },
      });

      return reply.send(await getVentaCompleta(venta.id));
    },
  );

  // PUT /ventas/:id/delivery — establecer/actualizar info de delivery (repartidor, dirección)
  fastify.put(
    '/ventas/:id/delivery',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          repartidor: z
            .enum(['DAMIAN', 'DELIVERATE', 'OTRO_EMPLEADO', 'PLATAFORMA'])
            .nullable()
            .optional(),
          empresaExterna: z.string().max(80).optional(),
          empleadoNombre: z.string().max(120).optional(),
          horaPrometida: z.string().datetime().optional(),
          observaciones: z.string().max(500).optional(),
          direccionSnapshot: z.record(z.unknown()).optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as {
        repartidor?: 'DAMIAN' | 'DELIVERATE' | 'OTRO_EMPLEADO' | 'PLATAFORMA' | null;
        empresaExterna?: string;
        empleadoNombre?: string;
        horaPrometida?: string;
        observaciones?: string;
        direccionSnapshot?: Record<string, unknown>;
      };
      const venta = await prisma.venta.findUnique({ where: { id: params.id } });
      if (!venta) return reply.code(404).send({ error: 'Venta no encontrada' });

      // Mapear el "repartidor" elegido a los campos del modelo:
      //   DAMIAN / OTRO_EMPLEADO → guardamos el nombre en empleadoNombre como override del snapshot
      //   DELIVERATE / PLATAFORMA → empresaExterna
      let empresaExternaFinal: string | null = null;
      let empleadoNombreFinal: string | null = null;
      switch (body.repartidor) {
        case 'DELIVERATE':
          empresaExternaFinal = 'DELIVERATE';
          break;
        case 'PLATAFORMA':
          empresaExternaFinal = body.empresaExterna ?? venta.canal;
          break;
        case 'DAMIAN':
          empleadoNombreFinal = 'Damián';
          break;
        case 'OTRO_EMPLEADO':
          empleadoNombreFinal = body.empleadoNombre ?? null;
          break;
      }

      // Merge con el snapshot existente — no sobreescribimos clienteNombre/
      // clienteTelefono/direccion/indicaciones si el caller solo manda
      // info del repartidor. Antes el snapshot se reemplazaba entero y se
      // perdían los datos del cliente.
      const existing = await prisma.deliveryInfo.findUnique({
        where: { ventaId: params.id },
      });
      const existingSnap = (existing?.direccionSnapshot as Record<string, unknown> | null) ?? {};
      const incomingSnap = body.direccionSnapshot ?? {};
      const datosDeliveryRepartidor = {
        ...existingSnap,
        ...incomingSnap,
        // Si el caller mandó body.repartidor, sobreescribimos los markers.
        // Si no, dejamos los que ya estaban en el snapshot.
        ...(body.repartidor !== undefined && {
          _repartidor: body.repartidor ?? null,
          _empresaExterna: empresaExternaFinal,
          _empleadoNombre: empleadoNombreFinal,
        }),
      };

      const updated = await prisma.deliveryInfo.upsert({
        where: { ventaId: params.id },
        create: {
          ventaId: params.id,
          empresaExterna: empresaExternaFinal,
          direccionSnapshot: datosDeliveryRepartidor as never,
          horaPrometida: body.horaPrometida ? new Date(body.horaPrometida) : null,
          observaciones: body.observaciones ?? null,
        },
        update: {
          // Solo updateamos empresaExterna si vino body.repartidor.
          ...(body.repartidor !== undefined && { empresaExterna: empresaExternaFinal }),
          direccionSnapshot: datosDeliveryRepartidor as never,
          ...(body.horaPrometida !== undefined && {
            horaPrometida: body.horaPrometida ? new Date(body.horaPrometida) : null,
          }),
          ...(body.observaciones !== undefined && {
            observaciones: body.observaciones ?? null,
          }),
        },
      });

      await recordAudit({
        tabla: 'delivery_info',
        registroId: updated.id,
        accion: 'UPSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: {
          repartidor: body.repartidor,
          empresa: empresaExternaFinal,
          empleado: empleadoNombreFinal,
        },
      });

      return updated;
    },
  );

  // POST /ventas/:id/items — agregar items a una venta PROCESADA.
  fastify.post(
    '/ventas/:id/items',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ items: z.array(ItemNuevoSchema).min(1) }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { items: Array<z.infer<typeof ItemNuevoSchema>> };

      const venta = await prisma.venta.findUnique({ where: { id: params.id } });
      if (!venta) return reply.code(404).send({ error: 'Venta no encontrada' });
      if (venta.estado !== EstadoVenta.PROCESADA) {
        return reply.code(400).send({
          error: 'Solo se pueden agregar items a ventas en estado PROCESADA',
        });
      }

      const updated = await agregarItemsAVenta({
        ventaId: venta.id,
        items: body.items,
        usuarioId: req.usuario!.id,
      });

      await recordAudit({
        tabla: 'ventas',
        registroId: venta.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { itemsCount: 'sin contar', total: venta.total },
        valorNuevo: { agregados: body.items.length, totalNuevo: updated.total },
      });

      return reply.send(await getVentaCompleta(venta.id));
    },
  );

  // PATCH /ventas/:id/items/:itemId — editar campos del item (por ahora
  // sólo observacion). Solo permitido en ventas PROCESADAS.
  fastify.patch(
    '/ventas/:id/items/:itemId',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid(), itemId: z.string().uuid() }),
        body: z.object({
          observacion: z.string().max(500).nullable(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string; itemId: string };
      const body = req.body as { observacion: string | null };

      const venta = await prisma.venta.findUnique({ where: { id: params.id } });
      if (!venta) return reply.code(404).send({ error: 'Venta no encontrada' });
      if (venta.estado !== EstadoVenta.PROCESADA) {
        return reply.code(400).send({
          error: 'Solo se pueden editar items de ventas PROCESADAS',
        });
      }

      const updated = await editarItemDeVenta({
        ventaId: venta.id,
        itemId: params.itemId,
        observacion: body.observacion?.trim() || null,
        usuarioId: req.usuario!.id,
      });

      await recordAudit({
        tabla: 'items_venta',
        registroId: params.itemId,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorNuevo: { observacion: body.observacion },
        contexto: { ventaId: venta.id },
      });

      return reply.send(updated);
    },
  );

  // DELETE /ventas/:id/items/:itemId — quitar un item de venta PROCESADA.
  fastify.delete(
    '/ventas/:id/items/:itemId',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid(), itemId: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string; itemId: string };

      const venta = await prisma.venta.findUnique({ where: { id: params.id } });
      if (!venta) return reply.code(404).send({ error: 'Venta no encontrada' });
      if (venta.estado !== EstadoVenta.PROCESADA) {
        return reply.code(400).send({
          error: 'Solo se pueden quitar items de ventas PROCESADAS',
        });
      }

      await quitarItemDeVenta({ ventaId: venta.id, itemId: params.itemId });

      await recordAudit({
        tabla: 'items_venta',
        registroId: params.itemId,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        contexto: { ventaId: venta.id },
      });

      return reply.send(await getVentaCompleta(venta.id));
    },
  );

  // POST /ventas/:id/finalizar — cobrar y finalizar.
  fastify.post(
    '/ventas/:id/finalizar',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: FinalizarVentaSchema,
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = FinalizarVentaSchema.parse(req.body);

      const venta = await prisma.venta.findUnique({
        where: { id: params.id },
        include: { pagos: true },
      });
      if (!venta) return reply.code(404).send({ error: 'Venta no encontrada' });
      if (venta.estado !== EstadoVenta.PROCESADA) {
        return reply.code(400).send({ error: 'La venta no está en estado PROCESADA' });
      }

      // Calcular descuento efectivo si aplica.
      // El frontend manda los pagos con el monto NETO (post-descuento). Para
      // reconstruir el descuento aplicado conociendo el % `pct`:
      //   bruto = neto / (1 - pct/100)
      //   descuento = bruto - neto = neto * pct / (100 - pct)
      let descuento = 0;
      // Total bruto = subtotal + recargoCanal. El recargo (ej. surcharge de
      // RAPPI/PYA) NO se descuenta — solo se descuenta sobre el subtotal real
      // de productos. El total final = (subtotal - descuento) + recargoCanal.
      const recargoCanal = Number(venta.recargoCanal ?? 0);
      let total = Number(venta.total);
      if (body.aplicarDescuentoEfectivo && venta.canal === 'MOSTRADOR') {
        const pct = body.descuentoPctEfectivo;
        if (pct <= 0 || pct >= 100) {
          return reply
            .code(400)
            .send({ error: `Porcentaje de descuento inválido: ${pct}%` });
        }
        const efectivoNeto = body.pagos
          .filter((p) => p.metodo === 'EFECTIVO')
          .reduce((acc, p) => acc + Number(p.monto), 0);
        descuento = Math.round(((efectivoNeto * pct) / (100 - pct)) * 100) / 100;
        total = Number(venta.subtotal) - descuento + recargoCanal;
      }

      const totalPagado = body.pagos.reduce((acc, p) => acc + Number(p.monto), 0);
      if (totalPagado < total - 0.5) {
        return reply.code(400).send({
          error: 'Total pagado insuficiente',
          totalPagado,
          totalRequerido: total.toFixed(2),
          descuentoAplicado: descuento.toFixed(2),
        });
      }

      const finalizada = await prisma.$transaction(async (tx) => {
        // Crear pagos en batch — un solo INSERT con múltiples VALUES rows.
        // Antes era 1 INSERT por pago (3 en pagos split: efectivo + tarjeta + MP);
        // ahora es 1 INSERT total. Con RTT ~200ms a Supabase, esto ahorra
        // ~400ms en cobros con pago dividido.
        await tx.pago.createMany({
          data: body.pagos.map((p) => ({
            ventaId: venta.id,
            metodo: p.metodo,
            cuentaId: p.cuentaId,
            cuentaACobrarId: p.cuentaACobrarId ?? null,
            monto: p.monto,
            cambioDado: p.cambioDado ?? '0',
            numeroReferencia: p.numeroReferencia ?? null,
            tarjetaUltimos4: p.tarjetaUltimos4 ?? null,
            posnetId: p.posnetId ?? null,
            estado: EstadoPago.CONFIRMADO,
          })),
        });

        const updated = await tx.venta.update({
          where: { id: venta.id },
          data: {
            descuentoTotal: descuento.toFixed(2),
            total: total.toFixed(2),
            totalPagado: totalPagado.toFixed(2),
            descuentoEfectivoAplicado: body.aplicarDescuentoEfectivo,
            estado: EstadoVenta.FINALIZADA,
            fechaFinalizacion: new Date(),
            usuarioCierreId: req.usuario!.id,
          },
          include: { items: true, pagos: true },
        });

        // Audit dentro de la misma transacción para que mutación + audit
        // sean atómicos (si falla el audit, no queda venta finalizada huérfana).
        await recordAudit({
          tabla: 'ventas',
          registroId: venta.id,
          accion: 'TRANSITION',
          usuarioId: req.usuario!.id,
          valorAnterior: { estado: 'PROCESADA' },
          valorNuevo: { estado: 'FINALIZADA', total, descuento, recargoCanal },
          tx,
        });

        // Encolamos el ticket del cliente DENTRO de la misma transacción.
        // Si la transición rolleba, no queda print job huérfano. Solo se
        // encola si canal=MOSTRADOR (el cliente está físicamente acá).
        await encolarTicketClienteParaVenta(venta.id, tx);

        return updated;
      });

      return finalizada;
    },
  );

  // POST /ventas/:id/anular — requiere PIN admin in-line si está finalizada.
  fastify.post(
    '/ventas/:id/anular',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          motivo: z.string().min(1).max(500),
          pinAdmin: z.string().regex(/^\d{4}$/).optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { motivo: string; pinAdmin?: string };

      const venta = await prisma.venta.findUnique({ where: { id: params.id } });
      if (!venta) return reply.code(404).send({ error: 'Venta no encontrada' });
      if (venta.estado === EstadoVenta.ANULADA) {
        return reply.code(400).send({ error: 'La venta ya está anulada' });
      }

      // Si está finalizada, requiere PIN admin (a menos que el usuario actual sea admin).
      let aprobadorId: string | null = null;
      if (venta.estado === EstadoVenta.FINALIZADA && req.usuario!.rol !== 'ADMIN') {
        if (!body.pinAdmin) {
          return reply.code(403).send({
            error: 'Anular venta finalizada requiere PIN admin',
            code: 'NEEDS_ADMIN_PIN',
          });
        }
        try {
          const aprob = await aprobarConPinAdmin({
            pin: body.pinAdmin,
            accion: 'ANULAR_VENTA_FINALIZADA',
            contexto: { ventaId: venta.id, numero: venta.numero, motivo: body.motivo },
            usuarioSolicitanteId: req.usuario!.id,
            pcOrigen: venta.pcOrigen,
          });
          aprobadorId = aprob.usuarioAprobador.id;
        } catch (e) {
          return reply.code(403).send({
            error: e instanceof Error ? e.message : 'PIN admin inválido',
            code: 'INVALID_ADMIN_PIN',
          });
        }
      }

      // Pagos confirmados de la venta (sólo si está finalizada — las PROCESADAS
      // no tienen pagos todavía). Hay que revertir cada uno: decrementar la
      // cuenta correspondiente y marcar el pago como ANULADO.
      const pagosAReversar =
        venta.estado === EstadoVenta.FINALIZADA
          ? await prisma.pago.findMany({
              where: { ventaId: venta.id, estado: EstadoPago.CONFIRMADO },
            })
          : [];

      const anulada = await prisma.$transaction(async (tx) => {
        // 1. Revertir cada pago: decrementar la cuenta y marcar el pago ANULADO
        for (const pago of pagosAReversar) {
          await tx.cuenta.update({
            where: { id: pago.cuentaId },
            data: { saldoActual: { decrement: Number(pago.monto) } },
          });
          await tx.pago.update({
            where: { id: pago.id },
            data: { estado: EstadoPago.ANULADO },
          });
        }

        // 2. Marcar la venta como ANULADA
        const updated = await tx.venta.update({
          where: { id: venta.id },
          data: {
            estado: EstadoVenta.ANULADA,
            motivoAnulacion: body.motivo,
            fechaAnulacion: new Date(),
            usuarioAnulacionId: req.usuario!.id,
          },
        });

        // 3. Audit dentro de la misma transacción
        await recordAudit({
          tabla: 'ventas',
          registroId: venta.id,
          accion: 'TRANSITION',
          usuarioId: req.usuario!.id,
          valorAnterior: { estado: venta.estado, total: venta.total },
          valorNuevo: {
            estado: 'ANULADA',
            motivo: body.motivo,
            pagosReversados: pagosAReversar.length,
            montoReversado: pagosAReversar.reduce((s, p) => s + Number(p.monto), 0).toFixed(2),
            aprobadoPor: aprobadorId,
          },
          tx,
        });

        // 4. Encolar COMANDA_CANCELADA en todos los destinos donde se imprimió
        // el original (mostrador / delivery / cocina, según reglas).
        await encolarComandasCanceladas(venta.id, tx);

        return updated;
      });

      // TODO: si la comanda ya se imprimió, encolar comanda CANCELADA.
      return reply.code(200).send({
        ...anulada,
        pagosReversados: pagosAReversar.length,
      });
    },
  );
}
