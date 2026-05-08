'use client';

import { useEffect, useState, useCallback } from 'react';
import type { Periodo } from './PeriodoSelector';
import { api } from '@/lib/api';

export interface TabProps {
  periodo: Periodo;
  customDesde: string;
  customHasta: string;
}

/**
 * Hook genérico para fetchear data de analytics. Cada tab lo usa con su
 * endpoint y tipo. Re-fetchea cuando cambia el período.
 */
export function useAnalytics<T>(endpoint: string, props: TabProps) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const fetchData = useCallback(async () => {
    setCargando(true);
    try {
      const params = new URLSearchParams({ periodo: props.periodo });
      if (props.periodo === 'custom') {
        params.set('desde', props.customDesde);
        params.set('hasta', props.customHasta);
      }
      const res = await api.get<T>(`${endpoint}?${params.toString()}`);
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar');
    } finally {
      setCargando(false);
    }
  }, [endpoint, props.periodo, props.customDesde, props.customHasta]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return { data, error, cargando, refetch: fetchData };
}

/** Card genérica con título + opcional info tooltip. */
export function Card({
  titulo,
  tooltip,
  children,
  className = '',
}: {
  titulo?: string;
  tooltip?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`card p-4 ${className}`}>
      {titulo && (
        <div className="flex items-center mb-3">
          <h2 className="font-display text-md text-ink-900">{titulo}</h2>
          {tooltip}
        </div>
      )}
      {children}
    </div>
  );
}

/** Skeleton mientras cargan los datos. */
export function Cargando({ alto = 200 }: { alto?: number }) {
  return (
    <div
      className="bg-cream-200 animate-pulse rounded-md"
      style={{ height: alto }}
    />
  );
}

/** Banner de error consistente. */
export function ErrorBanner({ mensaje }: { mensaje: string }) {
  return (
    <div className="card p-4 border-pomodoro-600/30 bg-pomodoro-100">
      <p className="text-sm text-pomodoro-600">⚠ {mensaje}</p>
    </div>
  );
}

/** Wrapper de tabla pro consistente con Tailwind. */
export function TablaSimple({
  columnas,
  filas,
  vacioMsg = 'Sin datos en el período',
}: {
  columnas: Array<{ key: string; label: string; align?: 'left' | 'right' | 'center' }>;
  filas: Array<Record<string, React.ReactNode>>;
  vacioMsg?: string;
}) {
  if (filas.length === 0) {
    return <p className="text-sm text-ink-500 italic py-4 text-center">{vacioMsg}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-cream-300 text-ink-500 text-xs uppercase tracking-wide">
            {columnas.map((c) => (
              <th
                key={c.key}
                className={`py-2 px-2 font-medium ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.map((f, i) => (
            <tr key={i} className="border-b border-cream-200 hover:bg-cream-100">
              {columnas.map((c) => (
                <td
                  key={c.key}
                  className={`py-2 px-2 ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'}`}
                >
                  {f[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FORMATEADOR_PESOS = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function fmtPesos(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  return FORMATEADOR_PESOS.format(n);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

const FMT_NUM = new Intl.NumberFormat('es-AR');
export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return FMT_NUM.format(v);
}
