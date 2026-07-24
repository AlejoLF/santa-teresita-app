'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';
import { EncargoDetalleModal } from '@/components/encargos/EncargoDetalleModal';
import {
  type EncargoListItem,
  type FiltroEncargo,
  FILTROS_ENCARGO,
  coincideFiltro,
  cuandoLabel,
  estaAtrasado,
  fechaCortaDM,
  fechaLargaDia,
  hoyISO,
  isoMasDias,
  minutosAhoraAR,
} from '@/lib/encargos';

const DIAS_VENTANA = 30;

export default function EncargosPage() {
  const router = useRouter();
  const hoy = useMemo(() => hoyISO(), []);
  const [encargos, setEncargos] = useState<EncargoListItem[]>([]);
  const [selectedDay, setSelectedDay] = useState<string>(hoy);
  // Inicio de la ventana de 30 días que muestra el calendario. Default = hoy
  // (hoy → +29). Con ◀ ▶ la encargada navega al PASADO (y al futuro lejano).
  const [windowStart, setWindowStart] = useState<string>(hoy);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState<FiltroEncargo>('todos');
  // Buscador AMPLIO — sobre TODOS los encargos (futuros y pasados ya entregados).
  const [search, setSearch] = useState('');
  const [entregaFiltro, setEntregaFiltro] = useState<'todos' | 'pendientes' | 'entregados'>('todos');
  const [searchResults, setSearchResults] = useState<EncargoListItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchActivo = search.trim().length > 0;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const hasta = isoMasDias(windowStart, DIAS_VENTANA - 1);
      const res = await api.get<{ encargos: EncargoListItem[] }>(
        `/encargos?desde=${windowStart}&hasta=${hasta}`,
      );
      setEncargos(res.encargos ?? []);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) setEncargos([]);
    } finally {
      setLoading(false);
    }
  }, [windowStart]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Búsqueda con debounce. Sin término → limpia resultados (vuelve a la vista día).
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ encargos: EncargoListItem[] }>(
          // pageSize alto a propósito: esta vista del cajero NO tiene paginado
          // (muestra la lista completa de una). El paginado de a 12 es del
          // buscador de admin.
          `/encargos/buscar?q=${encodeURIComponent(q)}&entrega=${entregaFiltro}&pageSize=100`,
        );
        setSearchResults(res.encargos ?? []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [search, entregaFiltro]);

  // Conteo por día (para el calendario).
  const countByDay = useMemo(() => {
    const m = new Map<string, { total: number; aPagar: number }>();
    for (const e of encargos) {
      if (!e.fechaEntrega) continue;
      const cur = m.get(e.fechaEntrega) ?? { total: 0, aPagar: 0 };
      cur.total += 1;
      if (e.estadoCobro === 'A_PAGAR') cur.aPagar += 1;
      m.set(e.fechaEntrega, cur);
    }
    return m;
  }, [encargos]);

  const delDia = useMemo(
    () => encargos.filter((e) => e.fechaEntrega === selectedDay),
    [encargos, selectedDay],
  );

  // Se recalcula al cambiar el día/los datos: alcanza para los chips (no hace
  // falta un timer que refresque "atrasados" al minuto).
  const minutosAhora = useMemo(() => minutosAhoraAR(), [encargos, selectedDay]);

  // Cuántos encargos del día caen en cada filtro — se muestra en el chip.
  const conteos = useMemo(() => {
    const m = {} as Record<FiltroEncargo, number>;
    for (const f of FILTROS_ENCARGO) {
      m[f.valor] = delDia.filter((e) => coincideFiltro(e, f.valor, hoy, minutosAhora)).length;
    }
    return m;
  }, [delDia, hoy, minutosAhora]);

  const visibles = useMemo(
    () => delDia.filter((e) => coincideFiltro(e, filtro, hoy, minutosAhora)),
    [delDia, filtro, hoy, minutosAhora],
  );

  const dias = useMemo(
    () => Array.from({ length: DIAS_VENTANA }, (_, i) => isoMasDias(windowStart, i)),
    [windowStart],
  );

  return (
    <div className="max-w-5xl mx-auto p-3 lg:p-6 space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCalendarOpen((o) => !o)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border transition-colors',
              calendarOpen
                ? 'bg-wood-700 text-wood-50 border-wood-700'
                : 'bg-white text-wood-700 border-wood-300 hover:bg-wood-100',
            )}
            title="Ver calendario de 30 días"
          >
            <span className="text-lg">📅</span>
            Calendario
          </button>
          <div>
            <div className="font-display text-lg text-wood-900 leading-tight">
              {selectedDay === hoy ? 'Hoy' : fechaLargaDia(selectedDay)}
            </div>
            <div className="text-2xs text-ink-500">
              {delDia.length} encargo{delDia.length === 1 ? '' : 's'} · {fechaCortaDM(selectedDay)}
            </div>
          </div>
        </div>
        <button
          onClick={() => router.push('/encargos/nuevo')}
          className="px-4 py-2 rounded-md bg-wood-700 text-wood-50 font-medium hover:bg-wood-900 transition-colors"
        >
          + Nuevo encargo
        </button>
      </div>

      {/* Buscador AMPLIO — sobre TODOS los encargos (futuros y pasados). */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔎 Buscar: nombre, teléfono, día, total, N° de pedido…"
            className="w-full px-3 py-2 rounded-md border border-wood-300 text-sm focus:outline-none focus:border-wood-700"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-900 text-lg leading-none"
              title="Limpiar"
            >
              ✕
            </button>
          )}
        </div>
        {searchActivo && (
          <div className="flex items-center gap-1">
            {(['todos', 'pendientes', 'entregados'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setEntregaFiltro(v)}
                className={cn(
                  'px-2.5 py-1.5 rounded-full border text-xs font-medium transition-colors',
                  entregaFiltro === v
                    ? 'bg-wood-700 text-wood-50 border-wood-700'
                    : 'bg-white text-wood-700 border-wood-300 hover:bg-wood-100',
                )}
              >
                {v === 'todos' ? 'Todos' : v === 'pendientes' ? 'Sin retirar' : 'Entregados'}
              </button>
            ))}
          </div>
        )}
      </div>

      {searchActivo && (
        <div className="space-y-3">
          <div className="text-2xs text-ink-500">
            {searching
              ? 'Buscando…'
              : `${(searchResults ?? []).length} resultado${
                  (searchResults ?? []).length === 1 ? '' : 's'
                } para "${search.trim()}"`}
          </div>
          {!searching && (searchResults ?? []).length === 0 ? (
            <div className="card p-8 text-center text-ink-500">
              <div className="text-3xl mb-2">🔎</div>
              No se encontró ningún encargo con ese criterio.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(searchResults ?? []).map((e) => (
                <EncargoCard
                  key={e.id}
                  e={e}
                  hoy={hoy}
                  minutosAhora={minutosAhora}
                  onClick={() => setDetailId(e.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {!searchActivo && (
        <>
      {/* Filtros — atajos operativos sobre los encargos del día. Mezclan estado
          de cobro y de entrega a propósito (son dimensiones ortogonales). */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {FILTROS_ENCARGO.map((f) => {
          const n = conteos[f.valor] ?? 0;
          const activo = filtro === f.valor;
          const alerta = f.valor === 'atrasado' && n > 0;
          return (
            <button
              key={f.valor}
              onClick={() => setFiltro(f.valor)}
              className={cn(
                'px-2.5 py-1.5 rounded-full border text-xs font-medium transition-colors flex items-center gap-1',
                activo
                  ? 'bg-wood-700 text-wood-50 border-wood-700'
                  : alerta
                    ? 'bg-pomodoro-100 text-pomodoro-600 border-pomodoro-600/30 hover:bg-pomodoro-100/70'
                    : 'bg-white text-wood-700 border-wood-300 hover:bg-wood-100',
                !activo && n === 0 && 'opacity-45',
              )}
            >
              <span aria-hidden>{f.icono}</span>
              <span>{f.label}</span>
              <span
                className={cn(
                  'font-mono tabular-nums',
                  activo ? 'text-wood-100' : 'text-ink-500',
                )}
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>

      {/* Calendario 30 días */}
      {calendarOpen && (
        <div className="card p-3 border-t-4 border-wood-700">
          {/* Navegación de la ventana de 30 días — permite ver el PASADO
              (encargos ya entregados, read-only) y el futuro lejano. */}
          <div className="flex items-center justify-between mb-2 gap-2">
            <button
              onClick={() => {
                const w = isoMasDias(windowStart, -DIAS_VENTANA);
                setWindowStart(w);
                setSelectedDay(w);
              }}
              className="px-2.5 py-1.5 rounded-md text-xs font-medium border border-wood-300 bg-white text-wood-700 hover:bg-wood-100"
            >
              ◀ Anteriores
            </button>
            <span className="text-2xs text-ink-500 text-center">
              {fechaCortaDM(windowStart)} – {fechaCortaDM(isoMasDias(windowStart, DIAS_VENTANA - 1))}
            </span>
            <div className="flex items-center gap-1">
              {windowStart !== hoy && (
                <button
                  onClick={() => {
                    setWindowStart(hoy);
                    setSelectedDay(hoy);
                  }}
                  className="px-2.5 py-1.5 rounded-md text-xs font-medium border border-wood-300 bg-white text-wood-700 hover:bg-wood-100"
                >
                  Hoy
                </button>
              )}
              <button
                onClick={() => {
                  const w = isoMasDias(windowStart, DIAS_VENTANA);
                  setWindowStart(w);
                  setSelectedDay(w);
                }}
                className="px-2.5 py-1.5 rounded-md text-xs font-medium border border-wood-300 bg-white text-wood-700 hover:bg-wood-100"
              >
                Siguientes ▶
              </button>
            </div>
          </div>
          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-7 gap-1.5">
            {dias.map((iso) => {
              const c = countByDay.get(iso);
              const sel = iso === selectedDay;
              const esHoy = iso === hoy;
              return (
                <button
                  key={iso}
                  onClick={() => setSelectedDay(iso)}
                  className={cn(
                    'rounded-md border p-1.5 text-left transition-colors min-h-[58px] flex flex-col',
                    sel
                      ? 'bg-wood-700 text-wood-50 border-wood-700'
                      : c
                        ? 'bg-wood-100 border-wood-300 hover:bg-wood-200'
                        : 'bg-white border-cream-300 hover:bg-cream-100',
                  )}
                >
                  <span className={cn('text-2xs', sel ? 'text-wood-100' : 'text-ink-500')}>
                    {fechaLargaDia(iso)}
                    {esHoy && !sel && <span className="text-wood-700 font-bold"> ·hoy</span>}
                  </span>
                  {c ? (
                    <span className="mt-auto flex items-baseline gap-1">
                      <span className={cn('text-lg font-bold', sel ? 'text-white' : 'text-wood-700')}>
                        {c.total}
                      </span>
                      {c.aPagar > 0 && (
                        <span
                          className={cn(
                            'text-2xs px-1 rounded',
                            sel ? 'bg-white/20 text-white' : 'bg-saffron-100 text-saffron-600',
                          )}
                        >
                          {c.aPagar} a pagar
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="mt-auto text-2xs text-ink-300">—</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Tarjetas del día */}
      {loading ? (
        <div className="text-center text-ink-500 py-12">Cargando encargos…</div>
      ) : visibles.length === 0 ? (
        <div className="card p-10 text-center text-ink-500">
          <div className="text-3xl mb-2">📦</div>
          {delDia.length === 0 ? (
            <>
              No hay encargos para {selectedDay === hoy ? 'hoy' : 'este día'}.
              <div className="mt-3">
                <button
                  onClick={() => router.push('/encargos/nuevo')}
                  className="text-wood-700 hover:underline text-sm font-medium"
                >
                  + Cargar un encargo
                </button>
              </div>
            </>
          ) : (
            <>
              Ningún encargo de este día entra en el filtro seleccionado.
              <div className="mt-3">
                <button
                  onClick={() => setFiltro('todos')}
                  className="text-wood-700 hover:underline text-sm font-medium"
                >
                  Ver todos ({delDia.length})
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {visibles.map((e) => (
            <EncargoCard
              key={e.id}
              e={e}
              hoy={hoy}
              minutosAhora={minutosAhora}
              onClick={() => setDetailId(e.id)}
            />
          ))}
        </div>
      )}
        </>
      )}

      {detailId && (
        <EncargoDetalleModal
          encargoId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => void fetchData()}
        />
      )}
    </div>
  );
}

/** Tarjeta de un encargo — compartida por la vista día y el buscador. */
function EncargoCard({
  e,
  hoy,
  minutosAhora,
  onClick,
}: {
  e: EncargoListItem;
  hoy: string;
  minutosAhora: number;
  onClick: () => void;
}) {
  const retirado = !!e.retiradoAt;
  const atrasado = estaAtrasado(e, hoy, minutosAhora);
  return (
    <button
      onClick={onClick}
      className={cn(
        'card p-3.5 text-left hover:shadow-md transition-shadow border-l-4 flex flex-col gap-1.5',
        retirado ? 'border-basil-600 opacity-70' : atrasado ? 'border-pomodoro-600' : 'border-wood-600',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-md font-bold text-wood-700">
          #{String(e.numeroOrdenTurno).padStart(3, '0')}
        </span>
        <span className="flex items-center gap-1 flex-wrap justify-end">
          {retirado && (
            <span className="px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wide bg-basil-100 text-basil-600">
              ✅ Retirado
            </span>
          )}
          {!retirado && atrasado && (
            <span className="px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wide bg-pomodoro-100 text-pomodoro-600">
              ⚠️ Atrasado
            </span>
          )}
          <span
            className={cn(
              'px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wide',
              e.estadoCobro === 'COBRADO'
                ? 'bg-basil-100 text-basil-600'
                : 'bg-saffron-100 text-saffron-600',
            )}
          >
            {e.estadoCobro === 'COBRADO'
              ? 'Cobrado'
              : e.estadoCobro === 'PARCIAL'
                ? 'Pago parcial'
                : 'A pagar'}
          </span>
        </span>
      </div>
      <div className="text-sm font-medium text-ink-900 truncate">{e.cliente ?? 'Sin nombre'}</div>
      <div className="text-xs text-ink-500 flex items-center gap-2 flex-wrap">
        <span>🕒 {cuandoLabel(e)}</span>
        <span>{e.tipoEntrega === 'ENVIO' ? '🛵 Envío' : '🏪 Retira'}</span>
        <span>
          · {e.itemsCount} ítem{e.itemsCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex items-center justify-between mt-auto pt-1">
        {e.telefono && <span className="text-2xs text-ink-400">{e.telefono}</span>}
        <MoneyAmount value={e.total} className="font-mono text-md text-wood-900 ml-auto" />
      </div>
    </button>
  );
}
