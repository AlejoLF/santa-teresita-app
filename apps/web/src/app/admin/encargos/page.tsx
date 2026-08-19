'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { KpiCard } from '@/components/admin/KpiCard';
import { cn } from '@/lib/cn';
import { EncargoDetalleModal } from '@/components/encargos/EncargoDetalleModal';
import {
  useBusquedaPaginada,
  BuscadorFiltros,
  Paginacion,
} from '@/components/admin/BusquedaTabla';
import {
  type EncargoListItem,
  cuandoLabel,
  fechaLargaDia,
  hoyISO,
  isoMasDias,
} from '@/lib/encargos';

export default function AdminEncargosPage() {
  const router = useRouter();
  const hoy = useMemo(() => hoyISO(), []);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [entrega, setEntrega] = useState<'todos' | 'pendientes' | 'entregados'>('todos');

  // Los KPIs siguen calculándose sobre la ventana fija (últimos 7 días +
  // próximos 30), NO sobre la tabla: si dependieran del listado paginado,
  // mostrarían solo lo de la página actual, que sería un número equivocado.
  const [kpiEncargos, setKpiEncargos] = useState<EncargoListItem[]>([]);
  const fetchKpis = useCallback(async () => {
    try {
      const desde = isoMasDias(hoy, -7);
      const hasta = isoMasDias(hoy, 30);
      const res = await api.get<{ encargos: EncargoListItem[] }>(
        `/encargos?desde=${desde}&hasta=${hasta}`,
      );
      setKpiEncargos(res.encargos ?? []);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) setKpiEncargos([]);
    }
  }, [hoy]);

  useEffect(() => {
    void fetchKpis();
  }, [fetchKpis]);

  // Objeto estable: si se recreara en cada render, el hook refetchearía en loop.
  const paramsExtra = useMemo(() => ({ entrega }), [entrega]);
  const b = useBusquedaPaginada<EncargoListItem>({
    endpoint: '/encargos/buscar',
    extraerItems: (res) => (res as { encargos?: EncargoListItem[] }).encargos ?? [],
    paramsExtra,
  });

  const recargarTodo = useCallback(() => {
    void b.refetch();
    void fetchKpis();
  }, [b, fetchKpis]);

  const aPagar = kpiEncargos.filter((e) => e.estadoCobro === 'A_PAGAR');
  const totalAPagar = aPagar.reduce((a, e) => a + Number(e.total), 0);
  const proximos = kpiEncargos.filter((e) => (e.fechaEntrega ?? '') >= hoy);

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="font-display text-xl text-ink-900">Encargos</h1>
          <p className="text-sm text-ink-500">
            Pedidos cargados para días futuros. La carga y el cobro se operan desde la pestaña{' '}
            <button onClick={() => router.push('/encargos')} className="text-teresita-700 hover:underline">
              📦 Encargos
            </button>
            .
          </p>
        </div>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard label="Encargos próximos" value={String(proximos.length)} format="count" hint="de hoy en adelante" />
        <KpiCard label="Pendientes de cobro" value={String(aPagar.length)} format="count" accent={aPagar.length > 0 ? 'warning' : 'default'} hint="cargados 'a pagar'" />
        <KpiCard label="Por cobrar ($)" value={totalAPagar.toFixed(2)} accent="warning" hint="total de los 'a pagar'" />
      </section>

      <BuscadorFiltros
        q={b.q}
        onQ={b.setQ}
        periodo={b.periodo}
        onPeriodo={b.setPeriodo}
        desde={b.desde}
        onDesde={b.setDesde}
        hasta={b.hasta}
        onHasta={b.setHasta}
        placeholder="🔎 Buscar: cliente, teléfono, día de entrega, total, N° de pedido…"
        total={b.meta.total}
        loading={b.loading}
        onLimpiar={b.limpiar}
        hayFiltro={b.hayFiltro}
        exportar={{ path: b.pathExport, nombre: 'encargos.xlsx' }}
      >
        <select
          value={entrega}
          onChange={(e) => setEntrega(e.target.value as typeof entrega)}
          className="input w-auto"
        >
          <option value="todos">Todos</option>
          <option value="pendientes">Sin retirar</option>
          <option value="entregados">Retirados</option>
        </select>
      </BuscadorFiltros>

      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
          <h2 className="font-display text-md text-ink-900">Listado ({b.meta.total})</h2>
        </header>
        {b.loading && b.items.length === 0 ? (
          <div className="px-4 py-8 text-center text-ink-500 text-sm">Cargando…</div>
        ) : b.items.length === 0 ? (
          <div className="px-4 py-8 text-center text-ink-500 text-sm">
            {b.hayFiltro ? 'Ningún encargo coincide con la búsqueda.' : 'Sin encargos cargados.'}
          </div>
        ) : (
          <>
            <table className="w-full text-sm hidden md:table">
              <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
                <tr>
                  <th className="text-left px-4 py-2">Día</th>
                  <th className="text-left px-4 py-2">Comanda</th>
                  <th className="text-left px-4 py-2">Cliente</th>
                  <th className="text-left px-4 py-2">Horario</th>
                  <th className="text-left px-4 py-2">Entrega</th>
                  <th className="text-left px-4 py-2">Fecha y hora</th>
                  <th className="text-center px-4 py-2">Cobro</th>
                  <th className="text-right px-4 py-2">Total</th>
                  <th className="px-3 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {b.items.map((e) => (
                  <tr
                    key={e.id}
                    className="hover:bg-cream-100 cursor-pointer"
                    onClick={() => setDetailId(e.id)}
                  >
                    <td className="px-4 py-2 text-xs text-ink-700">
                      {e.fechaEntrega ? fechaLargaDia(e.fechaEntrega) : '—'}
                    </td>
                    <td className="px-4 py-2 font-mono text-sm text-teresita-700 font-semibold">
                      #{e.numeroOrdenTurno}
                    </td>
                    <td className="px-4 py-2 text-ink-900 max-w-[180px] truncate">{e.cliente ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-ink-700">🕒 {cuandoLabel(e)}</td>
                    <td className="px-4 py-2 text-xs text-ink-500">
                      {e.tipoEntrega === 'ENVIO' ? '🛵 Envío' : '🏪 Retira'}
                    </td>
                    <td className="px-4 py-2 text-xs text-ink-700 whitespace-nowrap">
                      {e.fechaEntrega ? (
                        <>
                          {fechaLargaDia(e.fechaEntrega)}
                          <span className="text-ink-400"> · </span>
                          {cuandoLabel(e)}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2 text-center">
                      <span
                        className={cn(
                          'px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wide',
                          e.estadoCobro === 'COBRADO'
                            ? 'bg-basil-100 text-basil-600'
                            : 'bg-saffron-100 text-saffron-600',
                        )}
                      >
                        {e.estadoCobro === 'COBRADO' ? 'Cobrado' : e.estadoCobro === 'PARCIAL' ? 'Pago parcial' : 'A pagar'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <MoneyAmount value={e.total} className="font-mono text-teresita-900" />
                    </td>
                    <td className="px-3 py-2 text-right text-2xs text-teresita-700">ver</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="md:hidden divide-y divide-cream-200">
              {b.items.map((e) => (
                <button
                  key={e.id}
                  onClick={() => setDetailId(e.id)}
                  className="w-full text-left p-3 active:bg-cream-100"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm text-ink-900">
                        <span className="font-mono text-teresita-700 font-semibold">
                          #{e.numeroOrdenTurno}
                        </span>{' '}
                        · {e.cliente ?? '—'}
                      </div>
                      <div className="text-2xs text-ink-500">
                        {e.fechaEntrega ? fechaLargaDia(e.fechaEntrega) : '—'} · 🕒 {cuandoLabel(e)} ·{' '}
                        {e.tipoEntrega === 'ENVIO' ? 'Envío' : 'Retira'}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <MoneyAmount value={e.total} className="font-mono text-teresita-900" />
                      <div
                        className={cn(
                          'text-2xs font-bold uppercase',
                          e.estadoCobro === 'COBRADO' ? 'text-basil-600' : 'text-saffron-600',
                        )}
                      >
                        {e.estadoCobro === 'COBRADO' ? 'Cobrado' : e.estadoCobro === 'PARCIAL' ? 'Pago parcial' : 'A pagar'}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
        <Paginacion
          page={b.meta.page}
          totalPages={b.meta.totalPages}
          total={b.meta.total}
          pageSize={b.meta.pageSize}
          onPage={b.setPage}
          loading={b.loading}
        />
      </section>

      {detailId && (
        <EncargoDetalleModal
          encargoId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={recargarTodo}
        />
      )}
    </div>
  );
}
