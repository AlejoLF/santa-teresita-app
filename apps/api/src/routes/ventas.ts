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
import {
  getOrCreateSesionActual,
  getSesionActualReadOnly,
  FueraDeHorarioError,
} from '../services/sesion-caja.js';
import { recordAudit } from '../services/audit.js';
import { aprobarConPinAdmin } from '../services/auth.js';
import {
  encolarComandasCanceladas,
  encolarComandasParaVenta,
  encolarTicketClienteParaVenta,
  encolarTicketDeliveryParaVenta,
  encolarComandaEncargo,
  esDestinoImpresion,
  ventaYaEnviadaACocina,
} from '../services/impresion.js';
import { prisma } from '@sta/db/client';
import { EstadoVenta, EstadoPago } from '@sta/db';

/**
 * IDOR guard (A3 del audit): un VENDEDOR sólo puede ver/operar ventas de SU
 * sesión actual; un ADMIN (o el agente virtual) cualquiera. Antes, los endpoints
 * resolvían la venta sólo por UUID sin chequear a quién pertenece, así que un
 * cajero podía editar/finalizar/anular ventas de otra sesión pasando el id.
 * Los handlers responden 404 (no 403) en cross-scope para no filtrar existencia.
 */
async function ventaEnScope(
  req: { usuario?: { rol: string } | null },
  venta: { sesionCajaId: string | null; esEncargo?: boolean },
): Promise<boolean> {
  if (req.usuario?.rol === 'ADMIN') return true;
  // Los encargos son una cola COMPARTIDA: se cargan un día y se cobran otro
  // (posiblemente en otra sesión y por otro cajero). Por eso cualquier cajero
  // los puede ver/cobrar, no solo el de la sesión donde se cargaron.
  if (venta.esEncargo) return true;
  const { sesion } = await getSesionActualReadOnly();
  return !!sesion && venta.sesionCajaId === sesion.id;
}

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
      if (!(await ventaEnScope(req, venta))) {
        return reply.code(404).send({ error: 'Venta no encontrada' });
      }
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
        // `esEncargo: false`: los encargos viven en su propia pestaña; no deben
        // aparecer como "pedidos abiertos" del cajero normal.
        where: { sesionCajaId: sesion.id, estado: EstadoVenta.PROCESADA, esEncargo: false },
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
      if (!(await ventaEnScope(req, venta))) {
        return reply.code(404).send({ error: 'Venta no encontrada' });
      }
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
      if (!(await ventaEnScope(req, venta))) {
        return reply.code(404).send({ error: 'Venta no encontrada' });
      }

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

      // Si vino body.repartidor (cambió la asignación) re-encolamos comandas
      // dentro de una transacción para que la cocina vea el repartidor nuevo.
      // Antes: la COCINA se encolaba al crear la venta con el default
      // (Damián). Si la cajera elegía otro repartidor después, el ticket
      // de adelante salía correcto pero el de cocina seguía diciendo Damián
      // (incidente reportado por la encargada).
      const cambiaRepartidor = body.repartidor !== undefined;
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.deliveryInfo.upsert({
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
        if (cambiaRepartidor) {
          // Sincronizar la modalidad de la venta con el repartidor elegido,
          // así la lógica de caja/cierre keya por modalidad sin depender del
          // canal. DELIVERATE → DELIVERY_DELIVERATE (rinde semanal, fuera de
          // caja). Otra empresa externa → DELIVERY_PLATAFORMA. Empleado propio
          // → DELIVERY_PROPIO. (No tocamos si no se asignó nadie.)
          let modalidadNueva: string | null = null;
          if (empresaExternaFinal === 'DELIVERATE') modalidadNueva = 'DELIVERY_DELIVERATE';
          else if (empresaExternaFinal) modalidadNueva = 'DELIVERY_PLATAFORMA';
          else if (empleadoNombreFinal) modalidadNueva = 'DELIVERY_PROPIO';
          if (modalidadNueva) {
            await tx.venta.update({
              where: { id: params.id },
              data: { modalidad: modalidadNueva as never },
            });
          }
          // NO reimprimimos la comanda de cocina al asignar/cambiar el
          // repartidor: la comida no cambia, solo quién la entrega. La comanda
          // de cocina ya se encoló al crear la venta. Reimprimir acá era la
          // causa de las comandas de cocina duplicadas (crear + asignar moto =
          // 2 comandas). El dato del repartidor sale en el TICKET_DELIVERY al
          // finalizar, que es quien lo necesita.
        }
        return u;
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
        body: z.object({
          items: z.array(ItemNuevoSchema).default([]),
          // Promos agregadas a la venta abierta (el server las desarma).
          promos: z
            .array(
              z.object({
                comboId: z.string().uuid(),
                cantidad: z.number().int().positive(),
                observacion: z.string().max(500).optional(),
              }),
            )
            .default([]),
        }).refine((b) => b.items.length > 0 || b.promos.length > 0, {
          message: 'Se requiere al menos un item o una promo',
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as {
        items: Array<z.infer<typeof ItemNuevoSchema>>;
        promos: Array<{ comboId: string; cantidad: number; observacion?: string }>;
      };

      const venta = await prisma.venta.findUnique({ where: { id: params.id } });
      if (!venta) return reply.code(404).send({ error: 'Venta no encontrada' });
      if (!(await ventaEnScope(req, venta))) {
        return reply.code(404).send({ error: 'Venta no encontrada' });
      }
      if (venta.estado !== EstadoVenta.PROCESADA) {
        return reply.code(400).send({
          error: 'Solo se pueden agregar items a ventas en estado PROCESADA',
        });
      }

      const updated = await agregarItemsAVenta({
        ventaId: venta.id,
        items: body.items,
        promos: body.promos,
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

  // POST /ventas/:id/envio — agrega un tipo de envío como item del pedido.
  // Los tipos de envío son productos del tipoProducto "Envío" gestionados
  // desde admin (sección Delivery). El precio es el precioBase del producto.
  //
  // Acepta:
  //   { productoId } — id del producto de envío (forma nueva, dinámica), o
  //   { tipo: SIMPLE|DOBLE } — compat: resuelve por código ENV01/ENV02.
  fastify.post(
    '/ventas/:id/envio',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            productoId: z.string().uuid().optional(),
            tipo: z.enum(['SIMPLE', 'DOBLE']).optional(),
          })
          .refine((b) => b.productoId || b.tipo, {
            message: 'Falta productoId o tipo',
          }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as { productoId?: string; tipo?: 'SIMPLE' | 'DOBLE' };
      const venta = await prisma.venta.findUnique({ where: { id: params.id } });
      if (!venta) return reply.code(404).send({ error: 'Venta no encontrada' });
      if (!(await ventaEnScope(req, venta))) {
        return reply.code(404).send({ error: 'Venta no encontrada' });
      }
      if (venta.estado !== EstadoVenta.PROCESADA) {
        return reply.code(400).send({
          error: 'Solo se pueden agregar envíos a ventas en estado PROCESADA',
        });
      }

      // Resolver el producto de envío: por id (nuevo) o por código (compat).
      const producto = body.productoId
        ? await prisma.producto.findUnique({ where: { id: body.productoId } })
        : await prisma.producto.findUnique({
            where: { codigo: body.tipo === 'SIMPLE' ? 'ENV01' : 'ENV02' },
          });
      if (!producto) {
        return reply.code(404).send({ error: 'Tipo de envío no encontrado' });
      }
      if (!producto.activo) {
        return reply.code(400).send({ error: 'Ese tipo de envío está desactivado' });
      }

      const updated = await agregarItemsAVenta({
        ventaId: venta.id,
        items: [{ productoId: producto.id, cantidad: 1, modificadores: [] }],
        usuarioId: req.usuario!.id,
      });

      await recordAudit({
        tabla: 'ventas',
        registroId: venta.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorNuevo: {
          envio: producto.nombre,
          monto: Number(producto.precioBase).toFixed(2),
          totalNuevo: updated.total,
        },
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
      if (!(await ventaEnScope(req, venta))) {
        return reply.code(404).send({ error: 'Venta no encontrada' });
      }
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
      if (!(await ventaEnScope(req, venta))) {
        return reply.code(404).send({ error: 'Venta no encontrada' });
      }
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
      if (!(await ventaEnScope(req, venta))) {
        return reply.code(404).send({ error: 'Venta no encontrada' });
      }
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
        // Seguridad: el cajero puede elegir el % por venta, pero capeamos al
        // MÁXIMO configurado (`descuento_manual_max_vendedor_pct`, default 30%)
        // para que no venda a cualquier precio. OJO: este es el TOPE, NO el
        // `descuento_efectivo_pct` (que es el descuento AUTOMÁTICO por defecto,
        // 10%) — confundirlos hacía que cualquier % > 10 se capeara a 10 y el
        // total no cuadrara con lo cobrado → "total pagado insuficiente".
        const pctConfig = await prisma.configuracionSistema.findUnique({
          where: { clave: 'descuento_manual_max_vendedor_pct' },
          select: { valor: true },
        });
        const pctMax = Math.min(100, Math.max(0, Number(pctConfig?.valor ?? 30) || 30));
        const pct = Math.min(body.descuentoPctEfectivo, pctMax);
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

      // Encargo: el cobro (sea inmediato o diferido días después) se registra en
      // la sesión de caja ACTUAL del momento del cobro — NUNCA retroactivo a la
      // sesión donde se cargó. Reasignamos sesion_caja_id a la sesión vigente.
      // Fuera de horario no hay sesión → 423 (igual que cualquier cobro).
      let sesionEncargoId: string | null = null;
      if (venta.esEncargo) {
        try {
          const sesionActual = await getOrCreateSesionActual(req.usuario!.id);
          sesionEncargoId = sesionActual.id;
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
            // Encargo: reasignar a la sesión actual + marcar cobrado.
            ...(venta.esEncargo && {
              sesionCajaId: sesionEncargoId,
              estadoCobroEncargo: 'COBRADO',
              fechaCobroEncargo: new Date(),
              usuarioCobroEncargoId: req.usuario!.id,
            }),
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

        // Encolamos los tickets físicos DENTRO de la misma transacción —
        // si la transición rollea, no quedan print jobs huérfanos.
        //   - TICKET_CLIENTE: sólo si canal=MOSTRADOR (cliente está acá).
        //   - TICKET_DELIVERY: sólo si modalidad=DELIVERY_PROPIO + canal interno
        //     (TELEFONO/WHATSAPP/WEB). Se emite acá (no al crear venta) para
        //     que refleje el método de pago real — antes salía con default
        //     "EFECTIVO / A_COBRAR" porque al crear venta todavía no había
        //     pagos registrados (incidente: ticket de #79 DEBITO impreso como
        //     EFECTIVO).
        // Comanda de COCINA: normalmente ya salió al ENVIAR el pedido (crear con
        // "Enviar a cocina" / "Cargar otro", o al agregar items). PERO si el pedido
        // se creó con "Cobrar" (enviarACocina=false), todavía no se envió a cocina:
        // sale ACÁ, al confirmar el pago. `ventaYaEnviadaACocina` evita duplicar si
        // ya había salido. Los tickets cliente/delivery salen acá porque necesitan
        // el pago real ya registrado.
        if (venta.esEncargo) {
          // Encargo: una sola comanda ENCARGO con "COBRADO" (no los tickets
          // normales de cliente/delivery). Sale por la comandera que eligió la
          // caja al cargarlo; los encargos viejos (campo NULL) van a Mostrador.
          await encolarComandaEncargo(
            venta.id,
            'COBRADO',
            tx,
            esDestinoImpresion(venta.destinoImpresionEncargo)
              ? venta.destinoImpresionEncargo
              : 'MOSTRADOR',
          );
        } else {
          if (!(await ventaYaEnviadaACocina(venta.id, tx))) {
            await encolarComandasParaVenta(venta.id, tx);
          }
          await encolarTicketClienteParaVenta(venta.id, tx);
          await encolarTicketDeliveryParaVenta(venta.id, tx);
        }

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
      if (!(await ventaEnScope(req, venta))) {
        return reply.code(404).send({ error: 'Venta no encontrada' });
      }
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
            ipOrigen: req.ip,
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
      // no tienen pagos todavía). Los marcamos ANULADO.
      const pagosAReversar =
        venta.estado === EstadoVenta.FINALIZADA
          ? await prisma.pago.findMany({
              where: { ventaId: venta.id, estado: EstadoPago.CONFIRMADO },
            })
          : [];

      const anulada = await prisma.$transaction(async (tx) => {
        // 1. Marcar cada pago como ANULADO.
        //
        // NO tocamos saldoActual: las ventas NO acreditan saldo a las cuentas
        // (los saldos se llevan por conciliación manual, ver Cuentas y saldos).
        // Antes esto DECREMENTABA la cuenta al anular, dejándola en negativo
        // porque la venta nunca la había acreditado. Bug corregido.
        for (const pago of pagosAReversar) {
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
