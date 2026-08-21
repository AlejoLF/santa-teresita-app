import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { RolUsuario, EstadoMovimiento } from '@sta/db';
import { queryBool } from '@sta/shared/schemas';
import { recordAudit } from '../services/audit.js';
import { getOrCreateSesionActual, FueraDeHorarioError } from '../services/sesion-caja.js';
import {
  resolverFiltroTemporal,
  whereRangoFecha,
  periodoBusquedaSchema,
  paginacionSchema,
  armarPaginacion,
  type PeriodoBusqueda,
} from '../services/filtro-temporal.js';
import {
  construirExcelBusqueda,
  descripcionFiltros,
  nombreArchivoExport,
} from '../services/export-busqueda.js';

/**
 * CRUD de empleados + carga de movimientos de personal (sueldos, adelantos, comisiones).
 * Cada movimiento de personal es un Movimiento (egreso) con entidadId apuntando al Empleado
 * y categoría "Sueldos" / "Adelanto a empleado" / "Comisiones".
 */
/**
 * El puesto en criollo para el Excel. En la base es un enum en mayúsculas
 * (CAJERO, COCINERO…) y así se ve como un volcado de tabla; la pantalla ya
 * muestra la etiqueta linda y el archivo tiene que coincidir con lo que la
 * encargada ve.
 */
const PUESTO_LABEL: Record<string, string> = {
  CAJERO: 'Cajero',
  COCINERO: 'Cocinero',
  ENCARGADO: 'Encargado',
  MOTOQUERO: 'Motoquero',
  ADMINISTRATIVO: 'Administrativo',
  OTRO: 'Otro',
};

export default async function empleadosRoutes(fastify: FastifyInstance) {
  // GET /admin/empleados — lista con búsqueda, filtro temporal, paginación y
  // export a Excel. Mismo contrato que las otras tablas pesadas del admin.
  //
  // El filtro temporal acota los MOVIMIENTOS (lo pagado, los adelantos), no la
  // lista de empleados: se ven todos, con sus números del período elegido. Una
  // lista de personal que esconde gente según un rango de fechas no tendría
  // sentido — el empleado existe igual aunque no haya cobrado esta semana.
  fastify.get(
    '/admin/empleados',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          incluirInactivos: queryBool(false),
          q: z.string().trim().min(1).max(80).optional(),
          periodo: periodoBusquedaSchema.optional(),
          desde: z.string().datetime().optional(),
          hasta: z.string().datetime().optional(),
          ...paginacionSchema,
          formato: z.enum(['json', 'xlsx']).optional(),
        }),
      },
    },
    async (req, reply) => {
      const q = req.query as {
        incluirInactivos: boolean;
        q?: string;
        periodo?: PeriodoBusqueda;
        desde?: string;
        hasta?: string;
        page: number;
        pageSize: number;
        formato?: 'json' | 'xlsx';
      };

      const ft = await resolverFiltroTemporal({
        periodo: q.periodo,
        desde: q.desde,
        hasta: q.hasta,
      });

      const texto = q.q?.trim();
      const where = {
        ...(q.incluirInactivos ? {} : { activo: true }),
        ...(texto && {
          // Multi-campo: además de nombre/apellido, por DNI, CUIL, teléfono
          // y email — para poder encontrar a alguien por cualquiera de sus datos.
          OR: [
            { nombre: { contains: texto, mode: 'insensitive' as const } },
            { apellido: { contains: texto, mode: 'insensitive' as const } },
            { dni: { contains: texto, mode: 'insensitive' as const } },
            { cuil: { contains: texto, mode: 'insensitive' as const } },
            { telefono: { contains: texto, mode: 'insensitive' as const } },
            { email: { contains: texto, mode: 'insensitive' as const } },
          ],
        }),
      };

      const orderBy = [{ activo: 'desc' as const }, { nombre: 'asc' as const }];
      const exportando = q.formato === 'xlsx';
      const TOPE_EXPORT = 5000;

      const skip = exportando ? 0 : (q.page - 1) * q.pageSize;
      const take = exportando ? TOPE_EXPORT : q.pageSize;

      const [empleados, total] = await Promise.all([
        prisma.empleado.findMany({ where, orderBy, skip, take }),
        prisma.empleado.count({ where }),
      ]);

      // Los movimientos se suman SOLO para los empleados que se van a devolver.
      // Sumarlos para toda la base y después descartar sería pagar la query
      // entera para mostrar doce filas.
      const ids = empleados.map((e) => e.id);
      const movs = ids.length
        ? await prisma.movimiento.groupBy({
            by: ['entidadId', 'categoriaId'],
            _sum: { monto: true },
            where: {
              entidadId: { in: ids },
              tipo: 'EGRESO',
              estado: EstadoMovimiento.CONFIRMADO,
              // Igual que en movimientos: por sesión se filtra por sesionCajaId,
              // no por un rango de fechas — son dos criterios distintos.
              ...(ft.sesionCajaId
                ? { sesionCajaId: ft.sesionCajaId }
                : whereRangoFecha('fechaComputo', ft)),
            },
          })
        : [];

      const categorias = await prisma.categoriaMovimiento.findMany({
        where: { id: { in: [...new Set(movs.map((m) => m.categoriaId))] } },
      });
      const catById = new Map(categorias.map((c) => [c.id, c.nombre]));

      type Resumen = { sueldos: number; adelantos: number; comisiones: number; otros: number };
      const resumen = new Map<string, Resumen>();
      for (const m of movs) {
        if (!m.entidadId) continue;
        const cur = resumen.get(m.entidadId) ?? {
          sueldos: 0,
          adelantos: 0,
          comisiones: 0,
          otros: 0,
        };
        const monto = Number(m._sum.monto ?? 0);
        const cat = catById.get(m.categoriaId) ?? '';
        if (cat === 'Sueldos') cur.sueldos += monto;
        else if (cat === 'Adelanto a empleado') cur.adelantos += monto;
        else if (cat === 'Comisiones') cur.comisiones += monto;
        else cur.otros += monto;
        resumen.set(m.entidadId, cur);
      }

      const filas = empleados.map((e) => {
        const r = resumen.get(e.id);
        const sueldoBase = e.sueldoBase ? Number(e.sueldoBase) : 0;
        const sueldos = r?.sueldos ?? 0;
        const adelantos = r?.adelantos ?? 0;
        const comisiones = r?.comisiones ?? 0;
        const otros = r?.otros ?? 0;
        return {
          e,
          sueldoBase,
          sueldos,
          adelantos,
          comisiones,
          otros,
          total: sueldos + adelantos + comisiones + otros,
          // Sueldo base menos lo cobrado EN EL PERÍODO ELEGIDO. Sólo significa
          // algo si el período se parece a un mes; con "hoy" o "7 días" va a dar
          // casi el sueldo entero. Por eso la lista arranca en 30 días.
          saldoSueldo: sueldoBase > 0 ? Math.max(0, sueldoBase - sueldos - adelantos) : 0,
        };
      });

      if (exportando) {
        const buf = await construirExcelBusqueda({
          titulo: 'Empleados',
          filtros: descripcionFiltros({
            periodo: q.periodo,
            desde: ft.desde,
            hasta: ft.hasta,
            texto,
            extra: q.incluirInactivos ? 'Incluye inactivos' : 'Sólo activos',
          }),
          columnas: [
            { header: 'Nombre', key: 'nombre', width: 22 },
            { header: 'Apellido', key: 'apellido', width: 22 },
            { header: 'Puesto', key: 'puesto', width: 16 },
            { header: 'Estado', key: 'estado', width: 10 },
            { header: 'DNI', key: 'dni', width: 14 },
            { header: 'CUIL', key: 'cuil', width: 16 },
            { header: 'Teléfono', key: 'telefono', width: 16 },
            { header: 'Email', key: 'email', width: 26 },
            { header: 'Forma de pago', key: 'formaPago', width: 14 },
            { header: 'Ingreso', key: 'ingreso', tipo: 'fecha' },
            { header: 'Egreso', key: 'egreso', tipo: 'fecha' },
            { header: 'Sueldo base', key: 'sueldoBase', tipo: 'dinero' },
            { header: 'Sueldos pagados', key: 'sueldos', tipo: 'dinero' },
            { header: 'Adelantos', key: 'adelantos', tipo: 'dinero' },
            { header: 'Comisiones', key: 'comisiones', tipo: 'dinero' },
            { header: 'Otros', key: 'otros', tipo: 'dinero' },
            { header: 'Total cobrado', key: 'total', tipo: 'dinero' },
            { header: 'Saldo de sueldo', key: 'saldo', tipo: 'dinero' },
            { header: 'Observaciones', key: 'observaciones', width: 34 },
          ],
          filas: filas.map((f) => ({
            nombre: f.e.nombre,
            apellido: f.e.apellido ?? '',
            puesto: PUESTO_LABEL[f.e.puesto] ?? f.e.puesto,
            estado: f.e.activo ? 'Activo' : 'Inactivo',
            dni: f.e.dni ?? '',
            cuil: f.e.cuil ?? '',
            telefono: f.e.telefono ?? '',
            email: f.e.email ?? '',
            formaPago: f.e.formaPago ?? '',
            ingreso: f.e.fechaIngreso,
            egreso: f.e.fechaEgreso,
            sueldoBase: f.sueldoBase,
            sueldos: f.sueldos,
            adelantos: f.adelantos,
            comisiones: f.comisiones,
            otros: f.otros,
            total: f.total,
            saldo: f.saldoSueldo,
            observaciones: f.e.observaciones ?? '',
          })),
          totales: [
            { etiqueta: 'TOTAL COBRADO', columna: 'total' },
            { etiqueta: 'ADELANTOS', columna: 'adelantos' },
            { etiqueta: 'SALDO DE SUELDOS', columna: 'saldo' },
            { etiqueta: 'Cantidad de empleados', valor: filas.length },
          ],
          hayMas:
            total > filas.length ? { exportadas: filas.length, totales: total } : undefined,
        });
        return reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          )
          .header(
            'Content-Disposition',
            `attachment; filename="${nombreArchivoExport('empleados')}"`,
          )
          .send(buf);
      }

      return {
        empleados: filas.map((f) => ({
          ...f.e,
          sueldoBase: f.e.sueldoBase?.toFixed(2) ?? null,
          sueldosPagados: f.sueldos.toFixed(2),
          adelantos: f.adelantos.toFixed(2),
          comisiones: f.comisiones.toFixed(2),
          otros: f.otros.toFixed(2),
          totalCobrado: f.total.toFixed(2),
          saldoSueldo: f.saldoSueldo.toFixed(2),
        })),
        // La paginación va en el NIVEL SUPERIOR, no anidada en `meta`: es lo que
        // lee `useBusquedaPaginada` (res.total, res.page…) y lo que devuelven
        // las otras tablas. Anidada, la pantalla mostraba "0 empleados" con
        // cuatro filas en la tabla y el botón de exportar deshabilitado.
        ...armarPaginacion(total, q.page, q.pageSize),
      };
    },
  );

  // GET /admin/empleados/:id — detalle con histórico
  fastify.get(
    '/admin/empleados/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          desde: z.string().datetime().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const q = req.query as { desde?: string };

      const empleado = await prisma.empleado.findUnique({ where: { id: params.id } });
      if (!empleado) return reply.code(404).send({ error: 'Empleado no encontrado' });

      const desde = q.desde
        ? new Date(q.desde)
        : new Date(new Date().getFullYear(), 0, 1); // Default: este año

      const movimientos = await prisma.movimiento.findMany({
        where: {
          entidadId: params.id,
          tipo: 'EGRESO',
          fechaComputo: { gte: desde },
        },
        include: {
          categoria: { select: { nombre: true } },
          cuentaOrigen: { select: { nombre: true } },
          usuario: { select: { nombre: true } },
        },
        orderBy: { fechaComputo: 'desc' },
        take: 200,
      });

      const totales = movimientos
        .filter((m) => m.estado === EstadoMovimiento.CONFIRMADO)
        .reduce(
          (acc, m) => {
            const cat = m.categoria.nombre;
            const monto = Number(m.monto);
            acc.total += monto;
            if (cat === 'Sueldos') acc.sueldos += monto;
            else if (cat === 'Adelanto a empleado') acc.adelantos += monto;
            else if (cat === 'Comisiones') acc.comisiones += monto;
            else acc.otros += monto;
            return acc;
          },
          { total: 0, sueldos: 0, adelantos: 0, comisiones: 0, otros: 0 },
        );

      return {
        empleado: {
          ...empleado,
          sueldoBase: empleado.sueldoBase?.toFixed(2) ?? null,
        },
        movimientos: movimientos.map((m) => ({
          ...m,
          monto: m.monto.toString(),
        })),
        totales: {
          total: totales.total.toFixed(2),
          sueldos: totales.sueldos.toFixed(2),
          adelantos: totales.adelantos.toFixed(2),
          comisiones: totales.comisiones.toFixed(2),
          otros: totales.otros.toFixed(2),
        },
      };
    },
  );

  // POST /admin/empleados — crear empleado
  fastify.post(
    '/admin/empleados',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().min(1).max(120),
          apellido: z.string().max(120).optional(),
          dni: z.string().max(20).optional(),
          cuil: z.string().max(20).optional(),
          puesto: z.enum([
            'CAJERO',
            'COCINERO',
            'ENCARGADO',
            'MOTOQUERO',
            'ADMINISTRATIVO',
            'OTRO',
          ]),
          sueldoBase: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          formaPago: z.string().max(40).optional(),
          telefono: z.string().max(40).optional(),
          email: z.string().email().optional(),
          fechaIngreso: z.string().optional(),
          observaciones: z.string().max(500).optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        apellido?: string;
        dni?: string;
        cuil?: string;
        puesto: 'CAJERO' | 'COCINERO' | 'ENCARGADO' | 'MOTOQUERO' | 'ADMINISTRATIVO' | 'OTRO';
        sueldoBase?: string;
        formaPago?: string;
        telefono?: string;
        email?: string;
        fechaIngreso?: string;
        observaciones?: string;
      };
      const created = await prisma.empleado.create({
        data: {
          nombre: body.nombre,
          apellido: body.apellido ?? null,
          dni: body.dni ?? null,
          cuil: body.cuil ?? null,
          puesto: body.puesto,
          sueldoBase: body.sueldoBase ?? null,
          formaPago: body.formaPago ?? null,
          telefono: body.telefono ?? null,
          email: body.email ?? null,
          fechaIngreso: body.fechaIngreso ? new Date(body.fechaIngreso) : null,
          observaciones: body.observaciones ?? null,
        },
      });
      await recordAudit({
        tabla: 'empleados',
        registroId: created.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { nombre: created.nombre, puesto: created.puesto },
      });
      return reply.code(201).send(created);
    },
  );

  // PATCH /admin/empleados/:id — editar
  fastify.patch(
    '/admin/empleados/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().min(1).max(120).optional(),
          apellido: z.string().max(120).nullable().optional(),
          dni: z.string().max(20).nullable().optional(),
          cuil: z.string().max(20).nullable().optional(),
          puesto: z
            .enum(['CAJERO', 'COCINERO', 'ENCARGADO', 'MOTOQUERO', 'ADMINISTRATIVO', 'OTRO'])
            .optional(),
          sueldoBase: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
          formaPago: z.string().max(40).nullable().optional(),
          telefono: z.string().max(40).nullable().optional(),
          email: z.string().email().nullable().optional(),
          activo: z.boolean().optional(),
          observaciones: z.string().max(500).nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.empleado.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Empleado no encontrado' });
      const updated = await prisma.empleado.update({
        where: { id: params.id },
        data: req.body as Record<string, unknown>,
      });
      await recordAudit({
        tabla: 'empleados',
        registroId: updated.id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre, puesto: before.puesto, activo: before.activo },
        valorNuevo: { nombre: updated.nombre, puesto: updated.puesto, activo: updated.activo },
      });
      return updated;
    },
  );

  // DELETE /admin/empleados/:id — soft delete (activo=false). Los movimientos
  // (sueldos/adelantos) históricos lo siguen referenciando.
  fastify.delete(
    '/admin/empleados/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      const before = await prisma.empleado.findUnique({ where: { id: params.id } });
      if (!before) return reply.code(404).send({ error: 'Empleado no encontrado' });
      await prisma.empleado.update({ where: { id: params.id }, data: { activo: false } });
      await recordAudit({
        tabla: 'empleados',
        registroId: params.id,
        accion: 'DELETE',
        usuarioId: req.usuario!.id,
        valorAnterior: { nombre: before.nombre },
      });
      return { ok: true };
    },
  );

  // POST /admin/empleados/:id/movimientos — cargar pago / adelanto / comisión
  fastify.post(
    '/admin/empleados/:id/movimientos',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          // Concepto como ETIQUETA libre (viene de la lista configurable
          // `concepto_pago_empleado`). Se acepta cualquier string para soportar
          // conceptos que la encargada agregue. `tipoConcepto` (enum viejo) se
          // mantiene opcional por compatibilidad.
          conceptoEtiqueta: z.string().min(1).max(120).optional(),
          tipoConcepto: z.string().max(40).optional(),
          // Modo simple (1 cuenta) — compat con clientes existentes.
          monto: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          cuentaOrigenId: z.string().uuid().optional(),
          metodo: z
            .enum([
              'EFECTIVO',
              'TRANSFERENCIA',
              'DEPOSITO',
              'CHEQUE',
              'MERCADOPAGO_QR',
              'OTRO',
            ])
            .default('EFECTIVO'),
          // Modo multicuenta: reparte el pago en varias cuentas (cada una con su
          // monto y método). Si viene, tiene prioridad sobre el modo simple.
          pagos: z
            .array(
              z.object({
                cuentaId: z.string().uuid(),
                monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
                metodo: z
                  .enum([
                    'EFECTIVO',
                    'TRANSFERENCIA',
                    'DEPOSITO',
                    'CHEQUE',
                    'MERCADOPAGO_QR',
                    'OTRO',
                  ])
                  .default('EFECTIVO'),
                numeroReferencia: z.string().max(80).optional(),
              }),
            )
            .min(1)
            .optional(),
          fechaComputo: z.string().datetime().optional(),
          observacion: z.string().max(500).optional(),
          numeroReferencia: z.string().max(80).optional(),
        }),
      },
    },
    async (req, reply) => {
      const params = req.params as { id: string };
      type MetodoPago =
        | 'EFECTIVO'
        | 'TRANSFERENCIA'
        | 'DEPOSITO'
        | 'CHEQUE'
        | 'MERCADOPAGO_QR'
        | 'OTRO';
      const body = req.body as {
        conceptoEtiqueta?: string;
        tipoConcepto?: string;
        monto?: string;
        cuentaOrigenId?: string;
        metodo: MetodoPago;
        pagos?: Array<{
          cuentaId: string;
          monto: string;
          metodo: MetodoPago;
          numeroReferencia?: string;
        }>;
        fechaComputo?: string;
        observacion?: string;
        numeroReferencia?: string;
      };

      const empleado = await prisma.empleado.findUnique({ where: { id: params.id } });
      if (!empleado) return reply.code(404).send({ error: 'Empleado no encontrado' });

      // Compat enum viejo (UPPERCASE) → etiqueta de la lista.
      const codeToEtiqueta: Record<string, string> = {
        SUELDO: 'Sueldo',
        JORNADA: 'Jornada',
        HORAS_EXTRA: 'Horas extra',
        FERIADO: 'Feriado',
        VACACIONES: 'Vacaciones',
        AGUINALDO: 'Aguinaldo',
        ADELANTO: 'Adelanto',
        COMISION: 'Comisión',
        OTRO: 'Otro',
      };
      const etiqueta =
        body.conceptoEtiqueta?.trim() ||
        (body.tipoConcepto ? codeToEtiqueta[body.tipoConcepto] ?? body.tipoConcepto : '') ||
        'Otro';

      // Resolver la categoría contable destino desde la lista configurable.
      // Fallback: mapa conocido por etiqueta, sino "Extraordinario / Sin categoría".
      const opcion = await prisma.opcionConfigurable.findFirst({
        where: { dominio: 'concepto_pago_empleado', etiqueta: { equals: etiqueta, mode: 'insensitive' } },
      });
      const fallbackCat: Record<string, string> = {
        Sueldo: 'Sueldos',
        Jornada: 'Sueldos',
        'Horas extra': 'Sueldos',
        Feriado: 'Sueldos',
        Vacaciones: 'Sueldos',
        Aguinaldo: 'Sueldos',
        Adelanto: 'Adelanto a empleado',
        Comisión: 'Comisiones',
      };
      const atributos = (opcion?.atributos as { categoria?: string } | null) ?? null;
      const categoriaNombre =
        atributos?.categoria ?? fallbackCat[etiqueta] ?? 'Extraordinario / Sin categoría';
      const categoria = await prisma.categoriaMovimiento.findUnique({
        where: { nombre: categoriaNombre },
      });
      if (!categoria) {
        return reply.code(500).send({ error: 'Categoría del sistema no encontrada' });
      }

      const fecha = body.fechaComputo ? new Date(body.fechaComputo) : new Date();

      // Normalizamos a una lista de líneas (1 o más cuentas). El modo `pagos`
      // (multicuenta) tiene prioridad; sino caemos al modo simple de 1 cuenta.
      const lineas: Array<{
        cuentaId: string;
        monto: string;
        metodo: MetodoPago;
        numeroReferencia?: string;
      }> =
        body.pagos && body.pagos.length > 0
          ? body.pagos
          : body.cuentaOrigenId && body.monto
            ? [
                {
                  cuentaId: body.cuentaOrigenId,
                  monto: body.monto,
                  metodo: body.metodo,
                  numeroReferencia: body.numeroReferencia,
                },
              ]
            : [];
      if (lineas.length === 0) {
        return reply.code(400).send({ error: 'Falta la cuenta de origen y el monto' });
      }
      const cuentaIds = lineas.map((l) => l.cuentaId);
      if (new Set(cuentaIds).size !== cuentaIds.length) {
        return reply.code(400).send({ error: 'No repitas la misma cuenta en el reparto' });
      }

      // Anteponer la etiqueta del concepto a la observación cuando aporta info
      // (los conceptos que comparten la categoría "Sueldos", o cualquiera que
      // no sea el plano "Sueldo"). Así queda trazable qué tipo de pago fue.
      const obsConConcepto =
        categoriaNombre === 'Sueldos' && etiqueta.toLowerCase() !== 'sueldo'
          ? `${etiqueta}${body.observacion ? ' · ' + body.observacion : ''}`
          : body.observacion;

      // Sesión del turno: el pago a empleado es un movimiento de caja y DEBE
      // contar en el cierre. Sin sesionCajaId el movimiento queda huérfano del
      // turno y el efectivo NO se descuenta de la caja (bug reportado). Ver
      // invariante en CLAUDE.md (mismo incidente que alpha.19).
      let sesion;
      try {
        sesion = await getOrCreateSesionActual(req.usuario!.id);
      } catch (e) {
        if (e instanceof FueraDeHorarioError) {
          return reply.code(423).send({
            error: 'Fuera del horario de atención — no hay sesión de caja abierta',
            codigo: 'FUERA_DE_HORARIO',
            resolucion: e.resolucion,
          });
        }
        throw e;
      }

      // Multicuenta: creamos N movimientos enlazados (un EGRESO por cuenta),
      // cada uno con su pago y su decremento de saldo. Mismo patrón que el form
      // de Aportes/Egresos. Con 1 sola cuenta es 1 movimiento, como antes.
      const total = lineas.length;
      const created = await prisma.$transaction(async (tx) => {
        const movs = [];
        for (let i = 0; i < lineas.length; i++) {
          const linea = lineas[i]!;
          const montoLinea = Number(linea.monto);
          const observacion =
            total > 1
              ? `${obsConConcepto ? obsConConcepto + ' ' : ''}(parte ${i + 1}/${total})`
              : obsConConcepto ?? null;
          const mov = await tx.movimiento.create({
            data: {
              tipo: 'EGRESO',
              monto: linea.monto,
              categoriaId: categoria.id,
              cuentaOrigenId: linea.cuentaId,
              entidadId: empleado.id,
              sesionCajaId: sesion.id,
              fechaComputo: fecha,
              observacion,
              estado: EstadoMovimiento.CONFIRMADO,
              usuarioId: req.usuario!.id,
            },
          });
          await tx.pago.create({
            data: {
              movimientoId: mov.id,
              metodo: linea.metodo,
              cuentaId: linea.cuentaId,
              monto: linea.monto,
              numeroReferencia: linea.numeroReferencia ?? null,
              estado: 'CONFIRMADO',
              fecha,
            },
          });
          await tx.cuenta.update({
            where: { id: linea.cuentaId },
            data: { saldoActual: { decrement: montoLinea } },
          });
          movs.push(mov);
        }
        return movs;
      });

      for (const mov of created) {
        await recordAudit({
          tabla: 'movimientos',
          registroId: mov.id,
          accion: 'INSERT',
          usuarioId: req.usuario!.id,
          valorNuevo: {
            tipo: 'EGRESO',
            concepto: body.conceptoEtiqueta ?? body.tipoConcepto,
            empleadoId: empleado.id,
            empleadoNombre: empleado.nombre,
            monto: mov.monto,
          },
        });
      }

      return reply.code(201).send({ movimientos: created });
    },
  );
}
