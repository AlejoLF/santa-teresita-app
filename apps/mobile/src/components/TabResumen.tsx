'use client';

import { useEffect, useState } from 'react';
import { fmtPesos, fmtNum, fmtFechaHora } from '@/lib/format';

interface ResumenData {
  hoy: { cantidad: string; monto: string; ticket: string };
  semana: { cantidad: string; monto: string; ticket: string };
  mes: { cantidad: string; monto: string; ticket: string };
  ultimas: Array<{
    id: string;
    numero: number;
    total: string;
    canal: string;
    fecha: string;
    cliente: string | null;
  }>;
}

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

export function TabResumen() {
  const [data, setData] = useState<ResumenData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/resumen');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as ResumenData;
        if (!cancelled) setData(j);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error de red');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Banner mensaje={error} />;
  if (!data) return <Skeleton />;

  return (
    <div className="p-4 space-y-3">
      <KpiCard titulo="Hoy" data={data.hoy} color="teresita" />
      <KpiCard titulo="Últimos 7 días" data={data.semana} color="basil" />
      <KpiCard titulo="Últimos 30 días" data={data.mes} color="ink" />

      <div>
        <h2 className="font-display text-md text-ink-900 mt-4 mb-2 px-1">Últimas ventas</h2>
        <div className="space-y-2">
          {data.ultimas.length === 0 && (
            <p className="text-sm text-ink-500 italic text-center py-4">
              Aún no hay ventas en la cloud DB. Una vez que el sync agent esté
              corriendo, las ventas de la encargada aparecen acá en tiempo real.
            </p>
          )}
          {data.ultimas.map((v) => (
            <div
              key={v.id}
              className="bg-white rounded-md border border-cream-300 p-3 flex justify-between"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink-900 truncate">
                  #{v.numero} · {v.cliente}
                </p>
                <p className="text-2xs text-ink-500">
                  {CANAL_LABEL[v.canal] ?? v.canal} · {fmtFechaHora(v.fecha)}
                </p>
              </div>
              <p className="text-md font-semibold text-teresita-700 whitespace-nowrap">
                {fmtPesos(v.total)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  titulo,
  data,
  color,
}: {
  titulo: string;
  data: { cantidad: string; monto: string; ticket: string };
  color: 'teresita' | 'basil' | 'ink';
}) {
  const colorClass =
    color === 'teresita'
      ? 'bg-teresita-700 text-cream-50'
      : color === 'basil'
        ? 'bg-basil-100 text-basil-600'
        : 'bg-cream-200 text-ink-700';
  return (
    <div className={`${colorClass} rounded-lg p-4`}>
      <p className="text-xs uppercase tracking-wide opacity-90">{titulo}</p>
      <p className="text-2xl font-bold">{fmtPesos(data.monto)}</p>
      <p className="text-xs opacity-80 mt-0.5">
        {fmtNum(Number(data.cantidad))} ventas · ticket promedio {fmtPesos(data.ticket)}
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="p-4 space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-cream-200 animate-pulse rounded-lg h-24" />
      ))}
    </div>
  );
}

function Banner({ mensaje }: { mensaje: string }) {
  return (
    <div className="m-4 bg-pomodoro-100 border-l-4 border-pomodoro-600 p-3 rounded-r-md">
      <p className="text-sm text-pomodoro-600">⚠ {mensaje}</p>
    </div>
  );
}
