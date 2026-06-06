'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hook de "tiempo real" por polling para los tabs del dashboard.
 *
 * Por qué polling y no Supabase Realtime/websockets:
 *   - El dashboard lee vía `pg` server-side (route handlers), no supabase-js.
 *     Montar websockets desde Vercel serverless + RLS + publication es mucho
 *     más frágil para un panel que refresca KPIs cada ~20s.
 *   - Un POS escribe poquísimo: refrescar cada 20s es "tiempo real" de sobra
 *     para que Julio/la encargada vean la venta recién cargada, y casi no
 *     consume (1 query liviana cada 20s por pantalla abierta).
 *
 * Comportamiento:
 *   - Carga "dura" (skeleton) al montar y cuando cambian `deps`.
 *   - Refresh "suave" cada `intervalMs` (mantiene los datos viejos en pantalla,
 *     marca `refreshing`). Un refresh que falla NO borra los datos buenos.
 *   - Pausa el timer cuando la pestaña está oculta (document.hidden) y dispara
 *     un refresh inmediato al volver al foco — no quema requests en background.
 *   - No apila requests (si uno está en vuelo, el tick se saltea).
 *   - Ignora resultados de una "generación" vieja si `deps` cambió en el medio.
 */

export interface AutoRefreshResult<T> {
  data: T | null;
  error: string | null;
  /** primera carga, sin datos aún → mostrar skeleton */
  loading: boolean;
  /** refetch en background con datos ya en pantalla */
  refreshing: boolean;
  /** epoch ms del último fetch OK (para "actualizado hace Xs") */
  lastUpdated: number | null;
  /** fuerza un refresh suave inmediato */
  refetch: () => void;
}

interface Options {
  intervalMs?: number;
  /** cambios en estos valores disparan una carga dura (skeleton). */
  deps?: unknown[];
  enabled?: boolean;
}

export function useAutoRefresh<T>(
  fetcher: () => Promise<T>,
  { intervalMs = 20_000, deps = [], enabled = true }: Options = {},
): AutoRefreshResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  // fetcher se recrea en cada render (closure sobre period/q/etc). Lo guardamos
  // en un ref para que los efectos NO dependan de su identidad y el timer no se
  // reinicie en cada render. El refresh suave siempre usa el fetcher más nuevo.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const inFlight = useRef(false);
  const mountedRef = useRef(true);
  const hasData = useRef(false);
  const genRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async (mode: 'hard' | 'soft') => {
    // No apilamos refreshes suaves; una carga dura siempre procede (supera lo
    // que haya en vuelo) e invalida resultados viejos vía genRef.
    if (mode === 'soft' && inFlight.current) return;
    const myGen = mode === 'hard' ? ++genRef.current : genRef.current;
    inFlight.current = true;
    if (mode === 'hard') {
      setLoading(true);
      setData(null);
      hasData.current = false;
    } else {
      setRefreshing(true);
    }
    try {
      const result = await fetcherRef.current();
      if (!mountedRef.current || myGen !== genRef.current) return;
      setData(result);
      hasData.current = true;
      setError(null);
      setLastUpdated(Date.now());
    } catch (e) {
      if (!mountedRef.current || myGen !== genRef.current) return;
      // En refresh suave con datos buenos en pantalla NO pisamos con un error:
      // mejor un dato levemente viejo que un parpadeo rojo.
      const msg = e instanceof Error ? e.message : 'Error de red';
      if (mode === 'hard' || !hasData.current) setError(msg);
    } finally {
      if (mountedRef.current && myGen === genRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
      inFlight.current = false;
    }
  }, []);

  // Carga dura al montar + cuando cambian deps.
  useEffect(() => {
    if (!enabled) return;
    void run('hard');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run, ...deps]);

  // Timer de refresh suave + pausa por visibilidad.
  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        void run('soft');
      }, intervalMs);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void run('soft');
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, run, ...deps]);

  const refetch = useCallback(() => {
    void run('soft');
  }, [run]);

  return { data, error, loading, refreshing, lastUpdated, refetch };
}
