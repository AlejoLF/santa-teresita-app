'use client';

import { useEffect, useState } from 'react';
import { fmtPesos } from '@/lib/format';

interface Pin {
  id: string;
  numero: number;
  total: string;
  estado: string;
  estado_delivery: string | null;
  cliente: string;
  telefono: string | null;
  direccion: string;
  lat: number | null;
  lng: number | null;
  demora_min: number | null;
}

const COLOR_ESTADO: Record<string, string> = {
  PENDIENTE: 'bg-saffron-600 text-cream-50',
  EN_RUTA: 'bg-teresita-700 text-cream-50',
  ENTREGADO: 'bg-basil-600 text-cream-50',
  NO_ENTREGADO: 'bg-pomodoro-600 text-cream-50',
  DEVUELTO: 'bg-ink-500 text-cream-50',
};

/**
 * En mobile, en vez de cargar MapLibre con el bundle entero, mostramos la
 * lista de pedidos del día con botones nativos:
 *   - "Llamar" → abre app de teléfono (tel:)
 *   - "Cómo llegar" → abre Apple Maps (maps:) o Google Maps fallback
 *
 * Es más liviano, más útil en mobile (no querés un mapa minúsculo en pantalla
 * de 6") y aprovecha apps nativas que ya hacen lo que necesitan.
 */
export function TabMapa() {
  const [pines, setPines] = useState<Pin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/mapa');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { pines: Pin[] };
        if (!cancelled) setPines(j.pines);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error de red');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="m-4 bg-pomodoro-100 border-l-4 border-pomodoro-600 p-3 rounded-r text-xs text-pomodoro-600">
        ⚠ {error}
      </div>
    );
  }

  if (!pines) {
    return (
      <div className="p-4 space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 bg-cream-200 animate-pulse rounded" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-md text-ink-900">Deliveries de hoy</h2>
        <span className="text-2xs text-ink-500">
          {pines.length} pedido{pines.length === 1 ? '' : 's'}
        </span>
      </div>

      {pines.length === 0 && (
        <p className="text-sm text-ink-500 italic text-center py-8">
          No hay deliveries cargados hoy.
        </p>
      )}

      <div className="space-y-2">
        {pines.map((p) => (
          <div
            key={p.id}
            className="bg-white rounded-md border border-cream-300 p-3"
          >
            <div className="flex justify-between items-start mb-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink-900 truncate">
                  #{p.numero} · {p.cliente}
                </p>
                <p className="text-2xs text-ink-500 truncate">{p.direccion || 'Sin dirección'}</p>
              </div>
              <span
                className={`px-2 py-0.5 rounded text-2xs font-medium whitespace-nowrap ${
                  COLOR_ESTADO[p.estado_delivery ?? p.estado] ?? 'bg-cream-200 text-ink-700'
                }`}
              >
                {p.estado_delivery ?? p.estado}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <p className="text-md font-semibold text-teresita-700">{fmtPesos(p.total)}</p>
              <div className="flex gap-2">
                {p.telefono && (
                  <a
                    href={`tel:${p.telefono}`}
                    className="text-xs px-3 py-1 rounded bg-cream-200 text-ink-700"
                  >
                    📞 Llamar
                  </a>
                )}
                {(p.lat && p.lng) || p.direccion ? (
                  <a
                    href={
                      p.lat && p.lng
                        ? `maps:?q=${p.lat},${p.lng}`
                        : `maps:?q=${encodeURIComponent(p.direccion)}`
                    }
                    className="text-xs px-3 py-1 rounded bg-teresita-700 text-cream-50"
                  >
                    🗺️ Ir
                  </a>
                ) : null}
              </div>
            </div>
            {p.demora_min != null && (
              <p className="text-2xs text-ink-500 mt-1">Demora: {p.demora_min} min</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
