import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import {
  RolUsuario,
  EstadoFacturaRecibida,
  EstadoMovimiento,
  EstadoPago,
} from '@sta/db';
import { queryBool } from '@sta/shared/schemas';
import { recordAudit } from '../services/audit.js';
import { calcSaldoFactura } from '../services/facturas.js';

/**
 * Endpoints para proveedores, facturas recibidas y el flujo de pago multi-cuenta
 * (Wireframe 08 / SPEC §5.6).
 */
export default async function proveedoresRoutes(fastify: FastifyInstance) {
  // ──────────────────────────────────────────────────────────────────────
  //   PROVEEDORES
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/proveedores — lista con saldo adeudado calculado
  fastify.get(
    '/admin/proveedores',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          q: z.string().optional(),
          incluirInactivos: queryBool(false),
        }),
      },
    },
    async (req) => {
      const q = req.query as { q?: string; incluirInactivos: boolean };
      const proveedores = await prisma.proveedor.findMany({
        where: {
          ...(q.q && { nombre: { contains: q.q, mode: 'insensitive' as const } }),
          ...(q.incluirInactivos ? {} : { activo: true }),
        },
        orderBy: { nombre: 'asc' },
      });

      // Como `saldo` no es columna real (es total - totalPagado calculado),
      // traemos las facturas pendientes y los sumamos en app.
      const facturas = await prisma.facturaRecibida.findMany({
        where: { estado: { in: ['PENDIENTE_PAGO', 'PAGADA_PARCIAL'] } },
        select: {
          proveedorId: true,
          total: true,
          totalPagado: true,
          fechaVencimiento: true,
        },
      });
      const saldosMap = new Map<string, { saldo: number; cantidad: number; proxVenc: Date | null }>();
      for (const f of facturas) {
        const cur = saldosMap.get(f.proveedorId) ?? { saldo: 0, cantidad: 0, proxVenc: null };
        cur.saldo += calcSaldoFactura(f);
        cur.cantidad += 1;
        if (f.fechaVencimiento && (!cur.proxVenc || f.fechaVencimiento < cur.proxVenc)) {
          cur.proxVenc = f.fechaVencimiento;
        }
        saldosMap.set(f.proveedorId, cur);
      }

      return {
        proveedores: proveedores.map((p) => ({
          ...p,
          saldoAdeudado: (saldosMap.get(p.id)?.saldo ?? 0).toFixed(2),
          facturasPendientes: saldosMap.get(p.id)?.cantidad ?? 0,
          proximoVencimiento: saldosMap.get(p.id)?.proxVenc ?? null,
        })),
      };
    },
  );

  // GET /admin/proveedores/:id — detalle con facturas
  fastify.get(
    '/admin/proveedores/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const proveedor = await prisma.proveedor.findUnique({
        where: { id: params.id },
        include: {
          facturas: {
            orderBy: { fechaEmision: 'desc' },
            include: {
              pagosFactura: { include: { pago: { include: { cuenta: true } } } },
            },
          },
        },
      });
      if (!proveedor) return reply.code(404).send({ error: 'Proveedor no encontrado' });

      const facturas = proveedor.facturas.map((f) => ({
        ...f,
        saldo: (calcSaldoFactura(f)).toFixed(2),
      }));

      const saldoFacturas = facturas
        .filter((f) => ['PENDIENTE_PAGO', 'PAGADA_PARCIAL'].includes(f.estado))
        .reduce((acc, f) => acc + Number(f.saldo), 0);

      // Pagos "a cuenta corriente": pagos hechos al proveedor que NO están
      // asociados a una factura específica (pagosFactura join vacío). Ej:
      // se paga $200k de un saldo de $400k desde Movimientos — queda como
      // pago a cuenta sin asignar. La encargada después puede ir a "Pagar
      // facturas" y asignarlo a una específica si quiere. Mientras tanto,
      // descuenta del saldo total adeudado.
      const pagosRaw = await prisma.pago.findMany({
        where: {
          movimiento: { entidadId: params.id, tipo: 'EGRESO' },
          pagosFactura: { none: {} },
        },
        include: {
          cuenta: { select: { nombre: true } },
          movimiento: { select: { observacion: true } },
        },
        orderBy: { fecha: 'desc' },
      });
      const pagosACuenta = pagosRaw.map((p) => ({
        id: p.id,
        fecha: p.fecha.toISOString(),
        metodo: p.metodo,
        monto: p.monto.toFixed(2),
        cuentaNombre: p.cuenta?.nombre ?? null,
        numeroReferencia: p.numeroReferencia,
        observacion: p.movimiento?.observacion ?? null,
      }));

      // Saldo adeudado real = saldo de facturas pendientes - pagos a cuenta
      // sin asignar (que son créditos a favor del proveedor todavía no
      // imputados a ninguna factura).
      const totalPagosACuenta = pagosACuenta.reduce((acc, p) => acc + Number(p.monto), 0);
      const saldoAdeudado = Math.max(0, saldoFacturas - totalPagosACuenta);

      return {
        proveedor: { ...proveedor, facturas: undefined },
        facturas,
        pagosACuenta,
        saldoFacturas: saldoFacturas.toFixed(2),
        totalPagosACuenta: totalPagosACuenta.toFixed(2),
        saldoAdeudado: saldoAdeudado.toFixed(2),
      };
    },
  );

  // POST /admin/proveedores — crear proveedor
  fastify.post(
    '/admin/proveedores',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(120),
          razonSocial: z.string().max(160).optional(),
          cuit: z.string().max(20).optional(),
          condicionIva: z
            .enum(['RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL'])
            .optional(),
          telefono: z.string().max(40).optional(),
          email: z.string().email().optional(),
          categoriaPrincipal: z.string().max(80).optional(),
          plazoPagoDias: z.number().int().min(0).default(0),
          observaciones: z.string().max(500).optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        razonSocial?: string;
        cuit?: string;
        condicionIva?: 'RESPONSABLE_INSCRIPTO' | 'MONOTRIBUTO' | 'EXENTO' | 'CONSUMIDOR_FINAL';
        telefono?: string;
        email?: string;
        categoriaPrincipal?: string;
        plazoPagoDias?: number;
        observaciones?: string;
      };
      const created = await prisma.proveedor.create({
        data: {
          nombre: body.nombre,
          razonSocial: body.razonSocial ?? null,
          cuit: body.cuit ?? null,
          condicionIva: body.condicionIva ?? null,
          telefono: body.telefono ?? null,
          email: body.email ?? null,
          categoriaPrincipal: body.categoriaPrincipal ?? null,
          plazoPagoDias: body.plazoPagoDias ?? 0,
          observaciones: body.observaciones ?? null,
        },
      });
      await recordAudit({
        tabla: 'proveedores',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: created.nombre, cuit: created.cuit },
      });
      return reply.code(201).send(created);
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   FACTURAS RECIBIDAS
  // ──────────────────────────────────────────────────────────────────────

  // POST /admin/facturas — crear factura manualmente con desglose de items.
  fastify.post(
    '/admin/facturas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          proveedorId: z.string().uuid(),
          tipoComprobante: z.enum([
            'FACTURA_A',
            'FACTURA_B',
            'FACTURA_C',
            'FACTURA_X',
            'NOTA_CREDITO',
            'NOTA_DEBITO',
            'TICKET',
            'REMITO',
            'OTRO',
          ]),
          puntoVenta: z.string().max(20).optional(),
          numero: z.string().min(1).max(40),
          fechaEmision: z.string(),
          fechaComputo: z.string().optional(),
          fechaVencimiento: z.string().optional(),
          neto: z.string().regex(/^\d+(\.\d{1,2})?$/),
          iva: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
          total: z.string().regex(/^\d+(\.\d{1,2})?$/),
          observaciones: z.string().max(500).optional(),
          items: z
            .array(
              z.object({
                insumoId: z.string().uuid().nullable().optional(),
                descripcion: z.string().min(1).max(240),
                cantidad: z.string().regex(/^\d+(\.\d{1,3})?$/),
                unidad: z.string().min(1).max(20),
                precioUnitario: z.string().regex(/^\d+(\.\d{1,4})?$/),
                alicuotaIva: z.string().regex(/^\d+(\.\d{1,4})?$/).default('21'),
                subtotal: z.string().regex(/^\d+(\.\d{1,2})?$/),
              }),
            )
            .default([]),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        proveedorId: string;
        tipoComprobante: string;
        puntoVenta?: string;
        numero: string;
        fechaEmision: string;
        fechaComputo?: string;
        fechaVencimiento?: string;
        neto: string;
        iva: string;
        total: string;
        observaciones?: string;
        items: Array<{
          insumoId?: string | null;
          descripcion: string;
          cantidad: string;
          unidad: string;
          precioUnitario: string;
          alicuotaIva: string;
          subtotal: string;
        }>;
      };

      const fechaEm = new Date(body.fechaEmision);

      const created = await prisma.$transaction(async (tx) => {
        const factura = await tx.facturaRecibida.create({
          data: {
            proveedorId: body.proveedorId,
            tipoComprobante: body.tipoComprobante as never,
            puntoVenta: body.puntoVenta ?? null,
            numero: body.numero,
            fechaEmision: fechaEm,
            fechaComputo: new Date(body.fechaComputo ?? body.fechaEmision),
            fechaVencimiento: body.fechaVencimiento ? new Date(body.fechaVencimiento) : null,
            netoGravado: body.neto,
            iva21: body.iva,
            total: body.total,
            estado: EstadoFacturaRecibida.PENDIENTE_PAGO,
            origen: 'PROGRAMA_MANUAL',
            observaciones: body.observaciones ?? null,
            usuarioCargaId: req.usuario!.id,
            validadaAt: new Date(),
            usuarioValidacionId: req.usuario!.id,
            items: {
              create: body.items.map((it, idx) => ({
                insumoId: it.insumoId ?? null,
                descripcion: it.descripcion,
                cantidad: it.cantidad,
                unidad: it.unidad,
                precioUnitario: it.precioUnitario,
                alicuotaIva: it.alicuotaIva,
                subtotal: it.subtotal,
                orden: idx,
              })),
            },
          },
        });

        // Actualizar precio último por insumo+proveedor (si la factura es la más reciente vista)
        for (const it of body.items) {
          if (!it.insumoId) continue;
          const existing = await tx.insumoProveedor.findUnique({
            where: { insumoId_proveedorId: { insumoId: it.insumoId, proveedorId: body.proveedorId } },
          });
          if (!existing || !existing.fechaUltimoPrecio || existing.fechaUltimoPrecio < fechaEm) {
            await tx.insumoProveedor.upsert({
              where: {
                insumoId_proveedorId: { insumoId: it.insumoId, proveedorId: body.proveedorId },
              },
              create: {
                insumoId: it.insumoId,
                proveedorId: body.proveedorId,
                precioUltimo: it.precioUnitario,
                fechaUltimoPrecio: fechaEm,
                esPrincipal: false,
              },
              update: {
                precioUltimo: it.precioUnitario,
                fechaUltimoPrecio: fechaEm,
              },
            });
          }
        }

        return factura;
      });

      await recordAudit({
        tabla: 'facturas_recibidas',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: {
          numero: created.numero,
          total: created.total.toString(),
          itemsCount: body.items.length,
        },
      });
      return reply.code(201).send(created);
    },
  );

  // GET /admin/facturas/:id — detalle de factura con items
  fastify.get(
    '/admin/facturas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const factura = await prisma.facturaRecibida.findUnique({
        where: { id: params.id },
        include: {
          proveedor: { select: { id: true, nombre: true } },
          items: { include: { insumo: true }, orderBy: { orden: 'asc' } },
          pagosFactura: {
            include: { pago: { include: { cuenta: { select: { nombre: true } } } } },
          },
        },
      });
      if (!factura) return reply.code(404).send({ error: 'Factura no encontrada' });
      return {
        ...factura,
        saldo: (calcSaldoFactura(factura)).toFixed(2),
      };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   INSUMOS (catálogo persistente)
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/insumos-catalogo — lista de insumos con proveedor principal,
  // precio último y todos los proveedores que lo venden (para autocomplete +
  // pestaña "Insumos" del panel admin).
  fastify.get(
    '/admin/insumos-catalogo',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          q: z.string().optional(),
          proveedorId: z.string().uuid().optional(),
          categoria: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
      },
    },
    async (req) => {
      const q = req.query as {
        q?: string;
        proveedorId?: string;
        categoria?: string;
        limit: number;
      };
      const insumos = await prisma.insumo.findMany({
        where: {
          activo: true,
          ...(q.q && { nombre: { contains: q.q, mode: 'insensitive' as const } }),
          ...(q.categoria && { categoria: q.categoria as never }),
          ...(q.proveedorId && {
            proveedoresVinculo: { some: { proveedorId: q.proveedorId } },
          }),
        },
        include: {
          proveedorPrincipal: { select: { id: true, nombre: true } },
          proveedoresVinculo: {
            include: {
              proveedor: { select: { id: true, nombre: true, activo: true } },
            },
          },
        },
        orderBy: { nombre: 'asc' },
        take: q.limit,
      });

      const ahora = Date.now();
      return {
        insumos: insumos.map((i) => {
          // Lista de proveedores que lo venden, con precio
          const proveedores = i.proveedoresVinculo
            .filter((v) => v.proveedor.activo)
            .map((v) => ({
              id: v.proveedor.id,
              nombre: v.proveedor.nombre,
              esPrincipal: v.esPrincipal,
              precioUltimo: v.precioUltimo?.toString() ?? null,
              fechaUltimoPrecio: v.fechaUltimoPrecio,
            }))
            .sort((a, b) => {
              // Principal primero, después por precio asc
              if (a.esPrincipal !== b.esPrincipal) return a.esPrincipal ? -1 : 1;
              const pa = a.precioUltimo ? Number(a.precioUltimo) : Infinity;
              const pb = b.precioUltimo ? Number(b.precioUltimo) : Infinity;
              return pa - pb;
            });

          // Precio "vigente" = el del proveedor principal si existe, sino el más bajo
          const vinculoPrincipal =
            proveedores.find((p) => p.esPrincipal) ??
            proveedores.find((p) => p.precioUltimo !== null) ??
            null;
          const precioVigente = vinculoPrincipal?.precioUltimo ?? null;
          const fechaVigente = vinculoPrincipal?.fechaUltimoPrecio ?? null;

          // Días desde último precio (para mostrar "actualizado hace X días")
          let diasDesdePrecio: number | null = null;
          let frescura: 'reciente' | 'medio' | 'viejo' | null = null;
          if (fechaVigente) {
            diasDesdePrecio = Math.floor(
              (ahora - new Date(fechaVigente).getTime()) / (1000 * 60 * 60 * 24),
            );
            if (diasDesdePrecio <= 14) frescura = 'reciente';
            else if (diasDesdePrecio <= 60) frescura = 'medio';
            else frescura = 'viejo';
          }

          return {
            id: i.id,
            nombre: i.nombre,
            categoria: i.categoria,
            unidadCompra: i.unidadCompra,
            presentacion: i.presentacion,
            stockActual: i.stockActual.toString(),
            stockMinimo: i.stockMinimo?.toString() ?? null,
            proveedorPrincipal: i.proveedorPrincipal,
            proveedores,
            precioVigente,
            fechaVigente,
            diasDesdePrecio,
            frescura,
          };
        }),
      };
    },
  );

  // POST /admin/insumos-catalogo — crear insumo nuevo.
  fastify.post(
    '/admin/insumos-catalogo',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(160),
          categoria: z.enum([
            'VERDULERIA',
            'LACTEOS',
            'CARNES',
            'POLLO',
            'HUEVOS',
            'HARINAS',
            'CONDIMENTOS',
            'ENVASES',
            'LIMPIEZA',
            'BEBIDAS',
            'SIN_TACC',
            'POSTRES',
            'OTROS',
          ]),
          unidadCompra: z.enum([
            'KG',
            'GRAMOS',
            'UNIDAD',
            'LITRO',
            'CAJA',
            'BOLSA',
            'PAQUETE',
            'DOCENA',
            'OTRO',
          ]),
          presentacion: z.string().max(160).optional(),
          proveedorPrincipalId: z.string().uuid().optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        categoria: string;
        unidadCompra: string;
        presentacion?: string;
        proveedorPrincipalId?: string;
      };

      // Evitar duplicados case-insensitive
      const existing = await prisma.insumo.findFirst({
        where: { nombre: { equals: body.nombre, mode: 'insensitive' } },
      });
      if (existing) {
        return reply.code(409).send({
          error: `Ya existe un insumo con ese nombre: "${existing.nombre}"`,
          insumo: existing,
        });
      }

      const created = await prisma.insumo.create({
        data: {
          nombre: body.nombre,
          categoria: body.categoria as never,
          unidadCompra: body.unidadCompra as never,
          presentacion: body.presentacion ?? null,
          proveedorPrincipalId: body.proveedorPrincipalId ?? null,
        },
      });
      await recordAudit({
        tabla: 'insumos',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: created.nombre, categoria: created.categoria },
      });
      return reply.code(201).send(created);
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   REPORTE DE COMPRAS POR PROVEEDOR (evolución de precios + cantidades)
  // ──────────────────────────────────────────────────────────────────────

  // GET /admin/proveedores/:id/compras
  fastify.get(
    '/admin/proveedores/:id/compras',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          periodo: z.enum(['semana', 'mes', 'trimestre', 'anio', 'todo']).default('mes'),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const q = req.query as { periodo: 'semana' | 'mes' | 'trimestre' | 'anio' | 'todo' };

      const proveedor = await prisma.proveedor.findUnique({ where: { id: params.id } });
      if (!proveedor) return reply.code(404).send({ error: 'Proveedor no encontrado' });

      const ahora = new Date();
      const desde = new Date(ahora);
      switch (q.periodo) {
        case 'semana':
          desde.setDate(desde.getDate() - 7);
          break;
        case 'mes':
          desde.setMonth(desde.getMonth() - 1);
          break;
        case 'trimestre':
          desde.setMonth(desde.getMonth() - 3);
          break;
        case 'anio':
          desde.setFullYear(desde.getFullYear() - 1);
          break;
        case 'todo':
          desde.setFullYear(2000);
          break;
      }

      // Items de facturas del proveedor en el período
      const items = await prisma.facturaItemRecibida.findMany({
        where: {
          factura: {
            proveedorId: params.id,
            fechaEmision: { gte: desde },
          },
        },
        include: {
          factura: { select: { fechaEmision: true, numero: true } },
          insumo: { select: { id: true, nombre: true, categoria: true, unidadCompra: true } },
        },
        orderBy: { factura: { fechaEmision: 'asc' } },
      });

      // Agrupar por insumo (o por descripcion cuando no hay insumoId)
      const byKey = new Map<
        string,
        {
          insumoId: string | null;
          nombre: string;
          categoria: string | null;
          unidad: string;
          totalCantidad: number;
          totalGastado: number;
          ocurrencias: number;
          precioMin: number;
          precioMax: number;
          precioPrimera: { fecha: Date; precio: number } | null;
          precioUltima: { fecha: Date; precio: number } | null;
          historico: Array<{ fecha: Date; precio: number; cantidad: number; numero: string }>;
        }
      >();

      for (const it of items) {
        const key = it.insumoId ?? `desc:${it.descripcion.toLowerCase().trim()}`;
        const cur = byKey.get(key) ?? {
          insumoId: it.insumoId,
          nombre: it.insumo?.nombre ?? it.descripcion,
          categoria: it.insumo?.categoria ?? null,
          unidad: it.unidad,
          totalCantidad: 0,
          totalGastado: 0,
          ocurrencias: 0,
          precioMin: Number.POSITIVE_INFINITY,
          precioMax: 0,
          precioPrimera: null,
          precioUltima: null,
          historico: [],
        };
        const precio = Number(it.precioUnitario);
        const cant = Number(it.cantidad);
        cur.totalCantidad += cant;
        cur.totalGastado += Number(it.subtotal);
        cur.ocurrencias += 1;
        cur.precioMin = Math.min(cur.precioMin, precio);
        cur.precioMax = Math.max(cur.precioMax, precio);
        const fechaEmision = it.factura.fechaEmision;
        if (!cur.precioPrimera || fechaEmision < cur.precioPrimera.fecha) {
          cur.precioPrimera = { fecha: fechaEmision, precio };
        }
        if (!cur.precioUltima || fechaEmision > cur.precioUltima.fecha) {
          cur.precioUltima = { fecha: fechaEmision, precio };
        }
        cur.historico.push({
          fecha: fechaEmision,
          precio,
          cantidad: cant,
          numero: it.factura.numero,
        });
        byKey.set(key, cur);
      }

      const compras = Array.from(byKey.values()).map((c) => {
        const aumentoPct =
          c.precioPrimera && c.precioPrimera.precio > 0
            ? ((c.precioUltima!.precio - c.precioPrimera.precio) / c.precioPrimera.precio) * 100
            : 0;
        return {
          insumoId: c.insumoId,
          nombre: c.nombre,
          categoria: c.categoria,
          unidad: c.unidad,
          totalCantidad: c.totalCantidad.toFixed(3),
          totalGastado: c.totalGastado.toFixed(2),
          ocurrencias: c.ocurrencias,
          precioMin: c.precioMin === Number.POSITIVE_INFINITY ? 0 : c.precioMin,
          precioMax: c.precioMax,
          precioActual: c.precioUltima?.precio ?? 0,
          aumentoPct: Number(aumentoPct.toFixed(2)),
          historico: c.historico
            .sort((a, b) => a.fecha.getTime() - b.fecha.getTime())
            .map((h) => ({
              fecha: h.fecha,
              precio: h.precio.toFixed(4),
              cantidad: h.cantidad.toFixed(3),
              numero: h.numero,
            })),
        };
      });

      // Ordenar: primero los que más aumentaron, después por gasto total
      compras.sort((a, b) => {
        if (Math.abs(a.aumentoPct - b.aumentoPct) > 1) return b.aumentoPct - a.aumentoPct;
        return Number(b.totalGastado) - Number(a.totalGastado);
      });

      const totalGastadoPeriodo = compras.reduce((acc, c) => acc + Number(c.totalGastado), 0);

      return {
        proveedor: { id: proveedor.id, nombre: proveedor.nombre },
        periodo: q.periodo,
        desde,
        hasta: ahora,
        compras,
        totalGastadoPeriodo: totalGastadoPeriodo.toFixed(2),
        cantidadInsumos: compras.length,
        cantidadFacturas: new Set(items.map((i) => i.factura.numero)).size,
      };
    },
  );

  // ──────────────────────────────────────────────────────────────────────
  //   PAGO MULTI-CUENTA (SPEC §5.6 / Wireframe 08)
  // ──────────────────────────────────────────────────────────────────────

  // POST /admin/pagos-multicuenta
  // Crea un Movimiento (egreso), N Pagos (uno por cuenta), y N×M PagoFactura.
  fastify.post(
    '/admin/pagos-multicuenta',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          proveedorId: z.string().uuid(),
          // Facturas a cancelar (parcial o total) con monto a aplicar a cada una.
          facturas: z
            .array(
              z.object({
                facturaId: z.string().uuid(),
                montoAplicar: z.string().regex(/^\d+(\.\d{1,2})?$/),
              }),
            )
            .min(1),
          // Cuentas con monto y método (uno o varios)
          pagos: z
            .array(
              z.object({
                cuentaId: z.string().uuid(),
                metodo: z.enum([
                  'EFECTIVO',
                  'TRANSFERENCIA',
                  'DEPOSITO',
                  'CHEQUE',
                  'MERCADOPAGO_QR',
                  'OTRO',
                ]),
                monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
                numeroReferencia: z.string().max(80).optional(),
              }),
            )
            .min(1),
          // Distribución opcional. Si no se manda, se hace FIFO automático.
          distribucion: z
            .array(
              z.object({
                pagoIdx: z.number().int().min(0),
                facturaId: z.string().uuid(),
                montoAplicado: z.string().regex(/^\d+(\.\d{1,2})?$/),
              }),
            )
            .optional(),
          observaciones: z.string().max(500).optional(),
          fechaPago: z.string().datetime().optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        proveedorId: string;
        facturas: Array<{ facturaId: string; montoAplicar: string }>;
        pagos: Array<{
          cuentaId: string;
          metodo: 'EFECTIVO' | 'TRANSFERENCIA' | 'DEPOSITO' | 'CHEQUE' | 'MERCADOPAGO_QR' | 'OTRO';
          monto: string;
          numeroReferencia?: string;
        }>;
        distribucion?: Array<{ pagoIdx: number; facturaId: string; montoAplicado: string }>;
        observaciones?: string;
        fechaPago?: string;
      };

      const fecha = body.fechaPago ? new Date(body.fechaPago) : new Date();

      // Validar sumas
      const totalAplicar = body.facturas.reduce((acc, f) => acc + Number(f.montoAplicar), 0);
      const totalPagos = body.pagos.reduce((acc, p) => acc + Number(p.monto), 0);
      if (Math.abs(totalAplicar - totalPagos) > 0.01) {
        return reply.code(400).send({
          error: `La suma de pagos (${totalPagos.toFixed(2)}) no coincide con la suma de montos a aplicar a facturas (${totalAplicar.toFixed(2)})`,
        });
      }

      // Cargar facturas para validar saldos
      const facturasDb = await prisma.facturaRecibida.findMany({
        where: { id: { in: body.facturas.map((f) => f.facturaId) } },
      });
      if (facturasDb.length !== body.facturas.length) {
        return reply.code(400).send({ error: 'Alguna factura no existe' });
      }
      for (const f of body.facturas) {
        const dbF = facturasDb.find((d) => d.id === f.facturaId);
        if (!dbF) continue;
        const saldoActual = calcSaldoFactura(dbF);
        if (Number(f.montoAplicar) > saldoActual + 0.01) {
          return reply.code(400).send({
            error: `Factura ${dbF.numero}: monto a aplicar (${f.montoAplicar}) supera el saldo (${saldoActual.toFixed(2)})`,
          });
        }
        if (dbF.proveedorId !== body.proveedorId) {
          return reply.code(400).send({
            error: `Factura ${dbF.numero} pertenece a otro proveedor`,
          });
        }
      }

      // Construir distribución (manual o FIFO automático)
      type Distrib = { pagoIdx: number; facturaId: string; montoAplicado: number };
      let distribucion: Distrib[];
      if (body.distribucion) {
        distribucion = body.distribucion.map((d) => ({
          pagoIdx: d.pagoIdx,
          facturaId: d.facturaId,
          montoAplicado: Number(d.montoAplicado),
        }));
        // Validar consistencia con facturas y pagos
        for (const f of body.facturas) {
          const sum = distribucion
            .filter((d) => d.facturaId === f.facturaId)
            .reduce((acc, d) => acc + d.montoAplicado, 0);
          if (Math.abs(sum - Number(f.montoAplicar)) > 0.01) {
            return reply.code(400).send({
              error: `La distribución para la factura ${f.facturaId} no suma ${f.montoAplicar}`,
            });
          }
        }
        for (let i = 0; i < body.pagos.length; i++) {
          const p = body.pagos[i];
          if (!p) continue;
          const sum = distribucion
            .filter((d) => d.pagoIdx === i)
            .reduce((acc, d) => acc + d.montoAplicado, 0);
          if (Math.abs(sum - Number(p.monto)) > 0.01) {
            return reply.code(400).send({
              error: `La distribución del pago #${i + 1} no suma ${p.monto}`,
            });
          }
        }
      } else {
        // FIFO: cubrir cada factura en orden con los pagos en orden
        distribucion = [];
        const pagosRest = body.pagos.map((p) => Number(p.monto));
        let pagoIdx = 0;
        for (const f of body.facturas) {
          let restFactura = Number(f.montoAplicar);
          while (restFactura > 0.01 && pagoIdx < pagosRest.length) {
            const restPago = pagosRest[pagoIdx];
            if (restPago === undefined) {
              pagoIdx++;
              continue;
            }
            if (restPago <= 0) {
              pagoIdx++;
              continue;
            }
            const monto = Math.min(restFactura, restPago);
            distribucion.push({
              pagoIdx,
              facturaId: f.facturaId,
              montoAplicado: Number(monto.toFixed(2)),
            });
            restFactura -= monto;
            pagosRest[pagoIdx] = Number((restPago - monto).toFixed(2));
            if (pagosRest[pagoIdx]! <= 0.01) pagoIdx++;
          }
        }
      }

      // Categoría "Insumos (compras a proveedores)"
      const categoria = await prisma.categoriaMovimiento.findUnique({
        where: { nombre: 'Insumos (compras a proveedores)' },
      });
      if (!categoria) {
        return reply.code(500).send({ error: 'Categoría "Insumos" no existe en el sistema' });
      }

      // Transacción: crear movimiento, pagos, pagosFactura, actualizar facturas y saldos
      const result = await prisma.$transaction(async (tx) => {
        // 1. Movimiento (un solo egreso por la suma total)
        const cuentaUnica =
          new Set(body.pagos.map((p) => p.cuentaId)).size === 1
            ? body.pagos[0]?.cuentaId
            : null;

        const movimiento = await tx.movimiento.create({
          data: {
            tipo: 'EGRESO',
            monto: totalPagos.toFixed(2),
            categoriaId: categoria.id,
            entidadId: body.proveedorId,
            cuentaOrigenId: cuentaUnica ?? null,
            fechaComputo: fecha,
            observacion: body.observaciones ?? null,
            estado: EstadoMovimiento.CONFIRMADO,
            usuarioId: req.usuario!.id,
          },
        });

        // 2. Pagos (uno por cuenta)
        const pagosCreados = [];
        for (const [idx, p] of body.pagos.entries()) {
          const created = await tx.pago.create({
            data: {
              movimientoId: movimiento.id,
              metodo: p.metodo,
              cuentaId: p.cuentaId,
              monto: p.monto,
              numeroReferencia: p.numeroReferencia ?? null,
              estado: EstadoPago.CONFIRMADO,
              fecha,
            },
          });
          pagosCreados.push({ ...created, idx });

          // Actualizar saldo de cuenta (decrement)
          await tx.cuenta.update({
            where: { id: p.cuentaId },
            data: { saldoActual: { decrement: Number(p.monto) } },
          });
        }

        // 3. PagoFactura (relación N×M)
        for (const d of distribucion) {
          const pago = pagosCreados.find((pc) => pc.idx === d.pagoIdx);
          if (!pago) continue;
          await tx.pagoFactura.create({
            data: {
              pagoId: pago.id,
              facturaId: d.facturaId,
              movimientoId: movimiento.id,
              montoAplicado: d.montoAplicado.toFixed(2),
            },
          });
        }

        // 4. Actualizar totalPagado y estado de cada factura
        for (const f of body.facturas) {
          const dbF = facturasDb.find((d) => d.id === f.facturaId);
          if (!dbF) continue;
          const totalPagadoNuevo = Number(dbF.totalPagado) + Number(f.montoAplicar);
          const saldoNuevo = Number(dbF.total) - totalPagadoNuevo;
          const nuevoEstado: EstadoFacturaRecibida =
            saldoNuevo <= 0.01
              ? EstadoFacturaRecibida.PAGADA
              : EstadoFacturaRecibida.PAGADA_PARCIAL;
          await tx.facturaRecibida.update({
            where: { id: f.facturaId },
            data: {
              totalPagado: totalPagadoNuevo.toFixed(2),
              estado: nuevoEstado,
              pagadaAt: nuevoEstado === EstadoFacturaRecibida.PAGADA ? new Date() : null,
            },
          });
        }

        // 5. Vincular movimiento ↔ facturas (tabla intermedia)
        for (const f of body.facturas) {
          await tx.movimientoFactura.create({
            data: { movimientoId: movimiento.id, facturaId: f.facturaId },
          });
        }

        // 6. Actualizar última actividad del proveedor
        await tx.proveedor.update({
          where: { id: body.proveedorId },
          data: { ultimoMovimientoAt: fecha },
        });

        return { movimiento, pagos: pagosCreados };
      });

      await recordAudit({
        tabla: 'movimientos',
        registroId: result.movimiento.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: {
          tipo: 'EGRESO',
          monto: totalPagos.toFixed(2),
          proveedorId: body.proveedorId,
          facturasCount: body.facturas.length,
          pagosCount: body.pagos.length,
        },
      });

      return reply.code(201).send({
        movimientoId: result.movimiento.id,
        pagosIds: result.pagos.map((p) => p.id),
        total: totalPagos.toFixed(2),
      });
    },
  );

  // POST /admin/pagos-a-cuenta — pago "a cuenta corriente" sin asociar a una
  // factura específica. Útil cuando el dueño paga, ej, $1.2M de un saldo total
  // adeudado de $2.5M sin que ese monto coincida con ninguna factura.
  fastify.post(
    '/admin/pagos-a-cuenta',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          proveedorId: z.string().uuid(),
          pagos: z
            .array(
              z.object({
                cuentaId: z.string().uuid(),
                metodo: z.enum([
                  'EFECTIVO',
                  'TRANSFERENCIA',
                  'DEPOSITO',
                  'CHEQUE',
                  'MERCADOPAGO_QR',
                  'OTRO',
                ]),
                monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
                numeroReferencia: z.string().max(80).optional(),
              }),
            )
            .min(1),
          observaciones: z.string().max(500).optional(),
          fechaPago: z.string().datetime().optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        proveedorId: string;
        pagos: Array<{
          cuentaId: string;
          metodo:
            | 'EFECTIVO'
            | 'TRANSFERENCIA'
            | 'DEPOSITO'
            | 'CHEQUE'
            | 'MERCADOPAGO_QR'
            | 'OTRO';
          monto: string;
          numeroReferencia?: string;
        }>;
        observaciones?: string;
        fechaPago?: string;
      };

      const fecha = body.fechaPago ? new Date(body.fechaPago) : new Date();
      const totalPagos = body.pagos.reduce((acc, p) => acc + Number(p.monto), 0);
      if (totalPagos <= 0) {
        return reply.code(400).send({ error: 'El total a pagar debe ser mayor a 0' });
      }

      const proveedor = await prisma.proveedor.findUnique({
        where: { id: body.proveedorId },
      });
      if (!proveedor) return reply.code(404).send({ error: 'Proveedor no encontrado' });

      const categoria = await prisma.categoriaMovimiento.findUnique({
        where: { nombre: 'Insumos (compras a proveedores)' },
      });
      if (!categoria) {
        return reply.code(500).send({ error: 'Categoría "Insumos" no existe en el sistema' });
      }

      const observacionFinal =
        body.observaciones ??
        `Pago a cuenta corriente · ${proveedor.nombre} (sin factura específica)`;

      const result = await prisma.$transaction(async (tx) => {
        const cuentaUnica =
          new Set(body.pagos.map((p) => p.cuentaId)).size === 1
            ? body.pagos[0]?.cuentaId
            : null;

        const movimiento = await tx.movimiento.create({
          data: {
            tipo: 'EGRESO',
            monto: totalPagos.toFixed(2),
            categoriaId: categoria.id,
            entidadId: body.proveedorId,
            cuentaOrigenId: cuentaUnica ?? null,
            fechaComputo: fecha,
            observacion: observacionFinal,
            estado: EstadoMovimiento.CONFIRMADO,
            usuarioId: req.usuario!.id,
          },
        });

        const pagosCreados = [];
        for (const p of body.pagos) {
          const created = await tx.pago.create({
            data: {
              movimientoId: movimiento.id,
              metodo: p.metodo,
              cuentaId: p.cuentaId,
              monto: p.monto,
              numeroReferencia: p.numeroReferencia ?? null,
              estado: EstadoPago.CONFIRMADO,
              fecha,
            },
          });
          pagosCreados.push(created);
          await tx.cuenta.update({
            where: { id: p.cuentaId },
            data: { saldoActual: { decrement: Number(p.monto) } },
          });
        }

        await tx.proveedor.update({
          where: { id: body.proveedorId },
          data: { ultimoMovimientoAt: fecha },
        });

        return { movimiento, pagos: pagosCreados };
      });

      await recordAudit({
        tabla: 'movimientos',
        registroId: result.movimiento.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: {
          tipo: 'EGRESO',
          subtipo: 'pago_a_cuenta',
          monto: totalPagos.toFixed(2),
          proveedorId: body.proveedorId,
        },
      });

      return reply.code(201).send({
        movimientoId: result.movimiento.id,
        pagosIds: result.pagos.map((p) => p.id),
        total: totalPagos.toFixed(2),
        observacion: observacionFinal,
      });
    },
  );

  // POST /admin/egreso-a-proveedor — flujo simplificado para la cajera/encargada:
  // un egreso simple (1 cuenta, 1 método) que automáticamente alloca FIFO contra
  // las facturas pendientes del proveedor para que su saldoAdeudado se actualice.
  // Si el monto excede el total adeudado en facturas, el excedente queda como
  // "saldo a favor" (egreso registrado sin asociar factura, observable en histórico).
  fastify.post(
    '/admin/egreso-a-proveedor',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          proveedorId: z.string().uuid(),
          monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
          cuentaId: z.string().uuid(),
          metodo: z.enum([
            'EFECTIVO',
            'TRANSFERENCIA',
            'DEPOSITO',
            'CHEQUE',
            'MERCADOPAGO_QR',
            'OTRO',
          ]),
          numeroReferencia: z.string().max(80).optional(),
          observaciones: z.string().max(500).optional(),
          fechaPago: z.string().datetime().optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        proveedorId: string;
        monto: string;
        cuentaId: string;
        metodo: 'EFECTIVO' | 'TRANSFERENCIA' | 'DEPOSITO' | 'CHEQUE' | 'MERCADOPAGO_QR' | 'OTRO';
        numeroReferencia?: string;
        observaciones?: string;
        fechaPago?: string;
      };

      const fecha = body.fechaPago ? new Date(body.fechaPago) : new Date();
      const montoTotal = Number(body.monto);
      if (montoTotal <= 0) return reply.code(400).send({ error: 'El monto debe ser mayor a 0' });

      const proveedor = await prisma.proveedor.findUnique({ where: { id: body.proveedorId } });
      if (!proveedor) return reply.code(404).send({ error: 'Proveedor no encontrado' });

      const cuenta = await prisma.cuenta.findUnique({ where: { id: body.cuentaId } });
      if (!cuenta) return reply.code(404).send({ error: 'Cuenta no encontrada' });

      const categoria = await prisma.categoriaMovimiento.findUnique({
        where: { nombre: 'Insumos (compras a proveedores)' },
      });
      if (!categoria) {
        return reply.code(500).send({ error: 'Categoría "Insumos" no existe en el sistema' });
      }

      // Facturas pendientes del proveedor (FIFO por fecha de emisión)
      const facturasPendientes = await prisma.facturaRecibida.findMany({
        where: {
          proveedorId: body.proveedorId,
          estado: { in: [EstadoFacturaRecibida.PENDIENTE_PAGO, EstadoFacturaRecibida.PAGADA_PARCIAL] },
        },
        orderBy: [{ fechaEmision: 'asc' }, { numero: 'asc' }],
      });

      // Allocar FIFO el monto contra las facturas pendientes
      type Asignacion = { facturaId: string; montoAplicado: number };
      const asignaciones: Asignacion[] = [];
      let restante = montoTotal;
      for (const f of facturasPendientes) {
        if (restante <= 0.01) break;
        const saldoFactura = calcSaldoFactura(f);
        if (saldoFactura <= 0.01) continue;
        const aplicar = Math.min(restante, saldoFactura);
        asignaciones.push({ facturaId: f.id, montoAplicado: Number(aplicar.toFixed(2)) });
        restante = Number((restante - aplicar).toFixed(2));
      }
      const excedente = restante; // queda como "saldo a favor" del proveedor

      const observacionFinal =
        body.observaciones ??
        (asignaciones.length === 0
          ? `Pago a cuenta · ${proveedor.nombre} (sin facturas pendientes)`
          : `Pago a ${proveedor.nombre}` +
            (excedente > 0.01 ? ` · excedente $${excedente.toFixed(2)} a saldo a favor` : ''));

      const result = await prisma.$transaction(async (tx) => {
        // 1. Movimiento (egreso)
        const movimiento = await tx.movimiento.create({
          data: {
            tipo: 'EGRESO',
            monto: montoTotal.toFixed(2),
            categoriaId: categoria.id,
            entidadId: body.proveedorId,
            cuentaOrigenId: body.cuentaId,
            fechaComputo: fecha,
            observacion: observacionFinal,
            estado: EstadoMovimiento.CONFIRMADO,
            usuarioId: req.usuario!.id,
          },
        });

        // 2. Pago (uno solo)
        const pago = await tx.pago.create({
          data: {
            movimientoId: movimiento.id,
            metodo: body.metodo,
            cuentaId: body.cuentaId,
            monto: montoTotal.toFixed(2),
            numeroReferencia: body.numeroReferencia ?? null,
            estado: EstadoPago.CONFIRMADO,
            fecha,
          },
        });

        // 3. Decrementar saldo de la cuenta
        await tx.cuenta.update({
          where: { id: body.cuentaId },
          data: { saldoActual: { decrement: montoTotal } },
        });

        // 4. PagoFactura + actualizar facturas (sólo si hubo asignaciones)
        for (const a of asignaciones) {
          await tx.pagoFactura.create({
            data: {
              pagoId: pago.id,
              facturaId: a.facturaId,
              movimientoId: movimiento.id,
              montoAplicado: a.montoAplicado.toFixed(2),
            },
          });
          const f = facturasPendientes.find((x) => x.id === a.facturaId);
          if (!f) continue;
          const totalPagadoNuevo = Number(f.totalPagado) + a.montoAplicado;
          const saldoNuevo = Number(f.total) - totalPagadoNuevo;
          const nuevoEstado: EstadoFacturaRecibida =
            saldoNuevo <= 0.01
              ? EstadoFacturaRecibida.PAGADA
              : EstadoFacturaRecibida.PAGADA_PARCIAL;
          await tx.facturaRecibida.update({
            where: { id: f.id },
            data: {
              totalPagado: totalPagadoNuevo.toFixed(2),
              estado: nuevoEstado,
              pagadaAt: nuevoEstado === EstadoFacturaRecibida.PAGADA ? new Date() : null,
            },
          });
          await tx.movimientoFactura.create({
            data: { movimientoId: movimiento.id, facturaId: f.id },
          });
        }

        // 5. Última actividad del proveedor
        await tx.proveedor.update({
          where: { id: body.proveedorId },
          data: { ultimoMovimientoAt: fecha },
        });

        return { movimiento, pago };
      });

      await recordAudit({
        tabla: 'movimientos',
        registroId: result.movimiento.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: {
          tipo: 'EGRESO',
          subtipo: 'egreso-a-proveedor-fifo',
          monto: montoTotal.toFixed(2),
          proveedorId: body.proveedorId,
          facturasAlocadas: asignaciones.length,
          excedente: excedente.toFixed(2),
        },
      });

      return reply.code(201).send({
        movimientoId: result.movimiento.id,
        pagoId: result.pago.id,
        total: montoTotal.toFixed(2),
        facturasAlocadas: asignaciones.map((a) => ({
          facturaId: a.facturaId,
          montoAplicado: a.montoAplicado.toFixed(2),
        })),
        excedente: excedente.toFixed(2),
        observacion: observacionFinal,
      });
    },
  );
}
