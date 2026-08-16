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
import { normalizarNombre, buscarProveedorParecido } from '../services/proveedor-match.js';
import {
  volcarSemanaProveedores,
  leerEtiquetasDelExcel,
} from '../services/excel-proveedores.js';
import {
  construirExcelBusqueda,
  descripcionFiltros,
  nombreArchivoExport,
} from '../services/export-busqueda.js';
import { getOrCreateSesionActual, FueraDeHorarioError } from '../services/sesion-caja.js';
import {
  periodoBusquedaSchema,
  paginacionSchema,
  resolverFiltroTemporal,
  whereRangoFecha,
  esBusquedaNumerica,
  armarPaginacion,
  type PeriodoBusqueda,
} from '../services/filtro-temporal.js';

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
          // Multi-campo: nombre, razón social, CUIT, contacto, rubro, localidad,
          // teléfono y email — así se encuentra al proveedor por cualquier dato.
          ...(q.q && {
            OR: [
              { nombre: { contains: q.q, mode: 'insensitive' as const } },
              { razonSocial: { contains: q.q, mode: 'insensitive' as const } },
              { cuit: { contains: q.q, mode: 'insensitive' as const } },
              { personaContacto: { contains: q.q, mode: 'insensitive' as const } },
              { categoriaPrincipal: { contains: q.q, mode: 'insensitive' as const } },
              { localidad: { contains: q.q, mode: 'insensitive' as const } },
              { telefono: { contains: q.q, mode: 'insensitive' as const } },
              { email: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }),
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

  // POST /admin/proveedores — crear proveedor con info fiscal + dirección
  const proveedorBodyBase = {
    nombre: z.string().min(1).max(120),
    razonSocial: z.string().max(160).nullable().optional(),
    cuit: z.string().max(20).nullable().optional(),
    condicionIva: z
      .enum(['RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL'])
      .nullable()
      .optional(),
    direccion: z.string().max(200).nullable().optional(),
    localidad: z.string().max(80).nullable().optional(),
    telefono: z.string().max(40).nullable().optional(),
    email: z.string().email().nullable().optional().or(z.literal('')),
    personaContacto: z.string().max(120).nullable().optional(),
    categoriaPrincipal: z.string().max(80).nullable().optional(),
    plazoPagoDias: z.number().int().min(0).default(0),
    observaciones: z.string().max(500).nullable().optional(),
    activo: z.boolean().optional(),
  };

  fastify.post(
    '/admin/proveedores',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { body: z.object(proveedorBodyBase) },
    },
    async (req, reply) => {
      const body = req.body as Record<string, unknown>;
      // Email vacío → null (zod acepta '' como alternativa al email válido).
      const email = body.email === '' ? null : (body.email ?? null);
      const created = await prisma.proveedor.create({
        data: {
          nombre: body.nombre as string,
          razonSocial: (body.razonSocial as string | null | undefined) ?? null,
          cuit: (body.cuit as string | null | undefined) ?? null,
          condicionIva: (body.condicionIva as never) ?? null,
          direccion: (body.direccion as string | null | undefined) ?? null,
          localidad: (body.localidad as string | null | undefined) ?? null,
          telefono: (body.telefono as string | null | undefined) ?? null,
          email: email as string | null,
          personaContacto: (body.personaContacto as string | null | undefined) ?? null,
          categoriaPrincipal: (body.categoriaPrincipal as string | null | undefined) ?? null,
          plazoPagoDias: (body.plazoPagoDias as number | undefined) ?? 0,
          observaciones: (body.observaciones as string | null | undefined) ?? null,
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

  // PATCH /admin/proveedores/:id — editar proveedor existente. Todos los
  // campos son opcionales; mandar `null` para limpiar un valor.
  fastify.patch(
    '/admin/proveedores/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          ...proveedorBodyBase,
          nombre: z.string().min(1).max(120).optional(),
          plazoPagoDias: z.number().int().min(0).optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      const before = await prisma.proveedor.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Proveedor no encontrado' });

      // Email vacío explícito → null (limpieza).
      const data: Record<string, unknown> = {};
      for (const k of Object.keys(body)) {
        if (body[k] === undefined) continue;
        data[k] = body[k] === '' ? null : body[k];
      }

      const updated = await prisma.proveedor.update({
        where: { id: params.id },
        data,
      });
      await recordAudit({
        tabla: 'proveedores',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre, cuit: before.cuit, activo: before.activo },
        valorNuevo: { nombre: updated.nombre, cuit: updated.cuit, activo: updated.activo },
      });
      return updated;
    },
  );

  // DELETE /admin/proveedores/:id — soft delete (activo=false). No borramos
  // físico para no romper facturas/movimientos históricos que lo referencian.
  fastify.delete(
    '/admin/proveedores/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.proveedor.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Proveedor no encontrado' });
      await prisma.proveedor.update({ where: { id: params.id }, data: { activo: false } });
      await recordAudit({
        tabla: 'proveedores',
        registroId: params.id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre },
      });
      return { ok: true };
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

  // PATCH /admin/facturas/:id/proveedor — reasignar el proveedor de una
  // factura y, opcionalmente, RECORDAR el vínculo.
  //
  // El nombre impreso en el comprobante casi nunca es el que el local usa
  // ("GRAFIPACK SAN MARTIN S.R.L." contra "Grafipack"). Cuando el OCR no
  // acierta, la encargada elige el proveedor de verdad acá; si además guarda
  // el alias, la próxima factura con ese mismo nombre impreso entra derecho al
  // proveedor correcto, sin intervención.
  fastify.patch(
    '/admin/facturas/:id/proveedor',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          proveedorId: z.string().uuid(),
          /// Guardar el nombre que traía la factura como alias del proveedor
          /// elegido. Default true: es el punto de la pantalla.
          guardarAlias: z.boolean().default(true),
          /// Qué nombre guardar. Si no viene, se usa el del proveedor que la
          /// factura tenía asignado — que es el que leyó el OCR.
          aliasNombre: z.string().min(1).max(160).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as {
        proveedorId: string;
        guardarAlias: boolean;
        aliasNombre?: string;
      };

      const factura = await prisma.facturaRecibida.findUnique({
        where: { id },
        select: {
          id: true,
          estado: true,
          proveedorId: true,
          razonSocialEmisor: true,
          proveedor: { select: { nombre: true } },
        },
      });
      if (!factura) return reply.code(404).send({ error: 'Factura no encontrada' });

      const destino = await prisma.proveedor.findUnique({
        where: { id: body.proveedorId },
        select: { id: true, nombre: true },
      });
      if (!destino) return reply.code(404).send({ error: 'Proveedor no encontrado' });
      if (destino.id === factura.proveedorId) {
        return reply.code(400).send({ error: 'La factura ya es de ese proveedor' });
      }

      // El nombre a recordar: el que vino en la factura. Casi siempre es el
      // del proveedor que el OCR creó de más y que estamos abandonando.
      const nombreAlias =
        body.aliasNombre ?? factura.proveedor?.nombre ?? factura.razonSocialEmisor ?? null;
      const normalizado = nombreAlias ? normalizarNombre(nombreAlias) : '';

      let aliasGuardado: string | null = null;
      let aliasConflicto: string | null = null;

      await prisma.$transaction(async (tx) => {
        await tx.facturaRecibida.update({
          where: { id },
          data: { proveedorId: destino.id },
        });
        await recordAudit({
          tabla: 'facturas_recibidas',
          registroId: id,
          accion: 'UPDATE',
          usuarioId: req.usuario!.id,
          valorAnterior: { proveedorId: factura.proveedorId, proveedor: factura.proveedor?.nombre },
          valorNuevo: { proveedorId: destino.id, proveedor: destino.nombre },
          contexto: { motivo: 'reasignacion manual de proveedor' },
          tx,
        });

        if (!body.guardarAlias || !normalizado) return;

        // Un mismo nombre no puede apuntar a dos proveedores. Si ya existe
        // apuntando a OTRO, no se pisa en silencio: se avisa. Pisarlo
        // redirigiría facturas futuras sin que nadie se entere.
        const existente = await tx.proveedorAlias.findUnique({
          where: { nombreNormalizado: normalizado },
          select: { id: true, proveedorId: true },
        });
        if (existente && existente.proveedorId !== destino.id) {
          aliasConflicto = nombreAlias;
          return;
        }
        if (existente) {
          aliasGuardado = nombreAlias;
          return;
        }

        const alias = await tx.proveedorAlias.create({
          data: {
            proveedorId: destino.id,
            nombreOriginal: (nombreAlias ?? '').slice(0, 160),
            nombreNormalizado: normalizado,
            origen: 'ocr',
          },
          select: { id: true },
        });
        // Sin audit no se replica a la nube (ver replicator.ts). El alias
        // tiene que viajar, o el mirror resolvería distinto que S1.
        await recordAudit({
          tabla: 'proveedor_alias',
          registroId: alias.id,
          accion: 'INSERT',
          usuarioId: req.usuario!.id,
          valorNuevo: { proveedorId: destino.id, nombre: nombreAlias },
          tx,
        });
        aliasGuardado = nombreAlias;
      });

      return reply.send({
        ok: true,
        proveedor: destino,
        aliasGuardado,
        aliasConflicto,
      });
    },
  );

  // GET /admin/facturas — listado (inbox). Filtra por estado (ej. la bandeja
  // de "sin validar" del flujo OCR). Liviano: para la lista, no el detalle.
  fastify.get(
    '/admin/facturas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          estado: z
            .enum(['PENDIENTE_VALIDACION', 'PENDIENTE_PAGO', 'PAGADA_PARCIAL', 'PAGADA', 'ANULADA'])
            .optional(),
          // Búsqueda libre: nº, punto de venta, proveedor, tipo y total exacto.
          q: z.string().trim().min(1).max(80).optional(),
          // Filtro temporal sobre fechaEmision. Default 'todo' = toda la base.
          periodo: periodoBusquedaSchema.optional(),
          desde: z.string().datetime().optional(),
          hasta: z.string().datetime().optional(),
          ...paginacionSchema,
          // LEGACY: algunos llamadores viejos mandan `limit` sin paginar.
          limit: z.coerce.number().int().min(1).max(200).optional(),
          // Mismo resultado en Excel, sin paginar. Ver la nota en /admin/movimientos.
          formato: z.enum(['json', 'xlsx']).optional(),
        }),
      },
    },
    async (req, reply) => {
      const q = req.query as {
        estado?: string;
        q?: string;
        periodo?: PeriodoBusqueda;
        desde?: string;
        hasta?: string;
        page: number;
        pageSize: number;
        limit?: number;
        formato?: 'json' | 'xlsx';
      };

      const ft = await resolverFiltroTemporal({
        periodo: q.periodo,
        desde: q.desde,
        hasta: q.hasta,
      });

      const texto = q.q?.trim();
      const where = {
        ...(q.estado ? { estado: q.estado as never } : {}),
        // Las facturas NO tienen sesión de caja: si piden una sesión, caemos al
        // rango [apertura, cierre] de esa sesión sería confuso — mejor ignorar
        // el criterio de sesión y filtrar solo por fecha cuando hay rango.
        ...whereRangoFecha('fechaEmision', ft),
        ...(texto && {
          OR: [
            { numero: { contains: texto, mode: 'insensitive' as const } },
            { puntoVenta: { contains: texto, mode: 'insensitive' as const } },
            { proveedor: { nombre: { contains: texto, mode: 'insensitive' as const } } },
            ...(esBusquedaNumerica(texto) ? [{ total: texto }] : []),
          ],
        }),
      };

      if (q.formato === 'xlsx') {
        const TOPE = 5000;
        const [filas, totalFilas] = await Promise.all([
          prisma.facturaRecibida.findMany({
            where,
            select: {
              numero: true,
              puntoVenta: true,
              tipoComprobante: true,
              fechaEmision: true,
              creadoAt: true,
              estado: true,
              origen: true,
              ocrConfianza: true,
              netoGravado: true,
              netoNoGravado: true,
              iva21: true,
              iva10_5: true,
              iva27: true,
              otrosImpuestos: true,
              total: true,
              totalPagado: true,
              observaciones: true,
              proveedor: { select: { nombre: true, cuit: true } },
              _count: { select: { items: true } },
            },
            orderBy: { creadoAt: 'desc' },
            take: TOPE,
          }),
          prisma.facturaRecibida.count({ where }),
        ]);
        const buf = await construirExcelBusqueda({
          titulo: 'Facturas recibidas',
          filtros: descripcionFiltros({
            periodo: q.periodo,
            desde: ft.desde,
            hasta: ft.hasta,
            texto,
            extra: q.estado ? `Estado: ${q.estado}` : undefined,
          }),
          columnas: [
            { header: 'Proveedor', key: 'proveedor', width: 32 },
            { header: 'CUIT', key: 'cuit', width: 16 },
            { header: 'Tipo', key: 'tipo', width: 10 },
            { header: 'Punto de venta', key: 'pv', width: 14 },
            { header: 'Número', key: 'numero', width: 18 },
            { header: 'Fecha emisión', key: 'fechaEmision', tipo: 'fecha' },
            { header: 'Cargada el', key: 'creado', tipo: 'fecha' },
            { header: 'Estado', key: 'estado', width: 22 },
            { header: 'Origen', key: 'origen', width: 16 },
            { header: 'Confianza OCR', key: 'confianza', tipo: 'numero', width: 14 },
            { header: 'Ítems', key: 'items', tipo: 'numero', width: 8 },
            { header: 'Observaciones', key: 'observaciones', width: 34 },
            { header: 'Neto gravado', key: 'netoGravado', tipo: 'dinero' },
            { header: 'Neto no gravado', key: 'netoNoGravado', tipo: 'dinero' },
            { header: 'IVA', key: 'iva', tipo: 'dinero' },
            { header: 'Otros impuestos', key: 'otros', tipo: 'dinero' },
            { header: 'Total', key: 'total', tipo: 'dinero' },
            { header: 'Pagado', key: 'pagado', tipo: 'dinero' },
            { header: 'Saldo', key: 'saldo', tipo: 'dinero' },
          ],
          filas: filas.map((f) => ({
            proveedor: f.proveedor?.nombre ?? '',
            cuit: f.proveedor?.cuit ?? '',
            tipo: f.tipoComprobante,
            pv: f.puntoVenta ?? '',
            numero: f.numero,
            fechaEmision: f.fechaEmision,
            creado: f.creadoAt,
            estado: f.estado,
            origen: f.origen,
            confianza: f.ocrConfianza != null ? Number(f.ocrConfianza) : null,
            items: f._count.items,
            observaciones: f.observaciones ?? '',
            netoGravado: Number(f.netoGravado),
            netoNoGravado: Number(f.netoNoGravado),
            // Las tres alícuotas se suman en una sola columna: separarlas es
            // ruido para lo que la encargada mira, y el detalle sigue en la
            // ficha de la factura.
            iva: Number(f.iva21) + Number(f.iva10_5) + Number(f.iva27),
            otros: Number(f.otrosImpuestos),
            total: Number(f.total),
            pagado: Number(f.totalPagado),
            saldo: Number(f.total) - Number(f.totalPagado),
          })),
          totales: [
            { etiqueta: 'TOTAL FACTURADO', columna: 'total' },
            { etiqueta: 'SALDO A PAGAR', columna: 'saldo' },
            { etiqueta: 'Total IVA', columna: 'iva' },
            { etiqueta: 'Cantidad de facturas', valor: filas.length },
          ],
          hayMas:
            totalFilas > filas.length
              ? { exportadas: filas.length, totales: totalFilas }
              : undefined,
        });
        return reply
          .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .header('Content-Disposition', `attachment; filename="${nombreArchivoExport('facturas')}"`)
          .send(buf);
      }

      // `limit` legacy manda: si vino, no paginamos (compat con la bandeja OCR).
      const pageSize = q.limit ?? q.pageSize;
      const skip = q.limit ? 0 : (q.page - 1) * q.pageSize;

      const [facturas, total] = await Promise.all([
        prisma.facturaRecibida.findMany({
          where,
          select: {
            id: true,
            numero: true,
            puntoVenta: true,
            tipoComprobante: true,
            total: true,
            estado: true,
            origen: true,
            ocrConfianza: true,
            fechaEmision: true,
            creadoAt: true,
            proveedor: { select: { id: true, nombre: true } },
            _count: { select: { items: true } },
          },
          // sin validar primero por más viejas (cola FIFO); el resto por carga.
          orderBy:
            q.estado === 'PENDIENTE_VALIDACION' ? { creadoAt: 'asc' } : { creadoAt: 'desc' },
          skip,
          take: pageSize,
        }),
        prisma.facturaRecibida.count({ where }),
      ]);

      return {
        facturas: facturas.map((f) => ({
          ...f,
          total: f.total.toString(),
          ocrConfianza: f.ocrConfianza?.toString() ?? null,
          itemsCount: f._count.items,
          _count: undefined,
        })),
        ...armarPaginacion(total, q.limit ? 1 : q.page, pageSize),
      };
    },
  );

  // PATCH /admin/facturas/:id — corregir los datos de una factura ANTES de
  // validar (el humano arregla lo que el OCR leyó mal). Solo en
  // PENDIENTE_VALIDACION. Reemplaza items si vienen. NO toca pagos.
  fastify.patch(
    '/admin/facturas/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          proveedorId: z.string().uuid().optional(),
          tipoComprobante: z
            .enum(['FACTURA_A', 'FACTURA_B', 'FACTURA_C', 'FACTURA_X', 'NOTA_CREDITO', 'NOTA_DEBITO', 'TICKET', 'REMITO', 'OTRO'])
            .optional(),
          puntoVenta: z.string().max(20).nullable().optional(),
          numero: z.string().min(1).max(40).optional(),
          fechaEmision: z.string().optional(),
          fechaVencimiento: z.string().nullable().optional(),
          neto: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          iva: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          total: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          observaciones: z.string().max(2000).nullable().optional(),
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
            .optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown> & {
        items?: Array<{
          insumoId?: string | null; descripcion: string; cantidad: string;
          unidad: string; precioUnitario: string; alicuotaIva: string; subtotal: string;
        }>;
      };
      const actual = await prisma.facturaRecibida.findUnique({
        where: { id },
        select: { id: true, estado: true, numero: true, total: true },
      });
      if (!actual) return reply.code(404).send({ error: 'Factura no encontrada' });
      if (actual.estado !== EstadoFacturaRecibida.PENDIENTE_VALIDACION) {
        return reply
          .code(409)
          .send({ error: 'Solo se puede editar una factura sin validar', estado: actual.estado });
      }

      const data: Record<string, unknown> = {};
      if (body.proveedorId) data.proveedorId = body.proveedorId;
      if (body.tipoComprobante) data.tipoComprobante = body.tipoComprobante;
      if (body.puntoVenta !== undefined) data.puntoVenta = body.puntoVenta;
      if (body.numero) data.numero = body.numero;
      if (body.fechaEmision) {
        data.fechaEmision = new Date(body.fechaEmision as string);
        data.fechaComputo = new Date(body.fechaEmision as string);
      }
      if (body.fechaVencimiento !== undefined)
        data.fechaVencimiento = body.fechaVencimiento ? new Date(body.fechaVencimiento as string) : null;
      if (body.neto !== undefined) data.netoGravado = body.neto;
      if (body.iva !== undefined) data.iva21 = body.iva;
      if (body.total !== undefined) data.total = body.total;
      if (body.observaciones !== undefined) data.observaciones = body.observaciones;

      const updated = await prisma.$transaction(async (tx) => {
        if (body.items) {
          await tx.facturaItemRecibida.deleteMany({ where: { facturaId: id } });
          data.items = {
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
          };
        }
        const f = await tx.facturaRecibida.update({
          where: { id },
          data,
          select: { id: true, numero: true, total: true },
        });
        await recordAudit({
          tabla: 'facturas_recibidas',
          registroId: id,
          accion: 'UPDATE',
          usuarioId: req.usuario!.id,
          valorAnterior: { numero: actual.numero, total: actual.total.toString() },
          valorNuevo: { numero: f.numero, total: f.total.toString(), itemsReemplazados: !!body.items },
          contexto: { fuente: 'validacion-ocr-edit' },
          tx,
        });
        return f;
      });
      return reply.send({ ok: true, id: updated.id });
    },
  );

  // POST /admin/facturas/:id/validar — el humano ACEPTA la factura leída por
  // OCR. PENDIENTE_VALIDACION → PENDIENTE_PAGO. Marca validadaAt + quién.
  // Actualiza precio último por insumo (si hay items linkeados). NO genera
  // ningún pago ni movimiento de cuenta — eso es el flujo de pago aparte.
  fastify.post(
    '/admin/facturas/:id/validar',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const factura = await prisma.facturaRecibida.findUnique({
        where: { id },
        select: {
          id: true, estado: true, proveedorId: true, fechaEmision: true, numero: true,
          items: { select: { insumoId: true, precioUnitario: true } },
        },
      });
      if (!factura) return reply.code(404).send({ error: 'Factura no encontrada' });
      if (factura.estado !== EstadoFacturaRecibida.PENDIENTE_VALIDACION) {
        return reply.code(409).send({ error: 'La factura no está pendiente de validación', estado: factura.estado });
      }

      await prisma.$transaction(async (tx) => {
        await tx.facturaRecibida.update({
          where: { id },
          data: {
            estado: EstadoFacturaRecibida.PENDIENTE_PAGO,
            validadaAt: new Date(),
            usuarioValidacionId: req.usuario!.id,
          },
        });
        // Precio último por insumo+proveedor (solo items linkeados a un insumo).
        for (const it of factura.items) {
          if (!it.insumoId) continue;
          const existing = await tx.insumoProveedor.findUnique({
            where: { insumoId_proveedorId: { insumoId: it.insumoId, proveedorId: factura.proveedorId } },
          });
          if (!existing || !existing.fechaUltimoPrecio || existing.fechaUltimoPrecio < factura.fechaEmision) {
            await tx.insumoProveedor.upsert({
              where: { insumoId_proveedorId: { insumoId: it.insumoId, proveedorId: factura.proveedorId } },
              create: {
                insumoId: it.insumoId, proveedorId: factura.proveedorId,
                precioUltimo: it.precioUnitario, fechaUltimoPrecio: factura.fechaEmision, esPrincipal: false,
              },
              update: { precioUltimo: it.precioUnitario, fechaUltimoPrecio: factura.fechaEmision },
            });
          }
        }
        await recordAudit({
          tabla: 'facturas_recibidas',
          registroId: id,
          accion: 'UPDATE',
          usuarioId: req.usuario!.id,
          valorNuevo: { estado: 'PENDIENTE_PAGO', numero: factura.numero },
          contexto: { fuente: 'validacion-ocr-aceptar' },
          tx,
        });
      });
      return reply.send({ ok: true, id, estado: 'PENDIENTE_PAGO' });
    },
  );

  // POST /admin/facturas/:id/anular — rechazar (OCR basura / duplicado / error).
  // Solo si no tiene pagos aplicados. → ANULADA.
  fastify.post(
    '/admin/facturas/:id/anular',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ motivo: z.string().max(500).optional() }).optional(),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const motivo = (req.body as { motivo?: string } | undefined)?.motivo;
      const factura = await prisma.facturaRecibida.findUnique({
        where: { id },
        select: { id: true, estado: true, totalPagado: true, numero: true, observaciones: true },
      });
      if (!factura) return reply.code(404).send({ error: 'Factura no encontrada' });
      if (factura.estado === EstadoFacturaRecibida.ANULADA) {
        return reply.send({ ok: true, id, estado: 'ANULADA' });
      }
      if (Number(factura.totalPagado) > 0.01) {
        return reply.code(409).send({ error: 'No se puede anular una factura con pagos aplicados' });
      }
      await prisma.$transaction(async (tx) => {
        await tx.facturaRecibida.update({
          where: { id },
          data: {
            estado: EstadoFacturaRecibida.ANULADA,
            observaciones: motivo
              ? `${factura.observaciones ? factura.observaciones + ' | ' : ''}ANULADA: ${motivo}`
              : factura.observaciones,
          },
        });
        await recordAudit({
          tabla: 'facturas_recibidas',
          registroId: id,
          accion: 'UPDATE',
          usuarioId: req.usuario!.id,
          valorAnterior: { estado: factura.estado },
          valorNuevo: { estado: 'ANULADA', motivo: motivo ?? null },
          contexto: { fuente: 'validacion-ocr-rechazar' },
          tx,
        });
      });
      return reply.send({ ok: true, id, estado: 'ANULADA' });
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
          // Multi-campo: nombre, presentación, observaciones y el nombre del
          // proveedor que lo vende (así "buscar por proveedor" trae sus insumos).
          ...(q.q && {
            OR: [
              { nombre: { contains: q.q, mode: 'insensitive' as const } },
              { presentacion: { contains: q.q, mode: 'insensitive' as const } },
              { observaciones: { contains: q.q, mode: 'insensitive' as const } },
              {
                proveedoresVinculo: {
                  some: {
                    proveedor: { nombre: { contains: q.q, mode: 'insensitive' as const } },
                  },
                },
              },
            ],
          }),
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

      // Resolver/crear sesión actual para que el movimiento cuente en el
      // cierre del turno. Sin esto, el pago a proveedor queda con
      // sesion_caja_id=NULL y la encargada no lo ve al cerrar caja
      // (aunque sí en /admin/movimientos por fecha). Mismo patrón que
      // el fix de alpha.19 para POST /admin/movimientos.
      let sesion;
      try {
        sesion = await getOrCreateSesionActual(req.usuario!.id);
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

      // Transacción: crear movimiento, pagos, pagosFactura, actualizar facturas y saldos
      const result = await prisma.$transaction(async (tx) => {
        // 1+2. UN EGRESO por cada cuenta/pago, cada uno con su cuentaOrigenId Y
        //   sesionCajaId. Antes era UN movimiento con cuentaOrigenId=null cuando
        //   el pago era multicuenta → la reconciliación de caja (que filtra por
        //   movimiento+cuenta) NO veía el efectivo y el cierre cerraba mal.
        //   Ahora cada flujo de plata es su propio movimiento: el efectivo desde
        //   "Caja física" cuenta, y la transferencia/banco no toca la caja.
        const lineasMov: Array<{
          mov: { id: string };
          pago: { id: string };
          idx: number;
        }> = [];
        for (const [idx, p] of body.pagos.entries()) {
          const mov = await tx.movimiento.create({
            data: {
              tipo: 'EGRESO',
              monto: p.monto,
              categoriaId: categoria.id,
              entidadId: body.proveedorId,
              cuentaOrigenId: p.cuentaId,
              fechaComputo: fecha,
              observacion: body.observaciones ?? null,
              estado: EstadoMovimiento.CONFIRMADO,
              usuarioId: req.usuario!.id,
              sesionCajaId: sesion.id,
            },
          });
          const pago = await tx.pago.create({
            data: {
              movimientoId: mov.id,
              metodo: p.metodo,
              cuentaId: p.cuentaId,
              monto: p.monto,
              numeroReferencia: p.numeroReferencia ?? null,
              estado: EstadoPago.CONFIRMADO,
              fecha,
            },
          });
          await tx.cuenta.update({
            where: { id: p.cuentaId },
            data: { saldoActual: { decrement: Number(p.monto) } },
          });
          lineasMov.push({ mov, pago, idx });
        }

        // 3. PagoFactura (N×M): cada pago liga a su(s) factura(s) según la distribución.
        for (const d of distribucion) {
          const lm = lineasMov.find((x) => x.idx === d.pagoIdx);
          if (!lm) continue;
          await tx.pagoFactura.create({
            data: {
              pagoId: lm.pago.id,
              facturaId: d.facturaId,
              movimientoId: lm.mov.id,
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

        // 5. MovimientoFactura: un vínculo por cada par (movimiento, factura) pagado.
        const pares = new Set<string>();
        for (const d of distribucion) {
          const lm = lineasMov.find((x) => x.idx === d.pagoIdx);
          if (!lm) continue;
          const key = `${lm.mov.id}|${d.facturaId}`;
          if (pares.has(key)) continue;
          pares.add(key);
          await tx.movimientoFactura.create({
            data: { movimientoId: lm.mov.id, facturaId: d.facturaId },
          });
        }

        // 6. Actualizar última actividad del proveedor
        await tx.proveedor.update({
          where: { id: body.proveedorId },
          data: { ultimoMovimientoAt: fecha },
        });

        return { movs: lineasMov.map((x) => x.mov), pagos: lineasMov.map((x) => x.pago) };
      });

      for (const mov of result.movs) {
        await recordAudit({
          tabla: 'movimientos',
          registroId: mov.id,
          accion: 'INSERT',
          usuarioId: req.usuario!.id,
          valorNuevo: {
            tipo: 'EGRESO',
            proveedorId: body.proveedorId,
            facturasCount: body.facturas.length,
            pagosCount: body.pagos.length,
          },
        });
      }

      return reply.code(201).send({
        movimientoId: result.movs[0]?.id, // compat con clientes que esperaban 1
        movimientoIds: result.movs.map((m) => m.id),
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

      // Resolver/crear sesión actual — mismo patrón que pagos-multicuenta.
      // Sin esto el pago queda fuera del cierre de caja.
      let sesion;
      try {
        sesion = await getOrCreateSesionActual(req.usuario!.id);
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

      const result = await prisma.$transaction(async (tx) => {
        // Un EGRESO por cada cuenta/pago (cuentaOrigenId + sesionCajaId) para que
        // el efectivo desde Caja física cuente en el cierre. Antes: un movimiento
        // con cuentaOrigenId=null en multicuenta → la caja no lo veía.
        const lineasMov: Array<{ mov: { id: string }; pago: { id: string } }> = [];
        for (const p of body.pagos) {
          const mov = await tx.movimiento.create({
            data: {
              tipo: 'EGRESO',
              monto: p.monto,
              categoriaId: categoria.id,
              entidadId: body.proveedorId,
              cuentaOrigenId: p.cuentaId,
              fechaComputo: fecha,
              observacion: observacionFinal,
              estado: EstadoMovimiento.CONFIRMADO,
              usuarioId: req.usuario!.id,
              sesionCajaId: sesion.id,
            },
          });
          const pago = await tx.pago.create({
            data: {
              movimientoId: mov.id,
              metodo: p.metodo,
              cuentaId: p.cuentaId,
              monto: p.monto,
              numeroReferencia: p.numeroReferencia ?? null,
              estado: EstadoPago.CONFIRMADO,
              fecha,
            },
          });
          await tx.cuenta.update({
            where: { id: p.cuentaId },
            data: { saldoActual: { decrement: Number(p.monto) } },
          });
          lineasMov.push({ mov, pago });
        }

        await tx.proveedor.update({
          where: { id: body.proveedorId },
          data: { ultimoMovimientoAt: fecha },
        });

        return { movs: lineasMov.map((x) => x.mov), pagos: lineasMov.map((x) => x.pago) };
      });

      for (const mov of result.movs) {
        await recordAudit({
          tabla: 'movimientos',
          registroId: mov.id,
          accion: 'INSERT',
          usuarioId: req.usuario!.id,
          valorNuevo: {
            tipo: 'EGRESO',
            subtipo: 'pago_a_cuenta',
            proveedorId: body.proveedorId,
          },
        });
      }

      return reply.code(201).send({
        movimientoId: result.movs[0]?.id,
        movimientoIds: result.movs.map((m) => m.id),
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

      // Resolver/crear sesión actual — mismo patrón que pagos-multicuenta.
      // Sin esto el egreso queda fuera del cierre de caja.
      let sesion;
      try {
        sesion = await getOrCreateSesionActual(req.usuario!.id);
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
            sesionCajaId: sesion.id,
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

  // ══════════════════════════════════════════════════════════════════════
  //   EXCEL "Proveedores 2026.xlsx" — hoja Deudas
  // ══════════════════════════════════════════════════════════════════════

  // Las filas del Excel + las semanas que tiene el archivo. Es lo que la
  // pantalla de mapeo necesita para ofrecer las etiquetas reales en vez de
  // hacer que alguien las tipee (y las tipee mal).
  fastify.get(
    '/admin/excel-proveedores/estructura',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async (_req, reply) => {
      try {
        const est = await leerEtiquetasDelExcel();
        const mapeos = await prisma.mapeoExcelProveedor.findMany({
          include: { proveedor: { select: { id: true, nombre: true } } },
        });
        // Sugerencia de mapeo para las filas que todavía no tienen ninguno.
        // Sugerencia, no decisión: la confirma un humano. Mezclar la cuenta
        // corriente de dos proveedores se descubre tarde y se limpia a mano.
        const proveedores = await prisma.proveedor.findMany({
          where: { activo: true },
          select: { id: true, nombre: true, razonSocial: true },
        });
        const conMapeo = new Set(mapeos.map((m) => m.etiquetaExcel));
        const sugerencias = est.etiquetas
          .filter((e) => !conMapeo.has(e))
          .map((e) => ({ etiqueta: e, sugerido: buscarProveedorParecido(e, proveedores) }))
          .filter((s) => s.sugerido);

        return {
          ...est,
          mapeos: mapeos.map((m) => ({
            id: m.id,
            etiquetaExcel: m.etiquetaExcel,
            proveedorId: m.proveedorId,
            proveedorNombre: m.proveedor.nombre,
            tiposComprobante: m.tiposComprobante,
            activo: m.activo,
          })),
          sugerencias,
        };
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : 'Error leyendo el Excel' });
      }
    },
  );

  // Crear/actualizar el mapeo de una fila.
  fastify.post(
    '/admin/excel-proveedores/mapeo',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          etiquetaExcel: z.string().min(1).max(120),
          proveedorId: z.string().uuid(),
          // Vacío = todos los comprobantes de ese proveedor van a esta fila.
          // Con valores, se parte el proveedor entre filas ("en Blanco" /
          // "en Negro").
          tiposComprobante: z.array(z.string().max(30)).max(12).default([]),
          activo: z.boolean().default(true),
        }),
      },
    },
    async (req) => {
      const b = req.body as {
        etiquetaExcel: string;
        proveedorId: string;
        tiposComprobante: string[];
        activo: boolean;
      };
      const m = await prisma.mapeoExcelProveedor.upsert({
        where: {
          etiquetaExcel_proveedorId: {
            etiquetaExcel: b.etiquetaExcel,
            proveedorId: b.proveedorId,
          },
        },
        create: b,
        update: { tiposComprobante: b.tiposComprobante, activo: b.activo },
      });
      await recordAudit({
        tabla: 'mapeo_excel_proveedores',
        registroId: m.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: b as unknown as Record<string, unknown>,
      });
      return m;
    },
  );

  fastify.delete(
    '/admin/excel-proveedores/mapeo/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existe = await prisma.mapeoExcelProveedor.findUnique({ where: { id } });
      if (!existe) return reply.code(404).send({ error: 'Mapeo no encontrado' });
      await prisma.mapeoExcelProveedor.delete({ where: { id } });
      await recordAudit({
        tabla: 'mapeo_excel_proveedores',
        registroId: id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { etiquetaExcel: existe.etiquetaExcel },
      });
      return { ok: true };
    },
  );

  // Volcar la semana al Excel.
  //
  // `simular=true` (el default) NO escribe: devuelve exactamente lo que haría.
  // Es a propósito — el archivo es el cuaderno de trabajo de la encargada, y
  // se mira antes de tocarlo.
  fastify.post(
    '/admin/excel-proveedores/volcar',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z
          .object({
            fecha: z.string().datetime().optional(),
            simular: z.boolean().default(true),
            // Pisar lo que ella ya escribió. Requiere pedirlo explícitamente.
            pisarDiferencias: z.boolean().default(false),
          })
          .optional(),
      },
    },
    async (req, reply) => {
      const b = (req.body ?? {}) as {
        fecha?: string;
        simular?: boolean;
        pisarDiferencias?: boolean;
      };
      try {
        const r = await volcarSemanaProveedores({
          fecha: b.fecha ? new Date(b.fecha) : undefined,
          simular: b.simular !== false,
          pisarDiferencias: b.pisarDiferencias === true,
        });
        if (!r.simulado && r.escritas > 0) {
          await recordAudit({
            tabla: 'mapeo_excel_proveedores',
            registroId: '00000000-0000-0000-0000-000000000000',
            accion: 'UPDATE',
            usuarioId: req.usuario!.id,
            valorNuevo: {
              accion: 'volcado al Excel de proveedores',
              semana: r.semana,
              celdas: r.escritas,
              diferencias: r.diferencias,
            },
          });
        }
        return r;
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : 'No se pudo volcar' });
      }
    },
  );
}
