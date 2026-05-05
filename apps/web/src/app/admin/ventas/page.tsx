'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { KpiCard } from '@/components/admin/KpiCard';
import { cn } from '@/lib/cn';

type Periodo = 'hoy' | 'ayer' | 'semana' | 'mes' | 'trimestre' | 'anio' | 'custom';

interface DesgloseEntry {
  monto: string;
  cantidad: number;
}

interface AnalisisVentas {
  rango: { desde: string; hasta: string };
  kpis: {
    totalCobrado: string;
    cantidadVentas: number;
    ticketPromedio: string;
    totalDescuentos: string;
    anuladasCantidad: number;
  };
  cierreCajas: {
    mostrador: {
      total: string;
      efectivo: DesgloseEntry;
      debito: DesgloseEntry;
      creditoOtros: DesgloseEntry;
    };
    delivery: {
      total: string;
      efectivoDamian: DesgloseEntry;
      efectivoDeliverate: DesgloseEntry;
      online: DesgloseEntry;
    };
    plataformas: {
      total: string;
      app: DesgloseEntry;
      efectivo: DesgloseEntry;
    };
    efectivoEnCaja: {
      total: string;
      desgloseVentas: {
        mostrador: string;
        damian: string;
        plataformasEfectivo: string;
        subtotal: string;
      };
      aportes: DesgloseEntry;
      egresos: DesgloseEntry;
    };
  };
  porMetodo: Array<{ metodo: string; monto: string; cantidad: number; pct: number }>;
  porCanal: Array<{ canal: string; monto: string; cantidad: number; pct: number }>;
  porHora: Array<{ hora: number; monto: number; cantidad: number }>;
  porDia: Array<{ fecha: string; monto: number; cantidad: number }>;
  ventas: Array<{
    id: string;
    numero: number;
    numeroOrdenTurno: number;
    canal: string;
    modalidad: string;
    fecha: string | null;
    total: string;
    descuento: string;
    metodos: string[];
  }>;
}

const PERIODOS: Array<{ key: Periodo; label: string }> = [
  { key: 'hoy', label: 'Hoy' },
  { key: 'ayer', label: 'Ayer' },
  { key: 'semana', label: '7 días' },
  { key: 'mes', label: '30 días' },
  { key: 'trimestre', label: '90 días' },
  { key: 'anio', label: '1 año' },
];

const METODOS = [
  { value: '', label: 'Todos los métodos' },
  { value: 'EFECTIVO', label: '💵 Efectivo' },
  { value: 'DEBITO', label: '💳 Débito' },
  { value: 'CREDITO_1_PAGO', label: '💳 Crédito' },
  { value: 'CREDITO_CUOTAS', label: '💳 Crédito en cuotas' },
  { value: 'MERCADOPAGO_QR', label: '📱 MP / QR' },
  { value: 'TRANSFERENCIA', label: '🏦 Transferencia' },
  { value: 'TARJETA_NARANJA', label: '💳 Tarjeta Naranja' },
];

const CANALES = [
  { value: '', label: 'Todos los canales' },
  { value: 'MOSTRADOR', label: '🏪 Mostrador' },
  { value: 'TELEFONO', label: '📞 Teléfono' },
  { value: 'WHATSAPP', label: '💬 WhatsApp' },
  { value: 'PEDIDOS_YA', label: '🛵 Pedidos YA' },
  { value: 'RAPPI', label: '🛵 RAPPI' },
  { value: 'MERCADO_LIBRE', label: '🛵 Mercado Libre' },
  { value: 'DELIVERATE', label: '🛵 DELIVERATE' },
];

const CANAL_LABEL: Record<string, string> = Object.fromEntries(
  CANALES.filter((c) => c.value).map((c) => [c.value, c.label]),
);

const METODO_LABEL: Record<string, string> = Object.fromEntries(
  METODOS.filter((m) => m.value).map((m) => [m.value, m.label]),
);

function isoHoy(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function VentasPage() {
  const [periodo, setPeriodo] = useState<Periodo>('hoy');
  const [customDesde, setCustomDesde] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [customHasta, setCustomHasta] = useState<string>(isoHoy);
  const [metodo, setMetodo] = useState('');
  const [canal, setCanal] = useState('');
  const [data, setData] = useState<AnalisisVentas | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Modal de anulación
  const [anularTarget, setAnularTarget] = useState<AnalisisVentas['ventas'][number] | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ periodo });
      if (periodo === 'custom') {
        params.set('desde', customDesde);
        params.set('hasta', customHasta);
      }
      if (metodo) params.set('metodo', metodo);
      if (canal) params.set('canal', canal);
      const res = await api.get<AnalisisVentas>(`/admin/ventas-analisis?${params.toString()}`);
      setData(res);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar las ventas');
      }
    } finally {
      setLoading(false);
    }
  }, [periodo, customDesde, customHasta, metodo, canal]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (error) return <div className="text-pomodoro-600 p-6">{error}</div>;
  if (!data) return <div className="text-ink-500 p-6">Cargando ventas...</div>;

  const totalCobradoNum = Number(data.kpis.totalCobrado);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="font-display text-xl text-ink-900">Ventas</h1>
        <p className="text-sm text-ink-500">
          {new Date(data.rango.desde).toLocaleDateString('es-AR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          })}
          {' — '}
          {new Date(data.rango.hasta).toLocaleDateString('es-AR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          })}
          {loading && <span className="ml-3 text-2xs text-ink-300">recargando...</span>}
        </p>
      </header>

      {/* Filtros */}
      <section className="card p-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {PERIODOS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriodo(p.key)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
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
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              periodo === 'custom'
                ? 'bg-teresita-700 text-cream-50'
                : 'bg-cream-200 text-ink-700 hover:bg-cream-300',
            )}
          >
            Personalizado
          </button>
        </div>
        {periodo === 'custom' && (
          <div className="flex items-center gap-1">
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
        <div className="flex gap-2 ml-auto">
          <select
            value={metodo}
            onChange={(e) => setMetodo(e.target.value)}
            className="input text-xs py-1 w-auto"
          >
            {METODOS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <select
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
            className="input text-xs py-1 w-auto"
          >
            {CANALES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {(metodo || canal) && (
            <button
              onClick={() => {
                setMetodo('');
                setCanal('');
              }}
              className="text-xs text-teresita-700 hover:underline"
            >
              ✕ limpiar
            </button>
          )}
        </div>
      </section>

      {/* KPIs */}
      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        <KpiCard
          label="Total cobrado"
          value={data.kpis.totalCobrado}
          accent="success"
          hint={`${data.kpis.cantidadVentas} ventas`}
        />
        <KpiCard
          label="Ticket promedio"
          value={data.kpis.ticketPromedio}
          hint={
            data.kpis.cantidadVentas === 0
              ? 'sin ventas'
              : `sobre ${data.kpis.cantidadVentas} ventas`
          }
        />
        <KpiCard
          label="Descuentos aplicados"
          value={data.kpis.totalDescuentos}
          accent="warning"
          hint="suma de descuentos por efectivo"
        />
        <KpiCard
          label="Anulaciones"
          value={String(data.kpis.anuladasCantidad)}
          format="count"
          accent={data.kpis.anuladasCantidad > 0 ? 'danger' : 'default'}
          hint="ventas anuladas en el período"
        />
        <KpiCard
          label="Cobrado / venta"
          value={data.kpis.cantidadVentas > 0 ? data.kpis.totalCobrado : '0'}
          hint={`${data.porCanal.length} canales activos`}
        />
      </section>

      {/* Bloque destacado: cuánto efectivo debería tener en caja */}
      <EfectivoEnCajaBlock data={data.cierreCajas.efectivoEnCaja} />

      {/* Jerarquía: Mostrador / Delivery / Plataformas */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <CategoriaBlock
          titulo="Mostrador"
          icono="🏪"
          total={data.cierreCajas.mostrador.total}
          tone="teresita"
          filas={[
            { label: 'Efectivo', entry: data.cierreCajas.mostrador.efectivo, sumaCaja: true },
            { label: 'Débito', entry: data.cierreCajas.mostrador.debito },
            {
              label: 'Crédito / MP / Transfer',
              entry: data.cierreCajas.mostrador.creditoOtros,
            },
          ]}
        />
        <CategoriaBlock
          titulo="Delivery"
          subtitulo="local + WhatsApp + web"
          icono="🛵"
          total={data.cierreCajas.delivery.total}
          tone="saffron"
          filas={[
            {
              label: 'Efectivo · Damián',
              entry: data.cierreCajas.delivery.efectivoDamian,
              sumaCaja: true,
            },
            {
              label: 'Transfer / Débito online',
              entry: data.cierreCajas.delivery.online,
            },
            {
              label: 'Efectivo · DELIVERATE',
              entry: data.cierreCajas.delivery.efectivoDeliverate,
              informativo: true,
              hint: 'rinde semanal · NO entra a caja del día',
            },
          ]}
        />
        <CategoriaBlock
          titulo="Plataformas"
          subtitulo="RAPPI · Pedidos YA · MELI"
          icono="📱"
          total={data.cierreCajas.plataformas.total}
          tone="ocean"
          filas={[
            { label: 'Cobrado por la app', entry: data.cierreCajas.plataformas.app },
            {
              label: 'Efectivo · cliente al motoquero',
              entry: data.cierreCajas.plataformas.efectivo,
              sumaCaja: true,
            },
          ]}
        />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Por método */}
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Por método de pago</h2>
          {data.porMetodo.length === 0 ? (
            <p className="text-sm text-ink-500">Sin pagos en el período.</p>
          ) : (
            <div className="space-y-2">
              {data.porMetodo.map((m) => (
                <div key={m.metodo}>
                  <div className="flex justify-between text-sm mb-0.5">
                    <span className="text-ink-700">
                      {METODO_LABEL[m.metodo] ?? m.metodo}
                    </span>
                    <span className="font-mono">
                      <MoneyAmount value={m.monto} />
                      <span className="text-2xs text-ink-500 ml-2">{m.pct}%</span>
                    </span>
                  </div>
                  <div className="bg-cream-200 rounded h-2 overflow-hidden">
                    <div
                      className="bg-teresita-500 h-full"
                      style={{ width: `${m.pct}%` }}
                    />
                  </div>
                  <div className="text-2xs text-ink-500 mt-0.5">{m.cantidad} pagos</div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Por canal */}
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Por canal</h2>
          {data.porCanal.length === 0 ? (
            <p className="text-sm text-ink-500">Sin ventas en el período.</p>
          ) : (
            <div className="space-y-2">
              {data.porCanal.map((c) => (
                <div key={c.canal}>
                  <div className="flex justify-between text-sm mb-0.5">
                    <span className="text-ink-700">{CANAL_LABEL[c.canal] ?? c.canal}</span>
                    <span className="font-mono">
                      <MoneyAmount value={c.monto} />
                      <span className="text-2xs text-ink-500 ml-2">{c.pct}%</span>
                    </span>
                  </div>
                  <div className="bg-cream-200 rounded h-2 overflow-hidden">
                    <div
                      className="bg-saffron-600 h-full"
                      style={{ width: `${c.pct}%` }}
                    />
                  </div>
                  <div className="text-2xs text-ink-500 mt-0.5">{c.cantidad} ventas</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Gráfico por hora (rangos cortos) o por día (rangos largos) */}
      {data.porHora.length > 0 && (
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Ventas por hora</h2>
          <BarChart
            data={data.porHora.map((h) => ({
              label: `${String(h.hora).padStart(2, '0')}:00`,
              monto: h.monto,
              cantidad: h.cantidad,
            }))}
          />
        </section>
      )}

      {data.porDia.length > 0 && (
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Ventas por día</h2>
          <BarChart
            data={data.porDia.map((d) => ({
              label: new Date(d.fecha).toLocaleDateString('es-AR', {
                day: '2-digit',
                month: '2-digit',
              }),
              monto: d.monto,
              cantidad: d.cantidad,
            }))}
          />
        </section>
      )}

      {anularTarget && (
        <AnularVentaModal
          venta={anularTarget}
          onClose={() => setAnularTarget(null)}
          onAnulada={() => {
            setAnularTarget(null);
            void fetchData();
          }}
        />
      )}

      {/* Listado de ventas */}
      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken flex items-center justify-between">
          <h2 className="font-display text-md text-ink-900">
            Ventas del período ({data.ventas.length})
          </h2>
          <span className="text-2xs text-ink-500">
            {data.ventas.length === 200 ? 'mostrando últimas 200' : 'todas'}
          </span>
        </header>
        {data.ventas.length === 0 ? (
          <div className="px-4 py-8 text-center text-ink-500 text-sm">
            Sin ventas en el período seleccionado.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-4 py-2">#</th>
                <th className="text-left px-4 py-2">Fecha / hora</th>
                <th className="text-left px-4 py-2">Canal</th>
                <th className="text-left px-4 py-2">Modalidad</th>
                <th className="text-left px-4 py-2">Métodos</th>
                <th className="text-right px-4 py-2">Descuento</th>
                <th className="text-right px-4 py-2">Total</th>
                <th className="px-3 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {data.ventas.map((v) => {
                const fecha = v.fecha ? new Date(v.fecha) : null;
                return (
                  <tr key={v.id} className="hover:bg-cream-100 transition-colors">
                    <td className="px-4 py-2 font-mono text-ink-500 text-xs">{v.numero}</td>
                    <td className="px-4 py-2 font-mono text-xs text-ink-700">
                      {fecha
                        ? `${fecha.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })} ${fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`
                        : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-700">
                      {CANAL_LABEL[v.canal] ?? v.canal}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-500">
                      {v.modalidad.replace(/_/g, ' ').toLowerCase()}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-700">
                      {v.metodos.map((m, i) => (
                        <span key={i} className="mr-1">
                          {METODO_LABEL[m]?.split(' ')[0] ?? m.charAt(0)}
                        </span>
                      ))}
                    </td>
                    <td className="px-4 py-2 text-right text-xs">
                      {Number(v.descuento) > 0 ? (
                        <MoneyAmount
                          value={v.descuento}
                          className="text-saffron-600 font-mono"
                        />
                      ) : (
                        <span className="text-ink-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <MoneyAmount
                        value={v.total}
                        className="font-mono text-md text-teresita-900"
                      />
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Link
                        href={`/venta/${v.id}`}
                        className="text-2xs text-teresita-700 hover:underline mr-2"
                      >
                        ver
                      </Link>
                      <button
                        onClick={() => setAnularTarget(v)}
                        className="text-2xs text-pomodoro-600 hover:underline"
                        title="Anular venta cobrada"
                      >
                        anular
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {totalCobradoNum > 0 && (
              <tfoot className="border-t-2 border-cream-300 bg-surface-sunken">
                <tr>
                  <td colSpan={6} className="px-4 py-3 font-medium text-ink-700">
                    TOTAL · {data.kpis.cantidadVentas} ventas
                  </td>
                  <td className="px-4 py-3 text-right">
                    <MoneyAmount
                      value={data.kpis.totalCobrado}
                      className="font-mono text-md text-teresita-700 font-bold"
                    />
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </section>
    </div>
  );
}

function EfectivoEnCajaBlock({
  data,
}: {
  data: AnalisisVentas['cierreCajas']['efectivoEnCaja'];
}) {
  return (
    <section className="card p-5 border-l-4 border-basil-600 bg-basil-100/40">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-md text-basil-600">
            💵 Efectivo en caja (en este momento)
          </h2>
          <p className="text-xs text-ink-500 mt-0.5">
            Lo que la encargada debería tener en caja física al cierre. Se actualiza con
            cada venta y movimiento.
          </p>
        </div>
        <div className="text-right">
          <MoneyAmount
            value={data.total}
            className="text-lg font-mono font-bold text-basil-600 tabular-nums whitespace-nowrap"
            hero
          />
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
        <DesgloseChip label="Mostrador" value={data.desgloseVentas.mostrador} sign="+" />
        <DesgloseChip label="Damián (delivery)" value={data.desgloseVentas.damian} sign="+" />
        <DesgloseChip
          label="Pedidos YA / apps"
          value={data.desgloseVentas.plataformasEfectivo}
          sign="+"
        />
        <DesgloseChip
          label={`Aportes (${data.aportes.cantidad})`}
          value={data.aportes.monto}
          sign="+"
        />
        <DesgloseChip
          label={`Egresos (${data.egresos.cantidad})`}
          value={data.egresos.monto}
          sign="−"
          tone="danger"
        />
      </div>
    </section>
  );
}

function DesgloseChip({
  label,
  value,
  sign,
  tone = 'success',
}: {
  label: string;
  value: string;
  sign: '+' | '−';
  tone?: 'success' | 'danger';
}) {
  const color = tone === 'danger' ? 'text-pomodoro-600' : 'text-basil-600';
  return (
    <div className="bg-white rounded-md px-3 py-2 border border-cream-300">
      <div className="text-2xs text-ink-500 uppercase tracking-wide truncate">{label}</div>
      <div className={cn('text-sm font-mono font-medium tabular-nums', color)}>
        {sign} <MoneyAmount value={value} />
      </div>
    </div>
  );
}

function CategoriaBlock({
  titulo,
  subtitulo,
  icono,
  total,
  tone,
  filas,
}: {
  titulo: string;
  subtitulo?: string;
  icono: string;
  total: string;
  tone: 'teresita' | 'saffron' | 'ocean';
  filas: Array<{
    label: string;
    entry: DesgloseEntry;
    sumaCaja?: boolean;
    informativo?: boolean;
    hint?: string;
  }>;
}) {
  const borderTone = {
    teresita: 'border-teresita-700',
    saffron: 'border-saffron-600',
    ocean: 'border-ocean-600',
  }[tone];
  const totalNum = Number(total);
  return (
    <section className={cn('card p-4 border-t-4', borderTone)}>
      <header className="mb-3">
        <h3 className="font-display text-md text-ink-900 flex items-baseline gap-2">
          <span>{icono}</span>
          <span>{titulo}</span>
        </h3>
        {subtitulo && <p className="text-2xs text-ink-500">{subtitulo}</p>}
      </header>
      <div className="space-y-1.5">
        {filas.map((f) => {
          const monto = Number(f.entry.monto);
          const pct = totalNum > 0 ? (monto / totalNum) * 100 : 0;
          return (
            <div key={f.label} className={cn(f.informativo && 'opacity-70')}>
              <div className="flex justify-between items-baseline text-sm">
                <span className="text-ink-700 flex items-baseline gap-1">
                  {f.label}
                  {f.sumaCaja && (
                    <span className="text-2xs text-basil-600" title="Suma a caja física">
                      ✓
                    </span>
                  )}
                  {f.informativo && (
                    <span className="text-2xs text-ink-400 italic">(info)</span>
                  )}
                </span>
                <span className="font-mono tabular-nums">
                  <MoneyAmount value={f.entry.monto} />
                </span>
              </div>
              <div className="text-2xs text-ink-500 flex justify-between">
                <span>
                  {f.entry.cantidad} pago{f.entry.cantidad !== 1 ? 's' : ''}
                </span>
                {monto > 0 && <span>{pct.toFixed(0)}% del bloque</span>}
              </div>
              {f.hint && (
                <div className="text-2xs text-ink-400 italic">{f.hint}</div>
              )}
            </div>
          );
        })}
      </div>
      <footer className="mt-3 pt-3 border-t border-cream-300 flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink-700">Total</span>
        <MoneyAmount
          value={total}
          className="text-md font-mono font-semibold text-ink-900 tabular-nums"
        />
      </footer>
    </section>
  );
}

function BarChart({
  data,
}: {
  data: Array<{ label: string; monto: number; cantidad: number }>;
}) {
  const max = Math.max(1, ...data.map((d) => d.monto));
  return (
    <div className="space-y-1">
      {data.map((d, i) => {
        const pct = (d.monto / max) * 100;
        return (
          <div key={`${d.label}-${i}`} className="flex items-center gap-2 text-xs">
            <span className="font-mono w-14 text-ink-500">{d.label}</span>
            <div className="flex-1 bg-cream-200 rounded h-5 overflow-hidden">
              <div
                className="bg-teresita-500 h-full transition-all duration-base"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono w-28 text-right text-ink-700">
              <MoneyAmount value={d.monto.toFixed(2)} />
            </span>
            <span className="font-mono w-10 text-right text-ink-500">{d.cantidad}</span>
          </div>
        );
      })}
    </div>
  );
}

function AnularVentaModal({
  venta,
  onClose,
  onAnulada,
}: {
  venta: AnalisisVentas['ventas'][number];
  onClose: () => void;
  onAnulada: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fecha = venta.fecha ? new Date(venta.fecha) : null;

  async function submit() {
    if (motivo.trim().length < 3) {
      setError('Ingresá un motivo (mínimo 3 caracteres) — queda registrado en el audit log.');
      return;
    }
    setConfirmando(true);
    setError(null);
    try {
      await api.post(`/ventas/${venta.id}/anular`, { motivo: motivo.trim() });
      onAnulada();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo anular la venta.');
    } finally {
      setConfirmando(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-ink-900/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-cream-300 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚠️</span>
            <div>
              <h2 className="font-display text-md text-pomodoro-600">Anular venta cobrada</h2>
              <p className="text-2xs text-ink-500 mt-0.5">
                Acción irreversible · queda en el audit log
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-900 text-xl leading-none">✕</button>
        </header>

        <div className="px-5 py-4 space-y-3">
          <div className="bg-cream-100 rounded-md p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-ink-500">Venta #</span>
              <span className="font-mono text-ink-900">{venta.numero}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-500">Fecha:</span>
              <span className="font-mono text-ink-900">
                {fecha
                  ? `${fecha.toLocaleDateString('es-AR')} ${fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`
                  : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-500">Canal:</span>
              <span className="text-ink-900">{venta.canal.replace(/_/g, ' ')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-500">Total:</span>
              <span className="font-mono text-teresita-700 font-medium">
                <MoneyAmount value={venta.total} />
              </span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Motivo de anulación *
            </label>
            <textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ej. cliente devolvió producto, error de carga, factura duplicada…"
              className="input w-full text-sm py-2"
              rows={3}
              maxLength={500}
              autoFocus
            />
            <p className="text-2xs text-ink-400 mt-1">
              Este texto queda registrado junto con tu usuario y la fecha. Sirve para auditoría
              y cierres de caja.
            </p>
          </div>

          <div className="bg-saffron-100/60 border-l-4 border-saffron-600 px-3 py-2 text-xs text-ink-700">
            ⚠️ La anulación <strong>no devuelve plata automáticamente</strong>. Si ya cobraste,
            registrá manualmente el reintegro como movimiento de caja.
          </div>

          {error && (
            <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-cream-300 flex justify-end gap-2 bg-surface-sunken">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md border border-cream-300 text-ink-700 hover:bg-cream-200 transition-colors"
            disabled={confirmando}
          >
            Cancelar
          </button>
          <button
            onClick={() => void submit()}
            disabled={confirmando || motivo.trim().length < 3}
            className="px-4 py-2 text-sm rounded-md bg-pomodoro-600 text-cream-50 font-medium hover:bg-pomodoro-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {confirmando ? 'Anulando...' : 'Anular venta'}
          </button>
        </footer>
      </div>
    </div>
  );
}
