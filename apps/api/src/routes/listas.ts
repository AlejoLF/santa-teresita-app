import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { RolUsuario, CanalListaPrecios } from '@sta/db';
import { recordAudit } from '../services/audit.js';

/**
 * Gestión de LISTAS DE PRECIOS (pestaña dentro de Catálogo).
 *
 * MODELO DE PRECIOS (3 tipos de lista):
 *
 *  - PÚBLICA (canal LOCAL_MOSTRADOR): el precio = `producto.precioBase`. Es la
 *    fuente de verdad del precio al público. Editar acá actualiza precioBase.
 *    Todos los productos pertenecen (implícito).
 *
 *  - CANAL (RAPPI/PEDIDOS_YA/MERCADO_LIBRE/DELIVERATE/etc.): el precio es
 *    DERIVADO = precioBase × (1 + ajuste%). No guarda precios por producto: si
 *    cambia el público, estas listas lo siguen solas. Solo se edita el % global.
 *    Todos los productos pertenecen (implícito).
 *
 *  - CUSTOM (canal MAYORISTA): precios EXPLÍCITOS por producto (PrecioPorLista),
 *    independientes. La membresía es por producto (checkbox). Editable.
 *
 * Así el precio efectivo de una venta sigue resolviéndose como
 * `precioEfectivo (si hay override) || precioBase × (1 + ajuste)`, sin cambios.
 */

type TipoLista = 'PUBLICA' | 'CANAL' | 'CUSTOM';
function tipoDeLista(canal: CanalListaPrecios): TipoLista {
  if (canal === CanalListaPrecios.LOCAL_MOSTRADOR) return 'PUBLICA';
  if (canal === CanalListaPrecios.MAYORISTA) return 'CUSTOM';
  return 'CANAL';
}

export default async function listasRoutes(fastify: FastifyInstance) {
  // ── Listado de listas ──
  fastify.get('/admin/listas', { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) }, async () => {
    const listas = await prisma.listaPrecios.findMany({
      orderBy: [{ activa: 'desc' }, { nombre: 'asc' }],
    });
    const counts = await prisma.precioPorLista.groupBy({
      by: ['listaId'],
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((c) => [c.listaId, c._count._all]));
    const totalActivos = await prisma.producto.count({ where: { activo: true } });

    return {
      listas: listas.map((l) => {
        const tipo = tipoDeLista(l.canalDefault);
        return {
          id: l.id,
          nombre: l.nombre,
          canalDefault: l.canalDefault,
          tipo,
          ajustePctDefault: l.ajustePctDefault.toString(),
          activa: l.activa,
          // CUSTOM cuenta sus miembros; PÚBLICA/CANAL incluyen a todos.
          productos: tipo === 'CUSTOM' ? (countMap.get(l.id) ?? 0) : totalActivos,
        };
      }),
    };
  });

  // ── Detalle: productos agrupados por categoría ──
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
      const tipo = tipoDeLista(lista.canalDefault);
      const ajuste = Number(lista.ajustePctDefault);

      const productos = await prisma.producto.findMany({
        where: { activo: true },
        include: {
          tipoProducto: { include: { categoria: true } },
          preciosPorLista:
            tipo === 'CUSTOM'
              ? { where: { listaId: id }, orderBy: { vigenciaDesde: 'desc' }, take: 1 }
              : false,
        },
        orderBy: [
          { tipoProducto: { categoria: { orden: 'asc' } } },
          { tipoProducto: { orden: 'asc' } },
          { nombre: 'asc' },
        ],
      });

      const porCategoria = new Map<
        string,
        { id: string; nombre: string; orden: number; productos: unknown[] }
      >();
      for (const p of productos) {
        const cat = p.tipoProducto.categoria;
        if (!porCategoria.has(cat.id)) {
          porCategoria.set(cat.id, { id: cat.id, nombre: cat.nombre, orden: cat.orden, productos: [] });
        }
        const base = Number(p.precioBase);
        let precio: number;
        let enLista: boolean;
        if (tipo === 'PUBLICA') {
          precio = base;
          enLista = true;
        } else if (tipo === 'CANAL') {
          precio = base * (1 + ajuste / 100);
          enLista = true;
        } else {
          // CUSTOM
          const override = (p as { preciosPorLista?: Array<{ precioEfectivo: unknown }> })
            .preciosPorLista?.[0]?.precioEfectivo;
          enLista = override != null;
          precio = override != null ? Number(override) : base * (1 + ajuste / 100);
        }
        porCategoria.get(cat.id)!.productos.push({
          id: p.id,
          nombre: p.nombre,
          codigo: p.codigo,
          unidadPrecio: p.unidadPrecio,
          unidadPrecioLabel: p.unidadPrecioLabel,
          precioBase: p.precioBase.toFixed(2),
          enLista,
          precio: precio.toFixed(2),
        });
      }
      const categorias = [...porCategoria.values()].sort((a, b) => a.orden - b.orden);

      return {
        lista: {
          id: lista.id,
          nombre: lista.nombre,
          canalDefault: lista.canalDefault,
          tipo,
          ajustePctDefault: lista.ajustePctDefault.toString(),
          activa: lista.activa,
          // Qué puede editar la UI:
          editablePorProducto: tipo === 'PUBLICA' || tipo === 'CUSTOM',
          editableMembresia: tipo === 'CUSTOM',
          editableAjuste: tipo === 'CANAL' || tipo === 'CUSTOM',
        },
        categorias,
      };
    },
  );

  // ── Crear lista (siempre CUSTOM / mayorista) ──
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
          canalDefault: CanalListaPrecios.MAYORISTA,
          ajustePctDefault: b.ajustePctDefault.toFixed(4),
          activa: true,
        },
      });

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
          data: prods.map((p) => ({
            productoId: p.id,
            listaId: lista.id,
            precioEfectivo: (Number(p.precioBase) * (1 + b.ajustePctDefault / 100)).toFixed(2),
            vigenciaDesde: new Date(),
          })),
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

  // ── Eliminar lista (soft-delete; solo CUSTOM) ──
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
      if (tipoDeLista(lista.canalDefault) !== 'CUSTOM') {
        return reply.code(400).send({
          error: 'Solo se pueden eliminar listas custom (no la pública ni las de canal).',
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

  // ── Guardar precios (bulk). Comportamiento según tipo de lista ──
  //   PÚBLICA → cada precio actualiza producto.precioBase (las listas de canal
  //             lo siguen solas).
  //   CUSTOM  → upsert/baja de PrecioPorLista.
  //   CANAL   → rechazado (sus precios se ajustan con el % global, no por producto).
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
      const tipo = tipoDeLista(lista.canalDefault);

      if (tipo === 'CANAL') {
        return reply.code(400).send({
          error:
            'Las listas de canal (RAPPI/PYA/ML/...) se ajustan con el % global, no producto por producto.',
        });
      }

      if (tipo === 'PUBLICA') {
        // Actualiza el precio base de cada producto (= precio al público).
        await prisma.$transaction(
          b.upserts.map((u) =>
            prisma.producto.update({
              where: { id: u.productoId },
              data: { precioBase: u.precioEfectivo },
            }),
          ),
        );
      } else {
        // CUSTOM: upsert/baja de PrecioPorLista.
        await prisma.$transaction(async (tx) => {
          if (b.remove.length > 0) {
            await tx.precioPorLista.deleteMany({
              where: { listaId: id, productoId: { in: b.remove } },
            });
          }
          for (const u of b.upserts) {
            await tx.precioPorLista.deleteMany({
              where: { listaId: id, productoId: u.productoId },
            });
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
      }

      await recordAudit({
        tabla: 'listas_precios',
        registroId: id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorNuevo: { tipo, precios_actualizados: b.upserts.length, bajas: b.remove.length },
      });
      return { ok: true, actualizados: b.upserts.length, bajas: b.remove.length };
    },
  );

  // ── Agregar todos los productos de una categoría a una lista CUSTOM ──
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
      if (tipoDeLista(lista.canalDefault) !== 'CUSTOM') {
        return reply.code(400).send({
          error: 'La pública y las de canal ya incluyen todos los productos.',
        });
      }
      const ajuste = Number(lista.ajustePctDefault);
      const productos = await prisma.producto.findMany({
        where: { activo: true, tipoProducto: { categoriaId } },
        select: { id: true, precioBase: true },
      });
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
