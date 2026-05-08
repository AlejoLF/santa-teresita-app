'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

/**
 * Badge en el header admin que muestra el estado de sincronización con
 * la cloud. Polling cada 10s a /sync/status (endpoint local, no cloud,
 * así que NO depende de internet).
 *
 * Estados:
 *   - hidden:   pending=0, abandoned=0 → todo OK, no muestra nada.
 *   - amarillo: pending>0 (writes encolados, esperando que cloud responda).
 *   - rojo:     abandoned>0 (writes que fallaron 20+ veces — requieren atención).
 */
export function SyncStatusBadge() {
  const [status, setStatus] = useState<{ pending: number; abandoned: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const r = await api.get<{ pending: number; abandoned: number }>('/sync/status');
        if (!cancelled) setStatus(r);
      } catch (e) {
        // Si /sync/status falla, probablemente la API local también está
        // caída — algo más grave. Limpiamos status para no mostrar info
        // engañosa.
        if (!cancelled && !(e instanceof ApiError && e.status === 401)) {
          setStatus(null);
        }
      } finally {
        if (!cancelled) timer = setTimeout(tick, 10_000);
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!status) return null;
  if (status.pending === 0 && status.abandoned === 0) return null;

  if (status.abandoned > 0) {
    return (
      <a
        href="/admin/sync"
        className="text-2xs px-2 py-1 rounded bg-pomodoro-600 text-white font-medium hover:bg-pomodoro-600/90"
        title={`${status.abandoned} cambios fallaron 20+ veces — requieren tu atención`}
      >
        ⚠ {status.abandoned} sync fallidas
      </a>
    );
  }
  return (
    <span
      className="text-2xs px-2 py-1 rounded bg-saffron-600 text-white font-medium"
      title="Cambios pendientes de sincronizar a cloud — se van a publicar automáticamente cuando vuelva la conexión"
    >
      🔄 {status.pending} sync pendientes
    </span>
  );
}
