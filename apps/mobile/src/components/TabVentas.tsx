'use client';

import { useEffect, useState } from 'react';
import { fmtPesos, fmtFechaHora } from '@/lib/format';

type Periodo = 'hoy' | 'semana' | 'mes';
const CANAL_LABEL: Record<string, string> = {
  MOSTRADOR: 'Mostrador',
  TELEFONO: 'Tel',
  WHATSAPP: 'WSP',
  WEB: 'Web',
  RAPPI: 'RAPPI',
  PEDIDOS_YA: 'PYA',
  MERCADO_LIBRE: 'MELI',
  DELIVERATE: 'DELIVERATE',
};

interface Venta {
  id: string;
  numero: number;
  total: string;
  canal: string;
  modalidad: string;
  fecha: string;
  cliente: string;
  items_count: number;
}

export function TabVentas() {
  const [periodo, setPeriodo] = useState<Periodo>('hoy');
  const [q, setQ] = useState('');
  const [data, setData] = useState<Venta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ periodo });
    if (q.trim()) params.set('q', q.trim());
    (async () => {
      setData(null);
      try {
        const r = await fetch(`/api/ventas?${params}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { ventas: Venta[] };
        if (!cancelled) setData(j.ventas);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error de red');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [periodo, q]);

  return (
    <div className="p-4">
      <div className="flex gap-1 mb-3 bg-cream-200 rounded-md p-0.5">
        {(['hoy', 'semana', 'mes'] as Periodo[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriodo(p)}
            className={
              periodo === p
                ? 'flex-1 py-2 rounded text-sm font-semibold bg-white text-teresita-700 shadow-sm'
                : 'flex-1 py-2 rounded text-sm text-ink-500'
            }
          >
            {p === 'hoy' ? 'Hoy' : p === 'semana' ? '7 días' : '30 días'}
          </button>
        ))}
      </div>

      <input
        type="search"
        placeholder="Buscar por cliente o teléfono..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="w-full px-3 py-2 rounded-md border border-cream-300 bg-white text-sm mb-3"
      />

      {error && (
        <div className="bg-pomodoro-100 border-l-4 border-pomodoro-600 p-2 mb-3 rounded-r text-xs text-pomodoro-600">
          ⚠ {error}
        </div>
      )}

      {!data && !error && (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 bg-cream-200 animate-pulse rounded" />
          ))}
        </div>
      )}

      {data && data.length === 0 && (
        <p className="text-sm text-ink-500 italic text-center py-8">
          No hay ventas en este filtro.
        </p>
      )}

      <div className="space-y-2">
        {data?.map((v) => (
          <div
            key={v.id}
            className="bg-white rounded-md border border-cream-300 p-3"
          >
            <div className="flex justify-between items-start">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink-900 truncate">
                  #{v.numero} · {v.cliente}
                </p>
                <p className="text-2xs text-ink-500">
                  {CANAL_LABEL[v.canal] ?? v.canal} · {fmtFechaHora(v.fecha)} · {v.items_count} items
                </p>
              </div>
              <p className="text-md font-semibold text-teresita-700 whitespace-nowrap">
                {fmtPesos(v.total)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
