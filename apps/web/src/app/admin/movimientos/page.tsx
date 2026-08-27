'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { BotonExportarExcel } from '@/components/admin/BotonExportarExcel';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { MovimientoDetailModal } from '@/components/admin/MovimientoDetailModal';
import { Paginacion } from '@/components/admin/BusquedaTabla';
import { cn } from '@/lib/cn';

interface Cuenta {
  id: string;
  nombre: string;
  tipo: string;
}
interface Categoria {
  id: string;
  nombre: string;
  tipo: 'INGRESO' | 'EGRESO' | 'TRANSFERENCIA' | 'AMBOS';
  esOperativa: boolean;
  esSistema?: boolean;
}
interface Movimiento {
  id: string;
  tipo: 'INGRESO' | 'EGRESO' | 'TRANSFERENCIA_INTERNA' | 'AJUSTE' | 'LIQUIDACION';
  monto: string;
  fechaComputo: string;
  estado: 'PENDIENTE' | 'CONFIRMADO' | 'ANULADO';
  observacion: string | null;
  cuentaOrigen?: { nombre: string } | null;
  cuentaDestino?: { nombre: string } | null;
  categoria: { nombre: string };
  usuario: { nombre: string };
  modificado?: boolean;
  modificadoAt?: string | null;
  /** Nombre del empleado/proveedor cuando aplica (Sueldos / Insumos). */
  entidadNombre?: string | null;
}

interface Listado {
  movimientos: Movimiento[];
  total: number;
  page: number;
  pageSize: number;
  sumas: { ingresos: string; egresos: string; neto: string };
}

// 12 por página: entra en pantalla sin scrollear y mantiene las queries
// baratas contra el pooler (las cajas corren con connection_limit=1).
const PAGE_SIZE = 12;

type Periodo =
  | 'todo'
  | 'sesion'
  | 'sesion_anterior'
  | 'hoy'
  | 'semana'
  | 'mes'
  | 'custom';

const PERIODOS: Array<{ value: Periodo; label: string }> = [
  // "Todo" = sin ventana temporal: busca sobre TODA la base. La paginación es
  // la que acota, no un rango implícito.
  { value: 'todo', label: 'Todo' },
  { value: 'sesion', label: 'Sesión actual' },
  { value: 'sesion_anterior', label: 'Sesión anterior' },
  { value: 'hoy', label: 'Hoy' },
  { value: 'semana', label: 'Semana' },
  { value: 'mes', label: 'Mes' },
  { value: 'custom', label: 'Personalizado' },
];

/**
 * Rango ISO (desde/hasta) para los períodos de fecha. `sesion` y `custom` se
 * manejan aparte. Calcula con fecha LOCAL (las cajas corren en TZ AR), así
 * "Hoy" arranca a las 00:00 de Argentina.
 */
function rangoDeFecha(p: Periodo): { desde?: string; hasta?: string } {
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  const finHoy = new Date(y, mo, d, 23, 59, 59, 999).toISOString();
  if (p === 'hoy') return { desde: new Date(y, mo, d, 0, 0, 0, 0).toISOString(), hasta: finHoy };
  if (p === 'semana') {
    const dow = (now.getDay() + 6) % 7; // 0 = lunes
    return { desde: new Date(y, mo, d - dow, 0, 0, 0, 0).toISOString(), hasta: finHoy };
  }
  if (p === 'mes') return { desde: new Date(y, mo, 1, 0, 0, 0, 0).toISOString(), hasta: finHoy };
  return {};
}

/** Convierte un value de <input type="date"> (yyyy-mm-dd) a ISO local. */
function fechaInputAIso(value: string, finDelDia: boolean): string | undefined {
  if (!value) return undefined;
  const [yy, mm, dd] = value.split('-').map(Number);
  if (!yy || !mm || !dd) return undefined;
  const date = finDelDia
    ? new Date(yy, mm - 1, dd, 23, 59, 59, 999)
    : new Date(yy, mm - 1, dd, 0, 0, 0, 0);
  return date.toISOString();
}

export default function AdminMovimientosPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const cuentaIdParam = searchParams.get('cuentaId') ?? '';

  const [data, setData] = useState<Listado | null>(null);
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [tipoFiltro, setTipoFiltro] = useState<string>('');
  const [cuentaFiltro, setCuentaFiltro] = useState<string>(cuentaIdParam);
  const [periodo, setPeriodo] = useState<Periodo>('sesion');
  const [customDesde, setCustomDesde] = useState('');
  const [customHasta, setCustomHasta] = useState('');
  const [page, setPage] = useState(1);
  // Buscador libre (observación, categoría, cuenta, usuario, monto exacto).
  // Debounced para no disparar una query por tecla.
  const [busqueda, setBusqueda] = useState('');
  const [busquedaDebounced, setBusquedaDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setBusquedaDebounced(busqueda.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [busqueda]);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // ID del movimiento que la encargada hizo click → abre el modal de detalle
  const [detalleId, setDetalleId] = useState<string | null>(null);

  // Sincronizar filtro con URL al cambiar (back/forward o navegación lateral)
  useEffect(() => {
    setCuentaFiltro(cuentaIdParam);
    setPage(1);
  }, [cuentaIdParam]);

  // Los filtros de la búsqueda, SIN paginación. Vive afuera del fetch para que
  // el botón de exportar use exactamente los mismos: si armara los suyos, el
  // Excel terminaría mostrando algo distinto de lo que hay en pantalla.
  const paramsDeFiltros = useCallback((): URLSearchParams => {
    const params = new URLSearchParams();
    if (tipoFiltro) params.set('tipo', tipoFiltro);
    if (cuentaFiltro) params.set('cuentaId', cuentaFiltro);
    if (busquedaDebounced) params.set('q', busquedaDebounced);
    if (periodo === 'todo') {
      // Sin ventana temporal: el server barre toda la base y pagina.
      params.set('periodo', 'todo');
    } else if (periodo === 'sesion') {
      params.set('sesion', 'actual');
    } else if (periodo === 'sesion_anterior') {
      params.set('sesion', 'anterior');
    } else if (periodo === 'custom') {
      const desde = fechaInputAIso(customDesde, false);
      const hasta = fechaInputAIso(customHasta, true);
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);
    } else {
      const { desde, hasta } = rangoDeFecha(periodo);
      if (desde) params.set('desde', desde);
      if (hasta) params.set('hasta', hasta);
    }
    return params;
  }, [tipoFiltro, cuentaFiltro, busquedaDebounced, periodo, customDesde, customHasta]);

  const fetchMovimientos = useCallback(async () => {
    setLoading(true);
    try {
      const params = paramsDeFiltros();
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      const res = await api.get<Listado>(`/admin/movimientos?${params.toString()}`);
      setData(res);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los movimientos');
      }
    } finally {
      setLoading(false);
    }
  }, [page, tipoFiltro, cuentaFiltro, periodo, customDesde, customHasta, busquedaDebounced]);

  // Mantener URL en sync con el filtro (para que se pueda compartir el link)
  function setCuentaFiltroSync(id: string) {
    setCuentaFiltro(id);
    setPage(1);
    const next = new URLSearchParams(searchParams.toString());
    if (id) next.set('cuentaId', id);
    else next.delete('cuentaId');
    router.replace(`/admin/movimientos${next.toString() ? `?${next.toString()}` : ''}`);
  }

  useEffect(() => {
    void fetchMovimientos();
  }, [fetchMovimientos]);

  const refetchCategorias = useCallback(async (): Promise<Categoria[]> => {
    try {
      const cat = await api.get<{ categorias: Categoria[] }>('/admin/categorias-movimiento');
      setCategorias(cat.categorias);
      return cat.categorias;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const c = await api.get<{ cuentas: Cuenta[] }>('/admin/cuentas');
        setCuentas(c.cuentas);
        await refetchCategorias();
      } catch {
        /* silencioso */
      }
    })();
  }, [refetchCategorias]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-xl text-ink-900">Movimientos</h1>
          <p className="text-sm text-ink-500">
            {data?.total ?? 0} movimiento{(data?.total ?? 0) !== 1 && 's'}
          </p>
        </div>
        <Button onClick={() => setShowForm(true)}>+ Nuevo movimiento</Button>
      </header>

      {/* Sumas */}
      {data && (
        <section className="grid grid-cols-3 gap-2 sm:gap-4">
          <div className="card p-3 sm:p-4 min-w-0">
            <div className="text-xs text-ink-500 uppercase tracking-wide">Ingresos</div>
            <MoneyAmount value={data.sumas.ingresos} fit className="text-lg text-basil-600" />
          </div>
          <div className="card p-3 sm:p-4 min-w-0">
            <div className="text-xs text-ink-500 uppercase tracking-wide">Egresos</div>
            <MoneyAmount value={data.sumas.egresos} fit className="text-lg text-pomodoro-600" />
          </div>
          <div className="card p-3 sm:p-4 min-w-0">
            <div className="text-xs text-ink-500 uppercase tracking-wide">Neto</div>
            <MoneyAmount
              value={data.sumas.neto}
              fit
              className={cn(
                'text-lg',
                Number(data.sumas.neto) >= 0 ? 'text-teresita-700' : 'text-pomodoro-600',
              )}
            />
          </div>
        </section>
      )}

      {/* Filtros */}
      <section className="card p-3 space-y-3">
        {/* Buscador libre */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="🔎 Buscar: descripción, categoría, cuenta, quién cargó, monto…"
            className="input flex-1 min-w-[240px]"
          />
          {(busqueda || periodo !== 'sesion') && (
            <button
              onClick={() => {
                setBusqueda('');
                setPeriodo('sesion');
                setPage(1);
              }}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-cream-200 text-ink-700 hover:bg-cream-300 transition-colors"
            >
              Limpiar
            </button>
          )}
          {data && (
            <span className="text-2xs text-ink-500 tabular-nums ml-auto">
              {loading ? 'buscando…' : `${data.total} resultado${data.total === 1 ? '' : 's'}`}
              {periodo === 'todo' && !loading && data.total > 0 && ' · base completa'}
            </span>
          )}
          <BotonExportarExcel
            path={`/admin/movimientos?${paramsDeFiltros().toString()}`}
            nombre="movimientos.xlsx"
            deshabilitado={!data || data.total === 0}
          />
        </div>

        {/* Período */}
        <div className="flex flex-wrap gap-2 items-center border-t border-cream-200 pt-3">
          {PERIODOS.map((p) => (
            <button
              key={p.value}
              onClick={() => {
                setPeriodo(p.value);
                setPage(1);
              }}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm font-medium border transition-colors',
                periodo === p.value
                  ? 'bg-teresita-700 text-white border-teresita-700'
                  : 'bg-white border-cream-300 text-ink-700 hover:bg-cream-50',
              )}
            >
              {p.label}
            </button>
          ))}
          {periodo === 'custom' && (
            <div className="flex items-center gap-2 ml-1">
              <input
                type="date"
                value={customDesde}
                onChange={(e) => {
                  setCustomDesde(e.target.value);
                  setPage(1);
                }}
                className="input w-auto text-sm"
                title="Desde"
              />
              <span className="text-ink-500 text-sm">→</span>
              <input
                type="date"
                value={customHasta}
                onChange={(e) => {
                  setCustomHasta(e.target.value);
                  setPage(1);
                }}
                className="input w-auto text-sm"
                title="Hasta"
              />
            </div>
          )}
        </div>

        {/* Tipo + cuenta */}
        <div className="flex flex-wrap gap-3 items-center border-t border-cream-200 pt-3">
          <select
            value={tipoFiltro}
            onChange={(e) => {
              setTipoFiltro(e.target.value);
              setPage(1);
            }}
            className="input w-auto"
          >
            <option value="">Todos los tipos</option>
            <option value="INGRESO">Ingresos</option>
            <option value="EGRESO">Egresos</option>
            <option value="TRANSFERENCIA_INTERNA">Transferencias</option>
            <option value="AJUSTE">Ajustes</option>
          </select>
          <select
            value={cuentaFiltro}
            onChange={(e) => setCuentaFiltroSync(e.target.value)}
            className="input w-auto"
          >
            <option value="">Todas las cuentas</option>
            {cuentas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
          {cuentaFiltro && (
            <button
              onClick={() => setCuentaFiltroSync('')}
              className="text-xs text-teresita-700 hover:underline"
            >
              ✕ quitar filtro de cuenta
            </button>
          )}
        </div>
      </section>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      {/* Tabla */}
      <section className="card overflow-hidden">
        <table className="w-full text-sm hidden md:table">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Fecha</th>
              <th className="text-left px-4 py-2">Tipo</th>
              <th className="text-left px-4 py-2">Categoría</th>
              <th className="text-left px-4 py-2">Aclaración</th>
              <th className="text-left px-4 py-2">Cuenta</th>
              <th className="text-right px-4 py-2">Monto</th>
              <th className="text-left px-4 py-2">Usuario</th>
              <th className="text-center px-4 py-2">Estado</th>
              <th className="text-center px-4 py-2 w-24">Acciones</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {loading && (
              <tr>
                <td colSpan={9} className="text-center text-ink-500 py-8">
                  Cargando...
                </td>
              </tr>
            )}
            {!loading && data?.movimientos.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center text-ink-500 py-8">
                  Sin movimientos
                </td>
              </tr>
            )}
            {data?.movimientos.map((m) => {
              const esIngreso = m.tipo === 'INGRESO' || m.tipo === 'LIQUIDACION';
              const esEgreso = m.tipo === 'EGRESO';
              const cuenta =
                m.tipo === 'TRANSFERENCIA_INTERNA'
                  ? `${m.cuentaOrigen?.nombre ?? '—'} → ${m.cuentaDestino?.nombre ?? '—'}`
                  : m.cuentaOrigen?.nombre ?? m.cuentaDestino?.nombre ?? '—';
              return (
                <tr
                  key={m.id}
                  onClick={() => setDetalleId(m.id)}
                  className={cn(
                    'hover:bg-cream-100 cursor-pointer',
                    m.estado === 'ANULADO' && 'opacity-50',
                  )}
                  title="Click para ver detalle e historial"
                >
                  <td className="px-4 py-2 font-mono text-ink-700 text-xs">
                    {new Date(m.fechaComputo).toLocaleDateString('es-AR', {
                      timeZone: 'America/Argentina/Buenos_Aires',
                      day: '2-digit',
                      month: '2-digit',
                    })}{' '}
                    {new Date(m.fechaComputo).toLocaleTimeString('es-AR', {
                      timeZone: 'America/Argentina/Buenos_Aires',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {m.modificado && (
                      <span
                        className="ml-2 text-2xs px-1.5 py-0.5 bg-saffron-100 text-saffron-600 rounded"
                        title={
                          m.modificadoAt
                            ? `Modificado: ${new Date(m.modificadoAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`
                            : 'Modificado'
                        }
                      >
                        ✎ MOD
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={cn(
                        'text-2xs font-medium px-2 py-0.5 rounded uppercase',
                        esIngreso && 'bg-basil-100 text-basil-600',
                        esEgreso && 'bg-pomodoro-100 text-pomodoro-600',
                        m.tipo === 'TRANSFERENCIA_INTERNA' && 'bg-ocean-100 text-ocean-600',
                        m.tipo === 'AJUSTE' && 'bg-saffron-100 text-saffron-600',
                      )}
                    >
                      {m.tipo.toLowerCase().replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ink-700">
                    {m.categoria.nombre}
                    {m.entidadNombre && (
                      <span className="text-ink-500"> ({m.entidadNombre})</span>
                    )}
                  </td>
                  <td
                    className="px-4 py-2 text-ink-500 text-xs max-w-[16rem] truncate"
                    title={m.observacion ?? ''}
                  >
                    {m.observacion ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-ink-700 text-xs">{cuenta}</td>
                  <td className="px-4 py-2 text-right">
                    <MoneyAmount
                      value={m.monto}
                      className={cn(
                        esIngreso && 'text-basil-600',
                        esEgreso && 'text-pomodoro-600',
                        m.estado === 'ANULADO' && 'line-through',
                      )}
                    />
                  </td>
                  <td className="px-4 py-2 text-ink-500 text-xs">{m.usuario.nombre}</td>
                  <td className="px-4 py-2 text-center">
                    <span
                      className={cn(
                        'text-2xs font-medium uppercase tracking-wider',
                        m.estado === 'CONFIRMADO' && 'text-basil-600',
                        m.estado === 'ANULADO' && 'text-pomodoro-600',
                        m.estado === 'PENDIENTE' && 'text-saffron-600',
                      )}
                    >
                      {m.estado.toLowerCase()}
                    </span>
                  </td>
                  <td
                    className="px-4 py-2 text-center"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {m.estado !== 'ANULADO' && (
                      <div className="flex justify-center gap-1">
                        <button
                          onClick={() => setDetalleId(m.id)}
                          className="px-1.5 py-0.5 text-ink-500 hover:text-saffron-600 hover:bg-saffron-100 rounded"
                          title="Editar / ver detalle"
                        >
                          ✏️
                        </button>
                        <button
                          onClick={() => setDetalleId(m.id)}
                          className="px-1.5 py-0.5 text-ink-500 hover:text-pomodoro-600 hover:bg-pomodoro-100 rounded"
                          title="Anular"
                        >
                          🗑️
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Tarjetas (mobile) */}
        <div className="md:hidden divide-y divide-cream-200">
          {loading && <div className="p-6 text-center text-ink-500">Cargando...</div>}
          {!loading && data?.movimientos.length === 0 && (
            <div className="p-6 text-center text-ink-500">Sin movimientos</div>
          )}
          {data?.movimientos.map((m) => {
            const esIngreso = m.tipo === 'INGRESO' || m.tipo === 'LIQUIDACION';
            const esEgreso = m.tipo === 'EGRESO';
            const cuenta =
              m.tipo === 'TRANSFERENCIA_INTERNA'
                ? `${m.cuentaOrigen?.nombre ?? '—'} → ${m.cuentaDestino?.nombre ?? '—'}`
                : m.cuentaOrigen?.nombre ?? m.cuentaDestino?.nombre ?? '—';
            return (
              <div
                key={m.id}
                onClick={() => setDetalleId(m.id)}
                className={cn('p-3 active:bg-cream-100', m.estado === 'ANULADO' && 'opacity-50')}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={cn(
                          'text-2xs font-medium px-2 py-0.5 rounded uppercase',
                          esIngreso && 'bg-basil-100 text-basil-600',
                          esEgreso && 'bg-pomodoro-100 text-pomodoro-600',
                          m.tipo === 'TRANSFERENCIA_INTERNA' && 'bg-ocean-100 text-ocean-600',
                          m.tipo === 'AJUSTE' && 'bg-saffron-100 text-saffron-600',
                        )}
                      >
                        {m.tipo.toLowerCase().replace('_', ' ')}
                      </span>
                      {m.modificado && (
                        <span className="text-2xs px-1.5 py-0.5 bg-saffron-100 text-saffron-600 rounded">
                          ✎ MOD
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-ink-900 mt-1 truncate">
                      {m.categoria.nombre}
                      {m.entidadNombre && (
                        <span className="text-ink-500"> ({m.entidadNombre})</span>
                      )}
                    </div>
                    {m.observacion && (
                      <div
                        className="text-2xs text-ink-500 truncate"
                        title={m.observacion}
                      >
                        {m.observacion}
                      </div>
                    )}
                    <div className="text-2xs font-mono text-ink-500 truncate">
                      {cuenta} ·{' '}
                      {new Date(m.fechaComputo).toLocaleDateString('es-AR', {
                        timeZone: 'America/Argentina/Buenos_Aires',
                        day: '2-digit',
                        month: '2-digit',
                      })}{' '}
                      {new Date(m.fechaComputo).toLocaleTimeString('es-AR', {
                        timeZone: 'America/Argentina/Buenos_Aires',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      · {m.usuario.nombre}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <MoneyAmount
                      value={m.monto}
                      className={cn(
                        'text-md',
                        esIngreso && 'text-basil-600',
                        esEgreso && 'text-pomodoro-600',
                        m.estado === 'ANULADO' && 'line-through',
                      )}
                    />
                    <div
                      className={cn(
                        'text-2xs uppercase tracking-wider',
                        m.estado === 'CONFIRMADO' && 'text-basil-600',
                        m.estado === 'ANULADO' && 'text-pomodoro-600',
                        m.estado === 'PENDIENTE' && 'text-saffron-600',
                      )}
                    >
                      {m.estado.toLowerCase()}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {detalleId && (
        <MovimientoDetailModal
          movimientoId={detalleId}
          cuentas={cuentas}
          onClose={() => setDetalleId(null)}
          onUpdated={() => void fetchMovimientos()}
        />
      )}

      {data && (
        <div className="card overflow-hidden">
          <Paginacion
            page={page}
            totalPages={totalPages}
            total={data.total}
            pageSize={PAGE_SIZE}
            onPage={setPage}
            loading={loading}
          />
        </div>
      )}

      {showForm && (
        <FormNuevoMovimiento
          cuentas={cuentas}
          categorias={categorias}
          onCategoriasChange={refetchCategorias}
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            void fetchMovimientos();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Form crear movimiento
// ────────────────────────────────────────────────────────────────────────

interface EmpleadoLite {
  id: string;
  nombre: string;
  apellido: string | null;
  puesto: string;
}

interface ProveedorLite {
  id: string;
  nombre: string;
  saldoAdeudado: string;
  facturasPendientes: number;
}

type MetodoPagoProveedor =
  | 'EFECTIVO'
  | 'TRANSFERENCIA'
  | 'DEPOSITO'
  | 'CHEQUE'
  | 'MERCADOPAGO_QR'
  | 'OTRO';

const METODOS_PAGO_PROVEEDOR: Array<{ value: MetodoPagoProveedor; label: string }> = [
  { value: 'TRANSFERENCIA', label: '🏦 Transferencia' },
  { value: 'EFECTIVO', label: '💵 Efectivo' },
  { value: 'DEPOSITO', label: '🏦 Depósito' },
  { value: 'CHEQUE', label: '📝 Cheque' },
  { value: 'MERCADOPAGO_QR', label: '📱 MP / QR' },
  { value: 'OTRO', label: 'Otro' },
];

const CONCEPTOS_SUELDO = [
  { value: 'JORNADA', label: 'Jornada' },
  { value: 'HORAS_EXTRA', label: 'Horas extra' },
  { value: 'AGUINALDO', label: 'Aguinaldo' },
  { value: 'VACACIONES', label: 'Vacaciones' },
  { value: 'ADELANTO', label: 'Adelanto' },
  { value: 'OTRO', label: 'Otro' },
] as const;
type ConceptoTipo = (typeof CONCEPTOS_SUELDO)[number]['value'];

interface ConceptoLinea {
  tipo: ConceptoTipo;
  monto: string;
  detalle?: string;
}

interface CuentaLinea {
  cuentaId: string;
  monto: string;
}

function FormNuevoMovimiento({
  cuentas,
  categorias,
  onCategoriasChange,
  onClose,
  onCreated,
}: {
  cuentas: Cuenta[];
  categorias: Categoria[];
  onCategoriasChange: () => Promise<Categoria[]>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tipo, setTipo] = useState<'INGRESO' | 'EGRESO' | 'TRANSFERENCIA_INTERNA'>('EGRESO');
  const [monto, setMonto] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  // Crear categoría nueva al vuelo (la encargada agrega conceptos recurrentes
  // que no están en la lista). Cuando agregaCat=true mostramos el input inline.
  const [agregaCat, setAgregaCat] = useState(false);
  const [nuevaCatNombre, setNuevaCatNombre] = useState('');
  const [creandoCat, setCreandoCat] = useState(false);
  const [errorCat, setErrorCat] = useState<string | null>(null);
  // Multi-cuenta para INGRESO / EGRESO. Para TRANSFERENCIA_INTERNA usamos un origen y un destino únicos.
  const [cuentasLineas, setCuentasLineas] = useState<CuentaLinea[]>([
    { cuentaId: '', monto: '' },
  ]);
  const [cuentaDestinoId, setCuentaDestinoId] = useState(''); // sólo para TRANSFERENCIA
  const [observacion, setObservacion] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Empleados (cargado on-demand cuando se elige una categoría de personal)
  const [empleados, setEmpleados] = useState<EmpleadoLite[]>([]);
  const [empleadoId, setEmpleadoId] = useState<string>('');
  const [conceptos, setConceptos] = useState<ConceptoLinea[]>([
    { tipo: 'JORNADA', monto: '' },
  ]);

  // Una factura del proveedor que todavía debe plata.
  interface FacturaPendiente {
    id: string;
    numero: string;
    tipoComprobante: string;
    fechaEmision: string;
    total: string;
    totalPagado: string;
    saldo: string;
  }

  // Proveedores (cargado on-demand cuando se elige categoría "Insumos / Pago a proveedor")
  const [proveedores, setProveedores] = useState<ProveedorLite[]>([]);
  const [proveedorId, setProveedorId] = useState<string>('');
  const [metodoPago, setMetodoPago] = useState<MetodoPagoProveedor>('TRANSFERENCIA');
  // Nº de operación bancaria o código interno de referencia. Lo pedimos
  // cuando la categoría es proveedor (pago a cuenta corriente). Si el pago
  // es por transferencia/depósito, debería tener el nº de operación. Si es
  // efectivo, la encargada pone un código nuestro (ej "EF-20260510-001").
  const [numeroReferencia, setNumeroReferencia] = useState<string>('');

  // Facturas impagas del proveedor elegido + a cuáles se imputa este pago.
  //
  // `montos` guarda lo que se le asigna a cada factura tildada. Vacío = "lo que
  // toque": el server la llena de la más vieja a la más nueva con lo que quede.
  // Así el caso normal (pagar facturas enteras) es tildar y listo, y el pago
  // parcial es escribir un número en una.
  const [facturasProv, setFacturasProv] = useState<FacturaPendiente[]>([]);
  const [facturasElegidas, setFacturasElegidas] = useState<Record<string, string>>({});

  // Categorías disponibles para el tipo elegido
  const categoriasFiltradas = categorias.filter((c) => {
    if (tipo === 'TRANSFERENCIA_INTERNA') return c.tipo === 'TRANSFERENCIA' || c.tipo === 'AMBOS';
    return c.tipo === tipo || c.tipo === 'AMBOS';
  });

  // ¿Es egreso a empleado? (Sueldos / Adelanto a empleado)
  const categoriaActual = categorias.find((c) => c.id === categoriaId);
  const esCategoriaSueldo =
    tipo === 'EGRESO' &&
    categoriaActual !== undefined &&
    /sueldo|adelanto a empleado/i.test(categoriaActual.nombre);

  // ¿Es egreso a proveedor? (Insumos / Pago a proveedor)
  const esCategoriaProveedor =
    tipo === 'EGRESO' &&
    categoriaActual !== undefined &&
    /insumos|proveedor/i.test(categoriaActual.nombre);

  // Proveedor seleccionado actual (para mostrar saldo y nombre en el resumen)
  const proveedorActual = proveedores.find((p) => p.id === proveedorId);

  // Cargar empleados cuando se entra a categoría de sueldo
  useEffect(() => {
    if (esCategoriaSueldo && empleados.length === 0) {
      void (async () => {
        try {
          const res = await api.get<{ empleados: EmpleadoLite[] }>('/admin/empleados');
          setEmpleados(res.empleados);
        } catch {
          /* silencioso */
        }
      })();
    }
  }, [esCategoriaSueldo, empleados.length]);

  // Cargar proveedores cuando se entra a categoría de pago a proveedor
  useEffect(() => {
    if (esCategoriaProveedor && proveedores.length === 0) {
      void (async () => {
        try {
          const res = await api.get<{ proveedores: ProveedorLite[] }>('/admin/proveedores');
          setProveedores(res.proveedores);
        } catch {
          /* silencioso */
        }
      })();
    }
  }, [esCategoriaProveedor, proveedores.length]);

  // Facturas impagas del proveedor elegido. Se recargan cada vez que cambia el
  // proveedor y se limpia lo tildado: las facturas de uno no valen para el otro.
  useEffect(() => {
    setFacturasElegidas({});
    if (!esCategoriaProveedor || !proveedorId) {
      setFacturasProv([]);
      return;
    }
    void (async () => {
      try {
        const res = await api.get<{ facturas: FacturaPendiente[] }>(
          `/admin/proveedores/${proveedorId}/facturas-pendientes`,
        );
        setFacturasProv(res.facturas);
      } catch {
        setFacturasProv([]);
      }
    })();
  }, [esCategoriaProveedor, proveedorId]);

  // Sumatoria de conceptos (cuando aplica) — sobrescribe el monto manual
  const sumaConceptos = conceptos.reduce((acc, c) => acc + Number(c.monto || 0), 0);
  useEffect(() => {
    if (esCategoriaSueldo && sumaConceptos > 0) {
      setMonto(sumaConceptos.toFixed(2));
    }
  }, [esCategoriaSueldo, sumaConceptos]);

  // Resetear categoría si no aplica al tipo nuevo
  useEffect(() => {
    if (categoriaId && !categoriasFiltradas.some((c) => c.id === categoriaId)) {
      setCategoriaId('');
    }
  }, [tipo, categoriaId, categoriasFiltradas]);

  // Crear categoría nueva con tipo AMBOS: queda disponible tanto en ingresos
  // como en egresos (y transferencias), así la encargada la encuentra siempre
  // sin importar desde qué tipo de movimiento la creó. Tras crear, refrescamos
  // la lista del padre y la dejamos seleccionada.
  async function crearCategoria() {
    const nombre = nuevaCatNombre.trim();
    if (!nombre) {
      setErrorCat('Escribí un nombre');
      return;
    }
    setCreandoCat(true);
    setErrorCat(null);
    try {
      const creada = await api.post<{ id: string }>('/admin/categorias-movimiento', {
        nombre,
        tipo: 'AMBOS',
      });
      await onCategoriasChange();
      setCategoriaId(creada.id);
      setAgregaCat(false);
      setNuevaCatNombre('');
    } catch (e) {
      setErrorCat(e instanceof Error ? e.message : 'No se pudo crear la categoría');
    } finally {
      setCreandoCat(false);
    }
  }

  // Eliminar la categoría seleccionada (sólo las que no son de sistema).
  async function eliminarCategoria() {
    if (!categoriaActual) return;
    if (!confirm(`¿Eliminar la categoría "${categoriaActual.nombre}"?`)) return;
    setErrorCat(null);
    try {
      await api.delete(`/admin/categorias-movimiento/${categoriaActual.id}`);
      setCategoriaId('');
      await onCategoriasChange();
    } catch (e) {
      setErrorCat(e instanceof Error ? e.message : 'No se pudo eliminar la categoría');
    }
  }

  function setConcepto(idx: number, patch: Partial<ConceptoLinea>) {
    setConceptos((arr) => arr.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function addConcepto() {
    setConceptos((arr) => [...arr, { tipo: 'OTRO', monto: '' }]);
  }
  function removeConcepto(idx: number) {
    setConceptos((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }

  // Helpers multi-cuenta (sólo aplica a INGRESO / EGRESO)
  const usaMulti = tipo !== 'TRANSFERENCIA_INTERNA';
  const totalAsignado = cuentasLineas.reduce((acc, c) => acc + Number(c.monto || 0), 0);
  const montoNum = Number(monto || 0);
  const faltante = montoNum - totalAsignado;
  const cuadra = Math.abs(faltante) < 0.5;

  // Auto-fill: cuando hay UNA sola cuenta destino, monto = monto total del
  // movimiento. Se distribuye manualmente solo cuando hay 2+ cuentas. Antes
  // el campo arrancaba vacío y había que retipear el total.
  useEffect(() => {
    if (usaMulti && cuentasLineas.length === 1 && montoNum > 0) {
      const totalStr = montoNum.toFixed(2);
      if (cuentasLineas[0]!.monto !== totalStr) {
        setCuentasLineas((arr) =>
          arr.map((c, i) => (i === 0 ? { ...c, monto: totalStr } : c)),
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [montoNum, cuentasLineas.length, usaMulti]);

  function setCuentaLinea(idx: number, patch: Partial<CuentaLinea>) {
    setCuentasLineas((arr) => arr.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function addCuentaLinea() {
    const restoSugerido = Math.max(0, faltante);
    setCuentasLineas((arr) => [
      ...arr,
      { cuentaId: '', monto: restoSugerido > 0 ? restoSugerido.toFixed(2) : '' },
    ]);
  }
  function removeCuentaLinea(idx: number) {
    setCuentasLineas((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }
  function autocompletarResto(idx: number) {
    const otras = cuentasLineas.reduce(
      (acc, c, i) => (i === idx ? acc : acc + Number(c.monto || 0)),
      0,
    );
    const resto = Math.max(0, montoNum - otras);
    setCuentaLinea(idx, { monto: resto.toFixed(2) });
  }

  async function submit() {
    setError(null);
    if (!monto || montoNum <= 0) return setError('Monto inválido');
    if (!categoriaId) return setError('Elegí una categoría');

    if (usaMulti) {
      if (cuentasLineas.some((c) => !c.cuentaId)) {
        return setError('Hay una línea de cuenta sin elegir');
      }
      if (cuentasLineas.some((c) => Number(c.monto || 0) <= 0)) {
        return setError('Cada cuenta tiene que tener un monto > 0');
      }
      if (!cuadra) {
        return setError(
          faltante > 0
            ? `Falta asignar $${faltante.toFixed(2)} entre cuentas`
            : `Asignaste $${(-faltante).toFixed(2)} de más`,
        );
      }
      // Cuentas distintas (no permitir misma cuenta dos veces)
      const ids = cuentasLineas.map((c) => c.cuentaId);
      if (new Set(ids).size !== ids.length) {
        return setError('No podés repetir la misma cuenta dos veces');
      }
    } else {
      // TRANSFERENCIA_INTERNA: usa la primera línea como origen + cuentaDestinoId
      const origen = cuentasLineas[0]?.cuentaId;
      if (!origen || !cuentaDestinoId)
        return setError('Elegí cuenta origen y destino');
      if (origen === cuentaDestinoId)
        return setError('Origen y destino no pueden ser la misma cuenta');
    }

    if (esCategoriaSueldo) {
      if (!empleadoId) return setError('Elegí qué empleado va a cobrar');
      if (conceptos.some((c) => Number(c.monto) <= 0))
        return setError('Cada concepto tiene que tener monto > 0');
    }

    if (esCategoriaProveedor) {
      if (!proveedorId) return setError('Elegí el proveedor a quién se le paga');
      if (cuentasLineas.length !== 1 || !cuentasLineas[0]?.cuentaId) {
        return setError('Para pago a proveedor elegí una sola cuenta de origen');
      }
      // Lo escrito a mano no puede pasarse del pago; lo que quedó vacío lo
      // reparte el server, así que no entra en esta cuenta.
      const fijado = Object.values(facturasElegidas)
        .filter((v) => v !== '')
        .reduce((a, v) => a + Number(v || 0), 0);
      if (fijado > Number(monto) + 0.01) {
        return setError(
          `Estás repartiendo $${fijado.toLocaleString('es-AR')} entre las facturas y el pago es de $${Number(monto).toLocaleString('es-AR')}`,
        );
      }
    }

    setGuardando(true);
    try {
      // Pago a proveedor. El sistema NO adivina contra qué factura va: con
      // varias abiertas, alocar FIFO por su cuenta cancelaba la que no era.
      // Lo elige la encargada tildando facturas (y, si paga sólo una parte,
      // escribiendo cuánto va a cada una). Sin tildar nada sigue siendo un
      // pago a cuenta, como antes.
      if (esCategoriaProveedor && proveedorId) {
        const facturas = Object.entries(facturasElegidas).map(([facturaId, m]) => ({
          facturaId,
          // Vacío = "lo que haga falta": lo completa el server de la más vieja
          // a la más nueva.
          ...(m.trim() !== '' && { monto: Number(m).toFixed(2) }),
        }));
        await api.post('/admin/pagos-a-cuenta', {
          proveedorId,
          pagos: [
            {
              cuentaId: cuentasLineas[0]!.cuentaId,
              metodo: metodoPago,
              monto,
              numeroReferencia: numeroReferencia.trim() || undefined,
            },
          ],
          ...(facturas.length > 0 && { facturas }),
          observaciones: observacion || undefined,
        });
        onCreated();
        return;
      }

      if (!usaMulti) {
        // TRANSFERENCIA_INTERNA simple
        await api.post('/admin/movimientos', {
          tipo,
          monto,
          categoriaId,
          cuentaOrigenId: cuentasLineas[0]!.cuentaId,
          cuentaDestinoId,
          observacion: observacion || undefined,
        });
      } else if (cuentasLineas.length === 1) {
        // Una sola cuenta — flujo normal
        const linea = cuentasLineas[0]!;
        await api.post('/admin/movimientos', {
          tipo,
          monto,
          categoriaId,
          cuentaOrigenId: tipo === 'EGRESO' ? linea.cuentaId : undefined,
          cuentaDestinoId: tipo === 'INGRESO' ? linea.cuentaId : undefined,
          observacion: observacion || undefined,
          ...(esCategoriaSueldo && {
            entidadId: empleadoId,
            conceptos: conceptos.map((c) => ({
              tipo: c.tipo,
              monto: c.monto,
              detalle: c.detalle || undefined,
            })),
          }),
        });
      } else {
        // Multi-cuenta: creamos N movimientos enlazados con tag (1/3, 2/3...)
        const total = cuentasLineas.length;
        const obs = observacion || `${tipo === 'EGRESO' ? 'Egreso' : 'Ingreso'} multi-cuenta`;
        for (let i = 0; i < cuentasLineas.length; i++) {
          const linea = cuentasLineas[i]!;
          await api.post('/admin/movimientos', {
            tipo,
            monto: linea.monto,
            categoriaId,
            cuentaOrigenId: tipo === 'EGRESO' ? linea.cuentaId : undefined,
            cuentaDestinoId: tipo === 'INGRESO' ? linea.cuentaId : undefined,
            observacion: `${obs} (parte ${i + 1}/${total})`,
            ...(esCategoriaSueldo &&
              i === 0 && {
                entidadId: empleadoId,
                conceptos: conceptos.map((c) => ({
                  tipo: c.tipo,
                  monto: c.monto,
                  detalle: c.detalle || undefined,
                })),
              }),
            ...(esCategoriaSueldo && i > 0 && { entidadId: empleadoId }),
          });
        }
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear el movimiento');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-lg shadow-modal max-h-[90vh] flex flex-col">
        <header className="px-5 py-4 border-b border-cream-300 flex justify-between items-center">
          <h2 className="font-display text-lg text-teresita-700">Nuevo movimiento</h2>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-900 text-xl leading-none">
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Tipo */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-2">Tipo</label>
            <div className="grid grid-cols-3 gap-2">
              {(['INGRESO', 'EGRESO', 'TRANSFERENCIA_INTERNA'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTipo(t)}
                  className={cn(
                    'py-2 px-3 rounded-md text-sm font-medium border transition-colors',
                    tipo === t
                      ? t === 'INGRESO'
                        ? 'bg-basil-600 text-white border-basil-600'
                        : t === 'EGRESO'
                          ? 'bg-pomodoro-600 text-white border-pomodoro-600'
                          : 'bg-ocean-600 text-white border-ocean-600'
                      : 'bg-white border-cream-300 text-ink-700 hover:bg-cream-50',
                  )}
                >
                  {t === 'TRANSFERENCIA_INTERNA' ? 'Transferencia' : t.toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Monto */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">Monto</label>
            <input
              type="number"
              step="0.01"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              className="input font-mono text-lg"
              placeholder="0.00"
              autoFocus
            />
          </div>

          {/* Categoría */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">Categoría</label>
            {!agregaCat ? (
              <>
                <select
                  value={categoriaId}
                  onChange={(e) => {
                    if (e.target.value === '__nueva__') {
                      setAgregaCat(true);
                      setErrorCat(null);
                      return;
                    }
                    setCategoriaId(e.target.value);
                  }}
                  className="input"
                >
                  <option value="">Elegí categoría...</option>
                  {categoriasFiltradas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}
                      {!c.esOperativa && ' · no operativa'}
                    </option>
                  ))}
                  <option value="__nueva__">➕ Agregar categoría nueva…</option>
                </select>
                <div className="mt-1 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setAgregaCat(true);
                      setErrorCat(null);
                    }}
                    className="text-xs text-teresita-700 hover:underline"
                  >
                    ➕ Agregar una categoría que no está en la lista
                  </button>
                  {categoriaActual && !categoriaActual.esSistema && (
                    <button
                      type="button"
                      onClick={eliminarCategoria}
                      className="text-xs text-pomodoro-600 hover:underline"
                    >
                      🗑 Eliminar "{categoriaActual.nombre}"
                    </button>
                  )}
                </div>
                {errorCat && !agregaCat && (
                  <p className="text-2xs text-pomodoro-600 mt-1">{errorCat}</p>
                )}
              </>
            ) : (
              <div className="rounded-md border border-teresita-700/40 bg-teresita-50/50 p-3 space-y-2">
                <div className="text-2xs uppercase tracking-wider text-teresita-700 font-semibold">
                  Nueva categoría
                </div>
                <input
                  type="text"
                  value={nuevaCatNombre}
                  onChange={(e) => setNuevaCatNombre(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void crearCategoria();
                    }
                  }}
                  placeholder="Ej: Alquiler, Limpieza, Reparación heladera…"
                  className="input w-full"
                  maxLength={80}
                  autoFocus
                />
                {errorCat && <p className="text-2xs text-pomodoro-600">{errorCat}</p>}
                <p className="text-2xs text-ink-500">
                  Queda guardada para usarla siempre. Aparece tanto en ingresos como en egresos.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={crearCategoria} disabled={creandoCat}>
                    {creandoCat ? 'Guardando…' : 'Guardar categoría'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setAgregaCat(false);
                      setNuevaCatNombre('');
                      setErrorCat(null);
                    }}
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Sub-form para Insumos / Pago a proveedor */}
          {esCategoriaProveedor && (
            <div className="rounded-md border border-saffron-600/40 bg-saffron-100/40 p-3 space-y-3">
              <div className="text-2xs uppercase tracking-wider text-saffron-600 font-semibold">
                Pago a proveedor
              </div>
              <div>
                <label className="block text-2xs font-medium text-ink-700 mb-1">Proveedor</label>
                <select
                  value={proveedorId}
                  onChange={(e) => setProveedorId(e.target.value)}
                  className="input text-sm"
                >
                  <option value="">Elegí proveedor...</option>
                  {proveedores
                    .slice()
                    .sort((a, b) => Number(b.saldoAdeudado) - Number(a.saldoAdeudado))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre}
                        {Number(p.saldoAdeudado) > 0
                          ? ` · debe $${Number(p.saldoAdeudado).toLocaleString('es-AR', { minimumFractionDigits: 2 })} (${p.facturasPendientes} fact.)`
                          : ' · sin deuda'}
                      </option>
                    ))}
                </select>
              </div>

              {proveedorActual && (
                <div className="bg-white rounded-md p-2.5 border border-cream-300 text-xs space-y-1">
                  <div className="flex justify-between items-baseline">
                    <span className="text-ink-500">Saldo pendiente:</span>
                    <span
                      className={cn(
                        'font-mono font-semibold tabular-nums',
                        Number(proveedorActual.saldoAdeudado) > 0
                          ? 'text-pomodoro-600'
                          : 'text-basil-600',
                      )}
                    >
                      <MoneyAmount value={proveedorActual.saldoAdeudado} />
                    </span>
                  </div>
                  {Number(monto || 0) > 0 && (
                    <>
                      <div className="flex justify-between items-baseline">
                        <span className="text-ink-500">Pago a aplicar:</span>
                        <span className="font-mono tabular-nums">
                          <MoneyAmount value={Number(monto).toFixed(2)} />
                        </span>
                      </div>
                      <hr className="border-cream-200 my-1" />
                      <div className="flex justify-between items-baseline">
                        <span className="text-ink-700 font-medium">Saldo nuevo:</span>
                        {(() => {
                          const nuevo = Math.max(
                            0,
                            Number(proveedorActual.saldoAdeudado) - Number(monto || 0),
                          );
                          const exceso =
                            Number(monto || 0) - Number(proveedorActual.saldoAdeudado);
                          return (
                            <div className="text-right">
                              <span className="font-mono font-semibold tabular-nums text-basil-600">
                                <MoneyAmount value={nuevo.toFixed(2)} />
                              </span>
                              {exceso > 0.01 && (
                                <div className="text-2xs text-saffron-600">
                                  Excedente $
                                  {exceso.toLocaleString('es-AR', { minimumFractionDigits: 2 })}{' '}
                                  · queda como saldo a favor
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                      <p className="text-2xs text-ink-400 mt-1.5">
                        {Object.keys(facturasElegidas).length > 0
                          ? 'Se descuenta de las facturas tildadas abajo.'
                          : 'Sin facturas tildadas se registra como pago a cuenta: baja el saldo total del proveedor, pero las facturas siguen figurando impagas.'}
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* Contra qué facturas va el pago.
                  Sin esto, el egreso salía de la caja y las facturas quedaban
                  impagas: había que ir a marcarlas a mano desde Insumos. Y no
                  alcanzaba con "tildar y saldar entera", porque muchas veces se
                  paga sólo una parte — de ahí el casillero de monto por factura. */}
              {proveedorId && facturasProv.length > 0 && (
                <div className="bg-white rounded-md border border-cream-300 p-2.5 space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-2xs uppercase tracking-wider text-ink-500 font-semibold">
                      ¿De qué facturas se descuenta?
                    </span>
                    <button
                      type="button"
                      className="text-2xs text-teresita-700 hover:underline"
                      onClick={() => {
                        // "Las más viejas primero": tilda de arriba hacia abajo
                        // hasta cubrir el monto, y a la última le pone lo que
                        // sobra. Es lo que la encargada hace a mano casi siempre.
                        let resto = Number(monto || 0);
                        const next: Record<string, string> = {};
                        for (const f of facturasProv) {
                          if (resto <= 0.01) break;
                          const saldo = Number(f.saldo);
                          const aplica = Math.min(resto, saldo);
                          next[f.id] = aplica >= saldo - 0.01 ? '' : aplica.toFixed(2);
                          resto = Number((resto - aplica).toFixed(2));
                        }
                        setFacturasElegidas(next);
                      }}
                    >
                      Las más viejas primero
                    </button>
                  </div>

                  <ul className="space-y-1 max-h-44 overflow-y-auto">
                    {facturasProv.map((f) => {
                      const tildada = f.id in facturasElegidas;
                      return (
                        <li key={f.id} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={tildada}
                            onChange={(e) =>
                              setFacturasElegidas((prev) => {
                                const next = { ...prev };
                                if (e.target.checked) next[f.id] = '';
                                else delete next[f.id];
                                return next;
                              })
                            }
                            className="shrink-0"
                          />
                          <span className="font-mono text-2xs shrink-0">{f.numero}</span>
                          <span className="text-ink-400 text-2xs shrink-0">
                            {new Date(f.fechaEmision).toLocaleDateString('es-AR')}
                          </span>
                          <span className="text-ink-500 ml-auto shrink-0">
                            debe <MoneyAmount value={f.saldo} />
                          </span>
                          <input
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            disabled={!tildada}
                            value={facturasElegidas[f.id] ?? ''}
                            onChange={(e) =>
                              setFacturasElegidas((prev) => ({ ...prev, [f.id]: e.target.value }))
                            }
                            placeholder="todo"
                            title="Cuánto de este pago va a esta factura. Vacío = lo que haga falta para saldarla."
                            className="input text-2xs font-mono w-20 shrink-0 disabled:opacity-40"
                          />
                        </li>
                      );
                    })}
                  </ul>

                  {(() => {
                    // Sólo cuenta lo escrito a mano: lo que quedó vacío lo
                    // reparte el server, así que acá no se puede anticipar.
                    const fijado = Object.values(facturasElegidas)
                      .filter((v) => v !== '')
                      .reduce((a, v) => a + Number(v || 0), 0);
                    if (fijado <= Number(monto || 0) + 0.01) return null;
                    return (
                      <p className="text-2xs text-pomodoro-600">
                        Estás repartiendo ${fijado.toLocaleString('es-AR')} entre las facturas y el
                        pago es de ${Number(monto || 0).toLocaleString('es-AR')}.
                      </p>
                    );
                  })()}
                </div>
              )}

              {proveedorId && facturasProv.length === 0 && (
                <p className="text-2xs text-ink-400">
                  Este proveedor no tiene facturas impagas cargadas. El pago queda a cuenta.
                </p>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-2xs font-medium text-ink-700 mb-1">
                    Método de pago
                  </label>
                  <select
                    value={metodoPago}
                    onChange={(e) => setMetodoPago(e.target.value as MetodoPagoProveedor)}
                    className="input text-sm"
                  >
                    {METODOS_PAGO_PROVEEDOR.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-2xs font-medium text-ink-700 mb-1">
                    Nº de referencia
                  </label>
                  <input
                    type="text"
                    value={numeroReferencia}
                    onChange={(e) => setNumeroReferencia(e.target.value)}
                    placeholder={
                      metodoPago === 'TRANSFERENCIA' || metodoPago === 'DEPOSITO' || metodoPago === 'CHEQUE'
                        ? 'Nº operación bancaria'
                        : 'ej. EF-001 (opcional)'
                    }
                    maxLength={80}
                    className="input text-sm font-mono"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Sub-form para Sueldos / Adelanto a empleado */}
          {esCategoriaSueldo && (
            <div className="rounded-md border border-pomodoro-100 bg-pomodoro-50/40 p-3 space-y-3">
              <div className="text-2xs uppercase tracking-wider text-pomodoro-600 font-semibold">
                Pago a empleado · desglose por concepto
              </div>
              <div>
                <label className="block text-2xs font-medium text-ink-700 mb-1">Empleado</label>
                <select
                  value={empleadoId}
                  onChange={(e) => setEmpleadoId(e.target.value)}
                  className="input text-sm"
                >
                  <option value="">Elegí empleado...</option>
                  {empleados.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.nombre} {e.apellido ?? ''} · {e.puesto.toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-2xs font-medium text-ink-700 mb-1">
                  Conceptos (la suma se aplica como monto total)
                </label>
                <div className="space-y-2">
                  {conceptos.map((c, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={c.tipo}
                        onChange={(e) =>
                          setConcepto(idx, { tipo: e.target.value as ConceptoTipo })
                        }
                        className="input text-xs py-1.5 flex-1"
                      >
                        {CONCEPTOS_SUELDO.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        step="0.01"
                        value={c.monto}
                        onChange={(e) => setConcepto(idx, { monto: e.target.value })}
                        placeholder="0.00"
                        className="input text-xs py-1.5 font-mono w-32 text-right"
                      />
                      <button
                        type="button"
                        onClick={() => removeConcepto(idx)}
                        disabled={conceptos.length === 1}
                        className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded text-xs disabled:opacity-30"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {conceptos.some((c) => c.tipo === 'OTRO') && (
                    <input
                      type="text"
                      value={conceptos.find((c) => c.tipo === 'OTRO')?.detalle ?? ''}
                      onChange={(e) => {
                        const idx = conceptos.findIndex((c) => c.tipo === 'OTRO');
                        if (idx >= 0) setConcepto(idx, { detalle: e.target.value });
                      }}
                      placeholder="Detalle del concepto 'Otro' (opcional)"
                      className="input text-xs py-1.5"
                    />
                  )}
                </div>
                <button
                  type="button"
                  onClick={addConcepto}
                  className="mt-2 text-xs text-teresita-700 hover:underline"
                >
                  + Agregar otro concepto
                </button>
                {sumaConceptos > 0 && (
                  <div className="mt-2 text-xs text-ink-700">
                    Total a pagar:{' '}
                    <span className="font-mono font-semibold text-pomodoro-600">
                      {new Intl.NumberFormat('es-AR', {
                        style: 'currency',
                        currency: 'ARS',
                      }).format(sumaConceptos)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Cuentas: para INGRESO/EGRESO permitimos múltiples cuentas (split).
              Para TRANSFERENCIA_INTERNA: 1 origen + 1 destino. */}
          {usaMulti ? (
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1">
                {tipo === 'EGRESO' ? 'Sale de' : 'Entra a'}
                <span className="text-2xs text-ink-500 font-normal ml-1">
                  (podés repartir en varias cuentas)
                </span>
              </label>
              <div className="space-y-2">
                {cuentasLineas.map((linea, idx) => (
                  <div key={idx} className="flex gap-2 items-start">
                    <select
                      value={linea.cuentaId}
                      onChange={(e) => setCuentaLinea(idx, { cuentaId: e.target.value })}
                      className="input text-sm flex-1"
                    >
                      <option value="">Elegí cuenta...</option>
                      {cuentas.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nombre}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      value={linea.monto}
                      onChange={(e) => setCuentaLinea(idx, { monto: e.target.value })}
                      placeholder="0.00"
                      className="input text-sm font-mono w-32 text-right"
                    />
                    {cuentasLineas.length > 1 && Math.abs(faltante) > 0.5 && (
                      <button
                        type="button"
                        onClick={() => autocompletarResto(idx)}
                        className="px-2 py-1.5 text-2xs bg-saffron-100 text-saffron-600 rounded border border-saffron-600/40 hover:bg-saffron-600 hover:text-white whitespace-nowrap"
                        title="Autocompletar con el resto que falta"
                      >
                        Resto
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeCuentaLinea(idx)}
                      disabled={cuentasLineas.length === 1}
                      className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded disabled:opacity-30"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={addCuentaLinea}
                className="mt-2 text-xs text-teresita-700 hover:underline"
              >
                + Agregar otra cuenta
              </button>

              {/* Resumen Asignado / Faltante / Sobra */}
              {montoNum > 0 && cuentasLineas.length > 0 && (
                <div className="mt-2 bg-surface-sunken rounded-md px-3 py-2 grid grid-cols-2 gap-y-1 text-sm font-mono">
                  <span className="text-ink-700">Asignado:</span>
                  <span
                    className={cn(
                      'text-right',
                      cuadra && totalAsignado > 0 && 'text-basil-600 font-semibold',
                    )}
                  >
                    $ {totalAsignado.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                  </span>
                  {Math.abs(faltante) > 0.5 ? (
                    <>
                      <span
                        className={cn(
                          'font-semibold',
                          faltante > 0 ? 'text-pomodoro-600' : 'text-saffron-600',
                        )}
                      >
                        {faltante > 0 ? 'Falta:' : 'Sobra:'}
                      </span>
                      <span
                        className={cn(
                          'text-right font-semibold',
                          faltante > 0 ? 'text-pomodoro-600' : 'text-saffron-600',
                        )}
                      >
                        $ {Math.abs(faltante).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                      </span>
                    </>
                  ) : (
                    totalAsignado > 0 && (
                      <>
                        <span className="text-basil-600">✓ Cuadra</span>
                        <span></span>
                      </>
                    )
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1">Sale de</label>
                <select
                  value={cuentasLineas[0]?.cuentaId ?? ''}
                  onChange={(e) => setCuentaLinea(0, { cuentaId: e.target.value, monto: monto })}
                  className="input"
                >
                  <option value="">Elegí cuenta...</option>
                  {cuentas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1">Entra a</label>
                <select
                  value={cuentaDestinoId}
                  onChange={(e) => setCuentaDestinoId(e.target.value)}
                  className="input"
                >
                  <option value="">Elegí cuenta...</option>
                  {cuentas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* Observación */}
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Observación (opcional)
            </label>
            <input
              type="text"
              value={observacion}
              onChange={(e) => setObservacion(e.target.value)}
              className="input"
              placeholder="ej. número de operación, persona, contexto..."
            />
          </div>

          {error && (
            <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-cream-300 bg-surface-sunken flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={guardando}>
            {guardando ? 'Guardando...' : 'Crear movimiento'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
