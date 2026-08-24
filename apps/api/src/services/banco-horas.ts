/**
 * Banco de horas: horas trabajadas todavía no pagadas, y adelantos.
 *
 * Especificado en SPEC §14. Las dos decisiones que definen todo lo de acá:
 *
 * 1. **Las horas se revalúan.** La deuda se expresa en HORAS, no en pesos: si
 *    sube el valor de la categoría, todo lo pendiente pasa a valer más. Es lo
 *    que significa "banco de horas" y protege al empleado de la inflación.
 *
 * 2. **Los adelantos quedan en PESOS.** Convertirlos a horas indexaría la deuda
 *    en contra del empleado: subiría el valor hora y terminaría debiendo más
 *    plata de la que se llevó.
 *
 * 3. **Es una cuenta corriente, no un todo-o-nada.** Un préstamo de $100.000 no
 *    se cubre al día siguiente trabajando gratis: se devuelve de a poco, en los
 *    días que la encargada decide, mientras la persona sigue cobrando normal.
 *    Por eso cada fila lleva cuánto se le aplicó, y liquidar recibe DOS montos
 *    —cuánto se paga y cuánto va contra el préstamo— en vez de netear solo.
 *
 * De ahí sale lo que más condiciona el código: **el saldo no se persiste**. Se
 * calcula al leer. Un saldo guardado en pesos quedaría viejo apenas alguien
 * toca una categoría, y nadie se enteraría de que está mintiendo.
 */

import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
import { ReglaNegocioError } from './errores.js';

/**
 * Empleado con lo mínimo para saber cuánto vale su hora.
 *
 * `valorHora` acepta `number` además de `Decimal` para poder simular un valor
 * distinto —el "¿cuánto subiría la deuda si aumento?"— con el MISMO código que
 * calcula el saldo real. Una fórmula paralela para la simulación se
 * desincronizaría del cálculo verdadero en el primer cambio.
 */
export interface EmpleadoTarifa {
  id: string;
  valorHoraPropio: Prisma.Decimal | number | null;
  categoriaLaboral: { id: string; nombre: string; valorHora: Prisma.Decimal | number } | null;
}

/**
 * Valor hora base: el propio del empleado pisa al de la categoría.
 *
 * Devuelve 0 si no tiene ninguno de los dos — no se rompe, pero quien cobre
 * tiene que avisar (ver `exigirValorHora`). Un 0 silencioso liquidando plata
 * sería peor que un error.
 */
export function valorHoraBase(e: EmpleadoTarifa): number {
  if (e.valorHoraPropio != null) return Number(e.valorHoraPropio);
  if (e.categoriaLaboral) return Number(e.categoriaLaboral.valorHora);
  return 0;
}

export function exigirValorHora(e: EmpleadoTarifa, nombre: string): number {
  const v = valorHoraBase(e);
  if (v <= 0) {
    throw new ReglaNegocioError(
      `${nombre} no tiene valor hora: asignale una categoría laboral o cargale un valor propio antes de liquidar.`,
    );
  }
  return v;
}

/**
 * Valor hora de UNA fila, que no siempre es el del empleado.
 *
 * Si la fila trae categoría, ese día se trabajó en otra cosa —el de Mostrador
 * que cubrió Cocina— y manda esa categoría. Si no trae, vale la tarifa de
 * siempre de la persona.
 *
 * Ojo con el orden: la categoría de la fila pisa incluso al `valorHoraPropio`.
 * Es a propósito. Un arreglo personal es "lo que cobra habitualmente"; un día
 * en otra categoría es una excepción explícita que alguien tipeó recién, y la
 * excepción más específica gana.
 */
export function valorHoraDeFila(
  empleado: EmpleadoTarifa,
  categoriaFila: { valorHora: Prisma.Decimal | number } | null,
): number {
  if (categoriaFila) return Number(categoriaFila.valorHora);
  return valorHoraBase(empleado);
}

/** Lo mínimo de un tipo de hora para poder ponerle precio. */
export interface TipoHoraTarifa {
  multiplicador: Prisma.Decimal | null;
  valorHoraFijo: Prisma.Decimal | null;
}

/**
 * Cuánto vale una hora de ESTE tipo para ESTE empleado.
 *
 * El multiplicador sigue a la categoría: si sube el valor hora, la hora extra
 * sube sola. El valor fijo no — queda quieto hasta que alguien lo edita, que es
 * exactamente la diferencia que la encargada elige al crear el tipo.
 */
export function valorDeTipoHora(base: number, tipo: TipoHoraTarifa | null): number {
  if (!tipo) return base;
  if (tipo.valorHoraFijo != null) return Number(tipo.valorHoraFijo);
  if (tipo.multiplicador != null) return base * Number(tipo.multiplicador);
  return base;
}

export interface SaldoEmpleado {
  /** Horas cargadas y todavía no liquidadas. */
  horasPendientes: number;
  /**
   * No tiene categoría ni valor propio: sus horas valen $0.
   *
   * Se expone para que la pantalla lo diga en vez de mostrar un cero que se lee
   * como "no se le debe nada". Es el error fácil de cometer —dar de alta a
   * alguien, olvidar la categoría, cargarle horas— y el único síntoma sería un
   * total más bajo de lo que corresponde.
   */
  sinValorHora: boolean;
  /** Esas horas valuadas a HOY, tipo por tipo. */
  montoHoras: number;
  /**
   * Préstamos entregados y todavía no devueltos.
   *
   * NO se descuenta solo al pagar: es una deuda que se salda de a poco, cuando
   * la encargada lo decide. Netearla automáticamente obligaba a la persona a
   * trabajar gratis hasta cubrirla, que no es cómo funciona el local.
   */
  adelantosPendientes: number;
  /** `montoHoras − adelantosPendientes`. Negativo = la persona debe. */
  saldo: number;
  valorHora: number;
}

/** Filas pendientes de un empleado (sin liquidar), con su tipo de hora. */
type FilaPendiente = {
  id?: string;
  tipo: string;
  horas: Prisma.Decimal | null;
  horasAplicadas: Prisma.Decimal;
  montoPesos: Prisma.Decimal | null;
  montoAplicado: Prisma.Decimal;
  tipoHora: TipoHoraTarifa | null;
  /** Excepción del día: se trabajó en otra categoría. null = la de siempre. */
  categoriaLaboral: { id: string; nombre: string; valorHora: Prisma.Decimal } | null;
};

/** Lo que falta cobrar de una fila de horas, y lo que falta devolver de un préstamo. */
export function restanteHoras(f: { horas: Prisma.Decimal | null; horasAplicadas: Prisma.Decimal | number }): number {
  return Math.max(0, Number(f.horas ?? 0) - Number(f.horasAplicadas));
}
export function restantePrestamo(f: { montoPesos: Prisma.Decimal | null; montoAplicado: Prisma.Decimal | number }): number {
  return Math.max(0, Number(f.montoPesos ?? 0) - Number(f.montoAplicado));
}

/**
 * Saldo a partir de las filas pendientes ya cargadas.
 *
 * Separado de la consulta a propósito: la pantalla de listado trae las filas de
 * todos los empleados en UNA query y valúa acá, en vez de hacer una consulta
 * por persona.
 */
/**
 * "¿Cuánto sube la deuda si aumento esta categoría?".
 *
 * Se resuelve sustituyendo el valor DENTRO del mismo cálculo del saldo, no con
 * una fórmula aparte: una segunda fórmula se desincroniza del cálculo real en
 * el primer cambio, y el número que mostraría el aviso de aumento dejaría de
 * ser el que después se cobra.
 */
export interface SimulacionValorHora {
  categoriaId: string;
  valorHora: number;
}

function conSimulacion<T extends { id: string; valorHora: Prisma.Decimal | number }>(
  cat: T | null,
  sim: SimulacionValorHora | undefined,
): T | null {
  if (!cat) return null;
  // El cast es porque el valor simulado es `number` donde Prisma declara
  // `Decimal`; todo lo que lee este campo hace `Number(...)`, así que conviven.
  if (sim && cat.id === sim.categoriaId) return { ...cat, valorHora: sim.valorHora } as T;
  return cat;
}

export function calcularSaldo(
  empleado: EmpleadoTarifa,
  filas: FilaPendiente[],
  sim?: SimulacionValorHora,
): SaldoEmpleado {
  const emp = sim
    ? { ...empleado, categoriaLaboral: conSimulacion(empleado.categoriaLaboral, sim) }
    : empleado;
  const base = valorHoraBase(emp);
  let horasPendientes = 0;
  let montoHoras = 0;
  let adelantosPendientes = 0;
  /** Alguna fila vale $0: sin tarifa propia NI categoría en la fila. */
  let algunaSinValor = false;

  for (const f of filas) {
    const horas = restanteHoras(f);
    const pesos = restantePrestamo(f);
    if (horas) {
      horasPendientes += horas;
      // Cada fila se valúa con SU tipo y SU categoría: mezclar normales con
      // feriado —o un día de Cocina con uno de Mostrador— y multiplicar el
      // total por un solo valor daría de menos.
      const vh = valorHoraDeFila(emp, conSimulacion(f.categoriaLaboral, sim));
      if (vh <= 0) algunaSinValor = true;
      montoHoras += horas * valorDeTipoHora(vh, f.tipoHora);
    }
    if (pesos) adelantosPendientes += pesos;
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    horasPendientes: r2(horasPendientes),
    sinValorHora: algunaSinValor,
    montoHoras: r2(montoHoras),
    adelantosPendientes: r2(adelantosPendientes),
    saldo: r2(montoHoras - adelantosPendientes),
    valorHora: base,
  };
}

/** Trae las filas pendientes de varios empleados de una sola vez. */
export async function filasPendientesDe(empleadoIds: string[]) {
  if (!empleadoIds.length) return new Map<string, FilaPendiente[]>();
  const filas = await prisma.movimientoBancoHoras.findMany({
    where: { empleadoId: { in: empleadoIds }, liquidacionId: null },
    select: {
      id: true,
      empleadoId: true,
      tipo: true,
      horas: true,
      horasAplicadas: true,
      montoPesos: true,
      montoAplicado: true,
      tipoHora: { select: { multiplicador: true, valorHoraFijo: true } },
      categoriaLaboral: { select: { id: true, nombre: true, valorHora: true } },
    },
    orderBy: [{ fecha: 'asc' }, { creadoAt: 'asc' }],
  });
  const out = new Map<string, FilaPendiente[]>();
  for (const f of filas) {
    const arr = out.get(f.empleadoId) ?? [];
    arr.push({
      id: f.id,
      tipo: f.tipo,
      horas: f.horas,
      horasAplicadas: f.horasAplicadas,
      montoPesos: f.montoPesos,
      montoAplicado: f.montoAplicado,
      tipoHora: f.tipoHora,
      categoriaLaboral: f.categoriaLaboral,
    });
    out.set(f.empleadoId, arr);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
//   LIQUIDAR
// ════════════════════════════════════════════════════════════════════════

/**
 * Vive acá y no en la ruta porque tiene DOS entradas: el botón "Liquidar" de
 * la ficha, y el "pagar ahora" de la carga de horas. Duplicarlo garantizaba
 * que un día divergieran — y lo que divergiría es cuánta plata sale de la caja.
 */

export type MetodoPagoLiq =
  | 'EFECTIVO'
  | 'TRANSFERENCIA'
  | 'DEPOSITO'
  | 'CHEQUE'
  | 'MERCADOPAGO_QR'
  | 'OTRO';

export interface LineaPagoLiq {
  cuentaId: string;
  monto: string;
  metodo: MetodoPagoLiq;
  numeroReferencia?: string;
}

/**
 * Categoría contable del pago, resuelta desde la lista configurable
 * `concepto_pago_empleado` — la misma que usa el pago de sueldo de siempre.
 *
 * Importa que sea la misma: si la liquidación cayera en una categoría propia,
 * los sueldos quedarían partidos en dos lugares del cashflow según por qué
 * pantalla se pagaron.
 */
export async function resolverCategoriaPago(
  etiqueta: string,
): Promise<{ id: string; nombre: string }> {
  const opcion = await prisma.opcionConfigurable.findFirst({
    where: {
      dominio: 'concepto_pago_empleado',
      etiqueta: { equals: etiqueta, mode: 'insensitive' },
    },
  });
  const fallback: Record<string, string> = {
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
  const nombre = atributos?.categoria ?? fallback[etiqueta] ?? 'Sueldos';
  const cat = await prisma.categoriaMovimiento.findUnique({ where: { nombre } });
  if (!cat) {
    throw new ReglaNegocioError(
      `Falta la categoría de movimiento "${nombre}". Creala en Configuración antes de liquidar.`,
    );
  }
  return { id: cat.id, nombre: cat.nombre };
}
export interface FilaConsumible {
  id: string;
  tipo: string;
  horasRestantes: number;
  /** Valor hora YA resuelto para esta fila (su categoría y su tipo de hora). */
  valorHora: number;
  montoRestante: number;
  prestamoRestante: number;
}

export interface ResumenLiquidacion {
  /** Horas cargadas y todavía no cobradas. */
  horas: number;
  /** Lo que valen esas horas HOY. Es el techo de lo que se puede liquidar. */
  montoHoras: number;
  /** Préstamos entregados y todavía no devueltos. */
  prestamos: number;
  /** Filas de horas, de la más vieja a la más nueva. */
  horasFilas: FilaConsumible[];
  /** Préstamos, del más viejo al más nuevo. */
  prestamoFilas: FilaConsumible[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
/** Las horas aplicadas van a 6 decimales: ver el comentario del schema. */
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Qué se le debe hoy y qué debe él, sin tocar nada.
 *
 * Lo usan la pantalla (para mostrar los números antes de confirmar) y la
 * liquidación (para cobrarlos). Que salgan del mismo lugar es lo que garantiza
 * que el cartel y la caja digan lo mismo.
 */
export async function resumenPendiente(
  empleado: EmpleadoTarifa & { nombre: string; apellido?: string | null },
  tx: { movimientoBancoHoras: { findMany: typeof prisma.movimientoBancoHoras.findMany } } = prisma,
): Promise<ResumenLiquidacion> {
  const filas = await tx.movimientoBancoHoras.findMany({
    where: { empleadoId: empleado.id, liquidacionId: null },
    select: {
      id: true,
      tipo: true,
      horas: true,
      horasAplicadas: true,
      montoPesos: true,
      montoAplicado: true,
      tipoHora: { select: { multiplicador: true, valorHoraFijo: true } },
      categoriaLaboral: { select: { valorHora: true } },
    },
    // FIFO: se cobran primero las horas más viejas y se devuelve primero el
    // préstamo más viejo. Sin un orden fijo, dos liquidaciones iguales podrían
    // dejar saldos distintos.
    orderBy: [{ fecha: 'asc' }, { creadoAt: 'asc' }],
  });

  const horasFilas: FilaConsumible[] = [];
  const prestamoFilas: FilaConsumible[] = [];
  let horas = 0;
  let montoHoras = 0;
  let prestamos = 0;

  for (const f of filas) {
    const hRest = restanteHoras(f);
    if (hRest > 0) {
      const vh = valorDeTipoHora(valorHoraDeFila(empleado, f.categoriaLaboral), f.tipoHora);
      const monto = r2(hRest * vh);
      horas += hRest;
      montoHoras += monto;
      horasFilas.push({
        id: f.id,
        tipo: f.tipo,
        horasRestantes: hRest,
        valorHora: vh,
        montoRestante: monto,
        prestamoRestante: 0,
      });
    }
    const pRest = restantePrestamo(f);
    if (pRest > 0) {
      prestamos += pRest;
      prestamoFilas.push({
        id: f.id,
        tipo: f.tipo,
        horasRestantes: 0,
        valorHora: 0,
        montoRestante: 0,
        prestamoRestante: pRest,
      });
    }
  }

  return { horas: r2(horas), montoHoras: r2(montoHoras), prestamos: r2(prestamos), horasFilas, prestamoFilas };
}

// ────────────────────────────────────────────────────────────────────────
//   Liquidar
// ────────────────────────────────────────────────────────────────────────

export interface PlanLiquidacion {
  /** Lo que sale de la caja y se le entrega. */
  montoPagado: number;
  /** Lo que se descuenta del préstamo en vez de pagarse. */
  montoAlPrestamo: number;
}

export interface OpcionesLiquidar {
  empleado: EmpleadoTarifa & { nombre: string; apellido?: string | null };
  resumen: ResumenLiquidacion;
  plan: PlanLiquidacion;
  lineas: LineaPagoLiq[];
  categoriaMovimientoId: string;
  sesionCajaId: string;
  usuarioId: string;
  /** Fecha contable del egreso. La de la liquidación es siempre hoy. */
  fechaComputo: Date;
  fechaHoy: Date;
  observacion?: string | null;
}

/**
 * Valida el plan contra lo que hay pendiente.
 *
 * Separado de la escritura para que la pantalla pueda pedir la misma
 * validación antes de mostrar el botón, sin duplicar los límites.
 */
export function validarPlan(resumen: ResumenLiquidacion, plan: PlanLiquidacion): void {
  const total = r2(plan.montoPagado + plan.montoAlPrestamo);
  if (total <= 0) {
    throw new ReglaNegocioError('Poné cuánto se le paga, o cuánto va contra el préstamo.');
  }
  // Medio centavo de tolerancia: los montos vienen de dividir pesos por el
  // valor hora, y exigir igualdad exacta rechazaría un "pagar todo" legítimo.
  if (total > resumen.montoHoras + 0.005) {
    throw new ReglaNegocioError(
      `Sólo hay $${resumen.montoHoras.toFixed(2)} en horas para cubrir. Estás queriendo aplicar $${total.toFixed(2)}.`,
    );
  }
  if (plan.montoAlPrestamo > resumen.prestamos + 0.005) {
    throw new ReglaNegocioError(
      `El préstamo pendiente es de $${resumen.prestamos.toFixed(2)}, no se le puede descontar $${plan.montoAlPrestamo.toFixed(2)}.`,
    );
  }
}

/**
 * Cierra las horas que se cubren y paga.
 *
 * Todo adentro de UNA transacción. Dos cosas que no son obvias:
 *
 * - **Consume de a partes.** Una fila de 8 hs puede quedar cobrada a medias.
 *   Lo que sigue pendiente son HORAS, no pesos: si el valor sube, sube lo que
 *   falta cobrar. Ése es el punto del banco de horas.
 * - **El préstamo NO se netea solo.** Se descuenta lo que diga el plan y nada
 *   más. Netearlo automáticamente obligaba a la persona a trabajar gratis
 *   hasta cubrirlo.
 */
export async function liquidarEnTransaccion(
  tx: Prisma.TransactionClient,
  o: OpcionesLiquidar,
): Promise<{ liquidacionId: string; movimientoId: string | null; horasConsumidas: number }> {
  const { resumen, plan, empleado } = o;
  validarPlan(resumen, plan);

  const aCubrir = r2(plan.montoPagado + plan.montoAlPrestamo);

  // ── 1. Consumir horas, de la más vieja a la más nueva ──
  let restante = aCubrir;
  let horasConsumidas = 0;
  const cerradas: string[] = [];
  for (const f of resumen.horasFilas) {
    if (restante <= 0.004) break;
    const cubreEntera = f.montoRestante <= restante + 0.004;
    const horas = cubreEntera ? f.horasRestantes : r6(restante / f.valorHora);
    if (horas <= 0) continue;
    await tx.movimientoBancoHoras.update({
      where: { id: f.id },
      data: { horasAplicadas: { increment: horas } },
    });
    horasConsumidas += horas;
    restante = r2(restante - (cubreEntera ? f.montoRestante : restante));
    if (cubreEntera) cerradas.push(f.id);
  }

  // ── 2. Descontar del préstamo lo que diga el plan ──
  let alPrestamo = plan.montoAlPrestamo;
  for (const f of resumen.prestamoFilas) {
    if (alPrestamo <= 0.004) break;
    const monto = Math.min(f.prestamoRestante, alPrestamo);
    await tx.movimientoBancoHoras.update({
      where: { id: f.id },
      data: { montoAplicado: { increment: monto } },
    });
    alPrestamo = r2(alPrestamo - monto);
    if (monto >= f.prestamoRestante - 0.004) cerradas.push(f.id);
  }

  // ── 3. La plata que sale de la caja ──
  let mov: { id: string } | null = null;
  if (plan.montoPagado > 0) {
    mov = await tx.movimiento.create({
      data: {
        tipo: 'EGRESO',
        monto: plan.montoPagado,
        categoriaId: o.categoriaMovimientoId,
        cuentaOrigenId: o.lineas[0]!.cuentaId,
        entidadId: empleado.id,
        sesionCajaId: o.sesionCajaId,
        fechaComputo: o.fechaComputo,
        observacion:
          o.observacion ??
          `Pago de ${r2(horasConsumidas).toFixed(2)} hs a ${empleado.nombre}${empleado.apellido ? ' ' + empleado.apellido : ''}`,
        estado: 'CONFIRMADO',
        usuarioId: o.usuarioId,
      },
      select: { id: true },
    });

    // Una línea por cuenta: el pago puede venir repartido (una parte en
    // efectivo y otra por transferencia), igual que el pago de sueldo normal.
    for (const l of o.lineas) {
      const monto = Number(l.monto);
      await tx.pago.create({
        data: {
          movimientoId: mov.id,
          metodo: l.metodo as never,
          cuentaId: l.cuentaId,
          monto,
          numeroReferencia: l.numeroReferencia ?? null,
          estado: 'CONFIRMADO',
          fecha: o.fechaComputo,
        },
      });
      await tx.cuenta.update({
        where: { id: l.cuentaId },
        data: { saldoActual: { decrement: monto } },
      });
    }
  }

  const liq = await tx.liquidacionEmpleado.create({
    data: {
      empleadoId: empleado.id,
      fecha: o.fechaHoy,
      horasLiquidadas: r2(horasConsumidas),
      // El valor BASE del empleado. El monto sale de valuar fila por fila con
      // su tipo y su categoría, así que con filas mezcladas este número es la
      // referencia, no una multiplicación directa.
      valorHoraAplicado: valorHoraBase(empleado),
      montoHoras: aCubrir,
      adelantosAplicados: plan.montoAlPrestamo,
      montoPagado: plan.montoPagado,
      movimientoId: mov?.id ?? null,
      observacion: o.observacion ?? null,
      usuarioId: o.usuarioId,
    },
  });

  // Cerrar SÓLO las filas que quedaron consumidas del todo, y sólo si seguían
  // abiertas. Si alguien liquidó en paralelo entre la lectura y esto, el
  // updateMany no las toca y se aborta: pagar dos veces las mismas horas no se
  // deshace solo.
  if (cerradas.length) {
    const n = await tx.movimientoBancoHoras.updateMany({
      where: { id: { in: cerradas }, liquidacionId: null },
      data: { liquidacionId: liq.id },
    });
    if (n.count !== cerradas.length) {
      throw new ReglaNegocioError(
        'Otra persona liquidó a este empleado al mismo tiempo. Volvé a abrir la ficha y fijate el saldo antes de reintentar.',
      );
    }
  }

  // El asiento del pago, ya marcado como liquidado para que no vuelva a
  // contarse como pendiente.
  await tx.movimientoBancoHoras.create({
    data: {
      empleadoId: empleado.id,
      tipo: 'LIQUIDACION',
      horas: -r2(horasConsumidas),
      horasAplicadas: -r2(horasConsumidas),
      montoPesos: plan.montoPagado > 0 ? -plan.montoPagado : null,
      montoAplicado: plan.montoPagado > 0 ? -plan.montoPagado : 0,
      fecha: o.fechaHoy,
      observacion: o.observacion ?? null,
      movimientoId: mov?.id ?? null,
      liquidacionId: liq.id,
      usuarioId: o.usuarioId,
    },
  });

  return { liquidacionId: liq.id, movimientoId: mov?.id ?? null, horasConsumidas: r2(horasConsumidas) };
}
