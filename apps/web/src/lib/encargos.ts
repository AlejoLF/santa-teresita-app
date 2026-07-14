// Tipos y helpers compartidos de la pestaña de Encargos.

export const TZ_AR = 'America/Argentina/Buenos_Aires';

export type FranjaEntrega = 'MANANA' | 'TARDE' | 'NOCHE';
export type TipoEntrega = 'RETIRO' | 'ENVIO';
// PARCIAL = el encargo original y sus adiciones tienen mezcla de pagado/no pagado.
export type EstadoCobro = 'A_PAGAR' | 'COBRADO' | 'PARCIAL';

export interface EncargoListItem {
  id: string;
  numero: number;
  numeroOrdenTurno: number;
  estado: 'PROCESADA' | 'FINALIZADA' | 'ANULADA';
  total: string;
  tipoEntrega: TipoEntrega | null;
  fechaEntrega: string | null; // YYYY-MM-DD
  horaEntregaExacta: string | null;
  franjaEntrega: FranjaEntrega | null;
  estadoCobro: EstadoCobro;
  /** Entrega: cuándo se lo llevó el cliente. null = pendiente de retiro. */
  retiradoAt: string | null;
  cliente: string | null;
  telefono: string | null;
  itemsCount: number;
}

export const FRANJA_LABEL: Record<FranjaEntrega, string> = {
  MANANA: 'Mañana',
  TARDE: 'Tarde',
  NOCHE: 'Noche',
};

// ─── Filtros del HUD de encargos ──────────────────────────────────────
//
// El retiro es ORTOGONAL al cobro (se puede retirar un encargo impago), así que
// los chips mezclan las dos dimensiones a propósito: son atajos operativos, no
// un enum de estados. Selección única.

export type FiltroEncargo =
  | 'todos'
  | 'pendiente_retiro'
  | 'retirado'
  | 'impago'
  | 'cobrado'
  | 'atrasado';

export const FILTROS_ENCARGO: Array<{ valor: FiltroEncargo; label: string; icono: string }> = [
  { valor: 'todos', label: 'Todos', icono: '📋' },
  { valor: 'pendiente_retiro', label: 'Sin retirar', icono: '📦' },
  { valor: 'retirado', label: 'Retirados', icono: '✅' },
  { valor: 'impago', label: 'Pago pendiente', icono: '💰' },
  { valor: 'cobrado', label: 'Cobrados', icono: '💵' },
  { valor: 'atrasado', label: 'Atrasados', icono: '⚠️' },
];

/** Hora de corte de cada franja, en minutos desde medianoche. */
const FIN_FRANJA: Record<FranjaEntrega, number> = {
  MANANA: 13 * 60,
  TARDE: 20 * 60,
  NOCHE: 23 * 60 + 59,
};

/** Minutos transcurridos hoy, en hora de Argentina. */
export function minutosAhoraAR(): number {
  const hhmm = new Date().toLocaleTimeString('en-GB', {
    timeZone: TZ_AR,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Encargo atrasado: pasó su horario de entrega y todavía nadie lo retiró.
 * Los ya retirados nunca están atrasados, sin importar la hora.
 */
export function estaAtrasado(e: EncargoListItem, hoy: string, minutosAhora: number): boolean {
  if (e.retiradoAt || !e.fechaEntrega) return false;
  if (e.fechaEntrega < hoy) return true; // día ya pasado
  if (e.fechaEntrega > hoy) return false; // todavía falta
  const limite = e.horaEntregaExacta
    ? (() => {
        const [h, m] = e.horaEntregaExacta.split(':').map(Number);
        return (h ?? 0) * 60 + (m ?? 0);
      })()
    : e.franjaEntrega
      ? FIN_FRANJA[e.franjaEntrega]
      : null;
  return limite !== null && minutosAhora > limite;
}

/** ¿El encargo entra en el filtro elegido? */
export function coincideFiltro(
  e: EncargoListItem,
  filtro: FiltroEncargo,
  hoy: string,
  minutosAhora: number,
): boolean {
  switch (filtro) {
    case 'todos':
      return true;
    case 'pendiente_retiro':
      return !e.retiradoAt;
    case 'retirado':
      return !!e.retiradoAt;
    case 'impago':
      return e.estadoCobro !== 'COBRADO'; // A_PAGAR o PARCIAL
    case 'cobrado':
      return e.estadoCobro === 'COBRADO';
    case 'atrasado':
      return estaAtrasado(e, hoy, minutosAhora);
  }
}

/** Texto del horario de entrega: hora exacta o franja. */
export function cuandoLabel(e: {
  horaEntregaExacta?: string | null;
  franjaEntrega?: FranjaEntrega | null;
}): string {
  if (e.horaEntregaExacta) return `${e.horaEntregaExacta} hs`;
  if (e.franjaEntrega) return FRANJA_LABEL[e.franjaEntrega];
  return '—';
}

/** Hoy en AR, formato YYYY-MM-DD. */
export function hoyISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ_AR });
}

/** YYYY-MM-DD + n días (cálculo en UTC para no correr el día). */
export function isoMasDias(isoBase: string, n: number): string {
  const [y, m, d] = isoBase.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" → "DD/MM". */
export function fechaCortaDM(iso: string | null): string {
  if (!iso) return '—';
  const [, m, d] = iso.split('-');
  return d && m ? `${d}/${m}` : iso;
}

/** "YYYY-MM-DD" → "Lun 5 jul" (etiqueta de día, en UTC para no correr). */
export function fechaLargaDia(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  return dt.toLocaleDateString('es-AR', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
