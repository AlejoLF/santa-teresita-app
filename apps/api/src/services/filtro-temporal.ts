import { z } from 'zod';
import { getSesionActualReadOnly, getSesionAnteriorReadOnly } from './sesion-caja.js';

/**
 * Filtro temporal COMPARTIDO por los buscadores de admin (ventas, encargos,
 * movimientos, facturas).
 *
 * Regla de producto: el default es `todo` — SIN ventana de tiempo la búsqueda
 * barre la base COMPLETA del área. La acotación la da la paginación, no un
 * rango implícito. Por eso ningún endpoint debe defaultear a 'hoy'.
 */
export const PERIODOS_BUSQUEDA = [
  'todo',
  'sesion_actual',
  'sesion_anterior',
  'hoy',
  'ayer',
  '7dias',
  '30dias',
  'custom',
] as const;

export type PeriodoBusqueda = (typeof PERIODOS_BUSQUEDA)[number];

export const periodoBusquedaSchema = z.enum(PERIODOS_BUSQUEDA).default('todo');

/**
 * Schema de paginación común. 12 por página es lo que pidió el dueño: entra en
 * pantalla sin scrollear y mantiene las queries baratas contra el pooler
 * (las cajas corren con connection_limit=1).
 */
export const paginacionSchema = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(12),
};

/**
 * UUID que no existe: cuando se pide "sesión anterior" y no hay ninguna previa
 * (instalación nueva), filtramos por este id para devolver vacío en vez de
 * ignorar el filtro y mostrar TODA la base — que sería el error opuesto y
 * mucho más confuso. Mismo criterio que /admin/movimientos.
 */
const SESION_INEXISTENTE = '00000000-0000-0000-0000-000000000000';

export type FiltroTemporal = {
  /** Si viene, hay que filtrar por `sesionCajaId` (NO por fecha). */
  sesionCajaId: string | null;
  desde: Date | null;
  hasta: Date | null;
};

/**
 * Resuelve el filtro pedido a: una sesión de caja puntual, o un rango de
 * fechas, o nada (= toda la base).
 *
 * Sesión vs fecha: un registro pertenece al turno por su `sesionCajaId`, no por
 * su fecha (ver invariante en CLAUDE.md). Por eso cuando el filtro es por
 * sesión devolvemos `sesionCajaId` y NO un rango — filtrar por
 * [apertura, cierre] daría números distintos a los del cierre de caja.
 *
 * Los rangos relativos (hoy/ayer/7d/30d) se calculan con getFullYear/Month/Date,
 * o sea en la TZ del proceso. El .exe spawnea la API con
 * TZ='America/Argentina/Buenos_Aires', así que "hoy" es el día argentino.
 */
export async function resolverFiltroTemporal(args: {
  periodo?: PeriodoBusqueda;
  desde?: string;
  hasta?: string;
  /** Sesión puntual explícita (selector de sesiones del día). Tiene prioridad. */
  sesionId?: string;
}): Promise<FiltroTemporal> {
  const periodo = args.periodo ?? 'todo';

  if (args.sesionId) {
    return { sesionCajaId: args.sesionId, desde: null, hasta: null };
  }

  switch (periodo) {
    case 'todo':
      return { sesionCajaId: null, desde: null, hasta: null };

    case 'sesion_actual': {
      const { sesion } = await getSesionActualReadOnly();
      return { sesionCajaId: sesion?.id ?? SESION_INEXISTENTE, desde: null, hasta: null };
    }

    case 'sesion_anterior': {
      const { sesion } = await getSesionAnteriorReadOnly();
      return { sesionCajaId: sesion?.id ?? SESION_INEXISTENTE, desde: null, hasta: null };
    }

    case 'custom':
      return {
        sesionCajaId: null,
        desde: args.desde ? new Date(args.desde) : null,
        hasta: args.hasta ? new Date(args.hasta) : null,
      };

    default: {
      const ahora = new Date();
      const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());

      if (periodo === 'hoy') {
        return { sesionCajaId: null, desde: inicioHoy, hasta: ahora };
      }
      if (periodo === 'ayer') {
        const inicioAyer = new Date(inicioHoy);
        inicioAyer.setDate(inicioAyer.getDate() - 1);
        // hasta = 1ms antes de hoy, para no pisar el día de hoy.
        return {
          sesionCajaId: null,
          desde: inicioAyer,
          hasta: new Date(inicioHoy.getTime() - 1),
        };
      }
      // 7dias / 30dias: incluye hoy (por eso dias - 1).
      const dias = periodo === '7dias' ? 7 : 30;
      const desde = new Date(inicioHoy);
      desde.setDate(desde.getDate() - (dias - 1));
      return { sesionCajaId: null, desde, hasta: ahora };
    }
  }
}

/**
 * Arma el `where` de rango para un campo de fecha. Devuelve `{}` cuando el
 * filtro es por sesión (el rango no aplica) o cuando no hay ventana — así se
 * puede spreadear sin condicionales en el call site.
 */
export function whereRangoFecha(
  campo: string,
  f: FiltroTemporal,
): Record<string, { gte?: Date; lte?: Date }> {
  if (f.sesionCajaId) return {};
  if (!f.desde && !f.hasta) return {};
  return {
    [campo]: {
      ...(f.desde && { gte: f.desde }),
      ...(f.hasta && { lte: f.hasta }),
    },
  };
}

/**
 * Igual que `whereRangoFecha` pero para columnas `@db.Date` (date-only), que
 * Postgres guarda como MEDIANOCHE UTC — p. ej. `ventas.fecha_entrega_promesa`.
 *
 * Por qué no sirve el rango normal: los límites se calculan en TZ argentina
 * (UTC-3), así que "hoy" empieza a las 03:00Z. Comparar contra un @db.Date
 * guardado a las 00:00Z dejaría FUERA el día de hoy — corrimiento de 1 día,
 * el mismo bug que ya cerramos en el render. Acá tomamos el día calendario
 * (local, o sea AR) de cada extremo y lo llevamos a medianoche UTC.
 */
export function whereRangoDiaUtc(
  campo: string,
  f: FiltroTemporal,
): Record<string, { gte?: Date; lte?: Date }> {
  if (f.sesionCajaId) return {};
  if (!f.desde && !f.hasta) return {};
  const aDiaUtc = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return {
    [campo]: {
      ...(f.desde && { gte: aDiaUtc(f.desde) }),
      ...(f.hasta && { lte: aDiaUtc(f.hasta) }),
    },
  };
}

/** `true` si el texto es un número (para buscar por monto/total exacto). */
export function esBusquedaNumerica(q: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(q.trim());
}

/** `true` si el texto es una fecha YYYY-MM-DD (para buscar por día exacto). */
export function esBusquedaFecha(q: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(q.trim());
}

/** Sobre de paginación que devuelven todos los buscadores. */
export function armarPaginacion(total: number, page: number, pageSize: number) {
  return {
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
