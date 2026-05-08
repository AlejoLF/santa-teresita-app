'use client';

import { useEffect, useState } from 'react';
import { fmtPesos, fmtNum } from '@/lib/format';

interface Producto {
  id: string;
  codigo: string | null;
  nombre: string;
  categoria: string;
  tipo: string;
  precio: string;
  forma_venta: string;
  sabores_count: number;
}

const FORMA_LABEL: Record<string, string> = {
  UNIDAD: 'unidad',
  GRAMO: '100g',
  PLANCHA: 'plancha',
  PORCION: 'porción',
};

export function TabProductos() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<Producto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    (async () => {
      setData(null);
      try {
        const r = await fetch(`/api/productos?${params}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { productos: Producto[] };
        if (!cancelled) setData(j.productos);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error de red');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [q]);

  // Agrupar por categoría
  const grupos = (data ?? []).reduce<Record<string, Producto[]>>((acc, p) => {
    if (!acc[p.categoria]) acc[p.categoria] = [];
    acc[p.categoria]!.push(p);
    return acc;
  }, {});

  return (
    <div className="p-4">
      <input
        type="search"
        placeholder="Buscar producto..."
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
            <div key={i} className="h-12 bg-cream-200 animate-pulse rounded" />
          ))}
        </div>
      )}

      {data && data.length === 0 && (
        <p className="text-sm text-ink-500 italic text-center py-8">
          No hay productos.
        </p>
      )}

      <div className="space-y-4">
        {Object.entries(grupos).map(([cat, prods]) => (
          <div key={cat}>
            <h2 className="font-display text-sm text-ink-700 mb-2 px-1">
              {cat}{' '}
              <span className="text-2xs text-ink-500 font-normal">({prods.length})</span>
            </h2>
            <div className="space-y-1">
              {prods.map((p) => (
                <div
                  key={p.id}
                  className="bg-white rounded-md border border-cream-300 p-3 flex justify-between items-center"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink-900 truncate">
                      {p.codigo && <span className="text-2xs text-ink-500 mr-1">[{p.codigo}]</span>}
                      {p.nombre}
                    </p>
                    <p className="text-2xs text-ink-500">
                      {p.tipo}
                      {p.sabores_count > 0 && ` · ${fmtNum(p.sabores_count)} sabores`}
                    </p>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <p className="text-sm font-semibold text-teresita-700">
                      {fmtPesos(p.precio)}
                    </p>
                    <p className="text-2xs text-ink-500">
                      / {FORMA_LABEL[p.forma_venta] ?? p.forma_venta.toLowerCase()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
