'use client';

import { fmtPesos, fmtNum } from '@/lib/format';
import { useAutoRefresh } from '@/lib/useAutoRefresh';
import { RefreshIndicator } from './RefreshIndicator';

const CANAL_LABEL: Record<string, string> = {
  MOSTRADOR: 'Mostrador',
  TELEFONO: 'Teléfono',
  WHATSAPP: 'WhatsApp',
  WEB: 'Web',
  RAPPI: 'RAPPI',
  PEDIDOS_YA: 'Pedidos YA',
  MERCADO_LIBRE: 'Mercado Libre',
  DELIVERATE: 'DELIVERATE',
};

interface Data {
  topProductos: Array<{ nombre: string; cantidad: string; monto: string }>;
  porCanal: Array<{ canal: string; cantidad: number; monto: string }>;
  topClientes: Array<{ nombre: string; cantidad: number; monto: string }>;
  tendencia: Array<{ fecha: string; total: string; cantidad: number }>;
}

export function TabAnalytics() {
  const { data, error, loading, refreshing, lastUpdated, refetch } = useAutoRefresh<Data>(
    async () => {
      const r = await fetch('/api/analytics');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Data;
    },
    // Analytics es más pesado (30 días agregados) → refrescamos más espaciado.
    { intervalMs: 60_000 },
  );

  if (error && !data) {
    return (
      <div className="m-4 bg-pomodoro-100 border-l-4 border-pomodoro-600 p-3 rounded-r text-xs text-pomodoro-600">
        ⚠ {error}
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="p-4 space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-32 bg-cream-200 animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  // Min/max para escalar las barritas de tendencia
  const valores = data.tendencia.map((t) => Number(t.total));
  const max = Math.max(1, ...valores);

  return (
    <div className="p-4 space-y-4 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-4 lg:items-start">
      <div className="flex justify-end -mt-1 -mb-2 lg:col-span-2 lg:mb-0">
        <RefreshIndicator lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={refetch} />
      </div>
      <div className="bg-white rounded-lg border border-cream-300 p-3 lg:col-span-2">
        <h2 className="font-display text-sm text-ink-700 mb-2">
          Tendencia últimos 14 días
        </h2>
        <div className="flex items-end gap-1 h-24">
          {data.tendencia.map((t) => {
            const v = Number(t.total);
            const h = max > 0 ? (v / max) * 100 : 0;
            return (
              <div
                key={t.fecha}
                className="flex-1 flex flex-col items-center justify-end"
                title={`${t.fecha}: ${fmtPesos(t.total)} (${t.cantidad} ventas)`}
              >
                <div
                  className="w-full bg-teresita-500 rounded-t"
                  style={{ height: `${h}%`, minHeight: v > 0 ? 2 : 0 }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex justify-between text-2xs text-ink-500 mt-1">
          <span>{data.tendencia[0]?.fecha.slice(5)}</span>
          <span>{data.tendencia[data.tendencia.length - 1]?.fecha.slice(5)}</span>
        </div>
      </div>

      <Card titulo="Top 10 productos (30 días)">
        {data.topProductos.length === 0 ? (
          <Vacio />
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {data.topProductos.map((p, i) => (
                <tr key={i} className="border-b border-cream-200 last:border-0">
                  <td className="py-1.5 pr-2 font-medium truncate">{p.nombre}</td>
                  <td className="py-1.5 text-right text-ink-500 text-xs">
                    {fmtNum(Number(p.cantidad))}
                  </td>
                  <td className="py-1.5 text-right font-semibold text-teresita-700 whitespace-nowrap">
                    {fmtPesos(p.monto)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card titulo="Ventas por canal (30 días)">
        {data.porCanal.length === 0 ? (
          <Vacio />
        ) : (
          <div className="space-y-2">
            {data.porCanal.map((c) => (
              <div key={c.canal} className="flex justify-between text-sm">
                <span className="font-medium">{CANAL_LABEL[c.canal] ?? c.canal}</span>
                <div className="text-right">
                  <span className="font-semibold text-teresita-700">{fmtPesos(c.monto)}</span>
                  <span className="text-2xs text-ink-500 ml-2">{fmtNum(c.cantidad)} ventas</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card titulo="Top 10 clientes (30 días)">
        {data.topClientes.length === 0 ? (
          <Vacio />
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {data.topClientes.map((c, i) => (
                <tr key={i} className="border-b border-cream-200 last:border-0">
                  <td className="py-1.5 pr-2 font-medium truncate">{c.nombre}</td>
                  <td className="py-1.5 text-right text-ink-500 text-xs">{fmtNum(c.cantidad)}</td>
                  <td className="py-1.5 text-right font-semibold text-teresita-700 whitespace-nowrap">
                    {fmtPesos(c.monto)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Card({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-cream-300 p-3">
      <h2 className="font-display text-sm text-ink-700 mb-2">{titulo}</h2>
      {children}
    </div>
  );
}

function Vacio() {
  return <p className="text-xs text-ink-500 italic text-center py-3">Sin datos en el período.</p>;
}
