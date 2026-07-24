'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Búsqueda + filtro temporal + paginación COMPARTIDOS por las tablas pesadas de
 * admin (ventas, encargos, aportes y egresos, facturas).
 *
 * Regla de producto: sin ventana de tiempo elegida se busca sobre la base
 * COMPLETA del área. Para que eso no sea lento ni infinito, el server pagina de
 * a 12 y acá se pide una página a la vez (nunca se trae todo junto).
 */

export type PeriodoBusqueda =
  | 'todo'
  | 'sesion_actual'
  | 'sesion_anterior'
  | 'hoy'
  | 'ayer'
  | '7dias'
  | '30dias'
  | 'custom';

export const PAGE_SIZE_DEFAULT = 12;

/** Rangos por fecha. Las sesiones van aparte (son otro criterio, no un rango). */
const PERIODOS_FECHA: Array<{ key: PeriodoBusqueda; label: string }> = [
  { key: 'todo', label: 'Todo' },
  { key: 'hoy', label: 'Hoy' },
  { key: 'ayer', label: 'Ayer' },
  { key: '7dias', label: '7 días' },
  { key: '30dias', label: '30 días' },
];

const PERIODOS_SESION: Array<{ key: PeriodoBusqueda; label: string }> = [
  { key: 'sesion_actual', label: '🟢 Sesión actual' },
  { key: 'sesion_anterior', label: '⏮ Sesión anterior' },
];

type MetaPaginacion = { total: number; page: number; pageSize: number; totalPages: number };

const META_VACIA: MetaPaginacion = { total: 0, page: 1, pageSize: PAGE_SIZE_DEFAULT, totalPages: 1 };

export function useBusquedaPaginada<T>(opts: {
  /** Path del endpoint, sin query. Ej: '/admin/movimientos'. */
  endpoint: string;
  /** Saca el array de items de la respuesta (la key cambia por área). */
  extraerItems: (res: unknown) => T[];
  pageSize?: number;
  /**
   * Filtros propios del área (tipo, estado, canal…). Pasar un objeto ESTABLE
   * (useMemo en el caller) o cambiará en cada render y refetchearía en loop.
   */
  paramsExtra?: Record<string, string>;
  /** Periodo inicial. Default 'todo' = toda la base. */
  periodoInicial?: PeriodoBusqueda;
}) {
  const pageSize = opts.pageSize ?? PAGE_SIZE_DEFAULT;

  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');
  const [periodo, setPeriodo] = useState<PeriodoBusqueda>(opts.periodoInicial ?? 'todo');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<T[]>([]);
  const [meta, setMeta] = useState<MetaPaginacion>({ ...META_VACIA, pageSize });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce del texto: no disparamos una query por tecla.
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const paramsExtra = opts.paramsExtra;
  // Clave estable de "todo lo que no es la página". Si cambia, volvemos a la 1:
  // quedarse en la página 7 tras cambiar el filtro mostraría vacío sin razón.
  const filtrosKey = useMemo(
    () => JSON.stringify({ qDebounced, periodo, desde, hasta, paramsExtra }),
    [qDebounced, periodo, desde, hasta, paramsExtra],
  );
  const filtrosKeyPrev = useRef(filtrosKey);
  useEffect(() => {
    if (filtrosKeyPrev.current !== filtrosKey) {
      filtrosKeyPrev.current = filtrosKey;
      setPage(1);
    }
  }, [filtrosKey]);

  // Descarta respuestas viejas que llegan tarde (el usuario ya tipeó otra cosa).
  const reqId = useRef(0);
  const { endpoint, extraerItems } = opts;
  const extraerRef = useRef(extraerItems);
  extraerRef.current = extraerItems;

  const fetchData = useCallback(async () => {
    const mine = ++reqId.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        periodo,
      });
      if (qDebounced) params.set('q', qDebounced);
      if (periodo === 'custom') {
        if (desde) params.set('desde', new Date(desde + 'T00:00:00').toISOString());
        if (hasta) params.set('hasta', new Date(hasta + 'T23:59:59').toISOString());
      }
      for (const [k, v] of Object.entries(paramsExtra ?? {})) {
        if (v) params.set(k, v);
      }
      const res = await api.get<Record<string, unknown>>(`${endpoint}?${params.toString()}`);
      if (mine !== reqId.current) return; // llegó tarde
      setItems(extraerRef.current(res));
      setMeta({
        total: Number(res.total ?? 0),
        page: Number(res.page ?? 1),
        pageSize: Number(res.pageSize ?? pageSize),
        totalPages: Number(res.totalPages ?? 1),
      });
      setError(null);
    } catch (e) {
      if (mine !== reqId.current) return;
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los resultados');
        setItems([]);
        setMeta({ ...META_VACIA, pageSize });
      }
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, [endpoint, page, pageSize, periodo, qDebounced, desde, hasta, paramsExtra]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const limpiar = useCallback(() => {
    setQ('');
    setPeriodo('todo');
    setDesde('');
    setHasta('');
    setPage(1);
  }, []);

  return {
    q, setQ,
    periodo, setPeriodo,
    desde, setDesde,
    hasta, setHasta,
    page, setPage,
    items, meta, loading, error,
    refetch: fetchData,
    limpiar,
    hayFiltro: !!qDebounced || periodo !== 'todo',
  };
}

/** Barra de búsqueda + chips de temporalidad + rango personalizado. */
export function BuscadorFiltros({
  q,
  onQ,
  periodo,
  onPeriodo,
  desde,
  onDesde,
  hasta,
  onHasta,
  placeholder,
  total,
  loading,
  onLimpiar,
  hayFiltro,
  children,
}: {
  q: string;
  onQ: (v: string) => void;
  periodo: PeriodoBusqueda;
  onPeriodo: (p: PeriodoBusqueda) => void;
  desde: string;
  onDesde: (v: string) => void;
  hasta: string;
  onHasta: (v: string) => void;
  placeholder: string;
  total: number;
  loading?: boolean;
  onLimpiar: () => void;
  hayFiltro: boolean;
  /** Filtros propios del área (selects de tipo/estado/canal…). */
  children?: React.ReactNode;
}) {
  return (
    <section className="card p-3 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder={placeholder}
          className="input flex-1 min-w-[240px]"
        />
        {children}
        {hayFiltro && (
          <button
            onClick={onLimpiar}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-cream-200 text-ink-700 hover:bg-cream-300 transition-colors"
          >
            Limpiar
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {PERIODOS_FECHA.map((p) => (
          <ChipPeriodo key={p.key} activo={periodo === p.key} onClick={() => onPeriodo(p.key)}>
            {p.label}
          </ChipPeriodo>
        ))}
        <span className="self-center mx-0.5 h-5 w-px bg-cream-300" aria-hidden />
        {PERIODOS_SESION.map((p) => (
          <ChipPeriodo key={p.key} activo={periodo === p.key} onClick={() => onPeriodo(p.key)}>
            {p.label}
          </ChipPeriodo>
        ))}
        <span className="self-center mx-0.5 h-5 w-px bg-cream-300" aria-hidden />
        <ChipPeriodo activo={periodo === 'custom'} onClick={() => onPeriodo('custom')}>
          Personalizado
        </ChipPeriodo>

        {periodo === 'custom' && (
          <span className="flex items-center gap-1.5 ml-1">
            <input
              type="date"
              value={desde}
              onChange={(e) => onDesde(e.target.value)}
              className="input py-1 text-xs"
            />
            <span className="text-2xs text-ink-500">a</span>
            <input
              type="date"
              value={hasta}
              onChange={(e) => onHasta(e.target.value)}
              className="input py-1 text-xs"
            />
          </span>
        )}

        <span className="ml-auto text-2xs text-ink-500 tabular-nums">
          {loading ? 'buscando…' : `${total} resultado${total === 1 ? '' : 's'}`}
          {periodo === 'todo' && !loading && total > 0 && ' · base completa'}
        </span>
      </div>
    </section>
  );
}

function ChipPeriodo({
  activo,
  onClick,
  children,
}: {
  activo: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
        activo
          ? 'bg-teresita-700 text-cream-50'
          : 'bg-cream-200 text-ink-700 hover:bg-cream-300',
      )}
    >
      {children}
    </button>
  );
}

/** Navegación de páginas. Se oculta sola si hay una sola página. */
export function Paginacion({
  page,
  totalPages,
  total,
  pageSize,
  onPage,
  loading,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
  loading?: boolean;
}) {
  if (totalPages <= 1) return null;

  const desde = (page - 1) * pageSize + 1;
  const hasta = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-cream-300 bg-surface-sunken flex-wrap">
      <span className="text-2xs text-ink-500 tabular-nums">
        {desde}–{hasta} de {total}
      </span>
      <div className="flex items-center gap-1">
        <BotonPagina onClick={() => onPage(1)} disabled={page === 1 || loading}>
          ««
        </BotonPagina>
        <BotonPagina onClick={() => onPage(page - 1)} disabled={page === 1 || loading}>
          ‹ Anterior
        </BotonPagina>
        {numerosDePagina(page, totalPages).map((n, i) =>
          n === '…' ? (
            <span key={`gap-${i}`} className="px-1.5 text-2xs text-ink-300">
              …
            </span>
          ) : (
            <BotonPagina
              key={n}
              onClick={() => onPage(n)}
              disabled={loading}
              activo={n === page}
            >
              {n}
            </BotonPagina>
          ),
        )}
        <BotonPagina onClick={() => onPage(page + 1)} disabled={page >= totalPages || loading}>
          Siguiente ›
        </BotonPagina>
        <BotonPagina onClick={() => onPage(totalPages)} disabled={page >= totalPages || loading}>
          »»
        </BotonPagina>
      </div>
    </div>
  );
}

function BotonPagina({
  onClick,
  disabled,
  activo,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  activo?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'px-2.5 py-1 rounded-md text-2xs font-medium transition-colors tabular-nums',
        activo
          ? 'bg-teresita-700 text-cream-50'
          : 'bg-cream-200 text-ink-700 hover:bg-cream-300',
        disabled && !activo && 'opacity-40 cursor-not-allowed hover:bg-cream-200',
      )}
    >
      {children}
    </button>
  );
}

/** Ventana de páginas con elipsis: 1 … 4 [5] 6 … 20 */
function numerosDePagina(page: number, totalPages: number): Array<number | '…'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const out: Array<number | '…'> = [1];
  const ini = Math.max(2, page - 1);
  const fin = Math.min(totalPages - 1, page + 1);
  if (ini > 2) out.push('…');
  for (let n = ini; n <= fin; n++) out.push(n);
  if (fin < totalPages - 1) out.push('…');
  out.push(totalPages);
  return out;
}
