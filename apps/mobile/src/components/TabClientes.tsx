'use client';

import { useState } from 'react';
import { fmtPesos, fmtNum, fmtFecha } from '@/lib/format';
import { useAutoRefresh } from '@/lib/useAutoRefresh';
import { RefreshIndicator } from './RefreshIndicator';

interface Cliente {
  id: string;
  nombre: string;
  apellido: string | null;
  telefono: string | null;
  tipo: string;
  compras: number;
  total: string;
  ultima: string | null;
}

export function TabClientes() {
  const [q, setQ] = useState('');
  const { data, error, loading, refreshing, lastUpdated, refetch } = useAutoRefresh<{
    clientes: Cliente[];
  }>(
    async () => {
      const url = q.trim() ? `/api/clientes?q=${encodeURIComponent(q.trim())}` : '/api/clientes';
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { clientes: Cliente[] };
    },
    { deps: [q], intervalMs: 40_000 },
  );

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <input
          type="search"
          placeholder="Buscar por nombre o teléfono…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="flex-1 px-3 py-2 rounded-md border border-cream-300 bg-white text-sm"
        />
        <RefreshIndicator lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={refetch} />
      </div>

      {error && !data && (
        <div className="bg-pomodoro-100 border-l-4 border-pomodoro-600 p-2 rounded-r text-xs text-pomodoro-600">
          ⚠ {error}
        </div>
      )}
      {loading && !data && (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 bg-cream-200 animate-pulse rounded" />
          ))}
        </div>
      )}
      {data && data.clientes.length === 0 && (
        <p className="text-sm text-ink-500 italic text-center py-8">Sin clientes.</p>
      )}

      <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2">
        {data?.clientes.map((c) => (
          <div key={c.id} className="bg-white rounded-md border border-cream-300 p-3">
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink-900 truncate">
                  {c.nombre}
                  {c.apellido ? ` ${c.apellido}` : ''}
                </p>
                <p className="text-2xs text-ink-500 truncate">
                  {c.telefono ?? 'sin teléfono'}
                  {c.tipo === 'MAYORISTA' ? ' · Mayorista' : ''}
                  {c.ultima ? ` · última ${fmtFecha(c.ultima)}` : ''}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-md font-semibold text-teresita-700">{fmtPesos(c.total)}</p>
                <p className="text-2xs text-ink-500">
                  {fmtNum(c.compras)} compra{c.compras === 1 ? '' : 's'}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
