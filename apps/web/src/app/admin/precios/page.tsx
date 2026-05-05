'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

interface ProductoLista {
  id: string;
  codigo: string | null;
  nombre: string;
  marca: string | null;
  presentacion: string | null;
  precioBase: string;
  unidadPrecio: string;
  formaVenta: string;
  categoria: string;
  tipoNombre: string;
  ultimoCambio: {
    fecha: string;
    precioAnterior: string;
    deltaPct: number | null;
    motivo: string | null;
  } | null;
}

interface Aprobacion {
  id: string;
  archivoNombre: string;
  modificadoEn: string;
  modificadoPor: string | null;
  detectadoAt: string;
  cambiosTotal: number;
  cambiosAplicables: number;
  cambiosSospechosos: number;
  cambiosErrores: number;
  estado: 'PENDIENTE' | 'APROBADA' | 'RECHAZADA' | 'POSPUESTA' | 'APLICADA_PARCIAL';
  aprobadaAt: string | null;
  aprobadaPor: string | null;
}

interface CambioPrecio {
  tipo: 'PRECIO_CAMBIA';
  cambioId: string;
  productoId: string;
  codigo: string | null;
  nombreProducto: string;
  categoria: string;
  precioAnterior: string;
  precioNuevo: string;
  deltaPct: number;
}

interface ProductoSospechoso {
  tipo: 'PRODUCTO_NO_ENCONTRADO';
  cambioId: string;
  codigo: string | null;
  nombreSugerido: string;
  categoria: string | null;
  precioPropuesto: string;
  posibleMatchNombre: string | null;
}

interface ErrorExcel {
  tipo: string;
  mensaje: string;
}

interface AprobacionDetalle extends Aprobacion {
  observaciones: string | null;
  diff: {
    fuente: string;
    archivoNombre: string;
    cambios: CambioPrecio[];
    sospechosos: ProductoSospechoso[];
    errores: ErrorExcel[];
    resumen: {
      cambiosAplicables: number;
      sospechosos: number;
      errores: number;
      sinCambios: number;
    };
  };
}

interface CambioHistorial {
  id: string;
  fecha: string;
  productoId: string;
  productoNombre: string;
  productoCodigo: string | null;
  categoria: string;
  precioAnterior: string;
  precioNuevo: string;
  deltaPct: number | null;
  motivo: string | null;
  usuario: string | null;
  lista: string | null;
}

interface Categoria {
  id: string;
  nombre: string;
}

function unidadShort(unidadPrecio: string, formaVenta: string): string {
  switch (unidadPrecio) {
    case 'POR_KILO':
      return '/kg';
    case 'POR_GRAMO':
      return '/g';
    case 'POR_DOCENA':
      return '/doc';
    case 'POR_PORCION':
      return '/porc';
    case 'POR_PLANCHA':
      return '/pl';
    default:
      return formaVenta === 'GRAMO' ? '/g' : '/u';
  }
}

function formatRel(iso: string): string {
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (dias === 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 30) return `hace ${dias} días`;
  if (dias < 365) return `hace ${Math.floor(dias / 30)} meses`;
  return `hace ${Math.floor(dias / 365)} años`;
}

export default function AdminPreciosPage() {
  const [vista, setVista] = useState<'lista' | 'historial' | 'aprobaciones'>('lista');
  const [productos, setProductos] = useState<ProductoLista[]>([]);
  const [historial, setHistorial] = useState<CambioHistorial[]>([]);
  const [aprobaciones, setAprobaciones] = useState<Aprobacion[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [search, setSearch] = useState('');
  const [categoriaFiltro, setCategoriaFiltro] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Estado del flujo de Excel sync
  const [buscando, setBuscando] = useState(false);
  const [resultadoBusqueda, setResultadoBusqueda] = useState<{
    resumen: string;
    tone: 'success' | 'warning' | 'danger';
  } | null>(null);
  const [aprobacionAbierta, setAprobacionAbierta] = useState<AprobacionDetalle | null>(null);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);

  async function refetchAprobaciones() {
    try {
      const aprob = await api.get<{ aprobaciones: Aprobacion[] }>(
        '/admin/precios/aprobaciones',
      );
      setAprobaciones(aprob.aprobaciones);
    } catch {
      /* silencioso */
    }
  }

  async function buscarCambiosExcel() {
    setBuscando(true);
    setResultadoBusqueda(null);
    try {
      const res = await api.post<{
        resultados: Array<{
          fuente: string;
          aprobacionId: string;
          cambiosAplicables: number;
          sospechosos: number;
          errores: number;
        }>;
        errores: Array<{ fuente: string; mensaje: string }>;
      }>('/admin/precios/buscar-cambios', { fuente: 'AMBAS' });
      const totalCambios = res.resultados.reduce((acc, r) => acc + r.cambiosAplicables, 0);
      const totalSosp = res.resultados.reduce((acc, r) => acc + r.sospechosos, 0);
      const totalErr = res.resultados.reduce((acc, r) => acc + r.errores, 0);
      if (res.errores.length > 0) {
        setResultadoBusqueda({
          resumen: `Hubo errores en ${res.errores.length} fuente(s): ${res.errores
            .map((e) => `${e.fuente}: ${e.mensaje}`)
            .join(' · ')}`,
          tone: 'danger',
        });
      } else if (totalCambios + totalSosp + totalErr === 0) {
        setResultadoBusqueda({
          resumen: 'No se detectaron cambios. Los Excels están alineados con la base.',
          tone: 'success',
        });
      } else {
        setResultadoBusqueda({
          resumen: `${totalCambios} cambios, ${totalSosp} sospechosos, ${totalErr} errores. Revisalos abajo.`,
          tone: 'warning',
        });
      }
      await refetchAprobaciones();
    } catch (e) {
      setResultadoBusqueda({
        resumen: e instanceof Error ? e.message : 'Error al buscar cambios',
        tone: 'danger',
      });
    } finally {
      setBuscando(false);
    }
  }

  async function abrirAprobacion(id: string) {
    setCargandoDetalle(true);
    setError(null);
    try {
      const det = await api.get<AprobacionDetalle>(`/admin/precios/aprobaciones/${id}`);
      setAprobacionAbierta(det);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el detalle');
    } finally {
      setCargandoDetalle(false);
    }
  }

  const fetchLista = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (categoriaFiltro) params.set('categoriaId', categoriaFiltro);
      const res = await api.get<{ productos: ProductoLista[] }>(
        `/admin/precios/lista?${params.toString()}`,
      );
      setProductos(res.productos);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los precios');
      }
    } finally {
      setLoading(false);
    }
  }, [search, categoriaFiltro]);

  // Carga lateral: categorías + aprobaciones (para el banner) en cualquier vista
  useEffect(() => {
    (async () => {
      try {
        const [cats, aprob] = await Promise.all([
          api.get<{ categorias: Categoria[] }>('/catalogo/categorias'),
          api.get<{ aprobaciones: Aprobacion[] }>('/admin/precios/aprobaciones'),
        ]);
        setCategorias(cats.categorias);
        setAprobaciones(aprob.aprobaciones);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  useEffect(() => {
    if (vista === 'lista') void fetchLista();
    if (vista === 'historial') {
      (async () => {
        setLoading(true);
        try {
          const res = await api.get<{ cambios: CambioHistorial[] }>(
            '/admin/precios/historial?limit=100',
          );
          setHistorial(res.cambios);
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 401) {
            setError('No se pudo cargar el historial');
          }
        } finally {
          setLoading(false);
        }
      })();
    }
    if (vista === 'aprobaciones') setLoading(false);
  }, [vista, fetchLista]);

  const stats = useMemo(() => {
    const conCambioReciente = productos.filter((p) => {
      if (!p.ultimoCambio) return false;
      const dias = (Date.now() - new Date(p.ultimoCambio.fecha).getTime()) / 86_400_000;
      return dias < 30;
    }).length;
    const promedio =
      productos.length > 0
        ? productos.reduce((acc, p) => acc + Number(p.precioBase), 0) / productos.length
        : 0;
    return { total: productos.length, conCambioReciente, promedio };
  }, [productos]);

  const aprobacionesPendientes = aprobaciones.filter((a) => a.estado === 'PENDIENTE');

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-xl text-ink-900">Lista de precios</h1>
          <p className="text-sm text-ink-500">
            Vista enfocada en precios. Para editar productos, sus modificadores o estados,{' '}
            <Link href="/admin/productos" className="text-teresita-700 hover:underline">
              ir al catálogo
            </Link>
            .
          </p>
        </div>
      </header>

      {/* Banner de aprobaciones pendientes (si hay) */}
      {aprobacionesPendientes.length > 0 && (
        <section className="card p-4 border-l-4 border-saffron-600 bg-saffron-100/50">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-md text-saffron-600">
                ⚠ {aprobacionesPendientes.length} cambio
                {aprobacionesPendientes.length > 1 ? 's' : ''} de Excel pendiente
                {aprobacionesPendientes.length > 1 ? 's' : ''} de aprobar
              </h2>
              <ul className="text-xs text-ink-700 mt-2 space-y-1">
                {aprobacionesPendientes.slice(0, 3).map((a) => (
                  <li key={a.id}>
                    · <span className="font-medium">{a.archivoNombre}</span> —{' '}
                    {a.cambiosAplicables} aplicables, {a.cambiosSospechosos} sospechosos,{' '}
                    {a.cambiosErrores} con error · detectado {formatRel(a.detectadoAt)}
                  </li>
                ))}
              </ul>
            </div>
            <Button size="sm" onClick={() => setVista('aprobaciones')}>
              Revisar →
            </Button>
          </div>
        </section>
      )}

      {/* Tabs de vista */}
      <nav className="flex gap-1 border-b border-cream-300">
        {(
          [
            { v: 'lista', label: 'Precios actuales' },
            { v: 'historial', label: 'Historial de cambios' },
            { v: 'aprobaciones', label: `Aprobaciones (${aprobaciones.length})` },
          ] as const
        ).map((t) => (
          <button
            key={t.v}
            onClick={() => setVista(t.v)}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors border-b-2',
              vista === t.v
                ? 'border-teresita-700 text-teresita-700'
                : 'border-transparent text-ink-500 hover:text-ink-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">
          {error}
        </div>
      )}

      {/* Vista: lista de precios */}
      {vista === 'lista' && (
        <>
          {/* KPIs */}
          <section className="grid grid-cols-3 gap-4">
            <div className="card p-4">
              <div className="text-xs text-ink-500 uppercase tracking-wide">Total productos</div>
              <div className="font-display text-xl text-teresita-900 mt-1">{stats.total}</div>
              <div className="text-xs text-ink-500 mt-1">activos en venta</div>
            </div>
            <div className="card p-4">
              <div className="text-xs text-ink-500 uppercase tracking-wide">
                Cambiados últimos 30d
              </div>
              <div className="font-display text-xl text-saffron-600 mt-1">
                {stats.conCambioReciente}
              </div>
              <div className="text-xs text-ink-500 mt-1">productos con precio actualizado</div>
            </div>
            <div className="card p-4">
              <div className="text-xs text-ink-500 uppercase tracking-wide">Precio promedio</div>
              <MoneyAmount
                value={stats.promedio.toFixed(2)}
                className="font-display text-xl text-teresita-900 mt-1 block"
              />
              <div className="text-xs text-ink-500 mt-1">sobre catálogo activo</div>
            </div>
          </section>

          {/* Filtros */}
          <section className="card p-3 flex flex-wrap gap-3 items-center">
            <input
              type="search"
              placeholder="🔍 Buscar producto..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input flex-1 min-w-[200px]"
            />
            <select
              value={categoriaFiltro}
              onChange={(e) => setCategoriaFiltro(e.target.value)}
              className="input w-auto"
            >
              <option value="">Todas las categorías</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
          </section>

          <section className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
                <tr>
                  <th className="text-left px-4 py-2 w-16">Cód.</th>
                  <th className="text-left px-4 py-2">Producto</th>
                  <th className="text-left px-4 py-2">Categoría</th>
                  <th className="text-right px-4 py-2">Precio actual</th>
                  <th className="text-left px-4 py-2">Último cambio</th>
                  <th className="px-3 py-2 w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {loading && (
                  <tr>
                    <td colSpan={6} className="text-center text-ink-500 py-8">
                      Cargando...
                    </td>
                  </tr>
                )}
                {!loading && productos.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-ink-500 py-8">
                      Sin productos
                    </td>
                  </tr>
                )}
                {productos.map((p) => {
                  const ult = p.ultimoCambio;
                  return (
                    <tr key={p.id} className="hover:bg-cream-100 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-ink-500">
                        {p.codigo ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink-900">{p.nombre}</div>
                        {(p.marca || p.presentacion) && (
                          <div className="text-2xs text-ink-500">
                            {[p.marca, p.presentacion].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-ink-700">{p.categoria}</td>
                      <td className="px-4 py-3 text-right">
                        <span className="font-mono text-md text-teresita-900">
                          <MoneyAmount value={p.precioBase} />
                        </span>
                        <span className="text-2xs text-ink-500 ml-1">
                          {unidadShort(p.unidadPrecio, p.formaVenta)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {ult ? (
                          <div className="space-y-0.5">
                            <div className="text-ink-700">{formatRel(ult.fecha)}</div>
                            {ult.deltaPct !== null && (
                              <div
                                className={cn(
                                  'font-mono',
                                  ult.deltaPct > 0 && 'text-saffron-600',
                                  ult.deltaPct < 0 && 'text-basil-600',
                                  ult.deltaPct === 0 && 'text-ink-500',
                                )}
                              >
                                {ult.deltaPct > 0 ? '↑' : ult.deltaPct < 0 ? '↓' : '→'}{' '}
                                {Math.abs(ult.deltaPct).toFixed(1)}%
                                <span className="text-ink-300 ml-1">
                                  (de <MoneyAmount value={ult.precioAnterior} />)
                                </span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-ink-300 italic">sin cambios</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <Link
                          href={`/admin/productos?q=${encodeURIComponent(p.nombre)}`}
                          className="text-2xs text-teresita-700 hover:underline whitespace-nowrap"
                        >
                          editar →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}

      {/* Vista: historial */}
      {vista === 'historial' && (
        <section className="card overflow-hidden">
          <header className="px-5 py-3 border-b border-cream-300 bg-surface-sunken">
            <h2 className="font-display text-md text-ink-900">Últimos cambios de precio</h2>
            <p className="text-xs text-ink-500">100 más recientes en todo el catálogo.</p>
          </header>
          {loading ? (
            <div className="text-ink-500 text-center py-8">Cargando...</div>
          ) : historial.length === 0 ? (
            <div className="text-ink-500 text-center py-8">
              No hay cambios de precio registrados todavía.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
                <tr>
                  <th className="text-left px-4 py-2">Fecha</th>
                  <th className="text-left px-4 py-2">Producto</th>
                  <th className="text-right px-4 py-2">Anterior</th>
                  <th className="text-right px-4 py-2">Nuevo</th>
                  <th className="text-right px-4 py-2">%</th>
                  <th className="text-left px-4 py-2">Quién / motivo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {historial.map((c) => (
                  <tr key={c.id} className="hover:bg-cream-100 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-ink-700">
                      {new Date(c.fecha).toLocaleDateString('es-AR', {
                        day: '2-digit',
                        month: '2-digit',
                        year: '2-digit',
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-ink-900">{c.productoNombre}</div>
                      <div className="text-2xs text-ink-500">
                        {c.productoCodigo ? `#${c.productoCodigo} · ` : ''}
                        {c.categoria}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-ink-500 font-mono text-xs">
                      <MoneyAmount value={c.precioAnterior} />
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-md text-teresita-900">
                      <MoneyAmount value={c.precioNuevo} />
                    </td>
                    <td
                      className={cn(
                        'px-4 py-3 text-right font-mono text-xs',
                        (c.deltaPct ?? 0) > 0 && 'text-saffron-600',
                        (c.deltaPct ?? 0) < 0 && 'text-basil-600',
                      )}
                    >
                      {c.deltaPct === null ? '—' : (
                        <>
                          {c.deltaPct > 0 ? '↑' : c.deltaPct < 0 ? '↓' : '→'}{' '}
                          {Math.abs(c.deltaPct).toFixed(1)}%
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-700">
                      {c.usuario ?? <span className="italic text-ink-300">sistema</span>}
                      {c.motivo && (
                        <div className="text-2xs text-ink-500 italic mt-0.5">{c.motivo}</div>
                      )}
                      {c.lista && (
                        <div className="text-2xs text-ink-500">vía {c.lista}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* Vista: aprobaciones */}
      {vista === 'aprobaciones' && (
        <section className="space-y-3">
          <div className="card p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h2 className="font-display text-md text-ink-900">Sincronización con Excel</h2>
                <p className="text-xs text-ink-700 mt-1 leading-relaxed">
                  Lee los Excels locales del proyecto (
                  <code className="bg-cream-200 px-1 rounded text-2xs">Lista de Precios.xlsx</code>{' '}
                  y{' '}
                  <code className="bg-cream-200 px-1 rounded text-2xs">Proveedores 2026.xlsx</code>
                  ) y compara con el catálogo. Los cambios detectados quedan acá para que los
                  revises antes de aplicarlos. La integración con Google Drive viene en la
                  próxima versión.
                </p>
              </div>
              <Button onClick={buscarCambiosExcel} disabled={buscando}>
                {buscando ? 'Buscando...' : '🔄 Buscar cambios ahora'}
              </Button>
            </div>
            {resultadoBusqueda && (
              <div
                className={cn(
                  'mt-3 px-3 py-2 rounded text-xs',
                  resultadoBusqueda.tone === 'success' && 'bg-basil-100 text-basil-600',
                  resultadoBusqueda.tone === 'warning' && 'bg-saffron-100 text-saffron-600',
                  resultadoBusqueda.tone === 'danger' && 'bg-pomodoro-100 text-pomodoro-600',
                )}
              >
                {resultadoBusqueda.resumen}
              </div>
            )}
          </div>

          {aprobaciones.length === 0 ? (
            <div className="card p-8 text-center text-ink-500">
              No hay aprobaciones registradas todavía. Tocá <strong>Buscar cambios ahora</strong>{' '}
              para correr la primera detección.
            </div>
          ) : (
            <div className="space-y-2">
              {aprobaciones.map((a) => {
                const esPendiente = a.estado === 'PENDIENTE';
                return (
                  <button
                    key={a.id}
                    onClick={() => abrirAprobacion(a.id)}
                    disabled={cargandoDetalle}
                    className={cn(
                      'card p-4 text-left w-full transition-all hover:shadow-md disabled:opacity-50',
                      esPendiente && 'border-l-4 border-saffron-600',
                    )}
                  >
                    <div className="flex items-baseline justify-between mb-2">
                      <div>
                        <div className="font-medium text-ink-900">{a.archivoNombre}</div>
                        <div className="text-xs text-ink-500">
                          Detectado{' '}
                          {new Date(a.detectadoAt).toLocaleString('es-AR', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })}
                          {a.modificadoPor && ` · por ${a.modificadoPor}`}
                        </div>
                      </div>
                      <span
                        className={cn(
                          'text-2xs font-medium px-2 py-0.5 rounded uppercase tracking-wider',
                          a.estado === 'PENDIENTE' && 'bg-saffron-100 text-saffron-600',
                          a.estado === 'APROBADA' && 'bg-basil-100 text-basil-600',
                          a.estado === 'RECHAZADA' && 'bg-pomodoro-100 text-pomodoro-600',
                          a.estado === 'POSPUESTA' && 'bg-cream-200 text-ink-500',
                          a.estado === 'APLICADA_PARCIAL' && 'bg-ocean-100 text-ocean-600',
                        )}
                      >
                        {a.estado.toLowerCase().replace('_', ' ')}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2 text-sm">
                      <div>
                        <div className="text-2xs text-ink-500 uppercase">Total filas</div>
                        <div className="font-mono">{a.cambiosTotal}</div>
                      </div>
                      <div>
                        <div className="text-2xs text-ink-500 uppercase">Aplicables</div>
                        <div className="font-mono text-basil-600">{a.cambiosAplicables}</div>
                      </div>
                      <div>
                        <div className="text-2xs text-ink-500 uppercase">Sospechosos</div>
                        <div className="font-mono text-saffron-600">{a.cambiosSospechosos}</div>
                      </div>
                      <div>
                        <div className="text-2xs text-ink-500 uppercase">Errores</div>
                        <div className="font-mono text-pomodoro-600">{a.cambiosErrores}</div>
                      </div>
                    </div>
                    {a.aprobadaPor && a.aprobadaAt && (
                      <div className="text-2xs text-ink-500 mt-2">
                        ✓ {a.estado === 'RECHAZADA' ? 'Rechazada' : 'Aprobada'} por{' '}
                        {a.aprobadaPor} el {new Date(a.aprobadaAt).toLocaleString('es-AR')}
                      </div>
                    )}
                    {esPendiente && (
                      <div className="text-2xs text-teresita-700 font-medium mt-2 hover:underline">
                        Click para revisar y aprobar →
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Modal de detalle de aprobación */}
      {aprobacionAbierta && (
        <AprobacionModal
          aprobacion={aprobacionAbierta}
          onClose={() => setAprobacionAbierta(null)}
          onAccion={async () => {
            setAprobacionAbierta(null);
            await refetchAprobaciones();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal de aprobación con diff (Wireframe 07)
// ────────────────────────────────────────────────────────────────────────

function AprobacionModal({
  aprobacion,
  onClose,
  onAccion,
}: {
  aprobacion: AprobacionDetalle;
  onClose: () => void;
  onAccion: () => void | Promise<void>;
}) {
  const esPendiente = aprobacion.estado === 'PENDIENTE';
  const cambios = aprobacion.diff.cambios ?? [];
  const sospechosos = aprobacion.diff.sospechosos ?? [];
  const errores = aprobacion.diff.errores ?? [];

  // Por defecto, todos los cambios aplicables seleccionados.
  const [seleccion, setSeleccion] = useState<Set<string>>(
    new Set(esPendiente ? cambios.map((c) => c.cambioId) : []),
  );
  const [filtro, setFiltro] = useState<'todos' | 'aplicables' | 'sospechosos' | 'errores'>(
    'todos',
  );
  const [search, setSearch] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function toggle(id: string) {
    setSeleccion((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleTodos() {
    setSeleccion((s) =>
      s.size === cambios.length ? new Set() : new Set(cambios.map((c) => c.cambioId)),
    );
  }

  const cambiosFiltrados = cambios.filter((c) => {
    if (search && !c.nombreProducto.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const sospechososFiltrados = sospechosos.filter(
    (s) => !search || s.nombreSugerido.toLowerCase().includes(search.toLowerCase()),
  );

  async function aplicar() {
    setEnviando(true);
    setErrorMsg(null);
    try {
      await api.post(`/admin/precios/aprobaciones/${aprobacion.id}/aplicar`, {
        cambioIds: Array.from(seleccion),
      });
      await onAccion();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Error al aplicar');
    } finally {
      setEnviando(false);
    }
  }

  async function rechazar() {
    if (!confirm('¿Rechazar todos los cambios? No se aplicará ninguno.')) return;
    setEnviando(true);
    setErrorMsg(null);
    try {
      await api.post(`/admin/precios/aprobaciones/${aprobacion.id}/rechazar`, {});
      await onAccion();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Error al rechazar');
    } finally {
      setEnviando(false);
    }
  }

  async function posponer() {
    setEnviando(true);
    try {
      await api.post(`/admin/precios/aprobaciones/${aprobacion.id}/posponer`, {});
      await onAccion();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Error al posponer');
    } finally {
      setEnviando(false);
    }
  }

  const mostrarCambios = filtro === 'todos' || filtro === 'aplicables';
  const mostrarSosp = filtro === 'todos' || filtro === 'sospechosos';
  const mostrarErrores = filtro === 'todos' || filtro === 'errores';

  return (
    <div
      className="fixed inset-0 bg-ink-900/60 flex items-center justify-center z-50 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className="bg-cream-50 rounded-lg shadow-modal w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 py-4 border-b border-cream-300 bg-white">
          <div className="flex items-baseline justify-between">
            <div>
              <h2 className="font-display text-lg text-teresita-700">
                Cambios detectados en Excel
              </h2>
              <div className="text-xs text-ink-500 mt-0.5">
                <span className="font-mono">{aprobacion.archivoNombre}</span>
                {aprobacion.modificadoPor && ` · modificado por ${aprobacion.modificadoPor}`}{' '}
                · detectado{' '}
                {new Date(aprobacion.detectadoAt).toLocaleString('es-AR')}
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-ink-500 hover:text-ink-900 text-xl leading-none"
              aria-label="Cerrar"
            >
              ✕
            </button>
          </div>

          {/* Resumen */}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="bg-basil-100 text-basil-600 px-2 py-0.5 rounded">
              ✓ {cambios.length} aplicables
            </span>
            <span className="bg-saffron-100 text-saffron-600 px-2 py-0.5 rounded">
              ⚠ {sospechosos.length} sospechosos
            </span>
            <span className="bg-pomodoro-100 text-pomodoro-600 px-2 py-0.5 rounded">
              ✕ {errores.length} con error
            </span>
            <span className="text-ink-500 ml-auto">
              {aprobacion.diff.resumen.sinCambios} filas sin cambios
            </span>
          </div>

          {/* Filtros + búsqueda */}
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            {(['todos', 'aplicables', 'sospechosos', 'errores'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFiltro(f)}
                className={cn(
                  'text-xs px-3 py-1 rounded-full border transition-colors',
                  filtro === f
                    ? 'bg-teresita-700 text-cream-50 border-teresita-700'
                    : 'bg-white text-ink-700 border-cream-300 hover:bg-cream-100',
                )}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
            <input
              type="search"
              placeholder="🔍 buscar producto..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input flex-1 min-w-[200px] text-xs py-1.5"
            />
          </div>
        </header>

        {/* Body scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Sección cambios aplicables */}
          {mostrarCambios && cambios.length > 0 && (
            <section className="border border-cream-300 rounded-md overflow-hidden">
              <header className="px-4 py-2 bg-basil-100 flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm font-medium text-basil-600">
                  <input
                    type="checkbox"
                    checked={seleccion.size === cambios.length && cambios.length > 0}
                    onChange={toggleTodos}
                    disabled={!esPendiente}
                  />
                  ✓ Cambios de precio ({cambiosFiltrados.length})
                </label>
                <span className="text-xs text-basil-600">
                  {seleccion.size} seleccionados
                </span>
              </header>
              <div className="divide-y divide-cream-200 text-sm">
                {cambiosFiltrados.length === 0 && (
                  <div className="px-4 py-3 text-ink-500 text-xs">
                    Ningún cambio matchea la búsqueda.
                  </div>
                )}
                {cambiosFiltrados.map((c) => {
                  const sel = seleccion.has(c.cambioId);
                  const colorDelta =
                    c.deltaPct > 20
                      ? 'text-saffron-600'
                      : c.deltaPct < 0
                        ? 'text-pomodoro-600'
                        : 'text-basil-600';
                  return (
                    <label
                      key={c.cambioId}
                      className={cn(
                        'px-4 py-2 flex items-center gap-3 cursor-pointer',
                        sel ? 'bg-basil-100/50' : 'hover:bg-cream-100',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={() => toggle(c.cambioId)}
                        disabled={!esPendiente}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-ink-900">
                          {c.codigo && (
                            <span className="font-mono text-2xs text-ink-500 mr-2">
                              {c.codigo}
                            </span>
                          )}
                          {c.nombreProducto}
                        </div>
                        <div className="text-2xs text-ink-500">{c.categoria}</div>
                      </div>
                      <div className="flex items-center gap-2 font-mono text-xs">
                        <span className="text-ink-500">
                          <MoneyAmount value={c.precioAnterior} />
                        </span>
                        <span className="text-ink-300">→</span>
                        <span className="text-ink-900 font-semibold text-md">
                          <MoneyAmount value={c.precioNuevo} />
                        </span>
                        <span className={cn('w-16 text-right', colorDelta)}>
                          {c.deltaPct > 0 ? '+' : ''}
                          {c.deltaPct.toFixed(1)}%
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          {/* Sospechosos */}
          {mostrarSosp && sospechosos.length > 0 && (
            <section className="border border-cream-300 rounded-md overflow-hidden">
              <header className="px-4 py-2 bg-saffron-100 text-saffron-600 text-sm font-medium">
                ⚠ No encontrados en el sistema ({sospechososFiltrados.length})
              </header>
              <div className="divide-y divide-cream-200 text-sm">
                {sospechososFiltrados.map((s) => (
                  <div key={s.cambioId} className="px-4 py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-ink-900">
                        {s.codigo && (
                          <span className="font-mono text-2xs text-ink-500 mr-2">
                            {s.codigo}
                          </span>
                        )}
                        {s.nombreSugerido}
                      </div>
                      <div className="text-2xs text-ink-500">
                        {s.categoria ?? 'sin categoría'}
                        {s.posibleMatchNombre &&
                          ` · ¿typo de "${s.posibleMatchNombre}"?`}
                      </div>
                    </div>
                    <div className="font-mono text-xs text-ink-700">
                      <MoneyAmount value={s.precioPropuesto} />
                    </div>
                  </div>
                ))}
              </div>
              <footer className="px-4 py-2 bg-saffron-100/30 text-2xs text-ink-700">
                Para crear un producto nuevo desde acá hace falta el flujo completo de Excel sync
                (v2). Por ahora, cargalos manualmente desde{' '}
                <Link
                  href="/admin/productos"
                  className="text-teresita-700 hover:underline"
                >
                  catálogo
                </Link>
                .
              </footer>
            </section>
          )}

          {/* Errores */}
          {mostrarErrores && errores.length > 0 && (
            <section className="border border-cream-300 rounded-md overflow-hidden">
              <header className="px-4 py-2 bg-pomodoro-100 text-pomodoro-600 text-sm font-medium">
                ✕ Errores — no se aplican ({errores.length})
              </header>
              <ul className="divide-y divide-cream-200 text-sm">
                {errores.map((e, i) => (
                  <li key={i} className="px-4 py-2 text-pomodoro-600">
                    <span className="text-2xs uppercase tracking-wider mr-2">{e.tipo}</span>
                    {e.mensaje}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!esPendiente && aprobacion.observaciones && (
            <div className="bg-cream-100 px-3 py-2 rounded text-xs text-ink-700 italic">
              Observaciones: {aprobacion.observaciones}
            </div>
          )}

          {errorMsg && (
            <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
              {errorMsg}
            </div>
          )}
        </div>

        {/* Footer sticky con acciones */}
        {esPendiente ? (
          <footer className="px-5 py-3 border-t border-cream-300 bg-white flex flex-wrap items-center gap-2 justify-end">
            <span className="text-xs text-ink-500 mr-auto">
              {seleccion.size} de {cambios.length} seleccionados
            </span>
            <Button variant="secondary" onClick={posponer} disabled={enviando}>
              Posponer
            </Button>
            <Button variant="destructive" onClick={rechazar} disabled={enviando}>
              Rechazar todo
            </Button>
            <Button onClick={aplicar} disabled={enviando || seleccion.size === 0}>
              {enviando ? 'Aplicando...' : `✓ Aplicar ${seleccion.size}`}
            </Button>
          </footer>
        ) : (
          <footer className="px-5 py-3 border-t border-cream-300 bg-white flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Cerrar
            </Button>
          </footer>
        )}
      </div>
    </div>
  );
}
