/**
 * Banco de horas (SPEC §14). Todo ADMIN-only.
 *
 * El pedido del dueño fue "carga sólo la encargada", pero el sistema tiene dos
 * roles operativos y Julio también es Admin: no se puede excluir sin inventar
 * un nivel de permisos nuevo. En su lugar, **cada fila registra su usuarioId**.
 * Si un día carga Julio, se ve. Cubre la intención sin sumar una capa que
 * después hay que mantener.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@sta/db/client';
import { RolUsuario, EstadoMovimiento } from '@sta/db';
import { recordAudit } from '../services/audit.js';
import { getOrCreateSesionActual, FueraDeHorarioError } from '../services/sesion-caja.js';
import { ReglaNegocioError } from '../services/errores.js';
import {
  calcularSaldo,
  filasPendientesDe,
  exigirValorHora,
  valorHoraBase,
  valorDeTipoHora,
} from '../services/banco-horas.js';

const SELECT_TARIFA = {
  id: true,
  nombre: true,
  apellido: true,
  activo: true,
  puesto: true,
  valorHoraPropio: true,
  categoriaLaboral: { select: { id: true, nombre: true, valorHora: true } },
} as const;

/** Fecha (sin hora) en TZ Argentina. Ver el invariante de TZ en CLAUDE.md. */
function hoyFecha(): Date {
  const ahora = new Date();
  return new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
}

export default async function bancoHorasRoutes(fastify: FastifyInstance) {
  // ── Listado con el saldo de cada uno + el total adeudado ────────────────
  fastify.get(
    '/admin/banco-horas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        querystring: z.object({
          q: z.string().trim().min(1).max(80).optional(),
          incluirInactivos: z.coerce.boolean().default(false),
          soloConSaldo: z.coerce.boolean().default(false),
        }),
      },
    },
    async (req) => {
      const q = req.query as { q?: string; incluirInactivos: boolean; soloConSaldo: boolean };
      const empleados = await prisma.empleado.findMany({
        where: {
          ...(q.incluirInactivos ? {} : { activo: true }),
          ...(q.q && {
            OR: [
              { nombre: { contains: q.q, mode: 'insensitive' as const } },
              { apellido: { contains: q.q, mode: 'insensitive' as const } },
            ],
          }),
        },
        select: SELECT_TARIFA,
        orderBy: [{ activo: 'desc' }, { nombre: 'asc' }],
      });

      // Una sola consulta para todos: valuar es aritmética, no ida y vuelta a
      // la base por persona.
      const pendientes = await filasPendientesDe(empleados.map((e) => e.id));

      let filas = empleados.map((e) => {
        const s = calcularSaldo(e, pendientes.get(e.id) ?? []);
        return {
          id: e.id,
          nombre: e.nombre,
          apellido: e.apellido,
          puesto: e.puesto,
          activo: e.activo,
          categoria: e.categoriaLaboral?.nombre ?? null,
          tieneValorPropio: e.valorHoraPropio != null,
          valorHora: s.valorHora.toFixed(2),
          horasPendientes: s.horasPendientes.toFixed(2),
          montoHoras: s.montoHoras.toFixed(2),
          adelantosPendientes: s.adelantosPendientes.toFixed(2),
          saldo: s.saldo.toFixed(2),
          sinValorHora: s.sinValorHora,
        };
      });
      if (q.soloConSaldo) {
        filas = filas.filter(
          (f) => Number(f.horasPendientes) !== 0 || Number(f.adelantosPendientes) !== 0,
        );
      }

      const tot = filas.reduce(
        (a, f) => ({
          montoHoras: a.montoHoras + Number(f.montoHoras),
          adelantos: a.adelantos + Number(f.adelantosPendientes),
          saldo: a.saldo + Number(f.saldo),
        }),
        { montoHoras: 0, adelantos: 0, saldo: 0 },
      );

      return {
        empleados: filas,
        totales: {
          montoHoras: tot.montoHoras.toFixed(2),
          adelantos: tot.adelantos.toFixed(2),
          saldo: tot.saldo.toFixed(2),
        },
      };
    },
  );

  // ── El libro de una persona ─────────────────────────────────────────────
  fastify.get(
    '/admin/banco-horas/:empleadoId',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ empleadoId: z.string().uuid() }),
        querystring: z.object({ limite: z.coerce.number().int().min(1).max(500).default(100) }),
      },
    },
    async (req, reply) => {
      const { empleadoId } = req.params as { empleadoId: string };
      const { limite } = req.query as { limite: number };
      const empleado = await prisma.empleado.findUnique({
        where: { id: empleadoId },
        select: SELECT_TARIFA,
      });
      if (!empleado) return reply.code(404).send({ error: 'Empleado no encontrado' });

      const [movs, pendientes] = await Promise.all([
        prisma.movimientoBancoHoras.findMany({
          where: { empleadoId },
          orderBy: [{ fecha: 'desc' }, { creadoAt: 'desc' }],
          take: limite,
          select: {
            id: true,
            tipo: true,
            horas: true,
            montoPesos: true,
            fecha: true,
            observacion: true,
            liquidacionId: true,
            creadoAt: true,
            tipoHora: { select: { nombre: true, multiplicador: true, valorHoraFijo: true } },
            usuario: { select: { nombre: true } },
          },
        }),
        filasPendientesDe([empleadoId]),
      ]);
      const s = calcularSaldo(empleado, pendientes.get(empleadoId) ?? []);
      const base = valorHoraBase(empleado);

      return {
        empleado: {
          id: empleado.id,
          nombre: empleado.nombre,
          apellido: empleado.apellido,
          categoria: empleado.categoriaLaboral?.nombre ?? null,
          categoriaLaboralId: empleado.categoriaLaboral?.id ?? null,
          valorHoraPropio: empleado.valorHoraPropio?.toFixed(2) ?? null,
          valorHora: s.valorHora.toFixed(2),
        },
        saldo: {
          horasPendientes: s.horasPendientes.toFixed(2),
          montoHoras: s.montoHoras.toFixed(2),
          adelantosPendientes: s.adelantosPendientes.toFixed(2),
          saldo: s.saldo.toFixed(2),
          sinValorHora: s.sinValorHora,
        },
        movimientos: movs.map((m) => ({
          id: m.id,
          tipo: m.tipo,
          horas: m.horas?.toFixed(2) ?? null,
          montoPesos: m.montoPesos?.toFixed(2) ?? null,
          fecha: m.fecha,
          observacion: m.observacion,
          liquidado: m.liquidacionId != null,
          tipoHora: m.tipoHora?.nombre ?? null,
          // El valor que tendría HOY esa hora. En las filas ya liquidadas es
          // informativo: lo que se pagó quedó estampado en la liquidación.
          valorHoraFila: m.horas ? valorDeTipoHora(base, m.tipoHora).toFixed(2) : null,
          usuario: m.usuario.nombre,
          creadoAt: m.creadoAt,
        })),
      };
    },
  );

  // ── Cargar horas de un día ──────────────────────────────────────────────
  fastify.post(
    '/admin/banco-horas/:empleadoId/horas',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ empleadoId: z.string().uuid() }),
        body: z.object({
          fecha: z.string().datetime(),
          horas: z.number().positive().max(24),
          tipoHoraId: z.string().uuid().optional(),
          observacion: z.string().max(300).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { empleadoId } = req.params as { empleadoId: string };
      const body = req.body as {
        fecha: string;
        horas: number;
        tipoHoraId?: string;
        observacion?: string;
      };
      const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId } });
      if (!empleado) return reply.code(404).send({ error: 'Empleado no encontrado' });

      const fila = await prisma.movimientoBancoHoras.create({
        data: {
          empleadoId,
          tipo: 'HORAS_TRABAJADAS',
          horas: body.horas,
          tipoHoraId: body.tipoHoraId ?? null,
          fecha: new Date(body.fecha),
          observacion: body.observacion ?? null,
          usuarioId: req.usuario!.id,
        },
      });
      await recordAudit({
        tabla: 'movimientos_banco_horas',
        registroId: fila.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: fila,
      });
      return reply.code(201).send({ ok: true, id: fila.id });
    },
  );

  // ── Cuántas horas ya tiene ese día (para avisar, no para bloquear) ──────
  //
  // El turno partido —mañana y tarde— son dos cargas legítimas del mismo día,
  // así que no hay constraint único. Lo que sí hace la pantalla es avisar,
  // porque el error real y frecuente no es el turno partido: es cargar dos
  // veces lo mismo.
  fastify.get(
    '/admin/banco-horas/:empleadoId/dia',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ empleadoId: z.string().uuid() }),
        querystring: z.object({ fecha: z.string().datetime() }),
      },
    },
    async (req) => {
      const { empleadoId } = req.params as { empleadoId: string };
      const { fecha } = req.query as { fecha: string };
      const d = new Date(fecha);
      const dia = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const r = await prisma.movimientoBancoHoras.aggregate({
        _sum: { horas: true },
        where: { empleadoId, tipo: 'HORAS_TRABAJADAS', fecha: dia },
      });
      return { horas: Number(r._sum.horas ?? 0).toFixed(2) };
    },
  );

  // ── Adelanto: UNA acción con DOS efectos ────────────────────────────────
  //
  // Sale plata de la caja Y baja el saldo del empleado. Si fueran dos cargas
  // separadas, tarde o temprano queda un adelanto en el banco de horas que
  // nunca salió de la caja, o al revés.
  fastify.post(
    '/admin/banco-horas/:empleadoId/adelanto',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ empleadoId: z.string().uuid() }),
        body: z.object({
          monto: z.number().positive(),
          cuentaId: z.string().uuid(),
          metodo: z.string().min(1).max(40).default('EFECTIVO'),
          observacion: z.string().max(300).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { empleadoId } = req.params as { empleadoId: string };
      const body = req.body as {
        monto: number;
        cuentaId: string;
        metodo: string;
        observacion?: string;
      };
      const empleado = await prisma.empleado.findUnique({ where: { id: empleadoId } });
      if (!empleado) return reply.code(404).send({ error: 'Empleado no encontrado' });

      const categoria = await prisma.categoriaMovimiento.findFirst({
        where: { nombre: 'Adelanto a empleado' },
      });
      if (!categoria) {
        throw new ReglaNegocioError(
          'Falta la categoría de movimiento "Adelanto a empleado". Creala en Configuración antes de dar adelantos.',
        );
      }

      // Sin sesionCajaId el movimiento NO entra al cierre de caja pero SÍ
      // aparece en /admin/movimientos — el incidente de alpha.18, textual.
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

      const fecha = new Date();
      const out = await prisma.$transaction(async (tx) => {
        const mov = await tx.movimiento.create({
          data: {
            tipo: 'EGRESO',
            monto: body.monto,
            categoriaId: categoria.id,
            cuentaOrigenId: body.cuentaId,
            entidadId: empleadoId,
            sesionCajaId: sesion.id,
            fechaComputo: fecha,
            observacion: body.observacion ?? `Adelanto a ${empleado.nombre}`,
            estado: EstadoMovimiento.CONFIRMADO,
            usuarioId: req.usuario!.id,
          },
        });
        await tx.pago.create({
          data: {
            movimientoId: mov.id,
            metodo: body.metodo as never,
            cuentaId: body.cuentaId,
            monto: body.monto,
            estado: 'CONFIRMADO',
            fecha,
          },
        });
        await tx.cuenta.update({
          where: { id: body.cuentaId },
          data: { saldoActual: { decrement: body.monto } },
        });
        const fila = await tx.movimientoBancoHoras.create({
          data: {
            empleadoId,
            tipo: 'ADELANTO',
            montoPesos: body.monto,
            fecha: hoyFecha(),
            observacion: body.observacion ?? null,
            movimientoId: mov.id,
            usuarioId: req.usuario!.id,
          },
        });
        return { mov, fila };
      });

      await recordAudit({
        tabla: 'movimientos_banco_horas',
        registroId: out.fila.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: out.fila,
      });
      return reply.code(201).send({ ok: true, id: out.fila.id, movimientoId: out.mov.id });
    },
  );

  // ── Liquidar: pagar lo pendiente ────────────────────────────────────────
  //
  // En el local liquidan casi todos los días, así que esto es un botón y no un
  // formulario: por defecto se liquida TODO lo pendiente.
  //
  // Es el único punto donde la revaluación se detiene. Hasta acá las horas
  // valían lo que valiera la categoría hoy; desde acá, el valor queda estampado
  // en la liquidación y no se mueve nunca más.
  fastify.post(
    '/admin/banco-horas/:empleadoId/liquidar',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ empleadoId: z.string().uuid() }),
        body: z.object({
          cuentaId: z.string().uuid(),
          metodo: z.string().min(1).max(40).default('EFECTIVO'),
          observacion: z.string().max(300).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { empleadoId } = req.params as { empleadoId: string };
      const body = req.body as { cuentaId: string; metodo: string; observacion?: string };

      const empleado = await prisma.empleado.findUnique({
        where: { id: empleadoId },
        select: SELECT_TARIFA,
      });
      if (!empleado) return reply.code(404).send({ error: 'Empleado no encontrado' });

      const nombre = `${empleado.nombre}${empleado.apellido ? ' ' + empleado.apellido : ''}`;
      const base = exigirValorHora(empleado, nombre);

      const pendientes = await prisma.movimientoBancoHoras.findMany({
        where: { empleadoId, liquidacionId: null },
        select: {
          id: true,
          horas: true,
          montoPesos: true,
          tipoHora: { select: { multiplicador: true, valorHoraFijo: true } },
        },
      });
      if (!pendientes.length) {
        throw new ReglaNegocioError(`${nombre} no tiene nada pendiente de liquidar.`);
      }

      let horas = 0;
      let montoHoras = 0;
      let adelantos = 0;
      for (const f of pendientes) {
        const h = f.horas != null ? Number(f.horas) : 0;
        if (h) {
          horas += h;
          montoHoras += h * valorDeTipoHora(base, f.tipoHora);
        }
        if (f.montoPesos != null) adelantos += Number(f.montoPesos);
      }
      const r2 = (n: number) => Math.round(n * 100) / 100;
      horas = r2(horas);
      montoHoras = r2(montoHoras);
      adelantos = r2(adelantos);
      const aPagar = r2(montoHoras - adelantos);

      if (aPagar < 0) {
        throw new ReglaNegocioError(
          `${nombre} debe $${(-aPagar).toFixed(2)}: los adelantos superan las horas trabajadas, así que no hay nada que pagarle. Cargá las horas que falten antes de liquidar.`,
        );
      }

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

      const categoria = await prisma.categoriaMovimiento.findFirst({
        where: { nombre: 'Sueldos' },
      });
      if (!categoria) {
        throw new ReglaNegocioError(
          'Falta la categoría de movimiento "Sueldos". Creala en Configuración antes de liquidar.',
        );
      }

      const fecha = new Date();
      const idsPendientes = pendientes.map((p) => p.id);

      const out = await prisma.$transaction(async (tx) => {
        let mov = null;
        // Puede dar 0 si las horas cubren justo los adelantos: la liquidación
        // existe igual (cierra las filas), pero no sale plata de la caja y por
        // lo tanto no corresponde un movimiento.
        if (aPagar > 0) {
          mov = await tx.movimiento.create({
            data: {
              tipo: 'EGRESO',
              monto: aPagar,
              categoriaId: categoria.id,
              cuentaOrigenId: body.cuentaId,
              entidadId: empleadoId,
              sesionCajaId: sesion.id,
              fechaComputo: fecha,
              observacion:
                body.observacion ?? `Liquidación de ${horas.toFixed(2)} hs a ${nombre}`,
              estado: EstadoMovimiento.CONFIRMADO,
              usuarioId: req.usuario!.id,
            },
          });
          await tx.pago.create({
            data: {
              movimientoId: mov.id,
              metodo: body.metodo as never,
              cuentaId: body.cuentaId,
              monto: aPagar,
              estado: 'CONFIRMADO',
              fecha,
            },
          });
          await tx.cuenta.update({
            where: { id: body.cuentaId },
            data: { saldoActual: { decrement: aPagar } },
          });
        }

        const liq = await tx.liquidacionEmpleado.create({
          data: {
            empleadoId,
            fecha: hoyFecha(),
            horasLiquidadas: horas,
            // El valor BASE aplicado. El monto sale de valuar fila por fila con
            // su tipo, así que con tipos mezclados este número es la referencia,
            // no una multiplicación directa.
            valorHoraAplicado: base,
            montoHoras,
            adelantosAplicados: adelantos,
            montoPagado: aPagar,
            movimientoId: mov?.id ?? null,
            observacion: body.observacion ?? null,
            usuarioId: req.usuario!.id,
          },
        });

        // Cerrar SÓLO las filas que se leyeron. Si entre la lectura y el update
        // entrara una fila nueva, `liquidacionId: null` a secas la arrastraría
        // sin haberla contado — y se pagaría de menos.
        const cerradas = await tx.movimientoBancoHoras.updateMany({
          where: { id: { in: idsPendientes }, liquidacionId: null },
          data: { liquidacionId: liq.id },
        });
        if (cerradas.count !== idsPendientes.length) {
          // Alguien liquidó en paralelo. Abortar es lo correcto: pagar dos veces
          // las mismas horas no se deshace solo.
          throw new ReglaNegocioError(
            'Otra persona liquidó a este empleado al mismo tiempo. Volvé a abrir la ficha y fijate el saldo antes de reintentar.',
          );
        }

        // El asiento que deja el saldo en cero, ya marcado como liquidado.
        await tx.movimientoBancoHoras.create({
          data: {
            empleadoId,
            tipo: 'LIQUIDACION',
            horas: -horas,
            montoPesos: aPagar > 0 ? -aPagar : null,
            fecha: hoyFecha(),
            observacion: body.observacion ?? null,
            movimientoId: mov?.id ?? null,
            liquidacionId: liq.id,
            usuarioId: req.usuario!.id,
          },
        });

        return { liq, mov };
      });

      await recordAudit({
        tabla: 'liquidaciones_empleado',
        registroId: out.liq.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: out.liq,
      });

      return reply.code(201).send({
        ok: true,
        liquidacionId: out.liq.id,
        horas: horas.toFixed(2),
        montoHoras: montoHoras.toFixed(2),
        adelantosAplicados: adelantos.toFixed(2),
        montoPagado: aPagar.toFixed(2),
      });
    },
  );

  // ════════════════════════════════════════════════════════════════════════
  //   CONFIGURACIÓN: categorías laborales y tipos de hora
  // ════════════════════════════════════════════════════════════════════════

  fastify.get(
    '/admin/banco-horas-config',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]) },
    async () => {
      const [categorias, tipos] = await Promise.all([
        prisma.categoriaLaboral.findMany({
          orderBy: [{ activo: 'desc' }, { orden: 'asc' }, { nombre: 'asc' }],
          include: { _count: { select: { empleados: true } } },
        }),
        prisma.tipoHora.findMany({ orderBy: [{ activo: 'desc' }, { orden: 'asc' }] }),
      ]);
      return {
        categorias: categorias.map((c) => ({
          id: c.id,
          nombre: c.nombre,
          valorHora: c.valorHora.toFixed(2),
          activo: c.activo,
          empleados: c._count.empleados,
        })),
        tiposHora: tipos.map((t) => ({
          id: t.id,
          nombre: t.nombre,
          multiplicador: t.multiplicador?.toString() ?? null,
          valorHoraFijo: t.valorHoraFijo?.toFixed(2) ?? null,
          activo: t.activo,
        })),
      };
    },
  );

  /**
   * Qué pasaría si se cambia el valor hora de una categoría.
   *
   * Existe porque con revaluación un aumento NO toca sólo las horas futuras:
   * mueve toda la deuda acumulada de golpe. La pantalla lo muestra antes de
   * confirmar — sin eso, la encargada se entera cuando ya está hecho.
   */
  fastify.get(
    '/admin/banco-horas-config/categorias/:id/impacto',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ valorHora: z.coerce.number().positive() }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { valorHora } = req.query as { valorHora: number };
      const cat = await prisma.categoriaLaboral.findUnique({ where: { id } });
      if (!cat) return reply.code(404).send({ error: 'Categoría no encontrada' });

      // Sólo los que realmente cobran por esta categoría: el que tiene valor
      // propio no se entera del aumento.
      const empleados = await prisma.empleado.findMany({
        where: { categoriaLaboralId: id, valorHoraPropio: null },
        select: SELECT_TARIFA,
      });
      const pendientes = await filasPendientesDe(empleados.map((e) => e.id));

      let horas = 0;
      let antes = 0;
      let despues = 0;
      for (const e of empleados) {
        const filas = pendientes.get(e.id) ?? [];
        const actual = calcularSaldo(e, filas);
        horas += actual.horasPendientes;
        antes += actual.montoHoras;
        // La misma valuación, pero con el valor propuesto: así el "después"
        // sale del mismo código que el "antes" y no de una fórmula paralela
        // que podría desincronizarse.
        const simulado = {
          ...e,
          categoriaLaboral: { ...e.categoriaLaboral!, valorHora },
        };
        despues += calcularSaldo(simulado, filas).montoHoras;
      }
      const r2 = (n: number) => Math.round(n * 100) / 100;
      return {
        empleadosAfectados: empleados.length,
        horasPendientes: r2(horas).toFixed(2),
        valorActual: cat.valorHora.toFixed(2),
        valorNuevo: valorHora.toFixed(2),
        deudaAntes: r2(antes).toFixed(2),
        deudaDespues: r2(despues).toFixed(2),
        diferencia: r2(despues - antes).toFixed(2),
      };
    },
  );

  fastify.post(
    '/admin/banco-horas-config/categorias',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        body: z.object({
          nombre: z.string().trim().min(1).max(80),
          valorHora: z.number().positive(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as { nombre: string; valorHora: number };
      const cat = await prisma.$transaction(async (tx) => {
        const c = await tx.categoriaLaboral.create({
          data: { nombre: body.nombre, valorHora: body.valorHora },
        });
        await tx.valorHoraCategoria.create({
          data: {
            categoriaId: c.id,
            valorHora: body.valorHora,
            vigenciaDesde: new Date(),
            usuarioId: req.usuario!.id,
          },
        });
        return c;
      });
      return reply.code(201).send({ ok: true, id: cat.id });
    },
  );

  /**
   * Cambiar el valor hora. **El valor viejo no se pierde**: se inserta una fila
   * en el histórico. Sirve para responder "¿por qué en marzo se pagó esto?", y
   * es el mismo criterio que ya usan los precios por lista.
   */
  fastify.patch(
    '/admin/banco-horas-config/categorias/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          nombre: z.string().trim().min(1).max(80).optional(),
          valorHora: z.number().positive().optional(),
          activo: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { nombre?: string; valorHora?: number; activo?: boolean };
      const antes = await prisma.categoriaLaboral.findUnique({ where: { id } });
      if (!antes) return reply.code(404).send({ error: 'Categoría no encontrada' });

      const cat = await prisma.$transaction(async (tx) => {
        const c = await tx.categoriaLaboral.update({
          where: { id },
          data: {
            ...(body.nombre !== undefined && { nombre: body.nombre }),
            ...(body.valorHora !== undefined && { valorHora: body.valorHora }),
            ...(body.activo !== undefined && { activo: body.activo }),
          },
        });
        if (body.valorHora !== undefined && Number(antes.valorHora) !== body.valorHora) {
          await tx.valorHoraCategoria.create({
            data: {
              categoriaId: id,
              valorHora: body.valorHora,
              vigenciaDesde: new Date(),
              usuarioId: req.usuario!.id,
            },
          });
        }
        return c;
      });
      await recordAudit({
        tabla: 'categorias_laborales',
        registroId: id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: antes,
        valorNuevo: cat,
      });
      return { ok: true };
    },
  );

  fastify.get(
    '/admin/banco-horas-config/categorias/:id/historial',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const filas = await prisma.valorHoraCategoria.findMany({
        where: { categoriaId: id },
        orderBy: { vigenciaDesde: 'desc' },
        include: { usuario: { select: { nombre: true } } },
      });
      return {
        historial: filas.map((f) => ({
          valorHora: f.valorHora.toFixed(2),
          vigenciaDesde: f.vigenciaDesde,
          usuario: f.usuario.nombre,
        })),
      };
    },
  );

  // ── Tipos de hora ───────────────────────────────────────────────────────
  //
  // El XOR también está como CHECK en la base. Acá se valida para dar un
  // mensaje entendible en vez de un error de Postgres.
  const cuerpoTipoHora = z
    .object({
      nombre: z.string().trim().min(1).max(60),
      multiplicador: z.number().positive().max(100).nullable().optional(),
      valorHoraFijo: z.number().positive().nullable().optional(),
    })
    .refine((b) => (b.multiplicador != null) !== (b.valorHoraFijo != null), {
      message:
        'Elegí una sola forma de precio: multiplicador sobre la categoría, o un valor fijo por hora.',
    });

  fastify.post(
    '/admin/banco-horas-config/tipos-hora',
    { preHandler: fastify.requireAuth([RolUsuario.ADMIN]), schema: { body: cuerpoTipoHora } },
    async (req, reply) => {
      const body = req.body as {
        nombre: string;
        multiplicador?: number | null;
        valorHoraFijo?: number | null;
      };
      const t = await prisma.tipoHora.create({
        data: {
          nombre: body.nombre,
          multiplicador: body.multiplicador ?? null,
          valorHoraFijo: body.valorHoraFijo ?? null,
        },
      });
      return reply.code(201).send({ ok: true, id: t.id });
    },
  );

  fastify.patch(
    '/admin/banco-horas-config/tipos-hora/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            nombre: z.string().trim().min(1).max(60).optional(),
            multiplicador: z.number().positive().max(100).nullable().optional(),
            valorHoraFijo: z.number().positive().nullable().optional(),
            activo: z.boolean().optional(),
          })
          .refine(
            (b) =>
              b.multiplicador === undefined && b.valorHoraFijo === undefined
                ? true
                : (b.multiplicador != null) !== (b.valorHoraFijo != null),
            {
              message:
                'Elegí una sola forma de precio: multiplicador sobre la categoría, o un valor fijo por hora.',
            },
          ),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      const antes = await prisma.tipoHora.findUnique({ where: { id } });
      if (!antes) return reply.code(404).send({ error: 'Tipo de hora no encontrado' });
      const t = await prisma.tipoHora.update({
        where: { id },
        data: {
          ...(body.nombre !== undefined && { nombre: body.nombre as string }),
          ...(body.activo !== undefined && { activo: body.activo as boolean }),
          ...(body.multiplicador !== undefined && {
            multiplicador: (body.multiplicador as number | null) ?? null,
          }),
          ...(body.valorHoraFijo !== undefined && {
            valorHoraFijo: (body.valorHoraFijo as number | null) ?? null,
          }),
        },
      });
      await recordAudit({
        tabla: 'tipos_hora',
        registroId: id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: antes,
        valorNuevo: t,
      });
      return { ok: true };
    },
  );

  /** Asignar categoría o valor propio a un empleado. */
  fastify.patch(
    '/admin/banco-horas/:empleadoId/tarifa',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ empleadoId: z.string().uuid() }),
        body: z.object({
          categoriaLaboralId: z.string().uuid().nullable().optional(),
          valorHoraPropio: z.number().positive().nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { empleadoId } = req.params as { empleadoId: string };
      const body = req.body as {
        categoriaLaboralId?: string | null;
        valorHoraPropio?: number | null;
      };
      const antes = await prisma.empleado.findUnique({ where: { id: empleadoId } });
      if (!antes) return reply.code(404).send({ error: 'Empleado no encontrado' });
      const e = await prisma.empleado.update({
        where: { id: empleadoId },
        data: {
          ...(body.categoriaLaboralId !== undefined && {
            categoriaLaboralId: body.categoriaLaboralId,
          }),
          ...(body.valorHoraPropio !== undefined && { valorHoraPropio: body.valorHoraPropio }),
        },
      });
      await recordAudit({
        tabla: 'empleados',
        registroId: empleadoId,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: antes,
        valorNuevo: e,
      });
      return { ok: true };
    },
  );
}
