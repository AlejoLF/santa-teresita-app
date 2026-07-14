import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { RolUsuario, EstadoMovimiento } from '@sta/db';
import { queryBool } from '@sta/shared/schemas';
import { recordAudit } from '../services/audit.js';
import { getOrCreateSesionActual, FueraDeHorarioError } from '../services/sesion-caja.js';

/**
 * CRUD de empleados + carga de movimientos de personal (sueldos, adelantos, comisiones).
 * Cada movimiento de personal es un Movimiento (egreso) con entidadId apuntando al Empleado
 * y categoría "Sueldos" / "Adelanto a empleado" / "Comisiones".
 */
export default async function empleadosRoutes(fastify: FastifyInstance) {
  // GET /admin/empleados — lista con saldo mes actual y total adelantos pendientes
  fastify.get(
    '/admin/empleados',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          incluirInactivos: queryBool(false),
          q: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query as { incluirInactivos: boolean; q?: string };
      const empleados = await prisma.empleado.findMany({
        where: {
          ...(q.incluirInactivos ? {} : { activo: true }),
          ...(q.q && {
            // Multi-campo: además de nombre/apellido, por DNI, CUIL, teléfono
            // y email — para poder encontrar a alguien por cualquiera de sus datos.
            OR: [
              { nombre: { contains: q.q, mode: 'insensitive' as const } },
              { apellido: { contains: q.q, mode: 'insensitive' as const } },
              { dni: { contains: q.q, mode: 'insensitive' as const } },
              { cuil: { contains: q.q, mode: 'insensitive' as const } },
              { telefono: { contains: q.q, mode: 'insensitive' as const } },
              { email: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }),
        },
        orderBy: [{ activo: 'desc' }, { nombre: 'asc' }],
      });

      // Sumar movimientos del mes actual por empleado y categoría
      const ahora = new Date();
      const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

      const movsMes = await prisma.movimiento.groupBy({
        by: ['entidadId', 'categoriaId'],
        _sum: { monto: true },
        _count: { _all: true },
        where: {
          entidadId: { in: empleados.map((e) => e.id) },
          tipo: 'EGRESO',
          estado: EstadoMovimiento.CONFIRMADO,
          fechaComputo: { gte: inicioMes },
        },
      });

      // Cargar nombres de categorías
      const categorias = await prisma.categoriaMovimiento.findMany({
        where: {
          id: { in: [...new Set(movsMes.map((m) => m.categoriaId))] },
        },
      });
      const catById = new Map(categorias.map((c) => [c.id, c.nombre]));

      // Agrupar por empleado
      type ResumenEmpleado = {
        sueldosMes: number;
        adelantosMes: number;
        comisionesMes: number;
        otrosMes: number;
        totalMes: number;
      };
      const resumen = new Map<string, ResumenEmpleado>();
      for (const m of movsMes) {
        if (!m.entidadId) continue;
        const cur = resumen.get(m.entidadId) ?? {
          sueldosMes: 0,
          adelantosMes: 0,
          comisionesMes: 0,
          otrosMes: 0,
          totalMes: 0,
        };
        const monto = Number(m._sum.monto ?? 0);
        const catNombre = catById.get(m.categoriaId) ?? '';
        if (catNombre === 'Sueldos') cur.sueldosMes += monto;
        else if (catNombre === 'Adelanto a empleado') cur.adelantosMes += monto;
        else if (catNombre === 'Comisiones') cur.comisionesMes += monto;
        else cur.otrosMes += monto;
        cur.totalMes += monto;
        resumen.set(m.entidadId, cur);
      }

      return {
        empleados: empleados.map((e) => {
          const r = resumen.get(e.id);
          const sueldoBase = e.sueldoBase ? Number(e.sueldoBase) : 0;
          const adelantos = r?.adelantosMes ?? 0;
          const comisiones = r?.comisionesMes ?? 0;
          const sueldosPagados = r?.sueldosMes ?? 0;
          // Si tiene sueldo base mensual, se calcula saldo a pagar.
          const saldoSueldo =
            sueldoBase > 0
              ? Math.max(0, sueldoBase - sueldosPagados - adelantos)
              : 0;
          return {
            ...e,
            sueldoBase: e.sueldoBase?.toFixed(2) ?? null,
            sueldosPagadosMes: sueldosPagados.toFixed(2),
            adelantosMes: adelantos.toFixed(2),
            comisionesMes: comisiones.toFixed(2),
            saldoSueldoMes: saldoSueldo.toFixed(2),
          };
        }),
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
