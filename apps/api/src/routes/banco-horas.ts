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
  valorHoraDeFila,
  valorDeTipoHora,
  liquidarEnTransaccion,
  resumenPendiente,
  resolverCategoriaPago,
  aplicarDevolucion,
  asentarDevolucion,
  restanteHoras,
  restantePrestamo,
  type LineaPagoLiq,
  type MetodoPagoLiq,
  type ResumenLiquidacion,
  type PlanLiquidacion,
} from '../services/banco-horas.js';

const METODOS = [
  'EFECTIVO',
  'TRANSFERENCIA',
  'DEPOSITO',
  'CHEQUE',
  'MERCADOPAGO_QR',
  'OTRO',
] as const;

/**
 * Cómo se paga: una cuenta o varias.
 *
 * Es el mismo contrato que `POST /admin/empleados/:id/movimientos`, a
 * propósito: la encargada ya sabe repartir un sueldo entre efectivo y
 * transferencia, y el pago de horas no es un pago distinto.
 */
const pagoSchema = z.object({
  conceptoEtiqueta: z.string().min(1).max(120).optional(),
  cuentaId: z.string().uuid().optional(),
  metodo: z.enum(METODOS).default('EFECTIVO'),
  pagos: z
    .array(
      z.object({
        cuentaId: z.string().uuid(),
        monto: z.string().regex(/^\d+(\.\d{1,2})?$/),
        metodo: z.enum(METODOS).default('EFECTIVO'),
        numeroReferencia: z.string().max(80).optional(),
      }),
    )
    .min(1)
    .optional(),
  fechaComputo: z.string().datetime().optional(),
  observacion: z.string().max(300).optional(),
});

type CuerpoPago = z.infer<typeof pagoSchema>;

/**
 * Qué se paga y qué va contra el préstamo.
 *
 * El default es el caso de todos los días: **se le paga todo lo que valen las
 * horas pendientes y el préstamo no se toca.** Antes el préstamo se neteaba
 * solo, lo que obligaba a la persona a trabajar gratis hasta cubrirlo — no es
 * cómo funciona el local, donde el préstamo se devuelve de a poco y mientras
 * tanto se sigue cobrando normal.
 */
function armarPlan(
  resumen: ResumenLiquidacion,
  montoPagado: number | undefined,
  montoAlPrestamo: number,
): PlanLiquidacion {
  const alPrestamo = Math.round(montoAlPrestamo * 100) / 100;
  const pagado =
    montoPagado != null
      ? Math.round(montoPagado * 100) / 100
      : Math.max(0, Math.round((resumen.montoHoras - alPrestamo) * 100) / 100);
  return { montoPagado: pagado, montoAlPrestamo: alPrestamo };
}

/**
 * Antepone el concepto a la observación cuando aporta algo.
 *
 * Mismo criterio que el pago de sueldo de la ficha del empleado: los conceptos
 * que comparten la categoría "Sueldos" —Jornada, Horas extra, Feriado— son
 * indistinguibles en la lista de movimientos si no se escriben. Sin esto, dos
 * egresos del mismo monto y la misma categoría se ven iguales y no hay forma
 * de saber cuál fue cuál.
 */
function observacionConConcepto(
  etiqueta: string,
  categoriaNombre: string,
  observacion: string | null | undefined,
): string | null {
  if (categoriaNombre === 'Sueldos' && etiqueta.toLowerCase() !== 'sueldo') {
    return `${etiqueta}${observacion ? ' · ' + observacion : ''}`;
  }
  return observacion ?? null;
}

/**
 * Normaliza el pago a una lista de líneas que sume exactamente `aPagar`.
 *
 * El modo simple (una cuenta, sin monto) toma el total calculado: el monto de
 * una liquidación lo decide el sistema, no quien paga. En multicuenta sí se
 * valida la suma — repartir mal dejaría el arqueo de una cuenta mordido y la
 * otra sobrada, sin ningún error a la vista.
 */
function armarLineas(body: CuerpoPago, aPagar: number): LineaPagoLiq[] {
  // No sale plata: se trabajó para descontar el préstamo y nada más. No hace
  // falta cuenta ni método, y exigirlos sería pedir un dato que no existe.
  if (aPagar <= 0) return [];
  if (body.pagos?.length) {
    const ids = body.pagos.map((l) => l.cuentaId);
    if (new Set(ids).size !== ids.length) {
      throw new ReglaNegocioError('No repitas la misma cuenta en el reparto.');
    }
    const suma = Math.round(body.pagos.reduce((a, l) => a + Number(l.monto), 0) * 100) / 100;
    if (Math.abs(suma - aPagar) > 0.009) {
      throw new ReglaNegocioError(
        `El reparto suma $${suma.toFixed(2)} y hay que pagar $${aPagar.toFixed(2)}.`,
      );
    }
    return body.pagos.map((l) => ({ ...l, metodo: l.metodo as MetodoPagoLiq }));
  }
  if (!body.cuentaId) {
    throw new ReglaNegocioError('Falta la cuenta de la que sale la plata.');
  }
  return [
    { cuentaId: body.cuentaId, monto: aPagar.toFixed(2), metodo: body.metodo as MetodoPagoLiq },
  ];
}

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
            horasAplicadas: true,
            categoriaLaboralId: true,
            tipoHoraId: true,
            creadoAt: true,
            tipoHora: { select: { nombre: true, multiplicador: true, valorHoraFijo: true } },
            categoriaLaboral: { select: { id: true, nombre: true, valorHora: true } },
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
          /**
           * ¿Se puede corregir o borrar esta fila?
           *
           * Lo decide el servidor y no la pantalla: la regla es "no tiene un
           * peso cobrado", y una fila puede estar cobrada A MEDIAS sin
           * `liquidacionId` (el banco de horas se paga de a partes). Si la UI
           * lo dedujera de `liquidado`, ofrecería editar filas que el backend
           * después rechaza.
           */
          editable:
            m.tipo === 'HORAS_TRABAJADAS' &&
            m.liquidacionId == null &&
            Number(m.horasAplicadas) <= 0.000001,
          /// Para precargar el formulario de corrección sin otra consulta.
          tipoHoraId: m.tipoHoraId,
          categoriaLaboralId: m.categoriaLaboralId,
          tipoHora: m.tipoHora?.nombre ?? null,
          // La categoría sólo aparece cuando ese día fue una excepción. Si es
          // la de siempre no se muestra: repetirla en cada fila es ruido.
          categoria: m.categoriaLaboral?.nombre ?? null,
          // El valor que tendría HOY esa hora, con la categoría de la fila si
          // la tiene. En las filas ya liquidadas es informativo: lo que se pagó
          // quedó estampado en la liquidación.
          valorHoraFila: m.horas
            ? valorDeTipoHora(valorHoraDeFila(empleado, m.categoriaLaboral), m.tipoHora).toFixed(2)
            : null,
          usuario: m.usuario.nombre,
          creadoAt: m.creadoAt,
        })),
      };
    },
  );

  // ── Cargar horas de un día (y, si se pide, pagarlas en el acto) ─────────
  //
  // El "pagar ahora" existe porque el flujo de antes era cargar el sueldo y
  // listo, en un solo gesto. Partirlo en dos pantallas —cargar horas, después
  // liquidar— sería pedirle a la encargada más trabajo del que hacía para el
  // caso más común del local, que es pagar el día trabajado ese mismo día.
  //
  // Paga TODO lo pendiente, no sólo las horas que se acaban de cargar: si
  // quedara un adelanto viejo sin descontar, el saldo nunca cerraría en cero y
  // esa plata se pagaría dos veces. La pantalla muestra la cuenta completa
  // antes de confirmar.
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
          /// Excepción del día: se trabajó en otra categoría. Omitir = la de siempre.
          categoriaLaboralId: z.string().uuid().nullish(),
          observacion: z.string().max(300).optional(),
          pagarAhora: z.boolean().default(false),
          pago: pagoSchema.optional(),
          /// Cuánto pagarle. Omitido = todo lo que valen las horas pendientes,
          /// que es el caso de todos los días: trabajó, se le paga.
          montoPagado: z.number().nonnegative().optional(),
          /// Cuánto descontar del préstamo en vez de pagárselo. 0 por defecto:
          /// el préstamo NO se netea solo.
          montoAlPrestamo: z.number().nonnegative().default(0),
        }),
      },
    },
    async (req, reply) => {
      const { empleadoId } = req.params as { empleadoId: string };
      const body = req.body as {
        fecha: string;
        horas: number;
        tipoHoraId?: string;
        categoriaLaboralId?: string | null;
        observacion?: string;
        pagarAhora: boolean;
        pago?: CuerpoPago;
        montoPagado?: number;
        montoAlPrestamo: number;
      };
      const empleado = await prisma.empleado.findUnique({
        where: { id: empleadoId },
        select: SELECT_TARIFA,
      });
      if (!empleado) return reply.code(404).send({ error: 'Empleado no encontrado' });

      if (body.categoriaLaboralId) {
        const cat = await prisma.categoriaLaboral.findUnique({
          where: { id: body.categoriaLaboralId },
          select: { id: true, activo: true },
        });
        if (!cat) return reply.code(404).send({ error: 'Categoría laboral no encontrada' });
        if (!cat.activo) {
          throw new ReglaNegocioError('Esa categoría laboral está desactivada.');
        }
      }

      const datosFila = {
        empleadoId,
        tipo: 'HORAS_TRABAJADAS' as const,
        horas: body.horas,
        tipoHoraId: body.tipoHoraId ?? null,
        categoriaLaboralId: body.categoriaLaboralId ?? null,
        fecha: new Date(body.fecha),
        observacion: body.observacion ?? null,
        usuarioId: req.usuario!.id,
      };

      // ── Camino simple: sólo cargar ──
      if (!body.pagarAhora) {
        const fila = await prisma.movimientoBancoHoras.create({ data: datosFila });
        await recordAudit({
          tabla: 'movimientos_banco_horas',
          registroId: fila.id,
          accion: 'INSERT',
          usuarioId: req.usuario!.id,
          valorNuevo: fila,
        });
        return reply.code(201).send({ ok: true, id: fila.id });
      }

      // ── Camino "pagar ahora": cargar Y liquidar, en una sola transacción ──
      const pago = body.pago ?? ({ metodo: 'EFECTIVO' } as CuerpoPago);
      const nombre = `${empleado.nombre}${empleado.apellido ? ' ' + empleado.apellido : ''}`;
      // Sin categoría en la fila, la tarifa tiene que salir del empleado. Con
      // categoría en la fila alcanza con ésa, y no se exige la del empleado.
      if (!body.categoriaLaboralId) exigirValorHora(empleado, nombre);

      const etiqueta = pago.conceptoEtiqueta?.trim() || 'Sueldo';
      const categoriaMov = await resolverCategoriaPago(etiqueta);
      const observacionPago = observacionConConcepto(
        etiqueta,
        categoriaMov.nombre,
        pago.observacion,
      );

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

      const out = await prisma.$transaction(async (tx) => {
        const fila = await tx.movimientoBancoHoras.create({ data: datosFila });
        // El resumen se calcula DESPUÉS de insertar y dentro de la misma
        // transacción: así incluye las horas recién cargadas sin recalcularlas
        // por separado, que es donde se colaría una diferencia.
        const resumen = await resumenPendiente(empleado, tx);
        const plan = armarPlan(resumen, body.montoPagado, body.montoAlPrestamo);
        const liq = await liquidarEnTransaccion(tx, {
          empleado,
          resumen,
          plan,
          lineas: armarLineas(pago, plan.montoPagado),
          categoriaMovimientoId: categoriaMov.id,
          sesionCajaId: sesion.id,
          usuarioId: req.usuario!.id,
          fechaComputo: pago.fechaComputo ? new Date(pago.fechaComputo) : new Date(),
          fechaHoy: hoyFecha(),
          observacion: observacionPago,
        });
        return { fila, resumen, plan, liq };
      });

      await recordAudit({
        tabla: 'movimientos_banco_horas',
        registroId: out.fila.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: out.fila,
      });

      return reply.code(201).send({
        ok: true,
        id: out.fila.id,
        liquidacionId: out.liq.liquidacionId,
        horasCobradas: out.liq.horasConsumidas.toFixed(2),
        montoPagado: out.plan.montoPagado.toFixed(2),
        alPrestamo: out.plan.montoAlPrestamo.toFixed(2),
      });
    },
  );

  // ── Corregir o borrar horas ya cargadas ────────────────────────────────
  //
  // Hasta ahora una carga de horas era definitiva: si se tipeaban 8 en vez de
  // 6, o se cargaban en el empleado equivocado, no había vuelta atrás. La
  // encargada terminaba compensando con otra carga al revés, y el legajo
  // quedaba con dos filas falsas en vez de una correcta.
  //
  // **El límite es la plata, no el tiempo.** Mientras esas horas no se hayan
  // cobrado son un apunte; una vez liquidadas son parte de un pago que ya se
  // hizo, con su `valorHoraAplicado` estampado. Tocarlas ahí cambiaría el
  // sentido de un recibo firmado.
  //
  // Por eso el guard mira `horasAplicadas` y `liquidacionId`, no el estado ni
  // la antigüedad: `horasAplicadas > 0` alcanza para bloquear, incluso si la
  // fila se cobró sólo a medias (el banco de horas se paga de a partes).
  const filaEditable = async (id: string) => {
    const fila = await prisma.movimientoBancoHoras.findUnique({
      where: { id },
      select: {
        id: true,
        tipo: true,
        empleadoId: true,
        horas: true,
        horasAplicadas: true,
        liquidacionId: true,
        fecha: true,
        tipoHoraId: true,
        categoriaLaboralId: true,
        observacion: true,
      },
    });
    if (!fila) return { error: { code: 404, body: { error: 'Esa carga de horas no existe' } } };
    if (fila.tipo !== 'HORAS_TRABAJADAS') {
      return {
        error: {
          code: 409,
          body: {
            error:
              'Esto no es una carga de horas: los adelantos, devoluciones y liquidaciones ' +
              'mueven plata y se corrigen desde el movimiento de caja.',
            tipo: fila.tipo,
          },
        },
      };
    }
    if (Number(fila.horasAplicadas) > 0.000001 || fila.liquidacionId) {
      return {
        error: {
          code: 409,
          body: {
            error:
              'Estas horas ya se cobraron: forman parte de una liquidación hecha, con su valor ' +
              'hora estampado. Para corregirlas hay que anular esa liquidación primero.',
            horas: fila.horas?.toString() ?? null,
            horasCobradas: fila.horasAplicadas.toString(),
          },
        },
      };
    }
    return { fila };
  };

  fastify.patch(
    '/admin/banco-horas/movimientos/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          fecha: z.string().datetime().optional(),
          horas: z.number().positive().max(24).optional(),
          tipoHoraId: z.string().uuid().nullish(),
          categoriaLaboralId: z.string().uuid().nullish(),
          observacion: z.string().max(300).nullish(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as {
        fecha?: string;
        horas?: number;
        tipoHoraId?: string | null;
        categoriaLaboralId?: string | null;
        observacion?: string | null;
      };

      const r = await filaEditable(id);
      if (r.error) return reply.code(r.error.code).send(r.error.body);
      const fila = r.fila!;

      if (body.categoriaLaboralId) {
        const cat = await prisma.categoriaLaboral.findUnique({
          where: { id: body.categoriaLaboralId },
          select: { id: true, activo: true },
        });
        if (!cat) return reply.code(404).send({ error: 'Categoría laboral no encontrada' });
        if (!cat.activo) throw new ReglaNegocioError('Esa categoría laboral está desactivada.');
      }

      const data: Record<string, unknown> = {};
      if (body.fecha !== undefined) data.fecha = new Date(body.fecha);
      if (body.horas !== undefined) data.horas = body.horas;
      if (body.tipoHoraId !== undefined) data.tipoHoraId = body.tipoHoraId ?? null;
      if (body.categoriaLaboralId !== undefined)
        data.categoriaLaboralId = body.categoriaLaboralId ?? null;
      if (body.observacion !== undefined) data.observacion = body.observacion ?? null;

      const actualizada = await prisma.movimientoBancoHoras.update({ where: { id }, data });
      await recordAudit({
        tabla: 'movimientos_banco_horas',
        registroId: id,
        accion: 'UPDATE',
        usuarioId: req.usuario!.id,
        valorAnterior: {
          horas: fila.horas?.toString() ?? null,
          fecha: fila.fecha.toISOString(),
          tipoHoraId: fila.tipoHoraId,
          categoriaLaboralId: fila.categoriaLaboralId,
          observacion: fila.observacion,
        },
        valorNuevo: {
          horas: actualizada.horas?.toString() ?? null,
          fecha: actualizada.fecha.toISOString(),
          tipoHoraId: actualizada.tipoHoraId,
          categoriaLaboralId: actualizada.categoriaLaboralId,
          observacion: actualizada.observacion,
        },
        contexto: { fuente: 'correccion manual de horas cargadas' },
      });
      return reply.send({ ok: true, id, empleadoId: fila.empleadoId });
    },
  );

  fastify.delete(
    '/admin/banco-horas/movimientos/:id',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ id: z.string().uuid() }),
        // Por query y no en el body: `api.delete` del cliente no manda cuerpo.
        querystring: z.object({ motivo: z.string().max(300).optional() }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { motivo } = req.query as { motivo?: string };

      const r = await filaEditable(id);
      if (r.error) return reply.code(r.error.code).send(r.error.body);
      const fila = r.fila!;

      await prisma.$transaction(async (tx) => {
        // El snapshot va antes: después no hay de dónde sacarlo.
        await recordAudit({
          tabla: 'movimientos_banco_horas',
          registroId: id,
          accion: 'DELETE',
          usuarioId: req.usuario!.id,
          valorAnterior: {
            empleadoId: fila.empleadoId,
            horas: fila.horas?.toString() ?? null,
            fecha: fila.fecha.toISOString(),
            tipoHoraId: fila.tipoHoraId,
            categoriaLaboralId: fila.categoriaLaboralId,
            observacion: fila.observacion,
          },
          valorNuevo: null,
          contexto: { motivo: motivo ?? null, fuente: 'borrado manual de horas cargadas' },
          tx,
        });
        await tx.movimientoBancoHoras.delete({ where: { id } });
      });

      return reply.send({ ok: true, id, empleadoId: fila.empleadoId, borrada: true });
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

  // ── Cuánto quedaría a pagar si cargo estas horas y pago ahora ───────────
  //
  // Lo calcula el servidor y no la pantalla. Podría hacerse en el navegador
  // —tiene el saldo, el multiplicador del tipo y el valor de la categoría—,
  // pero entonces el número que la encargada ve antes de confirmar saldría de
  // una fórmula distinta de la que después mueve la plata. Con esto, el
  // preview y el cobro son literalmente el mismo código.
  fastify.get(
    '/admin/banco-horas/:empleadoId/preview-pago',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ empleadoId: z.string().uuid() }),
        querystring: z.object({
          horas: z.coerce.number().positive().max(24),
          tipoHoraId: z.string().uuid().optional(),
          categoriaLaboralId: z.string().uuid().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { empleadoId } = req.params as { empleadoId: string };
      const q = req.query as { horas: number; tipoHoraId?: string; categoriaLaboralId?: string };

      const [empleado, tipoHora, categoria] = await Promise.all([
        prisma.empleado.findUnique({ where: { id: empleadoId }, select: SELECT_TARIFA }),
        q.tipoHoraId
          ? prisma.tipoHora.findUnique({
              where: { id: q.tipoHoraId },
              select: { multiplicador: true, valorHoraFijo: true },
            })
          : null,
        q.categoriaLaboralId
          ? prisma.categoriaLaboral.findUnique({
              where: { id: q.categoriaLaboralId },
              select: { id: true, nombre: true, valorHora: true },
            })
          : null,
      ]);
      if (!empleado) return reply.code(404).send({ error: 'Empleado no encontrado' });

      const pendiente = await resumenPendiente(empleado);
      const valorHoraNueva = valorDeTipoHora(valorHoraDeFila(empleado, categoria), tipoHora);
      const montoNuevo = Math.round(q.horas * valorHoraNueva * 100) / 100;
      // El techo de lo que se puede liquidar: las horas viejas más las nuevas.
      // El préstamo NO se resta acá — la encargada decide cuánto descontar.
      const montoHoras = Math.round((pendiente.montoHoras + montoNuevo) * 100) / 100;

      return {
        valorHora: valorHoraNueva.toFixed(2),
        montoNuevo: montoNuevo.toFixed(2),
        horasPendientes: pendiente.horas.toFixed(2),
        montoPendiente: pendiente.montoHoras.toFixed(2),
        prestamos: pendiente.prestamos.toFixed(2),
        montoHoras: montoHoras.toFixed(2),
        sinValorHora: valorHoraNueva <= 0,
      };
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

  // ── Devolución: el empleado paga parte del préstamo con plata ───────────
  //
  // La contracara del adelanto. Entra plata a la caja y baja la deuda, en una
  // sola acción: si fueran dos cargas separadas, tarde o temprano queda una
  // devolución cobrada que la deuda no registra, o al revés.
  fastify.post(
    '/admin/banco-horas/:empleadoId/devolucion',
    {
      preHandler: fastify.requireAuth([RolUsuario.ADMIN]),
      schema: {
        params: z.object({ empleadoId: z.string().uuid() }),
        body: z.object({
          monto: z.number().positive(),
          cuentaId: z.string().uuid(),
          metodo: z.enum(METODOS).default('EFECTIVO'),
          numeroReferencia: z.string().max(80).optional(),
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
        numeroReferencia?: string;
        observacion?: string;
      };

      const empleado = await prisma.empleado.findUnique({
        where: { id: empleadoId },
        select: { id: true, nombre: true, apellido: true },
      });
      if (!empleado) return reply.code(404).send({ error: 'Empleado no encontrado' });
      const nombre = `${empleado.nombre}${empleado.apellido ? ' ' + empleado.apellido : ''}`;

      const categoria = await prisma.categoriaMovimiento.findUnique({
        where: { nombre: 'Devolución de préstamo' },
      });
      if (!categoria) {
        throw new ReglaNegocioError(
          'Falta la categoría de movimiento "Devolución de préstamo". Corré las migraciones de la base.',
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

      const fecha = new Date();
      const out = await prisma.$transaction(async (tx) => {
        const r = await aplicarDevolucion(tx, empleadoId, body.monto);
        // Devolver más de lo que se debe sería plata que entra sin contra-
        // partida: mejor negarse y decir cuánto es la deuda de verdad.
        if (r.sobrante > 0.004) {
          throw new ReglaNegocioError(
            r.aplicado > 0
              ? `${nombre} debe $${r.aplicado.toFixed(2)} y estás cargando $${body.monto.toFixed(2)}. Cargá como mucho lo que debe.`
              : `${nombre} no tiene préstamos pendientes.`,
          );
        }

        const mov = await tx.movimiento.create({
          data: {
            tipo: 'INGRESO',
            monto: body.monto,
            categoriaId: categoria.id,
            cuentaDestinoId: body.cuentaId,
            entidadId: empleadoId,
            sesionCajaId: sesion.id,
            fechaComputo: fecha,
            observacion: body.observacion ?? `Devolución de préstamo — ${nombre}`,
            estado: EstadoMovimiento.CONFIRMADO,
            usuarioId: req.usuario!.id,
          },
          select: { id: true },
        });
        await tx.pago.create({
          data: {
            movimientoId: mov.id,
            metodo: body.metodo as never,
            cuentaId: body.cuentaId,
            monto: body.monto,
            numeroReferencia: body.numeroReferencia ?? null,
            estado: 'CONFIRMADO',
            fecha,
          },
        });
        await tx.cuenta.update({
          where: { id: body.cuentaId },
          data: { saldoActual: { increment: body.monto } },
        });

        await asentarDevolucion(tx, {
          empleadoId,
          monto: body.monto,
          fecha: hoyFecha(),
          movimientoId: mov.id,
          observacion: body.observacion ?? null,
          usuarioId: req.usuario!.id,
        });

        return { mov, r };
      });

      await recordAudit({
        tabla: 'movimientos',
        registroId: out.mov.id,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { tipo: 'DEVOLUCION', empleadoId, monto: body.monto },
      });

      return reply.code(201).send({
        ok: true,
        movimientoId: out.mov.id,
        aplicado: out.r.aplicado.toFixed(2),
        prestamoRestante: out.r.prestamoRestante.toFixed(2),
        cancelado: out.r.prestamoRestante <= 0.004,
      });
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
        body: pagoSchema.extend({
          /// Cuánto pagarle. Omitido = todo lo que valen las horas pendientes.
          montoPagado: z.number().nonnegative().optional(),
          /// Cuánto descontar del préstamo. 0 por defecto: no se netea solo.
          montoAlPrestamo: z.number().nonnegative().default(0),
        }),
      },
    },
    async (req, reply) => {
      const { empleadoId } = req.params as { empleadoId: string };
      const body = req.body as CuerpoPago & { montoPagado?: number; montoAlPrestamo: number };

      const empleado = await prisma.empleado.findUnique({
        where: { id: empleadoId },
        select: SELECT_TARIFA,
      });
      if (!empleado) return reply.code(404).send({ error: 'Empleado no encontrado' });

      const nombre = `${empleado.nombre}${empleado.apellido ? ' ' + empleado.apellido : ''}`;
      const resumen = await resumenPendiente(empleado);

      if (resumen.horas <= 0) {
        throw new ReglaNegocioError(
          resumen.prestamos > 0
            ? `${nombre} no tiene horas cargadas sin cobrar. Debe $${resumen.prestamos.toFixed(2)} de préstamo: para descontarlo hay que cargarle las horas primero.`
            : `${nombre} no tiene nada pendiente de liquidar.`,
        );
      }
      // Con horas pendientes pero sin valor, el total daría $0 y se cerrarían
      // las filas pagando nada. Mejor negarse y decir por qué.
      if (resumen.montoHoras <= 0) {
        exigirValorHora(empleado, nombre);
      }

      const plan = armarPlan(resumen, body.montoPagado, body.montoAlPrestamo);

      const etiqueta = body.conceptoEtiqueta?.trim() || 'Sueldo';
      const categoriaMov = await resolverCategoriaPago(etiqueta);
      const observacionPago = observacionConConcepto(
        etiqueta,
        categoriaMov.nombre,
        body.observacion,
      );

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

      const lineas = armarLineas(body, plan.montoPagado);

      const out = await prisma.$transaction((tx) =>
        liquidarEnTransaccion(tx, {
          empleado,
          resumen,
          plan,
          lineas,
          categoriaMovimientoId: categoriaMov.id,
          sesionCajaId: sesion.id,
          usuarioId: req.usuario!.id,
          fechaComputo: body.fechaComputo ? new Date(body.fechaComputo) : new Date(),
          fechaHoy: hoyFecha(),
          observacion: observacionPago,
        }),
      );

      await recordAudit({
        tabla: 'liquidaciones_empleado',
        registroId: out.liquidacionId,
        accion: 'INSERT',
        usuarioId: req.usuario!.id,
        valorNuevo: { ...plan, empleadoId, movimientoId: out.movimientoId },
      });

      return reply.code(201).send({
        ok: true,
        liquidacionId: out.liquidacionId,
        horasCobradas: out.horasConsumidas.toFixed(2),
        montoPagado: plan.montoPagado.toFixed(2),
        alPrestamo: plan.montoAlPrestamo.toFixed(2),
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

      // A quién le pega el aumento, por DOS vías:
      //
      //   1. Los que cobran habitualmente por esta categoría (el que tiene
      //      valor propio no se entera del aumento).
      //   2. Cualquiera con horas pendientes cargadas COMO esta categoría —el
      //      de Mostrador que cubrió Cocina—, aunque su categoría sea otra o
      //      tenga valor propio. Sin esta segunda vía el aviso mostraría un
      //      número más chico que el que después se paga.
      const [porCategoria, porFila] = await Promise.all([
        prisma.empleado.findMany({
          where: { categoriaLaboralId: id, valorHoraPropio: null },
          select: { id: true },
        }),
        prisma.movimientoBancoHoras.findMany({
          where: { categoriaLaboralId: id, liquidacionId: null },
          select: { empleadoId: true },
          distinct: ['empleadoId'],
        }),
      ]);
      const ids = [...new Set([...porCategoria.map((e) => e.id), ...porFila.map((f) => f.empleadoId)])];
      const empleados = await prisma.empleado.findMany({
        where: { id: { in: ids } },
        select: SELECT_TARIFA,
      });
      const pendientes = await filasPendientesDe(ids);
      const sim = { categoriaId: id, valorHora };

      let horas = 0;
      let antes = 0;
      let despues = 0;
      let afectados = 0;
      for (const e of empleados) {
        const filas = pendientes.get(e.id) ?? [];
        const actual = calcularSaldo(e, filas);
        // La misma valuación, con el valor propuesto sustituido adentro: así el
        // "después" sale del mismo código que el "antes" y no de una fórmula
        // paralela que podría desincronizarse.
        const nuevo = calcularSaldo(e, filas, sim);
        if (nuevo.montoHoras === actual.montoHoras) continue; // a éste no le pega
        afectados += 1;
        horas += actual.horasPendientes;
        antes += actual.montoHoras;
        despues += nuevo.montoHoras;
      }
      const r2 = (n: number) => Math.round(n * 100) / 100;
      return {
        empleadosAfectados: afectados,
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
