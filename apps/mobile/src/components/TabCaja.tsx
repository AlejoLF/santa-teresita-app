'use client';

import { useState } from 'react';
import { fmtPesos, fmtNum, fmtFechaHora } from '@/lib/format';
import { useAutoRefresh } from '@/lib/useAutoRefresh';
import { RefreshIndicator } from './RefreshIndicator';

type SubTab = 'saldos' | 'movimientos' | 'cierres';

export function TabCaja() {
  const [sub, setSub] = useState<SubTab>('saldos');

  return (
    <div className="p-4">
      {/* Sub-tabs */}
      <div className="flex gap-1 mb-3 bg-cream-200 rounded-md p-0.5">
        {(
          [
            ['saldos', 'Saldos'],
            ['movimientos', 'Movimientos'],
            ['cierres', 'Cierres'],
          ] as Array<[SubTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSub(id)}
            className={
              sub === id
                ? 'flex-1 py-2 rounded text-sm font-semibold bg-white text-teresita-700 shadow-sm'
                : 'flex-1 py-2 rounded text-sm text-ink-500'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {sub === 'saldos' && <Saldos />}
      {sub === 'movimientos' && <Movimientos />}
      {sub === 'cierres' && <Cierres />}
    </div>
  );
}

/* ───────────────────────── Saldos ───────────────────────── */

interface CajaData {
  cuentas: Array<{ id: string; nombre: string; tipo: string; banco: string | null; saldo: string }>;
  porCobrar: Array<{ nombre: string; saldo: string }>;
  totales: { efectivo: number; bancario: number; disponible: number; porCobrar: number };
}

const TIPO_ICON: Record<string, string> = { EFECTIVO: '💵', BANCO: '🏦', WALLET: '📱' };

function Saldos() {
  const { data, error, loading, refreshing, lastUpdated, refetch } = useAutoRefresh<CajaData>(
    async () => {
      const r = await fetch('/api/caja');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as CajaData;
    },
    { intervalMs: 30_000 },
  );

  if (error && !data) return <ErrorBox msg={error} />;
  if (loading || !data) return <Skeleton n={4} h={16} />;

  return (
    <div className="space-y-3">
      <div className="flex justify-end -mt-1">
        <RefreshIndicator lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={refetch} />
      </div>

      {/* Total disponible (hero) */}
      <div className="bg-teresita-700 text-cream-50 rounded-lg p-4">
        <p className="text-xs uppercase tracking-wide opacity-90">Disponible ahora</p>
        <p className="text-3xl font-bold">{fmtPesos(data.totales.disponible)}</p>
        <p className="text-xs opacity-80 mt-1">
          💵 {fmtPesos(data.totales.efectivo)} efectivo · 🏦 {fmtPesos(data.totales.bancario)} en
          bancos
        </p>
        {data.totales.porCobrar > 0 && (
          <p className="text-xs opacity-80 mt-0.5">
            ⏳ {fmtPesos(data.totales.porCobrar)} por cobrar (tarjetas/plataformas)
          </p>
        )}
      </div>

      {/* Cuentas */}
      <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2">
        {data.cuentas.map((c) => (
          <div
            key={c.id}
            className="bg-white rounded-md border border-cream-300 p-3 flex items-center justify-between"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink-900 truncate">
                {TIPO_ICON[c.tipo] ?? '•'} {c.nombre}
              </p>
              {c.banco && <p className="text-2xs text-ink-500">{c.banco}</p>}
            </div>
            <p
              className={`text-md font-mono whitespace-nowrap ${
                Number(c.saldo) < 0 ? 'text-pomodoro-600' : 'text-teresita-700'
              }`}
            >
              {fmtPesos(c.saldo)}
            </p>
          </div>
        ))}
      </div>

      {/* Por cobrar */}
      {data.porCobrar.length > 0 && (
        <div>
          <h3 className="font-display text-sm text-ink-700 mt-2 mb-1 px-1">
            Por cobrar (en tránsito)
          </h3>
          <div className="space-y-1">
            {data.porCobrar.map((c) => (
              <div
                key={c.nombre}
                className="bg-cream-100 rounded-md p-2.5 flex items-center justify-between"
              >
                <span className="text-sm text-ink-700 truncate">⏳ {c.nombre}</span>
                <span className="text-sm font-mono text-saffron-600 whitespace-nowrap">
                  {fmtPesos(c.saldo)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── Movimientos ─────────────────────── */

type Periodo = 'hoy' | 'semana' | 'mes';

interface MovData {
  movimientos: Array<{
    id: string;
    tipo: string;
    monto: string;
    fecha: string;
    observacion: string | null;
    categoria: string;
    cuenta_origen: string | null;
    cuenta_destino: string | null;
    usuario: string | null;
  }>;
  resumen: { ingresos: string; egresos: string; cantidad: string };
}

const TIPO_MOV: Record<string, { signo: string; color: string; label: string }> = {
  INGRESO: { signo: '+', color: 'text-basil-600', label: 'Ingreso' },
  EGRESO: { signo: '−', color: 'text-pomodoro-600', label: 'Egreso' },
  TRANSFERENCIA_INTERNA: { signo: '↔', color: 'text-ink-500', label: 'Transferencia' },
  LIQUIDACION: { signo: '✓', color: 'text-teresita-700', label: 'Liquidación' },
  AJUSTE: { signo: '~', color: 'text-ink-500', label: 'Ajuste' },
};

function Movimientos() {
  const [periodo, setPeriodo] = useState<Periodo>('hoy');
  const { data, error, loading, refreshing, lastUpdated, refetch } = useAutoRefresh<MovData>(
    async () => {
      const r = await fetch(`/api/movimientos?periodo=${periodo}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as MovData;
    },
    { deps: [periodo], intervalMs: 25_000 },
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between -mt-1">
        <div className="flex gap-1 bg-cream-200 rounded-md p-0.5">
          {(['hoy', 'semana', 'mes'] as Periodo[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriodo(p)}
              className={
                periodo === p
                  ? 'px-3 py-1 rounded text-xs font-semibold bg-white text-teresita-700 shadow-sm'
                  : 'px-3 py-1 rounded text-xs text-ink-500'
              }
            >
              {p === 'hoy' ? 'Hoy' : p === 'semana' ? '7 días' : '30 días'}
            </button>
          ))}
        </div>
        <RefreshIndicator lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={refetch} />
      </div>

      {data && (
        <div className="grid grid-cols-3 gap-2">
          <MiniStat titulo="Ingresos" valor={data.resumen.ingresos} color="basil" />
          <MiniStat titulo="Egresos" valor={data.resumen.egresos} color="pomodoro" />
          <MiniStat
            titulo="Movimientos"
            valor={data.resumen.cantidad}
            color="ink"
            esNumero
          />
        </div>
      )}

      {error && !data && <ErrorBox msg={error} />}
      {loading && !data && <Skeleton n={5} h={14} />}
      {data && data.movimientos.length === 0 && (
        <p className="text-sm text-ink-500 italic text-center py-8">
          No hay movimientos en este período.
        </p>
      )}

      <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2">
        {data?.movimientos.map((m) => {
          const meta = TIPO_MOV[m.tipo] ?? TIPO_MOV.AJUSTE;
          const ruta =
            m.tipo === 'TRANSFERENCIA_INTERNA'
              ? `${m.cuenta_origen ?? '?'} → ${m.cuenta_destino ?? '?'}`
              : (m.cuenta_destino ?? m.cuenta_origen ?? '');
          return (
            <div key={m.id} className="bg-white rounded-md border border-cream-300 p-3">
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-900 truncate">{m.categoria}</p>
                  <p className="text-2xs text-ink-500 truncate">
                    {ruta}
                    {m.usuario ? ` · ${m.usuario}` : ''} · {fmtFechaHora(m.fecha)}
                  </p>
                  {m.observacion && (
                    <p className="text-2xs text-ink-500 italic truncate">{m.observacion}</p>
                  )}
                </div>
                <p className={`text-md font-mono whitespace-nowrap ${meta.color}`}>
                  {meta.signo} {fmtPesos(m.monto)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniStat({
  titulo,
  valor,
  color,
  esNumero,
}: {
  titulo: string;
  valor: string;
  color: 'basil' | 'pomodoro' | 'ink';
  esNumero?: boolean;
}) {
  const cls =
    color === 'basil'
      ? 'bg-basil-100 text-basil-600'
      : color === 'pomodoro'
        ? 'bg-pomodoro-100 text-pomodoro-600'
        : 'bg-cream-200 text-ink-700';
  return (
    <div className={`${cls} rounded-lg p-2.5 text-center`}>
      <p className="text-2xs uppercase tracking-wide opacity-90">{titulo}</p>
      <p className="text-sm font-bold leading-tight mt-0.5">
        {esNumero ? fmtNum(Number(valor)) : fmtPesos(valor)}
      </p>
    </div>
  );
}

/* ───────────────────────── Cierres ───────────────────────── */

interface Cierre {
  id: string;
  fecha: string;
  turno: string;
  estado: string;
  inicial: string | null;
  final: string | null;
  esperada: string | null;
  diferencia: string | null;
  apertura: string | null;
  cierre: string | null;
  abrio: string | null;
  cerro: string | null;
}

function fmtFechaCorta(ymd: string): string {
  // ymd = 'YYYY-MM-DD' (columna DATE) → 'DD/MM' sin pasar por Date() (TZ-safe).
  const [, m, d] = ymd.split('-');
  return d && m ? `${d}/${m}` : ymd;
}

function Cierres() {
  const { data, error, loading, refreshing, lastUpdated, refetch } = useAutoRefresh<{
    cierres: Cierre[];
  }>(
    async () => {
      const r = await fetch('/api/cierres');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { cierres: Cierre[] };
    },
    { intervalMs: 60_000 },
  );

  if (error && !data) return <ErrorBox msg={error} />;
  if (loading || !data) return <Skeleton n={4} h={20} />;

  return (
    <div className="space-y-3">
      <div className="flex justify-end -mt-1">
        <RefreshIndicator lastUpdated={lastUpdated} refreshing={refreshing} onRefresh={refetch} />
      </div>

      {data.cierres.length === 0 && (
        <p className="text-sm text-ink-500 italic text-center py-8">Todavía no hay cierres.</p>
      )}

      <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2">
        {data.cierres.map((c) => {
          const dif = c.diferencia != null ? Number(c.diferencia) : null;
          const difColor =
            dif == null
              ? 'text-ink-500'
              : Math.abs(dif) < 0.5
                ? 'text-basil-600'
                : 'text-pomodoro-600';
          return (
            <div key={c.id} className="bg-white rounded-md border border-cream-300 p-3">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <p className="text-sm font-semibold text-ink-900">
                    {fmtFechaCorta(c.fecha)} · {c.turno === 'MANANA' ? 'Mañana' : 'Tarde'}
                  </p>
                  <p className="text-2xs text-ink-500">
                    {c.cerro ? `Cerró ${c.cerro}` : ''}
                    {c.estado === 'APROBADA' ? ' · ✓ aprobado' : ''}
                  </p>
                </div>
                <span
                  className={`px-2 py-0.5 rounded text-2xs font-medium whitespace-nowrap ${
                    c.estado === 'APROBADA'
                      ? 'bg-basil-100 text-basil-600'
                      : 'bg-cream-200 text-ink-700'
                  }`}
                >
                  {c.estado}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Celda titulo="Esperado" valor={c.esperada} />
                <Celda titulo="Contado" valor={c.final} />
                <div>
                  <p className="text-2xs text-ink-500 uppercase">Diferencia</p>
                  <p className={`text-sm font-mono font-semibold ${difColor}`}>
                    {dif == null ? '—' : `${dif > 0 ? '+' : ''}${fmtPesos(dif)}`}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Celda({ titulo, valor }: { titulo: string; valor: string | null }) {
  return (
    <div>
      <p className="text-2xs text-ink-500 uppercase">{titulo}</p>
      <p className="text-sm font-mono text-ink-900">{valor == null ? '—' : fmtPesos(valor)}</p>
    </div>
  );
}

/* ───────────────────────── helpers ───────────────────────── */

function Skeleton({ n, h }: { n: number; h: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className={`bg-cream-200 animate-pulse rounded`} style={{ height: h * 4 }} />
      ))}
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="bg-pomodoro-100 border-l-4 border-pomodoro-600 p-3 rounded-r text-xs text-pomodoro-600">
      ⚠ {msg}
    </div>
  );
}
