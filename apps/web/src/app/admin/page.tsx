'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { KpiCard } from '@/components/admin/KpiCard';
import { cn } from '@/lib/cn';

interface DesgloseEntry {
  monto: string;
  cantidad: number;
}

interface Dashboard {
  kpis: {
    ventasHoy: {
      monto: string;
      cantidad: number;
      variacionPct: number | null;
      porCanal: Array<{ canal: string; monto: string; cantidad: number }>;
    };
    cobradoEfectivo: {
      monto: string;
      cantidad: number;
      desglose: {
        mostrador: DesgloseEntry;
        damian: DesgloseEntry;
        plataformas: DesgloseEntry;
        deliverateInformativo: DesgloseEntry;
      };
    };
    cobradoTarjeta: {
      monto: string;
      cantidad: number;
      desglose: {
        debito: DesgloseEntry;
        credito: DesgloseEntry;
        mpQr: DesgloseEntry;
        transferencia: DesgloseEntry;
        otro: DesgloseEntry;
      };
    };
    aportesHoy: {
      monto: string;
      cantidad: number;
      porCategoria: Array<{ categoria: string; monto: string; cantidad: number }>;
    };
    egresosHoy: {
      monto: string;
      cantidad: number;
      porCategoria: Array<{ categoria: string; monto: string; cantidad: number }>;
    };
    pedidosAbiertos: number;
  };
  proximosDepositos: Array<{
    fuente: string;
    cuentaDestino: string | null;
    fecha: string;
    monto: string;
    operaciones: number;
  }>;
  pendientes: {
    facturasSinValidar: number;
    facturasVencenPronto: number;
    cambiosExcelPendientes: number;
    sesionesSinAprobar: number;
  };
  saldosCuentas: Array<{ id: string; nombre: string; tipo: string; saldoActual: string }>;
}

type DrillDownTipo = 'ventas' | 'efectivo' | 'tarjeta' | 'aportes' | 'egresos' | null;

interface VentasPorHora {
  horas: Array<{ hora: number; cantidad: number; total: number }>;
}

export default function AdminDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [grafico, setGrafico] = useState<VentasPorHora | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drillDown, setDrillDown] = useState<DrillDownTipo>(null);

  useEffect(() => {
    (async () => {
      try {
        const [d, g] = await Promise.all([
          api.get<Dashboard>('/admin/dashboard'),
          api.get<VentasPorHora>('/admin/ventas-por-hora'),
        ]);
        setData(d);
        setGrafico(g);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) {
          setError('No se pudo cargar el dashboard');
        }
      }
    })();
  }, []);

  if (error) return <div className="text-pomodoro-600">{error}</div>;
  if (!data) return <div className="text-ink-500">Cargando dashboard...</div>;

  const v = data.kpis.ventasHoy;
  const trend =
    v.variacionPct !== null
      ? {
          pct: v.variacionPct,
          direction:
            v.variacionPct > 0 ? ('up' as const) : v.variacionPct < 0 ? ('down' as const) : ('flat' as const),
        }
      : null;

  const totalPendientes =
    data.pendientes.facturasSinValidar +
    data.pendientes.cambiosExcelPendientes +
    data.pendientes.sesionesSinAprobar +
    data.pendientes.facturasVencenPronto;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-xl text-ink-900">Inicio</h1>
        <span className="text-sm text-ink-500">
          {new Date().toLocaleDateString('es-AR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}
        </span>
      </header>

      {/* KPIs */}
      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
        <button onClick={() => setDrillDown('ventas')} className="text-left">
          <KpiCard
            label="Ventas hoy"
            value={v.monto}
            trend={trend}
            hint={`${v.cantidad} ventas · click para desglose`}
          />
        </button>
        <button onClick={() => setDrillDown('efectivo')} className="text-left">
          <KpiCard
            label="Cobrado en efectivo"
            value={data.kpis.cobradoEfectivo.monto}
            hint={`${data.kpis.cobradoEfectivo.cantidad} pagos · mostrador + Damián`}
            accent="success"
          />
        </button>
        <button onClick={() => setDrillDown('tarjeta')} className="text-left">
          <KpiCard
            label="Cobrado con tarjeta"
            value={data.kpis.cobradoTarjeta.monto}
            hint={`${data.kpis.cobradoTarjeta.cantidad} pagos · débito + crédito + transfer`}
          />
        </button>
        <button onClick={() => setDrillDown('aportes')} className="text-left">
          <KpiCard
            label="Aportes"
            value={data.kpis.aportesHoy.monto}
            hint={`${data.kpis.aportesHoy.cantidad} ingresos cargados`}
            accent="success"
          />
        </button>
        <button onClick={() => setDrillDown('egresos')} className="text-left">
          <KpiCard
            label="Egresos hoy"
            value={data.kpis.egresosHoy.monto}
            hint={`${data.kpis.egresosHoy.cantidad} movimientos`}
            accent="danger"
          />
        </button>
      </section>

      {/* Drill-down modal */}
      {drillDown && (
        <DrillDownModal
          tipo={drillDown}
          data={data}
          onClose={() => setDrillDown(null)}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pendientes */}
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">
            Pendientes
            {totalPendientes > 0 && (
              <span className="ml-2 bg-pomodoro-600 text-white text-2xs font-mono rounded-full px-2 py-0.5">
                {totalPendientes}
              </span>
            )}
          </h2>
          {totalPendientes === 0 ? (
            <p className="text-sm text-ink-500">Sin acciones pendientes ✨</p>
          ) : (
            <ul className="divide-y divide-cream-200">
              <PendienteRow
                show={data.pendientes.cambiosExcelPendientes > 0}
                label={`${data.pendientes.cambiosExcelPendientes} cambios en Excel sin aprobar`}
                icon="📊"
                href="/admin/precios"
                accent="warning"
              />
              <PendienteRow
                show={data.pendientes.facturasSinValidar > 0}
                label={`${data.pendientes.facturasSinValidar} facturas cargadas por OCR sin validar`}
                icon="🧾"
                href="/admin/insumos"
                accent="warning"
              />
              <PendienteRow
                show={data.pendientes.sesionesSinAprobar > 0}
                label={`${data.pendientes.sesionesSinAprobar} sesiones de caja sin aprobar`}
                icon="💵"
                href="/admin/cierres"
                accent="warning"
              />
              <PendienteRow
                show={data.pendientes.facturasVencenPronto > 0}
                label={`${data.pendientes.facturasVencenPronto} facturas vencen en próximos 20 días`}
                icon="⏰"
                href="/admin/insumos"
                accent="danger"
              />
              <PendienteRow
                show={data.kpis.pedidosAbiertos > 0}
                label={`${data.kpis.pedidosAbiertos} pedidos abiertos en el cajero`}
                icon="📋"
                href="/cargar-pedido"
                accent="default"
              />
            </ul>
          )}
        </section>

        {/* Saldos cuentas */}
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Saldos de cuentas</h2>
          <ul className="divide-y divide-cream-200">
            {data.saldosCuentas.map((c) => (
              <li key={c.id} className="py-2 flex justify-between items-baseline">
                <span className="text-sm text-ink-700">
                  <span className="text-ink-300 mr-2">
                    {c.tipo === 'EFECTIVO' ? '💵' : c.tipo === 'BANCO' ? '🏦' : '📱'}
                  </span>
                  {c.nombre}
                </span>
                <MoneyAmount value={c.saldoActual} className="text-md" />
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Próximos depósitos */}
      <section className="card p-5">
        <h2 className="font-display text-md text-ink-900 mb-3">
          Próximos depósitos · 20 días
        </h2>
        {data.proximosDepositos.length === 0 ? (
          <p className="text-sm text-ink-500">
            No hay liquidaciones pendientes. Cuando arranquen las ventas con tarjeta o
            plataformas, los depósitos esperados aparecen acá.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left py-2">Fecha</th>
                <th className="text-left py-2">Fuente</th>
                <th className="text-left py-2">Va a</th>
                <th className="text-right py-2">Operaciones</th>
                <th className="text-right py-2">Monto</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {data.proximosDepositos.slice(0, 10).map((d, i) => (
                <tr key={i}>
                  <td className="py-2 font-mono text-ink-700">
                    {new Date(d.fecha).toLocaleDateString('es-AR', {
                      day: '2-digit',
                      month: '2-digit',
                    })}
                  </td>
                  <td className="py-2">{d.fuente}</td>
                  <td className="py-2 text-ink-500">{d.cuentaDestino ?? '—'}</td>
                  <td className="py-2 text-right text-ink-500">{d.operaciones}</td>
                  <td className="py-2 text-right">
                    <MoneyAmount value={d.monto} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Gráfico ventas por hora (versión ASCII-bar simple, sin libs externas) */}
      {grafico && (
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Ventas por hora · hoy</h2>
          <VentasPorHoraChart data={grafico.horas} />
        </section>
      )}
    </div>
  );
}

function PendienteRow({
  show,
  label,
  icon,
  href,
  accent,
}: {
  show: boolean;
  label: string;
  icon: string;
  href: string;
  accent: 'default' | 'warning' | 'danger';
}) {
  if (!show) return null;
  return (
    <li className="py-2">
      <Link
        href={href}
        className={cn(
          'flex items-center justify-between gap-2 text-sm hover:underline',
          accent === 'warning' && 'text-saffron-600',
          accent === 'danger' && 'text-pomodoro-600',
          accent === 'default' && 'text-ink-700',
        )}
      >
        <span>
          {icon} {label}
        </span>
        <span>→</span>
      </Link>
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Drill-down modal — desglose de cada KPI
// ────────────────────────────────────────────────────────────────────────

const CANAL_LABEL: Record<string, string> = {
  MOSTRADOR: '🏪 Mostrador',
  TELEFONO: '📞 Teléfono',
  WHATSAPP: '💬 WhatsApp',
  PEDIDOS_YA: '🛵 Pedidos YA',
  RAPPI: '🛵 RAPPI',
  MERCADO_LIBRE: '🛵 Mercado Libre',
  DELIVERATE: '🛵 DELIVERATE',
  WEB: '🌐 Web',
};

function DrillDownModal({
  tipo,
  data,
  onClose,
}: {
  tipo: Exclude<DrillDownTipo, null>;
  data: Dashboard;
  onClose: () => void;
}) {
  const titulo = {
    ventas: '🧾 Ventas hoy — desglose por canal',
    efectivo: '💵 Cobrado en efectivo — desglose',
    tarjeta: '💳 Cobrado con tarjeta — desglose',
    aportes: '➕ Aportes del día',
    egresos: '➖ Egresos del día',
  }[tipo];

  const total = {
    ventas: data.kpis.ventasHoy.monto,
    efectivo: data.kpis.cobradoEfectivo.monto,
    tarjeta: data.kpis.cobradoTarjeta.monto,
    aportes: data.kpis.aportesHoy.monto,
    egresos: data.kpis.egresosHoy.monto,
  }[tipo];

  return (
    <div
      className="fixed inset-0 bg-ink-900/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-cream-50 rounded-lg shadow-modal w-full max-w-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-cream-300 flex items-center justify-between">
          <div>
            <h2 className="font-display text-md text-teresita-700">{titulo}</h2>
            <div className="text-xs text-ink-500 mt-0.5 font-mono">
              Total: <MoneyAmount value={total} className="text-md text-ink-900 font-semibold" />
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
          {tipo === 'ventas' && <DrillVentas data={data.kpis.ventasHoy} />}
          {tipo === 'efectivo' && <DrillEfectivo data={data.kpis.cobradoEfectivo} />}
          {tipo === 'tarjeta' && <DrillTarjeta data={data.kpis.cobradoTarjeta} />}
          {tipo === 'aportes' && (
            <DrillCategoria
              data={data.kpis.aportesHoy}
              tone="success"
              hrefLink="/admin/movimientos?tipo=INGRESO"
              hrefLabel="Ver todos los aportes"
              emptyMsg="Aún no hay aportes cargados hoy."
            />
          )}
          {tipo === 'egresos' && (
            <DrillCategoria
              data={data.kpis.egresosHoy}
              tone="danger"
              hrefLink="/admin/movimientos?tipo=EGRESO"
              hrefLabel="Ver todos los egresos"
              emptyMsg="Aún no hay egresos cargados hoy."
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DrillVentas({ data }: { data: Dashboard['kpis']['ventasHoy'] }) {
  if (data.porCanal.length === 0) {
    return <p className="text-sm text-ink-500 text-center py-8">Sin ventas hoy.</p>;
  }
  const total = Number(data.monto);
  return (
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
        {data.porCanal
          .slice()
          .sort((a, b) => Number(b.monto) - Number(a.monto))
          .map((r) => {
            const pct = total > 0 ? (Number(r.monto) / total) * 100 : 0;
            return (
              <tr key={r.canal}>
                <td className="py-2 text-ink-700">
                  {CANAL_LABEL[r.canal] ?? r.canal}
                </td>
                <td className="py-2 text-right font-mono text-ink-500">{r.cantidad}</td>
                <td className="py-2 text-right font-mono">
                  <MoneyAmount value={r.monto} />
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

function DrillEfectivo({ data }: { data: Dashboard['kpis']['cobradoEfectivo'] }) {
  const filas: Array<{
    label: string;
    hint?: string;
    entry: DesgloseEntry;
    informativo?: boolean;
  }> = [
    {
      label: '🏪 Mostrador',
      hint: 'efectivo cobrado en el local',
      entry: data.desglose.mostrador,
    },
    {
      label: '🛵 Damián (delivery propio)',
      hint: 'efectivo que trae el motoquero',
      entry: data.desglose.damian,
    },
    {
      label: '📱 Plataformas (Pedidos YA)',
      hint: 'cliente paga al motoquero de la app',
      entry: data.desglose.plataformas,
    },
    {
      label: '🛵 DELIVERATE',
      hint: 'rinde semanal · NO entra a la caja del día',
      entry: data.desglose.deliverateInformativo,
      informativo: true,
    },
  ];
  return (
    <div className="space-y-2">
      <div className="text-xs text-ink-500 mb-2">
        El efectivo del día es lo que entra a caja hoy: mostrador + Damián + Pedidos YA.
        DELIVERATE va a parte y se rinde una vez por semana.
      </div>
      {filas.map((f) => (
        <div
          key={f.label}
          className={cn(
            'flex items-baseline justify-between p-3 rounded-md border',
            f.informativo
              ? 'border-cream-300 bg-cream-100/50 italic text-ink-500'
              : 'border-cream-300 bg-white',
          )}
        >
          <div>
            <div className="text-sm font-medium text-ink-900">{f.label}</div>
            {f.hint && <div className="text-2xs text-ink-500">{f.hint}</div>}
          </div>
          <div className="text-right">
            <MoneyAmount
              value={f.entry.monto}
              className={cn('font-mono text-md', f.informativo && 'text-ink-500')}
            />
            <div className="text-2xs text-ink-500 font-mono">{f.entry.cantidad} pagos</div>
          </div>
        </div>
      ))}
      <div className="flex items-baseline justify-between p-3 rounded-md bg-basil-100 border border-basil-600 mt-3">
        <span className="text-sm font-semibold text-basil-600">Total a caja hoy</span>
        <MoneyAmount
          value={data.monto}
          className="font-mono text-md font-semibold text-basil-600"
        />
      </div>
    </div>
  );
}

function DrillTarjeta({ data }: { data: Dashboard['kpis']['cobradoTarjeta'] }) {
  const filas = [
    { label: '💳 Débito', entry: data.desglose.debito },
    { label: '💳 Crédito', entry: data.desglose.credito },
    { label: '📱 MercadoPago / QR', entry: data.desglose.mpQr },
    { label: '🏦 Transferencia / Depósito', entry: data.desglose.transferencia },
    { label: '❓ Otros', entry: data.desglose.otro },
  ].filter((f) => Number(f.entry.monto) > 0 || f.entry.cantidad > 0);

  if (filas.length === 0) {
    return (
      <p className="text-sm text-ink-500 text-center py-8">
        Aún no hay cobros con tarjeta hoy.
      </p>
    );
  }
  const total = Number(data.monto);
  return (
    <table className="w-full text-sm">
      <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
        <tr>
          <th className="text-left py-2">Método</th>
          <th className="text-right py-2">N°</th>
          <th className="text-right py-2">Monto</th>
          <th className="text-right py-2 w-16">%</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-cream-200">
        {filas
          .sort((a, b) => Number(b.entry.monto) - Number(a.entry.monto))
          .map((f) => {
            const pct = total > 0 ? (Number(f.entry.monto) / total) * 100 : 0;
            return (
              <tr key={f.label}>
                <td className="py-2 text-ink-700">{f.label}</td>
                <td className="py-2 text-right font-mono text-ink-500">{f.entry.cantidad}</td>
                <td className="py-2 text-right font-mono">
                  <MoneyAmount value={f.entry.monto} />
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

function DrillCategoria({
  data,
  tone,
  hrefLink,
  hrefLabel,
  emptyMsg,
}: {
  data: { monto: string; cantidad: number; porCategoria: Array<{ categoria: string; monto: string; cantidad: number }> };
  tone: 'success' | 'danger';
  hrefLink: string;
  hrefLabel: string;
  emptyMsg: string;
}) {
  if (data.porCategoria.length === 0) {
    return (
      <div className="text-sm text-ink-500 text-center py-8">
        {emptyMsg}
        <div className="mt-3">
          <Link href={hrefLink} className="text-teresita-700 hover:underline text-xs">
            {hrefLabel} →
          </Link>
        </div>
      </div>
    );
  }
  const total = Number(data.monto);
  const colorClass = tone === 'success' ? 'text-basil-600' : 'text-pomodoro-600';
  return (
    <div>
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
          {data.porCategoria
            .slice()
            .sort((a, b) => Number(b.monto) - Number(a.monto))
            .map((c) => {
              const pct = total > 0 ? (Number(c.monto) / total) * 100 : 0;
              return (
                <tr key={c.categoria}>
                  <td className="py-2 text-ink-700">{c.categoria}</td>
                  <td className="py-2 text-right font-mono text-ink-500">{c.cantidad}</td>
                  <td className={cn('py-2 text-right font-mono', colorClass)}>
                    <MoneyAmount value={c.monto} />
                  </td>
                  <td className="py-2 text-right text-2xs text-ink-500 font-mono">
                    {pct.toFixed(0)}%
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
      <div className="mt-3 text-right">
        <Link href={hrefLink} className="text-xs text-teresita-700 hover:underline">
          {hrefLabel} →
        </Link>
      </div>
    </div>
  );
}

function VentasPorHoraChart({
  data,
}: {
  data: Array<{ hora: number; cantidad: number; total: number }>;
}) {
  const max = Math.max(1, ...data.map((d) => d.total));
  return (
    <div className="grid gap-1">
      {data.map((d) => {
        const pct = (d.total / max) * 100;
        return (
          <div key={d.hora} className="flex items-center gap-2 text-xs">
            <span className="font-mono w-10 text-ink-500">
              {String(d.hora).padStart(2, '0')}:00
            </span>
            <div className="flex-1 bg-cream-200 rounded h-5 overflow-hidden">
              <div
                className="bg-teresita-500 h-full transition-all duration-base"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono w-24 text-right text-ink-700">
              <MoneyAmount value={d.total} />
            </span>
            <span className="font-mono w-12 text-right text-ink-500">{d.cantidad}</span>
          </div>
        );
      })}
    </div>
  );
}
