'use client';

import { useState } from 'react';
import { fmtPesos, fmtNum, fmtFecha } from '@/lib/format';
import { useAutoRefresh } from '@/lib/useAutoRefresh';
import { RefreshIndicator } from './RefreshIndicator';

interface Insumo {
  id: string;
  nombre: string;
  categoria: string;
  unidad: string;
  stock: string;
  minimo: string | null;
  proveedor: string | null;
  precio: string | null;
}
interface Factura {
  id: string;
  numero: string;
  fecha: string;
  total: string;
  pagado: string;
  estado: string;
  proveedor: string;
}
interface Data {
  insumos: Insumo[];
  facturas: Factura[];
  resumen: { por_pagar: string; facturas_pendientes: number; bajo_stock: number };
}

type Sub = 'insumos' | 'gastos';

export function TabInsumos() {
  const [sub, setSub] = useState<Sub>('insumos');
  const { data, error, loading, refreshing, lastUpdated, refetch } = useAutoRefresh<Data>(
    async () => {
      const r = await fetch('/api/insumos');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Data;
    },
    { intervalMs: 60_000 },
  );

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1 bg-cream-200 rounded-md p-0.5">
          {(
            [
              ['insumos', 'Insumos'],
              ['gastos', 'Gastos'],
            ] as Array<[Sub, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSub(id)}
              className={
                sub === id
                  ? 'px-4 py-1.5 rounded text-sm font-semibold bg-white text-teresita-700 shadow-sm'
                  : 'px-4 py-1.5 rounded text-sm text-ink-500'
              }
            >
              {label}
            </button>
          ))}
        </div>
        <RefreshIndicator lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={refetch} />
      </div>

      {error && !data && (
        <div className="bg-pomodoro-100 border-l-4 border-pomodoro-600 p-2 rounded-r text-xs text-pomodoro-600">
          ⚠ {error}
        </div>
      )}
      {loading && !data && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-14 bg-cream-200 animate-pulse rounded" />
          ))}
        </div>
      )}

      {data && sub === 'insumos' && <Insumos data={data} />}
      {data && sub === 'gastos' && <Gastos data={data} />}
    </div>
  );
}

function Insumos({ data }: { data: Data }) {
  if (data.insumos.length === 0) {
    return (
      <p className="text-sm text-ink-500 italic text-center py-8">
        Todavía no hay insumos cargados. Cuando se cargue el stock (o se active la
        lectura automática de facturas), aparece acá.
      </p>
    );
  }
  return (
    <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2">
      {data.insumos.map((i) => {
        const bajo = i.minimo != null && Number(i.stock) <= Number(i.minimo);
        return (
          <div key={i.id} className="bg-white rounded-md border border-cream-300 p-3">
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink-900 truncate">
                  {bajo ? '⚠️ ' : ''}
                  {i.nombre}
                </p>
                <p className="text-2xs text-ink-500 truncate">
                  {i.categoria}
                  {i.proveedor ? ` · ${i.proveedor}` : ''}
                  {i.precio ? ` · ${fmtPesos(i.precio)}` : ''}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p
                  className={`text-sm font-mono ${bajo ? 'text-pomodoro-600' : 'text-ink-900'}`}
                >
                  {fmtNum(Number(i.stock))}
                </p>
                <p className="text-2xs text-ink-500">{i.unidad.toLowerCase()}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Gastos({ data }: { data: Data }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-pomodoro-100 text-pomodoro-600 rounded-lg p-3">
          <p className="text-2xs uppercase tracking-wide opacity-90">Por pagar</p>
          <p className="text-lg font-bold">{fmtPesos(data.resumen.por_pagar)}</p>
          <p className="text-2xs opacity-80">{data.resumen.facturas_pendientes} facturas</p>
        </div>
        <div className="bg-saffron-100 text-saffron-600 rounded-lg p-3">
          <p className="text-2xs uppercase tracking-wide opacity-90">Bajo stock</p>
          <p className="text-lg font-bold">{fmtNum(data.resumen.bajo_stock)}</p>
          <p className="text-2xs opacity-80">insumos</p>
        </div>
      </div>

      {data.facturas.length === 0 ? (
        <p className="text-sm text-ink-500 italic text-center py-8">
          Todavía no hay facturas/gastos cargados.
        </p>
      ) : (
        <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2">
          {data.facturas.map((f) => {
            const pendiente = Number(f.total) - Number(f.pagado);
            return (
              <div key={f.id} className="bg-white rounded-md border border-cream-300 p-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink-900 truncate">{f.proveedor}</p>
                    <p className="text-2xs text-ink-500 truncate">
                      #{f.numero} · {fmtFecha(f.fecha)} · {f.estado.replace(/_/g, ' ').toLowerCase()}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-mono text-ink-900">{fmtPesos(f.total)}</p>
                    {pendiente > 0.5 && (
                      <p className="text-2xs text-pomodoro-600">debe {fmtPesos(pendiente)}</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
