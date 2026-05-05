import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';

export default async function catalogoRoutes(fastify: FastifyInstance) {
  // GET /catalogo/categorias — todas las categorías activas con sus tipos.
  fastify.get('/catalogo/categorias', { preHandler: fastify.requireAuth() }, async () => {
    const categorias = await prisma.categoria.findMany({
      where: { activa: true },
      orderBy: { orden: 'asc' },
      include: {
        tipos: {
          where: { activo: true },
          orderBy: [{ orden: 'asc' }, { nombre: 'asc' }],
        },
      },
    });
    return { categorias };
  });

  // GET /catalogo/productos — productos activos, con búsqueda por nombre o código.
  fastify.get(
    '/catalogo/productos',
    {
      preHandler: fastify.requireAuth(),
      schema: {
        querystring: z.object({
          tipoProductoId: z.string().uuid().optional(),
          q: z.string().optional(),
          listaPreciosId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(2000).default(1000),
        }),
      },
    },
    async (req) => {
      const q = req.query as {
        tipoProductoId?: string;
        q?: string;
        listaPreciosId?: string;
        limit: number;
      };

      // Si la búsqueda es solo dígitos (1-4), buscamos por código exacto o prefijo.
      const buscarPorCodigo = q.q && /^\d{1,4}$/.test(q.q.trim());

      const productos = await prisma.producto.findMany({
        where: {
          activo: true,
          tipoProductoId: q.tipoProductoId,
          ...(q.q && {
            OR: buscarPorCodigo
              ? [
                  { codigo: q.q.trim().padStart(4, '0') },
                  { codigo: { startsWith: q.q.trim() } },
                ]
              : [
                  { nombre: { contains: q.q, mode: 'insensitive' as const } },
                  { codigo: { contains: q.q, mode: 'insensitive' as const } },
                ],
          }),
        },
        include: {
          tipoProducto: {
            include: {
              categoria: true,
              // Modificadores heredados del tipo (ej: el grupo "Sabor — Ravioles"
              // aplica a todos los productos del tipo Ravioles).
              modificadores: {
                include: {
                  grupoModificador: {
                    include: {
                      opciones: { where: { activa: true }, orderBy: { orden: 'asc' } },
                    },
                  },
                },
              },
            },
          },
          // Modificadores específicos de este producto (override puntual).
          modificadores: {
            include: {
              grupoModificador: {
                include: { opciones: { where: { activa: true }, orderBy: { orden: 'asc' } } },
              },
            },
          },
          preciosPorLista: q.listaPreciosId
            ? { where: { listaId: q.listaPreciosId }, take: 1 }
            : false,
        },
        orderBy: [
          { tipoProducto: { categoria: { orden: 'asc' } } },
          { tipoProducto: { orden: 'asc' } },
          { codigo: 'asc' },
        ],
        take: q.limit,
      });

      // Sabores: el código viene del campo `OpcionModificador.codigo` (asignado en el seed).
      // Si está vacío, fallback a código derivado del producto (legacy).
      // incluyeSalsa: detectado por nombre del tipoProducto.
      //   "Ravioles porción simple" → SIMPLE
      //   "Lasagna porción especial" → ESPECIAL
      const productosConSabores = productos.map((p) => {
        const todosLosMods = [...p.modificadores, ...p.tipoProducto.modificadores];
        const grupoSabor = todosLosMods[0]?.grupoModificador;
        const sabores = grupoSabor
          ? grupoSabor.opciones.map((o, idx) => ({
              opcionId: o.id,
              grupoId: grupoSabor.id,
              grupoNombre: grupoSabor.nombre,
              nombre: o.nombre,
              deltaPrecio: o.deltaPrecio.toString(),
              codigo:
                (o as { codigo?: string | null }).codigo ??
                (p.codigo ? `${p.codigo}${String(idx + 1).padStart(2, '0')}` : null),
            }))
          : [];

        const tipoLower = p.tipoProducto.nombre.toLowerCase();
        const incluyeSalsa: 'SIMPLE' | 'ESPECIAL' | null = tipoLower.endsWith('porción simple')
          ? 'SIMPLE'
          : tipoLower.endsWith('porción especial')
            ? 'ESPECIAL'
            : null;

        return {
          ...p,
          modificadores: todosLosMods,
          saboresResumen: sabores.map((s) => s.nombre).slice(0, 8),
          sabores,
          incluyeSalsa,
        };
      });

      return { productos: productosConSabores };
    },
  );

  // GET /catalogo/buscar-por-codigo/:codigo — búsqueda exacta por código (Enter en barra).
  //
  // Sistema Santa Teresita:
  //   - Códigos cortos (1-4 dígitos) memorizables.
  //   - Cada SABOR tiene su código único: "0" = Ravioles VYR, "60" = Salsa Príncipe, etc.
  //   - Cada PRODUCTO standalone tiene su código: "8" = Ñoquis, "12" = Lasagna.
  //   - Resolución: primero buscamos en sabor.codigo, después en producto.codigo.
  //   - Si match con sabor → devolvemos el producto + saborPreseleccionado.
  //   - Si match con producto → devolvemos el producto sin saborPreseleccionado.
  //   - Legacy: 4 dígitos (ej "0042") → busca producto con codigo padded.
  //   - Legacy: 6 dígitos (ej "001102") → producto+sabor por índice (compatibilidad).
  fastify.get(
    '/catalogo/buscar-por-codigo/:codigo',
    {
      preHandler: fastify.requireAuth(),
      schema: { params: z.object({ codigo: z.string().regex(/^\d{1,6}$/) }) },
    },
    async (req, reply) => {
      const params = req.params as { codigo: string };
      const codigo = params.codigo;

      // Helper: incluir relaciones completas del producto
      const productoInclude = {
        tipoProducto: {
          include: {
            categoria: true,
            modificadores: {
              include: {
                grupoModificador: {
                  include: { opciones: { where: { activa: true }, orderBy: { orden: 'asc' } } },
                },
              },
            },
          },
        },
        modificadores: {
          include: {
            grupoModificador: {
              include: { opciones: { where: { activa: true }, orderBy: { orden: 'asc' } } },
            },
          },
        },
      } as const;

      // 1) Códigos cortos (1-4 dígitos sin padding) → buscar primero como SABOR
      if (/^\d{1,4}$/.test(codigo)) {
        const sabor = await prisma.opcionModificador.findFirst({
          where: { codigo, activa: true },
          include: { grupo: { include: { aplicables: { include: { tipoProducto: true, producto: true } } } } },
        });
        if (sabor) {
          // Resolvemos el producto a partir del aplicable
          let producto = null as Awaited<ReturnType<typeof prisma.producto.findFirst>> | null;
          for (const a of sabor.grupo.aplicables) {
            if (a.producto) {
              producto = await prisma.producto.findUnique({
                where: { id: a.producto.id, activo: true },
                include: productoInclude,
              });
              if (producto) break;
            }
            if (a.tipoProducto) {
              producto = await prisma.producto.findFirst({
                where: { tipoProductoId: a.tipoProducto.id, activo: true },
                include: productoInclude,
              });
              if (producto) break;
            }
          }
          if (!producto) {
            return reply.code(404).send({ error: `Sabor "${sabor.nombre}" sin producto activo` });
          }
          const todosLosMods = [...producto.modificadores, ...producto.tipoProducto.modificadores];
          return {
            producto: { ...producto, modificadores: todosLosMods },
            saborPreseleccionado: { opcionId: sabor.id, grupoId: sabor.grupoId, nombre: sabor.nombre },
          };
        }

        // 2) No hay sabor con ese código → buscar como producto directo
        const producto = await prisma.producto.findFirst({
          where: { codigo, activo: true },
          include: productoInclude,
        });
        if (producto) {
          const todosLosMods = [...producto.modificadores, ...producto.tipoProducto.modificadores];
          return {
            producto: { ...producto, modificadores: todosLosMods },
            saborPreseleccionado: null,
          };
        }

        // 3) Compatibilidad legacy: padding a 4 dígitos
        const codigoPadded = codigo.padStart(4, '0');
        if (codigoPadded !== codigo) {
          const productoLegacy = await prisma.producto.findFirst({
            where: { codigo: codigoPadded, activo: true },
            include: productoInclude,
          });
          if (productoLegacy) {
            const todosLosMods = [...productoLegacy.modificadores, ...productoLegacy.tipoProducto.modificadores];
            return {
              producto: { ...productoLegacy, modificadores: todosLosMods },
              saborPreseleccionado: null,
            };
          }
        }

        return reply.code(404).send({ error: `Sin producto/sabor con código ${codigo}` });
      }

      // Legacy 6 dígitos: producto+sabor por índice
      if (codigo.length === 6) {
        const codigoProd = codigo.slice(0, 4);
        const saborIdx = Number(codigo.slice(4)) - 1;
        const productoLegacy = await prisma.producto.findFirst({
          where: { codigo: codigoProd, activo: true },
          include: productoInclude,
        });
        if (!productoLegacy) {
          return reply.code(404).send({ error: `Sin producto con código ${codigoProd}` });
        }
        const todosLosMods = [...productoLegacy.modificadores, ...productoLegacy.tipoProducto.modificadores];
        const grupo = todosLosMods[0]?.grupoModificador;
        const opcion = grupo?.opciones[saborIdx];
        if (!opcion) {
          return reply.code(404).send({ error: `Sin sabor #${saborIdx + 1} para el producto ${codigoProd}` });
        }
        return {
          producto: { ...productoLegacy, modificadores: todosLosMods },
          saborPreseleccionado: { opcionId: opcion.id, grupoId: grupo!.id, nombre: opcion.nombre },
        };
      }

      return reply.code(400).send({ error: 'Códigos válidos: 1-4 dígitos (cortos) o 6 dígitos (legacy)' });
    },
  );

  // GET /catalogo/salsa/:tipo — devuelve el producto Salsa simple/especial con sus sabores
  // Lo usa el frontend para abrir el modal de salsa después de cargar una pasta porción.
  fastify.get(
    '/catalogo/salsa/:tipo',
    {
      preHandler: fastify.requireAuth(),
      schema: { params: z.object({ tipo: z.enum(['SIMPLE', 'ESPECIAL']) }) },
    },
    async (req, reply) => {
      const { tipo } = req.params as { tipo: 'SIMPLE' | 'ESPECIAL' };
      const nombreProducto = tipo === 'SIMPLE' ? 'Salsa simple' : 'Salsa especial';
      const producto = await prisma.producto.findFirst({
        where: { nombre: nombreProducto, activo: true },
        include: {
          tipoProducto: { include: { categoria: true } },
          modificadores: {
            include: {
              grupoModificador: {
                include: { opciones: { where: { activa: true }, orderBy: { orden: 'asc' } } },
              },
            },
          },
        },
      });
      if (!producto) {
        return reply.code(404).send({ error: `No existe el producto "${nombreProducto}"` });
      }
      const grupo = producto.modificadores[0]?.grupoModificador;
      const sabores = grupo
        ? grupo.opciones.map((o) => ({
            opcionId: o.id,
            grupoId: grupo.id,
            grupoNombre: grupo.nombre,
            nombre: o.nombre,
            deltaPrecio: o.deltaPrecio.toString(),
            codigo: (o as { codigo?: string | null }).codigo ?? null,
          }))
        : [];
      return {
        producto: {
          id: producto.id,
          codigo: producto.codigo,
          nombre: producto.nombre,
          precioBase: producto.precioBase.toString(),
          formaVenta: producto.formaVenta,
          unidadPrecio: producto.unidadPrecio,
          tipoProducto: {
            id: producto.tipoProducto.id,
            nombre: producto.tipoProducto.nombre,
            cocinaInterviene: producto.tipoProducto.cocinaInterviene,
            categoria: { id: producto.tipoProducto.categoria.id, nombre: producto.tipoProducto.categoria.nombre },
          },
        },
        sabores,
      };
    },
  );

  // GET /catalogo/listas-precios
  fastify.get('/catalogo/listas-precios', { preHandler: fastify.requireAuth() }, async () => {
    const listas = await prisma.listaPrecios.findMany({
      where: { activa: true },
      orderBy: { nombre: 'asc' },
    });
    return { listas };
  });

  // GET /catalogo/cuentas — cuentas activas (vendedor las necesita para registrar pagos)
  fastify.get('/catalogo/cuentas', { preHandler: fastify.requireAuth() }, async () => {
    const cuentas = await prisma.cuenta.findMany({
      where: { activa: true },
      select: { id: true, nombre: true, tipo: true },
      orderBy: { nombre: 'asc' },
    });
    return { cuentas };
  });

  // GET /catalogo/top — Top 3 productos vendidos en los últimos 30 días por categoría.
  // Versión simple: mock estable en dev (categoría → 3 productos al azar). Cuando hayan
  // ventas reales, se reemplaza con un query agregado.
  fastify.get(
    '/catalogo/top',
    {
      preHandler: fastify.requireAuth(),
      schema: { querystring: z.object({ categoriaId: z.string().uuid().optional() }) },
    },
    async (req) => {
      const q = req.query as { categoriaId?: string };
      const productos = await prisma.producto.findMany({
        where: {
          activo: true,
          ...(q.categoriaId && { tipoProducto: { categoriaId: q.categoriaId } }),
        },
        include: { tipoProducto: { include: { categoria: true } } },
        take: 3,
      });
      return { productos };
    },
  );
}
