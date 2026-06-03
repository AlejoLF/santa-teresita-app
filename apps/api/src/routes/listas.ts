import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
import { RolUsuario, CanalListaPrecios } from '@sta/db';
import { recordAudit } from '../services/audit.js';

/**
 * Gestión de LISTAS DE PRECIOS (pestaña dentro de Catálogo).
 *
 * Modelo: un PRODUCTO es único; su precio en cada lista vive en PrecioPorLista
 * (precioEfectivo). "Pertenecer a una lista" = tener una fila PrecioPorLista
 * para esa lista. Las listas custom (mayoristas) usan canalDefault = MAYORISTA
 * para no colisionar con la resolución por canal de la venta.
 *
 * El precio efectivo de una venta se resuelve: precioEfectivo (si está en la
 * lista) || precioBase × (1 + ajustePctDefault). Por eso agregar un producto a
 * una lista materializa su precio (editable después).
 */

async function precioBaseConAjuste(precioBase: Prisma.Decimal | number, ajustePct: number): Promise<string> {
  return (Number(precioBase) * (1 + ajustePct / 100)).toFixed(2);
}

export default async function listasRoutes(fastify: FastifyInstance) {
  // ── Listado de listas con conteo de productos ──
  fastify.get(
    '/admin/listas',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const listas = await prisma.listaPrecios.findMany({
        orderBy: [{ activa: 'desc' }, { nombre: 'asc' }],
      });
      const counts = await prisma.precioPorLista.groupBy({
        by: ['listaId'],
        _count: { _all: true },
      });
      const countMap = new Map(counts.map((c) => [c.listaId, c._count._all]));
      return {
        listas: listas.map((l) => ({
          id: l.id,
          nombre: l.nombre,
          canalDefault: l.canalDefault,
          ajustePctDefault: l.ajustePctDefault.toString(),
          activa: l.activa,
          // Lista "de sistema": las atadas a un canal de venta (no se borran).
          esCanal: l.canalDefault !== CanalListaPrecios.MAYORISTA,
          productos: countMap.get(l.id) ?? 0,
        })),
      };
    },
  );

  // ── Detalle de una lista: productos agrupados por categoría ──
  // Devuelve TODOS los productos activos (en y fuera de la lista) para soportar
  // tanto la vista (filtrar enLista) como la edición (marcar/desmarcar).
  fastify.get(
    '/admin/listas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const lista = await prisma.listaPrecios.findUnique({ where: { id } });
      if (!lista) return reply.code(404).send({ error: 'Lista no encontrada' });
      const ajuste = Number(lista.ajustePctDefault);

      const productos = await prisma.producto.findMany({
        where: { activo: true },
        include: {
          tipoProducto: { include: { categoria: true } },
          preciosPorLista: { where: { listaId: id }, orderBy: { vigenciaDesde: 'desc' }, take: 1 },
        },
        orderBy: [
          { tipoProducto: { categoria: { orden: 'asc' } } },
          { tipoProducto: { orden: 'asc' } },
          { nombre: 'asc' },
        ],
      });

      // Agrupar por categoría
      const porCategoria = new Map<
        string,
        { id: string; nombre: string; orden: number; productos: unknown[] }
      >();
      for (const p of productos) {
        const cat = p.tipoProducto.categoria;
        if (!porCategoria.has(cat.id)) {
          porCategoria.set(cat.id, { id: cat.id, nombre: cat.nombre, orden: cat.orden, productos: [] });
        }
        const enLista = p.preciosPorLista.length > 0;
        porCategoria.get(cat.id)!.productos.push({
          id: p.id,
          nombre: p.nombre,
          codigo: p.codigo,
          unidadPrecio: p.unidadPrecio,
          unidadPrecioLabel: p.unidadPrecioLabel,
          precioBase: p.precioBase.toFixed(2),
          enLista,
          // Precio en la lista: el efectivo si está, sino el sugerido (base × ajuste).
          precioEfectivo: enLista
            ? p.preciosPorLista[0]!.precioEfectivo.toFixed(2)
            : (Number(p.precioBase) * (1 + ajuste / 100)).toFixed(2),
        });
      }
      const categorias = [...porCategoria.values()].sort((a, b) => a.orden - b.orden);

      return {
        lista: {
          id: lista.id,
          nombre: lista.nombre,
          canalDefault: lista.canalDefault,
          ajustePctDefault: lista.ajustePctDefault.toString(),
          activa: lista.activa,
          esCanal: lista.canalDefault !== CanalListaPrecios.MAYORISTA,
        },
        categorias,
      };
    },
  );

  // ── Crear lista (opcionalmente con productos/categorías iniciales) ──
  fastify.post(
    '/admin/listas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(80),
          ajustePctDefault: z.coerce.number().default(0),
          productoIds: z.array(z.string().uuid()).optional(),
          categoriaIds: z.array(z.string().uuid()).optional(),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body as {
        nombre: string;
        ajustePctDefault: number;
        productoIds?: string[];
        categoriaIds?: string[];
      };
      const dup = await prisma.listaPrecios.findUnique({ where: { nombre: b.nombre } });
      if (dup) return reply.code(400).send({ error: 'Ya existe una lista con ese nombre' });

      const lista = await prisma.listaPrecios.create({
        data: {
          nombre: b.nombre,
          canalDefault: CanalListaPrecios.MAYORISTA, // lista custom — no es un canal de venta
          ajustePctDefault: b.ajustePctDefault.toFixed(4),
          activa: true,
        },
      });

      // Resolver productos iniciales: explícitos + los de las categorías elegidas.
      const ids = new Set(b.productoIds ?? []);
      if (b.categoriaIds && b.categoriaIds.length > 0) {
        const prods = await prisma.producto.findMany({
          where: { activo: true, tipoProducto: { categoriaId: { in: b.categoriaIds } } },
          select: { id: true },
        });
        prods.forEach((p) => ids.add(p.id));
      }
      if (ids.size > 0) {
        const prods = await prisma.producto.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, precioBase: true },
        });
        await prisma.precioPorLista.createMany({
          data: await Promise.all(
            prods.map(async (p) => ({
              productoId: p.id,
              listaId: lista.id,
              precioEfectivo: await precioBaseConAjuste(p.precioBase, b.ajustePctDefault),
              vigenciaDesde: new Date(),
            })),
          ),
        });
      }

      await recordAudit({
        tabla: 'listas_precios',
        registroId: lista.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: lista.nombre, productosIniciales: ids.size },
      });
      return reply.code(201).send(lista);
    },
  );

  // ── Editar lista (nombre / ajuste / activa) ──
  fastify.patch(
    '/admin/listas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(80).optional(),
          ajustePctDefault: z.coerce.number().optional(),
          activa: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { nombre?: string; ajustePctDefault?: number; activa?: boolean };
      const lista = await prisma.listaPrecios.findUnique({ where: { id } });
      if (!lista) return reply.code(404).send({ error: 'Lista no encontrada' });
      if (b.nombre && b.nombre !== lista.nombre) {
        const dup = await prisma.listaPrecios.findUnique({ where: { nombre: b.nombre } });
        if (dup) return reply.code(400).send({ error: 'Ya existe una lista con ese nombre' });
      }
      const updated = await prisma.listaPrecios.update({
        where: { id },
        data: {
          ...(b.nombre !== undefined && { nombre: b.nombre }),
          ...(b.ajustePctDefault !== undefined && {
            ajustePctDefault: b.ajustePctDefault.toFixed(4),
          }),
          ...(b.activa !== undefined && { activa: b.activa }),
        },
      });
      await recordAudit({
        tabla: 'listas_precios',
        registroId: id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorNuevo: b as Record<string, unknown>,
      });
      return updated;
    },
  );

  // ── Eliminar lista (soft-delete: activa=false) ──
  // No hard-delete: las ventas referencian listaPreciosId. Las de canal de venta
  // no se pueden eliminar (romperían el pricing por canal).
  fastify.delete(
    '/admin/listas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const lista = await prisma.listaPrecios.findUnique({ where: { id } });
      if (!lista) return reply.code(404).send({ error: 'Lista no encontrada' });
      if (lista.canalDefault !== CanalListaPrecios.MAYORISTA) {
        return reply.code(400).send({
          error:
            'No se puede eliminar una lista de canal de venta (Venta al público / RAPPI / etc.). Solo se pueden eliminar listas custom.',
        });
      }
      await prisma.listaPrecios.update({ where: { id }, data: { activa: false } });
      await recordAudit({
        tabla: 'listas_precios',
        registroId: id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: lista.nombre },
      });
      return { ok: true };
    },
  );

  // ── Guardar precios de la lista (bulk upsert + remove) ──
  // El frontend hace los cálculos (aumento global %, valor fijo, ediciones
  // individuales con antes/después) y manda el set final de precios + las
  // bajas. Acá solo persistimos.
  fastify.put(
    '/admin/listas/:id/precios',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          upserts: z
            .array(
              z.object({
                productoId: z.string().uuid(),
                precioEfectivo: z.string().regex(/^\d+(\.\d{1,2})?$/),
              }),
            )
            .default([]),
          remove: z.array(z.string().uuid()).default([]),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as {
        upserts: Array<{ productoId: string; precioEfectivo: string }>;
        remove: string[];
      };
      const lista = await prisma.listaPrecios.findUnique({ where: { id } });
      if (!lista) return reply.code(404).send({ error: 'Lista no encontrada' });

      await prisma.$transaction(async (tx) => {
        // Bajas: borrar PrecioPorLista del producto en esta lista.
        if (b.remove.length > 0) {
          await tx.precioPorLista.deleteMany({
            where: { listaId: id, productoId: { in: b.remove } },
          });
        }
        // Altas/cambios: como no hay unique (productoId, listaId), borramos y
        // recreamos para dejar una sola fila vigente por producto.
        for (const u of b.upserts) {
          await tx.precioPorLista.deleteMany({ where: { listaId: id, productoId: u.productoId } });
          await tx.precioPorLista.create({
            data: {
              productoId: u.productoId,
              listaId: id,
              precioEfectivo: u.precioEfectivo,
              vigenciaDesde: new Date(),
              usuarioId: req.usuario!.id,
            },
          });
        }
      });

      await recordAudit({
        tabla: 'listas_precios',
        registroId: id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorNuevo: { precios_actualizados: b.upserts.length, bajas: b.remove.length },
      });
      return { ok: true, actualizados: b.upserts.length, bajas: b.remove.length };
    },
  );

  // ── Agregar todos los productos de una categoría a la lista (bulk) ──
  fastify.post(
    '/admin/listas/:id/agregar-categoria',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ categoriaId: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { categoriaId } = req.body as { categoriaId: string };
      const lista = await prisma.listaPrecios.findUnique({ where: { id } });
      if (!lista) return reply.code(404).send({ error: 'Lista no encontrada' });
      const ajuste = Number(lista.ajustePctDefault);

      const productos = await prisma.producto.findMany({
        where: { activo: true, tipoProducto: { categoriaId } },
        select: { id: true, precioBase: true },
      });
      // Saltear los que ya están en la lista.
      const yaEn = await prisma.precioPorLista.findMany({
        where: { listaId: id, productoId: { in: productos.map((p) => p.id) } },
        select: { productoId: true },
      });
      const yaSet = new Set(yaEn.map((y) => y.productoId));
      const aAgregar = productos.filter((p) => !yaSet.has(p.id));

      if (aAgregar.length > 0) {
        await prisma.precioPorLista.createMany({
          data: aAgregar.map((p) => ({
            productoId: p.id,
            listaId: id,
            precioEfectivo: (Number(p.precioBase) * (1 + ajuste / 100)).toFixed(2),
            vigenciaDesde: new Date(),
          })),
        });
      }
      return { ok: true, agregados: aAgregar.length, yaEstaban: yaSet.size };
    },
  );
}
