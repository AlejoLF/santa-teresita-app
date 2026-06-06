'use client';

import { fmtPesos, fmtNum, fmtFecha } from '@/lib/format';
import { useAutoRefresh } from '@/lib/useAutoRefresh';
import { RefreshIndicator } from './RefreshIndicator';

interface Mayorista {
  id: string;
  nombre: string;
  contacto: string | null;
  telefono: string | null;
  cuenta_corriente: string;
  remitos_pendientes: number;
  ultimo_remito: string | null;
}

export function TabMayoristas() {
  const { data, error, loading, refreshing, lastUpdated, refetch } = useAutoRefresh<{
    mayoristas: Mayorista[];
  }>(async () => {
    const r = await fetch('/api/mayoristas');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as { mayoristas: Mayorista[] };
  });

  if (error && !data) {
    return (
      <div className="p-4">
        <div className="bg-pomodoro-100 border-l-4 border-pomodoro-600 p-2 rounded-r text-xs text-pomodoro-600">
          ⚠ {error}
        </div>
      </div>
    );
  }
  if (loading || !data) {
    return (
      <div className="p-4 space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 bg-cream-200 animate-pulse rounded" />
        ))}
      </div>
    );
  }

  const totalCC = data.mayoristas.reduce((s, m) => s + Number(m.cuenta_corriente), 0);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-md text-ink-900">Mayoristas</h2>
        <RefreshIndicator lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={refetch} />
      </div>

      {data.mayoristas.length === 0 ? (
        <p className="text-sm text-ink-500 italic text-center py-8">
          Todavía no hay clientes mayoristas cargados.
        </p>
      ) : (
        <>
          {totalCC > 0 && (
            <div className="bg-saffron-100 text-saffron-600 rounded-lg p-3">
              <p className="text-2xs uppercase tracking-wide opacity-90">Total en cuenta corriente</p>
              <p className="text-xl font-bold">{fmtPesos(totalCC)}</p>
              <p className="text-2xs opacity-80">entregado y pendiente de cobro</p>
            </div>
          )}
          <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2">
            {data.mayoristas.map((m) => (
              <div key={m.id} className="bg-white rounded-md border border-cream-300 p-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink-900 truncate">{m.nombre}</p>
                    <p className="text-2xs text-ink-500 truncate">
                      {m.contacto ?? m.telefono ?? '—'}
                      {m.ultimo_remito ? ` · último ${fmtFecha(m.ultimo_remito)}` : ''}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p
                      className={`text-md font-semibold ${
                        Number(m.cuenta_corriente) > 0 ? 'text-saffron-600' : 'text-ink-500'
                      }`}
                    >
                      {fmtPesos(m.cuenta_corriente)}
                    </p>
                    {m.remitos_pendientes > 0 && (
                      <p className="text-2xs text-ink-500">
                        {fmtNum(m.remitos_pendientes)} remito{m.remitos_pendientes === 1 ? '' : 's'}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
