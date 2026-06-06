'use client';

import { useEffect, useState } from 'react';

/**
 * Pildorita "EN VIVO · hace Xs" que va arriba a la derecha de cada tab del
 * dashboard. Toca para forzar un refresh. El punto pulsa mientras refresca.
 *
 * Se re-renderiza solo cada 10s para mantener el "hace Xs" fresco aunque no
 * haya un fetch nuevo.
 */
export function RefreshIndicator({
  lastUpdated,
  refreshing,
  onRefresh,
}: {
  lastUpdated: number | null;
  refreshing: boolean;
  onRefresh?: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => (n + 1) % 1000), 10_000);
    return () => clearInterval(t);
  }, []);

  let texto: string;
  if (refreshing) {
    texto = 'actualizando…';
  } else if (lastUpdated == null) {
    texto = '';
  } else {
    const secs = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));
    if (secs < 8) texto = 'recién';
    else if (secs < 60) texto = `hace ${secs}s`;
    else texto = `hace ${Math.round(secs / 60)} min`;
  }

  return (
    <button
      type="button"
      onClick={onRefresh}
      aria-label="Actualizar"
      className="flex items-center gap-1.5 text-2xs text-ink-500 px-2 py-1 rounded-full active:bg-cream-200"
    >
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full ${
          refreshing ? 'bg-saffron-600 animate-pulse' : 'bg-basil-600'
        }`}
      />
      <span className="uppercase tracking-wide font-medium text-basil-600">En vivo</span>
      {texto && <span className="text-ink-300">· {texto}</span>}
    </button>
  );
}
