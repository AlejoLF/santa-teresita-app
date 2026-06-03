import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
import { RolUsuario, EstadoMovimiento, TipoCategoriaMovimiento } from '@sta/db';
import { subtotalItem } from '@sta/shared';
import { recordAudit } from '../services/audit.js';

/**
 * MAYORISTAS — Clientes con cuenta corriente.
 *
 * Modelo de negocio: vendemos a empresas a precio especial (vía una lista de
 * precios dedicada por cliente). Cada entrega se documenta con un REMITO que
 * suma a la cuenta corriente del cliente. A fin de mes se agrupan los remitos
 * del período (resumen para facturar por fuera) y, cuando el cliente paga, se
 * registra un COBRO (movimiento INGRESO) que baja el saldo.
 *
 * Saldo adeudado = Σ remitos PENDIENTE − Σ cobros confirmados.
 * El cobro se modela como Movimiento INGRESO (entidadId = clienteMayoristaId)
 * para que la plata aterrice en el cashflow recién cuando efectivamente se cobra.
 */

const METODOS = [
  'EFECTIVO',
  'TRANSFERENCIA',
  'DEPOSITO',
  'CHEQUE',
  'MERCADOPAGO_QR',
  'OTRO',
] as const;

const CATEGORIA_COBRO = 'Cobro cuenta corriente';

/** Resuelve la categoría de sistema de los cobros (idempotente). */
async function getCategoriaCobroId(): Promise<string> {
  const cat = await prisma.categoriaMovimiento.upsert({
    where: { nombre: CATEGORIA_COBRO },
    create: {
      nombre: CATEGORIA_COBRO,
      tipo: TipoCategoriaMovimiento.INGRESO,
      esSistema: true,
      esOperativa: true,
    },
    update: {},
  });
  return cat.id;
}

export default async function mayoristasRoutes(fastify: FastifyInstance) {
  // ── Listas de precios disponibles (para asignar a un cliente) ──
  fastify.get(
    '/admin/mayoristas/listas',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const listas = await prisma.listaPrecios.findMany({
        where: { activa: true },
        orderBy: { nombre: 'asc' },
        select: { id: true, nombre: true },
      });
      return { listas };
    },
  );

  // ── Listado de clientes mayoristas con su saldo de cuenta corriente ──
  fastify.get(
    '/admin/mayoristas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({ incluirInactivos: z.coerce.boolean().optional() }),
      },
    },
    async (req) => {
      const q = req.query as { incluirInactivos?: boolean };
      const clientes = await prisma.clienteMayorista.findMany({
        where: q.incluirInactivos ? {} : { activo: true },
        include: { listaPrecios: { select: { id: true, nombre: true } } },
        orderBy: { nombre: 'asc' },
      });
      const ids = clientes.map((c) => c.id);
      const [remitado, cobrado] = await Promise.all([
        prisma.remito.groupBy({
          by: ['clienteMayoristaId'],
          _sum: { total: true },
          where: { estado: 'PENDIENTE', clienteMayoristaId: { in: ids } },
        }),
        prisma.movimiento.groupBy({
          by: ['entidadId'],
          _sum: { monto: true },
          where: { estado: EstadoMovimiento.CONFIRMADO, tipo: 'INGRESO', entidadId: { in: ids } },
        }),
      ]);
      const remMap = new Map(remitado.map((r) => [r.clienteMayoristaId, Number(r._sum.total ?? 0)]));
      const cobMap = new Map(cobrado.map((c) => [c.entidadId, Number(c._sum.monto ?? 0)]));

      return {
        clientes: clientes.map((c) => {
          const saldo = (remMap.get(c.id) ?? 0) - (cobMap.get(c.id) ?? 0);
          return {
            id: c.id,
            nombre: c.nombre,
            cuit: c.cuit,
            telefono: c.telefono,
            activo: c.activo,
            lista: c.listaPrecios,
            saldo: saldo.toFixed(2),
          };
        }),
      };
    },
  );

  // ── Crear cliente mayorista ──
  fastify.post(
    '/admin/mayoristas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(160),
          listaPreciosId: z.string().uuid(),
          cuit: z.string().max(20).optional(),
          contacto: z.string().max(120).optional(),
          telefono: z.string().max(40).optional(),
          email: z.string().max(120).optional(),
          direccion: z.string().max(500).optional(),
          observaciones: z.string().max(1000).optional(),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body as {
        nombre: string;
        listaPreciosId: string;
        cuit?: string;
        contacto?: string;
        telefono?: string;
        email?: string;
        direccion?: string;
        observaciones?: string;
      };
      const lista = await prisma.listaPrecios.findUnique({ where: { id: b.listaPreciosId } });
      if (!lista) return reply.code(400).send({ error: 'La lista de precios no existe' });

      const cliente = await prisma.clienteMayorista.create({
        data: {
          nombre: b.nombre,
          listaPreciosId: b.listaPreciosId,
          cuit: b.cuit || null,
          contacto: b.contacto || null,
          telefono: b.telefono || null,
          email: b.email || null,
          direccion: b.direccion || null,
          observaciones: b.observaciones || null,
        },
      });
      await recordAudit({
        tabla: 'clientes_mayoristas',
        registroId: cliente.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: cliente.nombre, lista: lista.nombre },
      });
      return reply.code(201).send(cliente);
    },
  );

  // ── Editar / activar-desactivar cliente ──
  fastify.patch(
    '/admin/mayoristas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(160).optional(),
          listaPreciosId: z.string().uuid().optional(),
          cuit: z.string().max(20).nullable().optional(),
          contacto: z.string().max(120).nullable().optional(),
          telefono: z.string().max(40).nullable().optional(),
          email: z.string().max(120).nullable().optional(),
          direccion: z.string().max(500).nullable().optional(),
          observaciones: z.string().max(1000).nullable().optional(),
          activo: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as Record<string, unknown>;
      const existe = await prisma.clienteMayorista.findUnique({ where: { id } });
      if (!existe) return reply.code(404).send({ error: 'Cliente no encontrado' });
      const updated = await prisma.clienteMayorista.update({
        where: { id },
        data: b as Prisma.ClienteMayoristaUncheckedUpdateInput,
      });
      await recordAudit({
        tabla: 'clientes_mayoristas',
        registroId: id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorNuevo: b as Record<string, unknown>,
      });
      return updated;
    },
  );

  // ── Detalle: cliente + saldo + remitos + cobros ──
  fastify.get(
    '/admin/mayoristas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const cliente = await prisma.clienteMayorista.findUnique({
        where: { id },
        include: { listaPrecios: { select: { id: true, nombre: true } } },
      });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

      const [remitos, cobros, remitado, cobrado] = await Promise.all([
        prisma.remito.findMany({
          where: { clienteMayoristaId: id },
          orderBy: { fecha: 'desc' },
          take: 500,
          include: { _count: { select: { items: true } } },
        }),
        prisma.movimiento.findMany({
          where: { entidadId: id, tipo: 'INGRESO' },
          orderBy: { fechaComputo: 'desc' },
          take: 200,
          include: {
            cuentaDestino: { select: { nombre: true } },
            usuario: { select: { nombre: true } },
          },
        }),
        prisma.remito.aggregate({
          _sum: { total: true },
          where: { clienteMayoristaId: id, estado: 'PENDIENTE' },
        }),
        prisma.movimiento.aggregate({
          _sum: { monto: true },
          where: { entidadId: id, tipo: 'INGRESO', estado: EstadoMovimiento.CONFIRMADO },
        }),
      ]);

      const totalRemitado = Number(remitado._sum.total ?? 0);
      const totalCobrado = Number(cobrado._sum.monto ?? 0);

      return {
        cliente: {
          id: cliente.id,
          nombre: cliente.nombre,
          cuit: cliente.cuit,
          contacto: cliente.contacto,
          telefono: cliente.telefono,
          email: cliente.email,
          direccion: cliente.direccion,
          observaciones: cliente.observaciones,
          activo: cliente.activo,
          lista: cliente.listaPrecios,
        },
        saldo: (totalRemitado - totalCobrado).toFixed(2),
        totales: { remitado: totalRemitado.toFixed(2), cobrado: totalCobrado.toFixed(2) },
        remitos: remitos.map((r) => ({
          id: r.id,
          numero: r.numero,
          fecha: r.fecha,
          total: r.total.toFixed(2),
          estado: r.estado,
          itemsCount: r._count.items,
          observaciones: r.observaciones,
        })),
        cobros: cobros
          .filter((m) => m.estado === EstadoMovimiento.CONFIRMADO)
          .map((m) => ({
            id: m.id,
            fecha: m.fechaComputo,
            monto: m.monto.toFixed(2),
            cuenta: m.cuentaDestino?.nombre ?? '—',
            usuario: m.usuario?.nombre ?? null,
            observacion: m.observacion,
          })),
      };
    },
  );

  // ── Catálogo con precios resueltos para la lista del cliente ──
  fastify.get(
    '/admin/mayoristas/:id/catalogo',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const cliente = await prisma.clienteMayorista.findUnique({
        where: { id },
        include: { listaPrecios: true },
      });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

      const ajustePct = Number(cliente.listaPrecios.ajustePctDefault);
      const productos = await prisma.producto.findMany({
        where: { activo: true },
        orderBy: { nombre: 'asc' },
        include: {
          preciosPorLista: {
            where: { listaId: cliente.listaPreciosId },
            orderBy: { vigenciaDesde: 'desc' },
            take: 1,
          },
        },
      });

      return {
        lista: { id: cliente.listaPrecios.id, nombre: cliente.listaPrecios.nombre },
        productos: productos.map((p) => {
          const override = p.preciosPorLista[0]?.precioEfectivo;
          const precio = override
            ? Number(override)
            : Number(p.precioBase) * (1 + ajustePct / 100);
          return {
            id: p.id,
            nombre: p.nombre,
            marca: p.marca,
            unidadPrecio: p.unidadPrecio,
            unidadPrecioLabel: p.unidadPrecioLabel,
            formaVenta: p.formaVenta,
            precioUnitario: precio.toFixed(2),
          };
        }),
      };
    },
  );

  // ── Crear remito ──
  fastify.post(
    '/admin/mayoristas/:id/remitos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          fecha: z.string().datetime().optional(),
          observaciones: z.string().max(1000).optional(),
          items: z
            .array(
              z.object({
                productoId: z.string().uuid().optional(),
                nombre: z.string().min(1).max(200),
                cantidad: z.coerce.number().positive(),
                // precioUnitario sólo se usa para ítems libres (sin productoId).
                precioUnitario: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
              }),
            )
            .min(1),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as {
        fecha?: string;
        observaciones?: string;
        items: Array<{ productoId?: string; nombre: string; cantidad: number; precioUnitario?: string }>;
      };
      const cliente = await prisma.clienteMayorista.findUnique({
        where: { id },
        include: { listaPrecios: true },
      });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

      const ajustePct = Number(cliente.listaPrecios.ajustePctDefault);
      // Resolvemos precios autoritativamente desde la lista del cliente (no
      // confiamos en lo que manda el front para ítems con productoId).
      const productoIds = [...new Set(b.items.map((i) => i.productoId).filter(Boolean) as string[])];
      const productos = productoIds.length
        ? await prisma.producto.findMany({
            where: { id: { in: productoIds } },
            include: {
              preciosPorLista: {
                where: { listaId: cliente.listaPreciosId },
                orderBy: { vigenciaDesde: 'desc' },
                take: 1,
              },
            },
          })
        : [];
      const prodMap = new Map(productos.map((p) => [p.id, p]));

      const itemsData: Array<{
        productoId: string | null;
        nombreSnapshot: string;
        cantidad: string;
        precioUnitario: string;
        subtotal: string;
        orden: number;
      }> = [];
      let total = 0;
      for (const [idx, it] of b.items.entries()) {
        let precioUnitario: number;
        let subtotalStr: string;
        let nombre = it.nombre;
        if (it.productoId) {
          const p = prodMap.get(it.productoId);
          if (!p) return reply.code(400).send({ error: `Producto ${it.productoId} no existe` });
          const override = p.preciosPorLista[0]?.precioEfectivo;
          precioUnitario = override
            ? Number(override)
            : Number(p.precioBase) * (1 + ajustePct / 100);
          nombre = p.nombre;
          subtotalStr = subtotalItem({
            cantidad: it.cantidad,
            precioUnitario: precioUnitario.toFixed(2),
            unidadPrecio: p.unidadPrecio,
          });
        } else {
          // Ítem libre (sin producto del catálogo): precio manual, por unidad.
          precioUnitario = Number(it.precioUnitario ?? 0);
          if (precioUnitario <= 0) {
            return reply.code(400).send({ error: `Falta el precio del ítem "${it.nombre}"` });
          }
          subtotalStr = (it.cantidad * precioUnitario).toFixed(2);
        }
        total += Number(subtotalStr);
        itemsData.push({
          productoId: it.productoId ?? null,
          nombreSnapshot: nombre,
          cantidad: String(it.cantidad),
          precioUnitario: precioUnitario.toFixed(2),
          subtotal: subtotalStr,
          orden: idx,
        });
      }

      const remito = await prisma.remito.create({
        data: {
          clienteMayoristaId: id,
          fecha: b.fecha ? new Date(b.fecha) : new Date(),
          total: total.toFixed(2),
          observaciones: b.observaciones || null,
          usuarioId: req.usuario!.id,
          items: { create: itemsData },
        },
        include: { items: true },
      });
      await recordAudit({
        tabla: 'remitos',
        registroId: remito.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { numero: remito.numero, cliente: cliente.nombre, total: remito.total.toFixed(2) },
      });
      return reply.code(201).send(remito);
    },
  );

  // ── Detalle de un remito (para verlo / imprimirlo) ──
  fastify.get(
    '/admin/mayoristas/remitos/:remitoId',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ remitoId: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { remitoId } = req.params as { remitoId: string };
      const remito = await prisma.remito.findUnique({
        where: { id: remitoId },
        include: {
          items: { orderBy: { orden: 'asc' } },
          clienteMayorista: { select: { nombre: true, cuit: true } },
        },
      });
      if (!remito) return reply.code(404).send({ error: 'Remito no encontrado' });
      return {
        id: remito.id,
        numero: remito.numero,
        fecha: remito.fecha,
        estado: remito.estado,
        total: remito.total.toFixed(2),
        observaciones: remito.observaciones,
        cliente: remito.clienteMayorista,
        items: remito.items.map((it) => ({
          nombre: it.nombreSnapshot,
          cantidad: it.cantidad.toString(),
          precioUnitario: it.precioUnitario.toFixed(2),
          subtotal: it.subtotal.toFixed(2),
        })),
      };
    },
  );

  // ── Anular remito ──
  fastify.post(
    '/admin/mayoristas/remitos/:remitoId/anular',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ remitoId: z.string().uuid() }),
        body: z.object({ motivo: z.string().max(300).optional() }).optional(),
      },
    },
    async (req, reply) => {
      const { remitoId } = req.params as { remitoId: string };
      const body = (req.body as { motivo?: string } | undefined) ?? {};
      const remito = await prisma.remito.findUnique({ where: { id: remitoId } });
      if (!remito) return reply.code(404).send({ error: 'Remito no encontrado' });
      if (remito.estado === 'ANULADO') {
        return reply.code(400).send({ error: 'El remito ya está anulado' });
      }
      const updated = await prisma.remito.update({
        where: { id: remitoId },
        data: { estado: 'ANULADO', motivoAnulacion: body.motivo || null, anuladoAt: new Date() },
      });
      await recordAudit({
        tabla: 'remitos',
        registroId: remitoId,
        accion: 'TRANSITION',
        usuarioId: req.usuario!.id,
        valorAnterior: { estado: 'PENDIENTE' },
        valorNuevo: { estado: 'ANULADO', motivo: body.motivo ?? null },
      });
      return updated;
    },
  );

  // ── Registrar cobro de cuenta corriente (movimiento INGRESO) ──
  fastify.post(
    '/admin/mayoristas/:id/cobros',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
          cuentaId: z.string().uuid(),
          metodo: z.enum(METODOS).default('TRANSFERENCIA'),
          fecha: z.string().datetime().optional(),
          numeroReferencia: z.string().max(80).optional(),
          observacion: z.string().max(500).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as {
        monto: string;
        cuentaId: string;
        metodo: (typeof METODOS)[number];
        fecha?: string;
        numeroReferencia?: string;
        observacion?: string;
      };
      const cliente = await prisma.clienteMayorista.findUnique({ where: { id } });
      if (!cliente) return reply.code(404).send({ error: 'Cliente no encontrado' });

      const categoriaId = await getCategoriaCobroId();
      const monto = Number(b.monto);
      const fecha = b.fecha ? new Date(b.fecha) : new Date();
      const obs = `Cobro ${cliente.nombre}${b.observacion ? ' · ' + b.observacion : ''}`;

      const mov = await prisma.$transaction(async (tx) => {
        const m = await tx.movimiento.create({
          data: {
            tipo: 'INGRESO',
            monto: b.monto,
            categoriaId,
            cuentaDestinoId: b.cuentaId,
            entidadId: cliente.id,
            fechaComputo: fecha,
            observacion: obs,
            estado: EstadoMovimiento.CONFIRMADO,
            usuarioId: req.usuario!.id,
          },
        });
        await tx.pago.create({
          data: {
            movimientoId: m.id,
            metodo: b.metodo,
            cuentaId: b.cuentaId,
            monto: b.monto,
            numeroReferencia: b.numeroReferencia ?? null,
            estado: 'CONFIRMADO',
            fecha,
          },
        });
        await tx.cuenta.update({
          where: { id: b.cuentaId },
          data: { saldoActual: { increment: monto } },
        });
        return m;
      });
      await recordAudit({
        tabla: 'movimientos',
        registroId: mov.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { tipo: 'INGRESO', concepto: 'Cobro cuenta corriente', cliente: cliente.nombre, monto: b.monto },
      });
      return reply.code(201).send(mov);
    },
  );
}
