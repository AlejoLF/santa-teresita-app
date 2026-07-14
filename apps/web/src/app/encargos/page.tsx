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
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState<FiltroEncargo>('todos');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const hasta = isoMasDias(hoy, DIAS_VENTANA - 1);
      const res = await api.get<{ encargos: EncargoListItem[] }>(
        `/encargos?desde=${hoy}&hasta=${hasta}`,
      );
      setEncargos(res.encargos ?? []);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) setEncargos([]);
    } finally {
      setLoading(false);
    }
  }, [hoy]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

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
    () => Array.from({ length: DIAS_VENTANA }, (_, i) => isoMasDias(hoy, i)),
    [hoy],
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
          {visibles.map((e) => {
            const retirado = !!e.retiradoAt;
            const atrasado = estaAtrasado(e, hoy, minutosAhora);
            return (
              <button
                key={e.id}
                onClick={() => setDetailId(e.id)}
                className={cn(
                  'card p-3.5 text-left hover:shadow-md transition-shadow border-l-4 flex flex-col gap-1.5',
                  retirado
                    ? 'border-basil-600 opacity-70'
                    : atrasado
                      ? 'border-pomodoro-600'
                      : 'border-wood-600',
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
                <div className="text-sm font-medium text-ink-900 truncate">
                  {e.cliente ?? 'Sin nombre'}
                </div>
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
          })}
        </div>
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
