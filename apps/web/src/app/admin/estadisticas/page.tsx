'use client';

import { useEffect, useState, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { KpiCard } from '@/components/admin/KpiCard';
import { cn } from '@/lib/cn';

type Periodo = 'hoy' | 'semana' | 'mes' | 'trimestre' | 'anio' | 'custom';
type DrillTipo = 'ventas' | 'egresos' | 'resultado' | 'anulaciones' | null;

interface Estadisticas {
  periodo: Periodo;
  desde: string;
  hasta: string;
  kpis: {
    ventasTotal: string;
    ventasCantidad: number;
    ticketPromedio: string;
    variacionVentasPct: number | null;
    anuladasMonto: string;
    anuladasCantidad: number;
    egresosTotal: string;
    resultadoNeto: string;
  };
  ventasPorCanal: Array<{ canal: string; monto: string; cantidad: number; pct: number }>;
  egresosPorCategoria: Array<{
    categoria: string;
    esOperativa: boolean;
    monto: string;
    cantidad: number;
  }>;
  topProductos: Array<{
    productoId: string;
    nombre: string;
    categoria: string;
    cantidad: string;
    monto: string;
    ocurrencias: number;
  }>;
  combosVendidos: Array<{
    comboId: string;
    nombre: string;
    instancias: number;
    monto: string;
    precioCombo: string;
  }>;
  ventasPorDia: Array<{ dia: string; cantidad: number; total: string }>;
  topClientes: Array<{
    clienteId: string | null;
    nombre: string;
    tipo: string | null;
    monto: string;
    cantidad: number;
  }>;
}

const PERIODOS: Array<{ key: Periodo; label: string }> = [
  { key: 'hoy', label: 'Hoy' },
  { key: 'semana', label: '7 días' },
  { key: 'mes', label: '30 días' },
  { key: 'trimestre', label: '90 días' },
  { key: 'anio', label: '1 año' },
];

const CANAL_LABEL: Record<string, string> = {
  MOSTRADOR: 'Mostrador',
  TELEFONO: 'Teléfono',
  WHATSAPP: 'WhatsApp',
  WEB: 'Web',
  RAPPI: 'RAPPI',
  PEDIDOS_YA: 'Pedidos YA',
  MERCADO_LIBRE: 'MELI',
  DELIVERATE: 'DELIVERATE',
};

function isoHoy(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function EstadisticasPage() {
  const [periodo, setPeriodo] = useState<Periodo>('mes');
  const [customDesde, setCustomDesde] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  });
  const [customHasta, setCustomHasta] = useState<string>(isoHoy);
  const [data, setData] = useState<Estadisticas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drillDown, setDrillDown] = useState<DrillTipo>(null);

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({ periodo });
      if (periodo === 'custom') {
        params.set('desde', customDesde);
        params.set('hasta', customHasta);
      }
      const res = await api.get<Estadisticas>(`/admin/estadisticas?${params.toString()}`);
      setData(res);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar las estadísticas');
      }
    }
  }, [periodo, customDesde, customHasta]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (error) return <div className="text-pomodoro-600 p-6">{error}</div>;
  if (!data) return <div className="text-ink-500 p-6">Cargando...</div>;

  const trendVentas = data.kpis.variacionVentasPct;
  const trendObj = trendVentas !== null
    ? {
        pct: trendVentas,
        direction:
          trendVentas > 0
            ? ('up' as const)
            : trendVentas < 0
              ? ('down' as const)
              : ('flat' as const),
      }
    : null;

  const resultadoNum = Number(data.kpis.resultadoNeto);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-xl text-ink-900">Estadísticas</h1>
          <p className="text-sm text-ink-500">
            {new Date(data.desde).toLocaleDateString('es-AR')} —{' '}
            {new Date(data.hasta).toLocaleDateString('es-AR')}
          </p>
        </div>
        <nav className="flex gap-2 items-center flex-wrap">
          {PERIODOS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriodo(p.key)}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                periodo === p.key
                  ? 'bg-teresita-700 text-cream-50'
                  : 'bg-cream-200 text-ink-700 hover:bg-cream-300',
              )}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setPeriodo('custom')}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              periodo === 'custom'
                ? 'bg-teresita-700 text-cream-50'
                : 'bg-cream-200 text-ink-700 hover:bg-cream-300',
            )}
          >
            Personalizado
          </button>
          {periodo === 'custom' && (
            <div className="flex items-center gap-1 ml-2">
              <input
                type="date"
                value={customDesde}
                max={customHasta}
                onChange={(e) => setCustomDesde(e.target.value)}
                className="input text-xs py-1 px-2"
              />
              <span className="text-xs text-ink-500">a</span>
              <input
                type="date"
                value={customHasta}
                min={customDesde}
                max={isoHoy()}
                onChange={(e) => setCustomHasta(e.target.value)}
                className="input text-xs py-1 px-2"
              />
            </div>
          )}
        </nav>
      </header>

      {/* KPIs (clickeables → modal con detalle) */}
      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <button onClick={() => setDrillDown('ventas')} className="text-left">
          <KpiCard
            label="Ventas finalizadas"
            value={data.kpis.ventasTotal}
            trend={trendObj}
            hint={`${data.kpis.ventasCantidad} ventas · ticket promedio ${data.kpis.ticketPromedio} · click para detalle`}
          />
        </button>
        <button onClick={() => setDrillDown('egresos')} className="text-left">
          <KpiCard
            label="Egresos"
            value={data.kpis.egresosTotal}
            accent="danger"
            hint={`${data.egresosPorCategoria.length} categorías · click para detalle`}
          />
        </button>
        <button onClick={() => setDrillDown('resultado')} className="text-left">
          <KpiCard
            label="Resultado neto"
            value={data.kpis.resultadoNeto}
            accent={resultadoNum >= 0 ? 'success' : 'danger'}
            hint="Ventas − Egresos · click para desarmar"
          />
        </button>
        <button onClick={() => setDrillDown('anulaciones')} className="text-left">
          <KpiCard
            label="Anulaciones"
            value={data.kpis.anuladasMonto}
            accent="warning"
            hint={`${data.kpis.anuladasCantidad} ventas anuladas · click para detalle`}
          />
        </button>
      </section>

      {drillDown && (
        <DrillDownModal tipo={drillDown} data={data} onClose={() => setDrillDown(null)} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Ventas por canal */}
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Ventas por canal</h2>
          {data.ventasPorCanal.length === 0 ? (
            <p className="text-sm text-ink-500">Sin ventas en el período.</p>
          ) : (
            <div className="space-y-2">
              {data.ventasPorCanal
                .sort((a, b) => Number(b.monto) - Number(a.monto))
                .map((c) => (
                  <div key={c.canal}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-ink-700">{CANAL_LABEL[c.canal] ?? c.canal}</span>
                      <span className="font-mono">
                        <MoneyAmount value={c.monto} />
                        <span className="text-2xs text-ink-500 ml-2">{c.pct}%</span>
                      </span>
                    </div>
                    <div className="bg-cream-200 rounded h-2 overflow-hidden">
                      <div
                        className="bg-teresita-500 h-full"
                        style={{ width: `${c.pct}%` }}
                      />
                    </div>
                    <div className="text-2xs text-ink-500 mt-0.5">{c.cantidad} ventas</div>
                  </div>
                ))}
            </div>
          )}
        </section>

        {/* Egresos por categoría */}
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Egresos por categoría</h2>
          {data.egresosPorCategoria.length === 0 ? (
            <p className="text-sm text-ink-500">Sin egresos en el período.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-cream-200">
                {data.egresosPorCategoria.map((e) => (
                  <tr key={e.categoria}>
                    <td className="py-2">
                      <span className="text-ink-700">{e.categoria}</span>
                      {!e.esOperativa && (
                        <span className="ml-2 text-2xs text-ink-300">no operativa</span>
                      )}
                    </td>
                    <td className="py-2 text-right text-ink-500 text-xs">{e.cantidad}</td>
                    <td className="py-2 text-right">
                      <MoneyAmount value={e.monto} className="text-pomodoro-600" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* Combos / Promos vendidos (separados de los productos individuales) */}
      {data.combosVendidos.length > 0 && (
        <section className="card p-5 border-l-4 border-saffron-600">
          <h2 className="font-display text-md text-ink-900 mb-3">
            🎁 Promos / combos vendidos en el período
          </h2>
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left py-2">Combo</th>
                <th className="text-right py-2">Cantidad vendida</th>
                <th className="text-right py-2">Precio combo</th>
                <th className="text-right py-2">Total facturado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {data.combosVendidos.map((c) => (
                <tr key={c.comboId}>
                  <td className="py-2 text-ink-900 font-medium">{c.nombre}</td>
                  <td className="py-2 text-right text-ink-700 font-mono">{c.instancias}</td>
                  <td className="py-2 text-right text-ink-500 font-mono">
                    <MoneyAmount value={c.precioCombo} />
                  </td>
                  <td className="py-2 text-right">
                    <MoneyAmount value={c.monto} className="text-saffron-600 font-medium" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Top productos individuales (excluye los vendidos como parte de un combo) */}
      <section className="card p-5">
        <h2 className="font-display text-md text-ink-900 mb-3">
          Top 10 productos individuales del período
        </h2>
        <p className="text-2xs text-ink-500 mb-3 italic">
          Solo productos vendidos sueltos. Los componentes de combos cuentan en la sección de
          arriba.
        </p>
        {data.topProductos.length === 0 ? (
          <p className="text-sm text-ink-500">Sin ventas con productos en el período.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left py-2">Producto</th>
                <th className="text-left py-2">Categoría</th>
                <th className="text-right py-2">Veces vendido</th>
                <th className="text-right py-2">Cantidad total</th>
                <th className="text-right py-2">Total facturado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {data.topProductos.map((p) => (
                <tr key={p.productoId}>
                  <td className="py-2 text-ink-900 font-medium">{p.nombre}</td>
                  <td className="py-2 text-ink-500 text-xs">{p.categoria}</td>
                  <td className="py-2 text-right text-ink-700 font-mono">{p.ocurrencias}</td>
                  <td className="py-2 text-right text-ink-500 font-mono">
                    {Number(p.cantidad).toFixed(0)}
                  </td>
                  <td className="py-2 text-right">
                    <MoneyAmount value={p.monto} className="text-teresita-700" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Top clientes */}
      {data.topClientes.length > 0 && (
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Top 5 clientes del período</h2>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-cream-200">
              {data.topClientes.map((c, i) => (
                <tr key={c.clienteId ?? i}>
                  <td className="py-2 text-ink-700">
                    <span className="text-ink-300 mr-2">{i + 1}.</span>
                    {c.nombre}
                    {c.tipo && (
                      <span className="ml-2 text-2xs text-ink-500 uppercase">{c.tipo}</span>
                    )}
                  </td>
                  <td className="py-2 text-right text-ink-500 text-xs">{c.cantidad} ventas</td>
                  <td className="py-2 text-right">
                    <MoneyAmount value={c.monto} className="text-teresita-700" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Gráfico de ventas por día */}
      {data.ventasPorDia.length > 0 && (
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Ventas por día</h2>
          <VentasPorDiaChart data={data.ventasPorDia} />
        </section>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Drill-down modal
// ────────────────────────────────────────────────────────────────────────

function DrillDownModal({
  tipo,
  data,
  onClose,
}: {
  tipo: Exclude<DrillTipo, null>;
  data: Estadisticas;
  onClose: () => void;
}) {
  const titulo = {
    ventas: '🧾 Ventas finalizadas — desglose',
    egresos: '➖ Egresos — desglose por categoría',
    resultado: '📊 Resultado neto — composición',
    anulaciones: '🚫 Anulaciones',
  }[tipo];

  return (
    <div
      className="fixed inset-0 bg-ink-900/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-cream-50 rounded-lg shadow-modal w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-cream-300 flex items-center justify-between">
          <div>
            <h2 className="font-display text-md text-teresita-700">{titulo}</h2>
            <div className="text-xs text-ink-500 mt-0.5">
              {new Date(data.desde).toLocaleDateString('es-AR')} —{' '}
              {new Date(data.hasta).toLocaleDateString('es-AR')}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-500 hover:text-ink-900 text-xl leading-none"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tipo === 'ventas' && <DrillVentas data={data} />}
          {tipo === 'egresos' && <DrillEgresos data={data} />}
          {tipo === 'resultado' && <DrillResultado data={data} />}
          {tipo === 'anulaciones' && <DrillAnulaciones data={data} />}
        </div>
      </div>
    </div>
  );
}

function DrillVentas({ data }: { data: Estadisticas }) {
  const total = Number(data.kpis.ventasTotal);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="card p-3">
          <div className="text-2xs text-ink-500 uppercase">Total facturado</div>
          <MoneyAmount value={data.kpis.ventasTotal} className="text-md font-mono text-teresita-900" />
        </div>
        <div className="card p-3">
          <div className="text-2xs text-ink-500 uppercase">Cantidad</div>
          <div className="text-md font-mono">{data.kpis.ventasCantidad}</div>
        </div>
        <div className="card p-3">
          <div className="text-2xs text-ink-500 uppercase">Ticket promedio</div>
          <MoneyAmount value={data.kpis.ticketPromedio} className="text-md font-mono" />
        </div>
      </div>
      <h3 className="text-sm font-medium text-ink-700">Por canal</h3>
      <table className="w-full text-sm">
        <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
          <tr>
            <th className="text-left py-2">Canal</th>
            <th className="text-right py-2">N°</th>
            <th className="text-right py-2">Monto</th>
            <th className="text-right py-2 w-16">%</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-cream-200">
          {data.ventasPorCanal
            .slice()
            .sort((a, b) => Number(b.monto) - Number(a.monto))
            .map((c) => (
              <tr key={c.canal}>
                <td className="py-2 text-ink-700">{CANAL_LABEL[c.canal] ?? c.canal}</td>
                <td className="py-2 text-right font-mono text-ink-500">{c.cantidad}</td>
                <td className="py-2 text-right font-mono">
                  <MoneyAmount value={c.monto} />
                </td>
                <td className="py-2 text-right text-2xs text-ink-500 font-mono">{c.pct}%</td>
              </tr>
            ))}
        </tbody>
      </table>
      {total === 0 && (
        <p className="text-sm text-ink-500 text-center py-4">Sin ventas en el período.</p>
      )}
    </div>
  );
}

function DrillEgresos({ data }: { data: Estadisticas }) {
  const total = Number(data.kpis.egresosTotal);
  return (
    <table className="w-full text-sm">
      <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
        <tr>
          <th className="text-left py-2">Categoría</th>
          <th className="text-right py-2">N°</th>
          <th className="text-right py-2">Monto</th>
          <th className="text-right py-2 w-16">%</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-cream-200">
        {data.egresosPorCategoria
          .slice()
          .sort((a, b) => Number(b.monto) - Number(a.monto))
          .map((e) => {
            const pct = total > 0 ? (Number(e.monto) / total) * 100 : 0;
            return (
              <tr key={e.categoria}>
                <td className="py-2 text-ink-700">
                  {e.categoria}
                  {!e.esOperativa && (
                    <span className="ml-2 text-2xs text-ink-300">no operativa</span>
                  )}
                </td>
                <td className="py-2 text-right font-mono text-ink-500">{e.cantidad}</td>
                <td className="py-2 text-right font-mono text-pomodoro-600">
                  <MoneyAmount value={e.monto} />
                </td>
                <td className="py-2 text-right text-2xs text-ink-500 font-mono">
                  {pct.toFixed(0)}%
                </td>
              </tr>
            );
          })}
      </tbody>
    </table>
  );
}

function DrillResultado({ data }: { data: Estadisticas }) {
  const ventas = Number(data.kpis.ventasTotal);
  const egresos = Number(data.kpis.egresosTotal);
  const resultado = Number(data.kpis.resultadoNeto);
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-500">
        El resultado neto del período es la diferencia entre las ventas finalizadas y los
        egresos confirmados.
      </p>
      <div className="bg-surface-sunken rounded-md p-4 space-y-2 font-mono text-sm">
        <div className="flex justify-between">
          <span className="text-ink-700">+ Ventas finalizadas</span>
          <MoneyAmount value={data.kpis.ventasTotal} className="text-basil-600" />
        </div>
        <div className="flex justify-between">
          <span className="text-ink-700">− Egresos</span>
          <MoneyAmount
            value={data.kpis.egresosTotal}
            className="text-pomodoro-600"
          />
        </div>
        <div
          className={cn(
            'flex justify-between border-t border-cream-300 pt-2 font-semibold text-md',
            resultado >= 0 ? 'text-basil-600' : 'text-pomodoro-600',
          )}
        >
          <span>= Resultado neto</span>
          <MoneyAmount value={data.kpis.resultadoNeto} />
        </div>
      </div>
      <div className="text-xs text-ink-500 italic">
        Margen: {ventas > 0 ? ((resultado / ventas) * 100).toFixed(1) : '0'}% de las ventas
        del período.
      </div>
    </div>
  );
}

function DrillAnulaciones({ data }: { data: Estadisticas }) {
  if (data.kpis.anuladasCantidad === 0) {
    return (
      <p className="text-sm text-ink-500 text-center py-4">
        Sin anulaciones en el período. ✨
      </p>
    );
  }
  const totalVentasYAnuladas =
    Number(data.kpis.ventasTotal) + Number(data.kpis.anuladasMonto);
  const pct =
    totalVentasYAnuladas > 0
      ? (Number(data.kpis.anuladasMonto) / totalVentasYAnuladas) * 100
      : 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="card p-3">
          <div className="text-2xs text-ink-500 uppercase">Cantidad</div>
          <div className="text-md font-mono">{data.kpis.anuladasCantidad}</div>
        </div>
        <div className="card p-3">
          <div className="text-2xs text-ink-500 uppercase">Monto anulado</div>
          <MoneyAmount
            value={data.kpis.anuladasMonto}
            className="text-md font-mono text-pomodoro-600"
          />
        </div>
      </div>
      <div className="text-xs text-ink-500">
        Las anulaciones representan{' '}
        <span className="font-medium text-pomodoro-600">{pct.toFixed(1)}%</span> del total de
        ventas del período (finalizadas + anuladas).
      </div>
      <div className="text-2xs text-ink-300 italic">
        Para ver el detalle de cada venta anulada, ir a la pantalla de historial de la sesión
        correspondiente.
      </div>
    </div>
  );
}

function VentasPorDiaChart({
  data,
}: {
  data: Array<{ dia: string; cantidad: number; total: string }>;
}) {
  const max = Math.max(1, ...data.map((d) => Number(d.total)));
  return (
    <div className="space-y-1">
      {data.map((d) => {
        const totalNum = Number(d.total);
        const pct = (totalNum / max) * 100;
        return (
          <div key={d.dia} className="flex items-center gap-2 text-xs">
            <span className="font-mono w-20 text-ink-500">
              {new Date(d.dia).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}
            </span>
            <div className="flex-1 bg-cream-200 rounded h-5 overflow-hidden">
              <div
                className="bg-teresita-500 h-full transition-all duration-base"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono w-28 text-right text-ink-700">
              <MoneyAmount value={d.total} />
            </span>
            <span className="font-mono w-12 text-right text-ink-500">{d.cantidad}</span>
          </div>
        );
      })}
    </div>
  );
}
