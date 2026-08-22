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
};

/**
 * Saldo a partir de las filas pendientes ya cargadas.
 *
 * Separado de la consulta a propósito: la pantalla de listado trae las filas de
 * todos los empleados en UNA query y valúa acá, en vez de hacer una consulta
 * por persona.
 */
export function calcularSaldo(
  empleado: EmpleadoTarifa,
  filas: FilaPendiente[],
): SaldoEmpleado {
  const base = valorHoraBase(empleado);
  let horasPendientes = 0;
  let montoHoras = 0;
  let adelantosPendientes = 0;

  for (const f of filas) {
    const horas = f.horas != null ? Number(f.horas) : 0;
    const pesos = f.montoPesos != null ? Number(f.montoPesos) : 0;
    if (horas) {
      horasPendientes += horas;
      // Cada fila se valúa con SU tipo: mezclar normales con feriado y
      // multiplicar el total por un solo valor daría de menos.
      montoHoras += horas * valorDeTipoHora(base, f.tipoHora);
    }
    if (pesos) adelantosPendientes += pesos;
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    horasPendientes: r2(horasPendientes),
    sinValorHora: base <= 0 && horasPendientes > 0,
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
    },
  });
  const out = new Map<string, FilaPendiente[]>();
  for (const f of filas) {
    const arr = out.get(f.empleadoId) ?? [];
    arr.push({ tipo: f.tipo, horas: f.horas, montoPesos: f.montoPesos, tipoHora: f.tipoHora });
    out.set(f.empleadoId, arr);
  }
  return out;
}
