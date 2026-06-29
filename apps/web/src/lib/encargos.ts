// Tipos y helpers compartidos de la pestaña de Encargos.

export const TZ_AR = 'America/Argentina/Buenos_Aires';

export type FranjaEntrega = 'MANANA' | 'TARDE' | 'NOCHE';
export type TipoEntrega = 'RETIRO' | 'ENVIO';
export type EstadoCobro = 'A_PAGAR' | 'COBRADO';

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
  cliente: string | null;
  telefono: string | null;
  itemsCount: number;
}

export const FRANJA_LABEL: Record<FranjaEntrega, string> = {
  MANANA: 'Mañana',
  TARDE: 'Tarde',
  NOCHE: 'Noche',
};

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
