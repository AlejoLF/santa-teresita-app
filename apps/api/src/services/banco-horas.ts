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
  /** Adelantos entregados y todavía no descontados. */
  adelantosPendientes: number;
  /** `montoHoras − adelantosPendientes`. Negativo = la persona debe. */
  saldo: number;
  valorHora: number;
}

/** Filas pendientes de un empleado (sin liquidar), con su tipo de hora. */
type FilaPendiente = {
  tipo: string;
  horas: Prisma.Decimal | null;
  montoPesos: Prisma.Decimal | null;
  tipoHora: TipoHoraTarifa | null;
  /** Excepción del día: se trabajó en otra categoría. null = la de siempre. */
  categoriaLaboral: { id: string; nombre: string; valorHora: Prisma.Decimal } | null;
};

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
    const horas = f.horas != null ? Number(f.horas) : 0;
    const pesos = f.montoPesos != null ? Number(f.montoPesos) : 0;
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
      empleadoId: true,
      tipo: true,
      horas: true,
      montoPesos: true,
      tipoHora: { select: { multiplicador: true, valorHoraFijo: true } },
      categoriaLaboral: { select: { id: true, nombre: true, valorHora: true } },
    },
  });
  const out = new Map<string, FilaPendiente[]>();
  for (const f of filas) {
    const arr = out.get(f.empleadoId) ?? [];
    arr.push({
      tipo: f.tipo,
      horas: f.horas,
      montoPesos: f.montoPesos,
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

export interface ResumenLiquidacion {
  horas: number;
  montoHoras: number;
  adelantos: number;
  aPagar: number;
  idsPendientes: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Qué se le debe hoy, sin tocar nada. Lo usan la pantalla (para mostrar el
 * total antes de confirmar) y la liquidación (para cobrarlo).
 */
export async function resumenPendiente(
  empleado: EmpleadoTarifa & { nombre: string; apellido?: string | null },
  tx: { movimientoBancoHoras: { findMany: typeof prisma.movimientoBancoHoras.findMany } } = prisma,
): Promise<ResumenLiquidacion> {
  const pendientes = await tx.movimientoBancoHoras.findMany({
    where: { empleadoId: empleado.id, liquidacionId: null },
    select: {
      id: true,
      horas: true,
      montoPesos: true,
      tipoHora: { select: { multiplicador: true, valorHoraFijo: true } },
      categoriaLaboral: { select: { valorHora: true } },
    },
  });

  let horas = 0;
  let montoHoras = 0;
  let adelantos = 0;
  for (const f of pendientes) {
    const h = f.horas != null ? Number(f.horas) : 0;
    if (h) {
      horas += h;
      montoHoras += h * valorDeTipoHora(valorHoraDeFila(empleado, f.categoriaLaboral), f.tipoHora);
    }
    if (f.montoPesos != null) adelantos += Number(f.montoPesos);
  }
  horas = r2(horas);
  montoHoras = r2(montoHoras);
  adelantos = r2(adelantos);
  return {
    horas,
    montoHoras,
    adelantos,
    aPagar: r2(montoHoras - adelantos),
    idsPendientes: pendientes.map((p) => p.id),
  };
}

export interface OpcionesLiquidar {
  empleado: EmpleadoTarifa & { nombre: string; apellido?: string | null };
  resumen: ResumenLiquidacion;
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
 * Cierra las horas pendientes y paga.
 *
 * Todo adentro de UNA transacción, con las mismas dos guardas que tenía el
 * botón de liquidar:
 *
 * - Cierra **sólo las filas que se leyeron**, por id. Un `liquidacionId: null`
 *   a secas arrastraría una fila que entró en el medio sin haberla contado, y
 *   se pagaría de menos.
 * - Si el update no cierra exactamente esas filas, aborta: alguien liquidó en
 *   paralelo, y pagar dos veces las mismas horas no se deshace solo.
 */
export async function liquidarEnTransaccion(
  tx: Prisma.TransactionClient,
  o: OpcionesLiquidar,
): Promise<{ liquidacionId: string; movimientoId: string | null }> {
  const { resumen: r, empleado } = o;
  const base = valorHoraBase(empleado);

  // Puede dar 0 si las horas cubren justo los adelantos: la liquidación existe
  // igual (cierra las filas), pero no sale plata y no corresponde movimiento.
  let mov: { id: string } | null = null;
  if (r.aPagar > 0) {
    mov = await tx.movimiento.create({
      data: {
        tipo: 'EGRESO',
        monto: r.aPagar,
        categoriaId: o.categoriaMovimientoId,
        cuentaOrigenId: o.lineas[0]!.cuentaId,
        entidadId: empleado.id,
        sesionCajaId: o.sesionCajaId,
        fechaComputo: o.fechaComputo,
        observacion:
          o.observacion ??
          `Liquidación de ${r.horas.toFixed(2)} hs a ${empleado.nombre}${empleado.apellido ? ' ' + empleado.apellido : ''}`,
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
      horasLiquidadas: r.horas,
      // El valor BASE aplicado. El monto sale de valuar fila por fila con su
      // tipo y su categoría, así que con filas mezcladas este número es la
      // referencia, no una multiplicación directa.
      valorHoraAplicado: base,
      montoHoras: r.montoHoras,
      adelantosAplicados: r.adelantos,
      montoPagado: r.aPagar,
      movimientoId: mov?.id ?? null,
      observacion: o.observacion ?? null,
      usuarioId: o.usuarioId,
    },
  });

  const cerradas = await tx.movimientoBancoHoras.updateMany({
    where: { id: { in: r.idsPendientes }, liquidacionId: null },
    data: { liquidacionId: liq.id },
  });
  if (cerradas.count !== r.idsPendientes.length) {
    throw new ReglaNegocioError(
      'Otra persona liquidó a este empleado al mismo tiempo. Volvé a abrir la ficha y fijate el saldo antes de reintentar.',
    );
  }

  // El asiento que deja el saldo en cero, ya marcado como liquidado.
  await tx.movimientoBancoHoras.create({
    data: {
      empleadoId: empleado.id,
      tipo: 'LIQUIDACION',
      horas: -r.horas,
      montoPesos: r.aPagar > 0 ? -r.aPagar : null,
      fecha: o.fechaHoy,
      observacion: o.observacion ?? null,
      movimientoId: mov?.id ?? null,
      liquidacionId: liq.id,
      usuarioId: o.usuarioId,
    },
  });

  return { liquidacionId: liq.id, movimientoId: mov?.id ?? null };
}
