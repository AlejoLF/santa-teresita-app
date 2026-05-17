'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface Categoria {
  id: string;
  nombre: string;
  icono?: string | null;
}

interface Producto {
  id: string;
  nombre: string;
  marca: string | null;
  presentacion: string | null;
  codigo: string | null;
  precioBase: string;
  formaVenta: string;
  unidadPrecio: string;
  cantidadDefault: string | null;
  activo: boolean;
  tipoProducto: {
    id: string;
    nombre: string;
    cocinaInterviene: boolean;
    categoria: { id: string; nombre: string; icono?: string | null };
  };
}

interface ListadoResp {
  productos: Producto[];
  total: number;
  page: number;
  pageSize: number;
}

interface HistorialPrecio {
  id: string;
  precioAnterior: string;
  precioNuevo: string;
  fechaCambio: string;
  motivo: string | null;
  lista: { nombre: string } | null;
}

const PAGE_SIZE = 50;

function unidadShort(formaVenta: string, unidadPrecio: string): string {
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

type TabPrincipal = 'productos' | 'combos';

export default function AdminProductosPage() {
  const [tab, setTab] = useState<TabPrincipal>('productos');

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <header>
        <h1 className="font-display text-xl text-ink-900">Catálogo</h1>
        <p className="text-sm text-ink-500">
          Productos individuales y combos / promociones.
        </p>
      </header>

      <nav className="flex gap-1 border-b border-cream-300">
        {(
          [
            { v: 'productos', label: 'Productos' },
            { v: 'combos', label: 'Combos / Promos' },
          ] as const
        ).map((t) => (
          <button
            key={t.v}
            onClick={() => setTab(t.v)}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors border-b-2',
              tab === t.v
                ? 'border-teresita-700 text-teresita-700'
                : 'border-transparent text-ink-500 hover:text-ink-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'productos' ? <ProductosTab /> : <CombosTab />}
    </div>
  );
}

function ProductosTab() {
  const [productos, setProductos] = useState<Producto[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [categoriaFiltro, setCategoriaFiltro] = useState<string>('');
  const [incluirInactivos, setIncluirInactivos] = useState(false);
  const [editing, setEditing] = useState<Producto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProductos = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        incluirInactivos: String(incluirInactivos),
      });
      if (search.trim()) params.set('q', search.trim());
      if (categoriaFiltro) params.set('categoriaId', categoriaFiltro);
      const res = await api.get<ListadoResp>(`/admin/productos?${params.toString()}`);
      setProductos(res.productos);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los productos');
      }
    } finally {
      setLoading(false);
    }
  }, [page, search, categoriaFiltro, incluirInactivos]);

  useEffect(() => {
    void fetchProductos();
  }, [fetchProductos]);

  const eliminarProducto = useCallback(
    async (p: Producto) => {
      const msg =
        `¿Eliminar "${p.nombre}"?\n\n` +
        'Si el producto tiene ventas históricas, se va a DESACTIVAR ' +
        '(no se borra para no romper reportes). Si no, se elimina del todo.';
      if (!confirm(msg)) return;
      try {
        const res = await api.delete<{
          deleted?: boolean;
          deactivated?: boolean;
          mensaje?: string;
        }>(`/admin/productos/${p.id}`);
        if (res.deactivated) {
          alert(
            res.mensaje ??
              'El producto se desactivó (tenía ventas asociadas). Ya no aparece en el catálogo del cajero.',
          );
        }
        await fetchProductos();
      } catch (e) {
        alert(e instanceof Error ? e.message : 'No se pudo eliminar el producto');
      }
    },
    [fetchProductos],
  );

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ categorias: Categoria[] }>('/catalogo/categorias');
        setCategorias(res.categorias);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Dropdown "Añadir" con opciones de creación
  const [addOpen, setAddOpen] = useState(false);
  const [addTipo, setAddTipo] = useState<null | 'producto' | 'subcategoria' | 'categoria'>(null);

  return (
    <div className="space-y-4">
      <header className="flex justify-between items-baseline">
        <p className="text-sm text-ink-500">
          {total} producto{total !== 1 && 's'} en total
        </p>
        {/* Menú "Añadir" — un solo botón, opciones desplegables */}
        <div className="relative">
          <button
            onClick={() => setAddOpen((v) => !v)}
            className="bg-teresita-700 hover:bg-teresita-900 text-cream-50 font-medium px-4 py-2 rounded-md flex items-center gap-2 transition-colors"
          >
            <span className="text-base leading-none">+</span>
            <span>Añadir</span>
            <span className={cn('text-xs transition-transform', addOpen && 'rotate-180')}>▾</span>
          </button>
          {addOpen && (
            <>
              {/* backdrop para cerrar al click afuera */}
              <div
                className="fixed inset-0 z-30"
                onClick={() => setAddOpen(false)}
              />
              <div className="absolute right-0 top-full mt-1 z-40 w-64 card shadow-modal py-1 overflow-hidden">
                <button
                  onClick={() => { setAddTipo('producto'); setAddOpen(false); }}
                  className="w-full px-4 py-2.5 text-left hover:bg-cream-100 flex items-center gap-3"
                >
                  <span className="text-lg">🍝</span>
                  <div>
                    <div className="text-sm font-medium text-ink-900">Nuevo producto</div>
                    <div className="text-2xs text-ink-500">Item individual con precio</div>
                  </div>
                </button>
                <button
                  onClick={() => { setAddTipo('subcategoria'); setAddOpen(false); }}
                  className="w-full px-4 py-2.5 text-left hover:bg-cream-100 flex items-center gap-3 border-t border-cream-200"
                >
                  <span className="text-lg">🗂️</span>
                  <div>
                    <div className="text-sm font-medium text-ink-900">Nueva subcategoría</div>
                    <div className="text-2xs text-ink-500">Agrupa productos dentro de una categoría</div>
                  </div>
                </button>
                <button
                  onClick={() => { setAddTipo('categoria'); setAddOpen(false); }}
                  className="w-full px-4 py-2.5 text-left hover:bg-cream-100 flex items-center gap-3 border-t border-cream-200"
                >
                  <span className="text-lg">📁</span>
                  <div>
                    <div className="text-sm font-medium text-ink-900">Nueva categoría</div>
                    <div className="text-2xs text-ink-500">Sección principal del catálogo</div>
                  </div>
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Modal de creación según tipo */}
      {addTipo && (
        <CrearModal
          tipo={addTipo}
          categorias={categorias}
          onClose={() => setAddTipo(null)}
          onCreated={() => {
            setAddTipo(null);
            // Refrescar listas (productos + categorías)
            void fetchProductos();
            (async () => {
              try {
                const res = await api.get<{ categorias: Categoria[] }>('/catalogo/categorias');
                setCategorias(res.categorias);
              } catch { /* silencioso */ }
            })();
          }}
        />
      )}

      {/* Filtros */}
      <section className="card p-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="🔍 Buscar producto por nombre..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="input flex-1 min-w-[280px]"
        />
        <select
          value={categoriaFiltro}
          onChange={(e) => {
            setCategoriaFiltro(e.target.value);
            setPage(1);
          }}
          className="input w-auto"
        >
          <option value="">Todas las categorías</option>
          {categorias.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icono} {c.nombre}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-ink-700 cursor-pointer">
          <input
            type="checkbox"
            checked={incluirInactivos}
            onChange={(e) => {
              setIncluirInactivos(e.target.checked);
              setPage(1);
            }}
            className="w-4 h-4"
          />
          Mostrar inactivos
        </label>
      </section>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      {/* Tabla */}
      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Producto</th>
              <th className="text-left px-4 py-2">Categoría / Tipo</th>
              <th className="text-right px-4 py-2">Precio</th>
              <th className="text-center px-4 py-2">Unidad</th>
              <th className="text-center px-4 py-2">Cocina</th>
              <th className="text-center px-4 py-2">Estado</th>
              <th className="px-4 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {loading && (
              <tr>
                <td colSpan={7} className="text-center text-ink-500 py-8">
                  Cargando...
                </td>
              </tr>
            )}
            {!loading && productos.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-ink-500 py-8">
                  Sin productos con esos filtros
                </td>
              </tr>
            )}
            {productos.map((p) => (
              <tr
                key={p.id}
                className={cn(
                  'hover:bg-cream-100 transition-colors cursor-pointer',
                  !p.activo && 'opacity-50',
                )}
                onClick={() => setEditing(p)}
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-ink-900">{p.nombre}</div>
                  <div className="text-2xs font-mono text-ink-500 flex gap-2">
                    {p.codigo && <span>{p.codigo}</span>}
                    {p.marca && <span className="text-ink-700">· {p.marca}</span>}
                    {p.presentacion && <span>· {p.presentacion}</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-ink-700">
                  <div className="text-xs text-ink-500">
                    {p.tipoProducto.categoria.icono} {p.tipoProducto.categoria.nombre}
                  </div>
                  <div>{p.tipoProducto.nombre}</div>
                </td>
                <td className="px-4 py-3 text-right">
                  <MoneyAmount value={p.precioBase} className="text-md text-teresita-700" />
                  <div className="text-2xs text-ink-500 font-mono">
                    {unidadShort(p.formaVenta, p.unidadPrecio)}
                  </div>
                </td>
                <td className="px-4 py-3 text-center text-ink-500 text-xs">
                  {p.cantidadDefault ? `${p.cantidadDefault} ${unidadShort(p.formaVenta, p.unidadPrecio).slice(1)}` : '—'}
                </td>
                <td className="px-4 py-3 text-center">
                  {p.tipoProducto.cocinaInterviene ? '🍳' : ''}
                </td>
                <td className="px-4 py-3 text-center">
                  <span
                    className={cn(
                      'text-2xs font-medium px-2 py-0.5 rounded uppercase tracking-wider',
                      p.activo
                        ? 'bg-basil-100 text-basil-600'
                        : 'bg-cream-200 text-ink-500',
                    )}
                  >
                    {p.activo ? 'activo' : 'inactivo'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(p);
                      }}
                      className="text-ink-500 hover:text-teresita-700 text-xs"
                      title="Editar producto"
                    >
                      ✏️ Editar
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void eliminarProducto(p);
                      }}
                      className="text-pomodoro-600 hover:text-pomodoro-700 text-xs"
                      title="Eliminar producto"
                    >
                      🗑 Eliminar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Paginación */}
      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-2 text-sm">
          <Button
            variant="secondary"
            size="sm"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← Anterior
          </Button>
          <span className="text-ink-500 mx-2">
            Página {page} de {totalPages}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page === totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Siguiente →
          </Button>
        </nav>
      )}

      {editing && (
        <ProductoEditModal
          producto={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setProductos((arr) => arr.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal de edición
// ────────────────────────────────────────────────────────────────────────

interface TipoProducto {
  id: string;
  nombre: string;
  categoria: { id: string; nombre: string; icono?: string | null };
}
interface Sabor {
  id: string;
  nombre: string;
  deltaPrecio: string;
  activa: boolean;
  orden: number;
}

function ProductoEditModal({
  producto,
  onClose,
  onSaved,
}: {
  producto: Producto;
  onClose: () => void;
  onSaved: (p: Producto) => void;
}) {
  const [tab, setTab] = useState<'datos' | 'sabores'>('datos');
  const [nombre, setNombre] = useState(producto.nombre);
  const [marca, setMarca] = useState(producto.marca ?? '');
  const [presentacion, setPresentacion] = useState(producto.presentacion ?? '');
  const [precio, setPrecio] = useState(producto.precioBase);
  const [activo, setActivo] = useState(producto.activo);
  const [tipoProductoId, setTipoProductoId] = useState(producto.tipoProducto.id);
  const [motivo, setMotivo] = useState('');
  const [historial, setHistorial] = useState<HistorialPrecio[]>([]);
  const [tiposProducto, setTiposProducto] = useState<TipoProducto[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ historial: HistorialPrecio[] }>(
          `/admin/productos/${producto.id}/historial-precios`,
        );
        setHistorial(res.historial);
      } catch {
        /* silencioso */
      }
      try {
        const tp = await api.get<{ tipos: TipoProducto[] }>('/admin/tipos-producto');
        setTiposProducto(tp.tipos);
      } catch {
        /* silencioso */
      }
    })();
  }, [producto.id]);

  const cambiaPrecio = precio !== producto.precioBase;
  const cambiaMarca = marca !== (producto.marca ?? '');
  const cambiaPresentacion = presentacion !== (producto.presentacion ?? '');
  const cambiaTipo = tipoProductoId !== producto.tipoProducto.id;
  const cambia =
    nombre !== producto.nombre ||
    cambiaPrecio ||
    cambiaMarca ||
    cambiaPresentacion ||
    cambiaTipo ||
    activo !== producto.activo;

  async function submit() {
    if (!cambia) return;
    if (cambiaPrecio && motivo.trim().length < 3) {
      setError('Si cambiás el precio, ingresá un motivo (mínimo 3 caracteres)');
      return;
    }
    setGuardando(true);
    try {
      const updated = await api.patch<Producto>(`/admin/productos/${producto.id}`, {
        nombre: nombre !== producto.nombre ? nombre : undefined,
        marca: cambiaMarca ? (marca || null) : undefined,
        presentacion: cambiaPresentacion ? (presentacion || null) : undefined,
        precioBase: cambiaPrecio ? precio : undefined,
        activo: activo !== producto.activo ? activo : undefined,
        tipoProductoId: cambiaTipo ? tipoProductoId : undefined,
        motivoCambioPrecio: cambiaPrecio ? motivo : undefined,
      });
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  }

  // Agrupar tiposProducto por categoría para mejor UX en el select
  const tiposPorCategoria = useMemo(() => {
    const map = new Map<string, TipoProducto[]>();
    for (const tp of tiposProducto) {
      const key = tp.categoria.nombre;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(tp);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], 'es'));
  }, [tiposProducto]);

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col shadow-modal">
        <header className="px-5 py-4 border-b border-cream-300 flex justify-between items-start">
          <div>
            <h2 className="font-display text-lg text-teresita-700">
              Editar producto · {producto.nombre}
            </h2>
            <p className="text-xs text-ink-500">
              {producto.tipoProducto.categoria.nombre} · {producto.tipoProducto.nombre}
              {producto.codigo && ` · ${producto.codigo}`}
            </p>
          </div>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-900 text-xl leading-none">
            ✕
          </button>
        </header>

        <nav className="flex gap-1 border-b border-cream-300 px-5">
          {(
            [
              { v: 'datos', label: 'Datos' },
              { v: 'sabores', label: 'Sabores' },
            ] as const
          ).map((t) => (
            <button
              key={t.v}
              onClick={() => setTab(t.v)}
              className={cn(
                'px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-[1px]',
                tab === t.v
                  ? 'border-teresita-700 text-teresita-700'
                  : 'border-transparent text-ink-500 hover:text-ink-700',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'datos' && (
          <div className="flex-1 overflow-y-auto px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1">Nombre</label>
                <input
                  type="text"
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  className="input"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1">
                  Categoría / Tipo
                </label>
                <select
                  value={tipoProductoId}
                  onChange={(e) => setTipoProductoId(e.target.value)}
                  className="input"
                >
                  {tiposPorCategoria.map(([catNombre, tipos]) => (
                    <optgroup key={catNombre} label={catNombre}>
                      {tipos.map((tp) => (
                        <option key={tp.id} value={tp.id}>
                          {tp.nombre}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {cambiaTipo && (
                  <div className="text-xs text-saffron-600 mt-1">
                    ⚠ Cambio de tipo · puede afectar a qué grupo de sabores aplica
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-ink-700 mb-1">Marca</label>
                  <input
                    type="text"
                    value={marca}
                    onChange={(e) => setMarca(e.target.value)}
                    className="input"
                    placeholder="ej. Troncoso, De La Torre..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-700 mb-1">
                    Presentación
                  </label>
                  <input
                    type="text"
                    value={presentacion}
                    onChange={(e) => setPresentacion(e.target.value)}
                    className="input"
                    placeholder="ej. 360 grs, 500 cc..."
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1">
                  Precio base{' '}
                  <span className="text-2xs text-ink-500 font-normal">
                    ({unidadShort(producto.formaVenta, producto.unidadPrecio)})
                  </span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={precio}
                  onChange={(e) => setPrecio(e.target.value)}
                  className="input font-mono"
                />
                {cambiaPrecio && (
                  <div className="text-xs text-saffron-600 mt-1">
                    ⚠ Cambio de precio detectado · queda en histórico
                  </div>
                )}
              </div>

              {cambiaPrecio && (
                <div>
                  <label className="block text-sm font-medium text-ink-700 mb-1">
                    Motivo del cambio
                  </label>
                  <input
                    type="text"
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    placeholder="ej. aumento general 3%, ajuste por inflación..."
                    className="input"
                  />
                </div>
              )}

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activo}
                  onChange={(e) => setActivo(e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="text-sm text-ink-700">Producto activo</span>
              </label>
            </div>

            <div>
              <h3 className="text-sm font-medium text-ink-700 mb-2">Historial de precios</h3>
              {historial.length === 0 ? (
                <p className="text-xs text-ink-500">Sin cambios registrados aún.</p>
              ) : (
                <ul className="text-xs space-y-2 max-h-64 overflow-y-auto">
                  {historial.map((h) => (
                    <li key={h.id} className="border-l-2 border-cream-300 pl-3">
                      <div className="font-mono">
                        <MoneyAmount value={h.precioAnterior} className="text-ink-400 line-through" />{' '}
                        → <MoneyAmount value={h.precioNuevo} className="text-teresita-700" />
                      </div>
                      <div className="text-ink-500">
                        {new Date(h.fechaCambio).toLocaleDateString('es-AR')}{' '}
                        {h.lista && `· ${h.lista.nombre}`}
                      </div>
                      {h.motivo && (
                        <div className="text-ink-700 italic mt-0.5">{h.motivo}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {tab === 'sabores' && (
          <SaboresEditor productoId={producto.id} productoNombre={producto.nombre} />
        )}

        {error && (
          <div className="px-5 py-2 bg-pomodoro-100 text-pomodoro-600 text-sm">{error}</div>
        )}

        <footer className="px-5 py-3 border-t border-cream-300 flex justify-end gap-2 bg-surface-sunken">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!cambia || guardando} onClick={() => void submit()}>
            {guardando ? 'Guardando...' : 'Guardar cambios'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Editor de sabores (opciones del primer modificador)
// ────────────────────────────────────────────────────────────────────────

function SaboresEditor({
  productoId,
  productoNombre,
}: {
  productoId: string;
  productoNombre: string;
}) {
  const [grupo, setGrupo] = useState<{
    id: string;
    nombre: string;
    obligatorio: boolean;
  } | null>(null);
  const [sabores, setSabores] = useState<Sabor[]>([]);
  const [loading, setLoading] = useState(true);
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoDelta, setNuevoDelta] = useState('0');
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSabores = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ grupo: typeof grupo; opciones: Sabor[] }>(
        `/admin/productos/${productoId}/sabores`,
      );
      setGrupo(res.grupo);
      setSabores(res.opciones);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar sabores');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productoId]);

  useEffect(() => {
    void fetchSabores();
  }, [fetchSabores]);

  async function agregar() {
    if (!nuevoNombre.trim()) return;
    setCreando(true);
    try {
      await api.post(`/admin/productos/${productoId}/sabores`, {
        nombre: nuevoNombre.trim(),
        deltaPrecio: nuevoDelta || '0',
      });
      setNuevoNombre('');
      setNuevoDelta('0');
      await fetchSabores();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al agregar sabor');
    } finally {
      setCreando(false);
    }
  }

  async function actualizar(id: string, patch: Partial<Sabor>) {
    try {
      await api.patch(`/admin/sabores/${id}`, patch);
      await fetchSabores();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al actualizar');
    }
  }

  async function eliminar(id: string) {
    if (!confirm('¿Eliminar este sabor?')) return;
    try {
      await api.delete(`/admin/sabores/${id}`);
      await fetchSabores();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al eliminar');
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
      <div className="text-2xs text-ink-500 uppercase tracking-wider">
        {grupo
          ? `Grupo: ${grupo.nombre}${grupo.obligatorio ? ' · obligatorio' : ''}`
          : `Sin grupo de sabores · al agregar el primero se crea uno automático`}
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-ink-500">Cargando...</p>
      ) : sabores.length === 0 ? (
        <p className="text-sm text-ink-500 italic">
          {productoNombre} no tiene sabores cargados todavía.
        </p>
      ) : (
        <div className="space-y-1">
          {sabores.map((s, idx) => (
            <div
              key={s.id}
              className={cn(
                'flex items-center gap-2 border rounded-md px-3 py-2',
                s.activa ? 'border-cream-300 bg-white' : 'border-cream-300 bg-cream-100/40 opacity-60',
              )}
            >
              <span className="text-2xs font-mono text-ink-400 w-6">
                {String(idx + 1).padStart(2, '0')}
              </span>
              <input
                type="text"
                defaultValue={s.nombre}
                onBlur={(e) => {
                  if (e.target.value !== s.nombre) {
                    void actualizar(s.id, { nombre: e.target.value });
                  }
                }}
                className="input text-sm py-1 flex-1"
              />
              <div className="flex items-center gap-1">
                <span className="text-2xs text-ink-500">+/−</span>
                <input
                  type="number"
                  step="0.01"
                  defaultValue={s.deltaPrecio}
                  onBlur={(e) => {
                    if (e.target.value !== s.deltaPrecio) {
                      void actualizar(s.id, { deltaPrecio: e.target.value });
                    }
                  }}
                  className="input text-xs py-1 w-24 font-mono text-right"
                  title="Diferencia de precio respecto al base"
                />
              </div>
              <label className="flex items-center gap-1 text-2xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={s.activa}
                  onChange={(e) => void actualizar(s.id, { activa: e.target.checked })}
                  className="w-3 h-3"
                />
                activa
              </label>
              <button
                onClick={() => void eliminar(s.id)}
                className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-0.5 rounded text-xs"
                title="Eliminar"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-cream-300 pt-3 mt-3">
        <div className="text-2xs uppercase tracking-wider text-teresita-700 font-medium mb-2">
          Agregar sabor nuevo
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={nuevoNombre}
            onChange={(e) => setNuevoNombre(e.target.value)}
            placeholder="ej. Verdura y Pollo"
            className="input text-sm py-1.5 flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void agregar();
            }}
          />
          <input
            type="number"
            step="0.01"
            value={nuevoDelta}
            onChange={(e) => setNuevoDelta(e.target.value)}
            placeholder="0"
            className="input text-sm py-1.5 w-28 font-mono text-right"
            title="Diferencia de precio (puede ser 0)"
          />
          <Button size="sm" onClick={() => void agregar()} disabled={creando || !nuevoNombre.trim()}>
            {creando ? '...' : '+ Agregar'}
          </Button>
        </div>
        <div className="text-2xs text-ink-500 mt-1 italic">
          El "+/−" es la diferencia de precio del sabor sobre el precio base. Dejá 0 si no
          modifica el precio.
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Tab: Combos / Promos
// ────────────────────────────────────────────────────────────────────────

interface ComboComponente {
  id: string;
  cantidad: string;
  etiqueta: string | null;
  producto: { id: string; nombre: string; codigo: string | null; precioBase: string } | null;
}
interface Combo {
  id: string;
  nombre: string;
  precioCombo: string;
  precioSuelto: string;
  descuento: string;
  descuentoPct: number;
  activo: boolean;
  observaciones: string | null;
  componentes: ComboComponente[];
}

function CombosTab() {
  const [combos, setCombos] = useState<Combo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  const [editando, setEditando] = useState<Combo | null>(null);
  const [incluirInactivos, setIncluirInactivos] = useState(false);

  const fetchCombos = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ incluirInactivos: String(incluirInactivos) });
      const res = await api.get<{ combos: Combo[] }>(`/admin/combos?${params.toString()}`);
      setCombos(res.combos);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudieron cargar los combos');
      }
    } finally {
      setLoading(false);
    }
  }, [incluirInactivos]);

  useEffect(() => {
    void fetchCombos();
  }, [fetchCombos]);

  async function eliminar(id: string) {
    if (!confirm('¿Desactivar / eliminar este combo?')) return;
    try {
      await api.delete(`/admin/combos/${id}`);
      await fetchCombos();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al eliminar');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <p className="text-sm text-ink-500">
          {combos.length} combo{combos.length !== 1 && 's'} ·{' '}
          <span className="text-2xs text-ink-400">
            cuando un cliente arma los componentes en el carrito, el sistema lo detecta y aplica
            el descuento automático
          </span>
        </p>
        <div className="flex gap-2 items-center">
          <label className="flex items-center gap-1 text-2xs text-ink-700 cursor-pointer">
            <input
              type="checkbox"
              checked={incluirInactivos}
              onChange={(e) => setIncluirInactivos(e.target.checked)}
            />
            ver inactivos
          </label>
          <Button onClick={() => setCreando(true)}>+ Nuevo combo</Button>
        </div>
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      {loading ? (
        <div className="text-ink-500 text-sm py-8 text-center">Cargando...</div>
      ) : combos.length === 0 ? (
        <div className="card p-8 text-center text-ink-500 text-sm">
          Todavía no hay combos. Tocá <strong>"+ Nuevo combo"</strong> para crear el primero.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {combos.map((c) => (
            <div
              key={c.id}
              className={cn(
                'card p-4',
                !c.activo && 'opacity-50',
                Number(c.descuento) > 0 && 'border-l-4 border-saffron-600',
              )}
            >
              <div className="flex justify-between items-baseline mb-2">
                <h3 className="font-medium text-ink-900">{c.nombre}</h3>
                <div className="text-right">
                  <MoneyAmount
                    value={c.precioCombo}
                    className="font-mono text-md text-teresita-700"
                  />
                  {Number(c.descuento) > 0 && (
                    <div className="text-2xs text-saffron-600">
                      −{c.descuentoPct}% (ahorrás <MoneyAmount value={c.descuento} />)
                    </div>
                  )}
                </div>
              </div>
              <ul className="text-xs space-y-0.5 mb-2">
                {c.componentes.map((comp) => (
                  <li key={comp.id} className="text-ink-700">
                    · {Number(comp.cantidad)}x {comp.producto?.nombre ?? '—'}
                    {comp.producto?.codigo && (
                      <span className="font-mono text-ink-400"> ({comp.producto.codigo})</span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="text-2xs text-ink-500 flex justify-between">
                <span>
                  Precio suelto: <MoneyAmount value={c.precioSuelto} />
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditando(c)}
                    className="text-teresita-700 hover:underline"
                  >
                    editar
                  </button>
                  <button
                    onClick={() => eliminar(c.id)}
                    className="text-pomodoro-600 hover:underline"
                  >
                    eliminar
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creando || editando) && (
        <ComboFormModal
          combo={editando}
          onClose={() => {
            setCreando(false);
            setEditando(null);
          }}
          onSaved={() => {
            setCreando(false);
            setEditando(null);
            void fetchCombos();
          }}
        />
      )}
    </div>
  );
}

interface ProductoLite {
  id: string;
  nombre: string;
  codigo: string | null;
  precioBase: string;
}

function ComboFormModal({
  combo,
  onClose,
  onSaved,
}: {
  combo: Combo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nombre, setNombre] = useState(combo?.nombre ?? '');
  const [precio, setPrecio] = useState(combo?.precioCombo ?? '');
  const [observaciones, setObservaciones] = useState(combo?.observaciones ?? '');
  const [activo, setActivo] = useState(combo?.activo ?? true);
  const [componentes, setComponentes] = useState<
    Array<{ productoId: string; cantidad: string; etiqueta: string }>
  >(
    combo?.componentes.map((c) => ({
      productoId: c.producto?.id ?? '',
      cantidad: Number(c.cantidad).toString(),
      etiqueta: c.etiqueta ?? '',
    })) ?? [{ productoId: '', cantidad: '1', etiqueta: '' }],
  );
  const [productos, setProductos] = useState<ProductoLite[]>([]);
  const [search, setSearch] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ productos: ProductoLite[] }>(
          '/catalogo/productos?limit=2000',
        );
        setProductos(res.productos);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  const productosFiltrados = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return productos;
    return productos.filter(
      (p) =>
        p.nombre.toLowerCase().includes(q) ||
        (p.codigo ?? '').toLowerCase().includes(q),
    );
  }, [productos, search]);

  const productoPorId = useMemo(() => {
    return new Map(productos.map((p) => [p.id, p]));
  }, [productos]);

  // Calcular precio suelto en vivo
  const precioSuelto = componentes.reduce((acc, c) => {
    const p = productoPorId.get(c.productoId);
    if (!p) return acc;
    return acc + Number(c.cantidad || 0) * Number(p.precioBase);
  }, 0);
  const precioComboNum = Number(precio || 0);
  const descuento = precioSuelto - precioComboNum;
  const descuentoPct = precioSuelto > 0 ? (descuento / precioSuelto) * 100 : 0;

  function setComp(idx: number, patch: Partial<(typeof componentes)[0]>) {
    setComponentes((arr) => arr.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }
  function addComp() {
    setComponentes((arr) => [...arr, { productoId: '', cantidad: '1', etiqueta: '' }]);
  }
  function removeComp(idx: number) {
    setComponentes((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }

  async function submit() {
    setError(null);
    if (!nombre.trim()) return setError('El nombre es obligatorio');
    if (!precio || Number(precio) <= 0) return setError('El precio del combo debe ser > 0');
    if (componentes.some((c) => !c.productoId))
      return setError('Cada componente tiene que tener producto');
    if (componentes.some((c) => Number(c.cantidad) <= 0))
      return setError('Cada componente tiene que tener cantidad > 0');
    setGuardando(true);
    try {
      const body = {
        nombre,
        precioCombo: Number(precio).toFixed(2),
        observaciones: observaciones || undefined,
        ...(combo && { activo }),
        componentes: componentes.map((c) => ({
          productoId: c.productoId,
          cantidad: c.cantidad,
          etiqueta: c.etiqueta || undefined,
        })),
      };
      if (combo) {
        await api.patch(`/admin/combos/${combo.id}`, body);
      } else {
        await api.post('/admin/combos', body);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar el combo');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-ink-900/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-cream-300 flex justify-between items-center">
          <h2 className="font-display text-lg text-teresita-700">
            {combo ? 'Editar combo' : 'Nuevo combo / promo'}
          </h2>
          <button
            onClick={onClose}
            className="text-ink-500 hover:text-ink-900 text-xl leading-none"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Nombre del combo
            </label>
            <input
              type="text"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="ej. Promo 2 Planchas + Salsa"
              className="input"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1">
                Precio del combo
              </label>
              <input
                type="number"
                step="0.01"
                value={precio}
                onChange={(e) => setPrecio(e.target.value)}
                placeholder="0.00"
                className="input font-mono"
              />
            </div>
            {combo && (
              <label className="flex items-end gap-2 cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={activo}
                  onChange={(e) => setActivo(e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="text-sm text-ink-700">Combo activo</span>
              </label>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-2">
              Componentes del combo
            </label>
            {componentes.map((c, idx) => {
              const prod = productoPorId.get(c.productoId);
              return (
                <div key={idx} className="flex gap-2 mb-2">
                  <input
                    type="number"
                    step="0.001"
                    value={c.cantidad}
                    onChange={(e) => setComp(idx, { cantidad: e.target.value })}
                    className="input text-sm py-1.5 w-20 font-mono text-right"
                  />
                  <select
                    value={c.productoId}
                    onChange={(e) => setComp(idx, { productoId: e.target.value })}
                    className="input text-sm py-1.5 flex-1"
                  >
                    <option value="">Elegí producto...</option>
                    {productosFiltrados.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.codigo ? `${p.codigo} · ` : ''}
                        {p.nombre} ({Number(p.precioBase).toLocaleString('es-AR')})
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeComp(idx)}
                    disabled={componentes.length === 1}
                    className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded text-sm disabled:opacity-30"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={addComp}
              className="text-xs text-teresita-700 hover:underline"
            >
              + Agregar otro componente
            </button>
            {productos.length > 30 && (
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="🔍 filtrar productos en los selects..."
                className="input text-xs py-1 mt-2"
              />
            )}
          </div>

          {/* Resumen del descuento */}
          {precioSuelto > 0 && (
            <div className="bg-cream-100 border border-cream-300 rounded-md px-3 py-2 grid grid-cols-2 gap-1 text-sm">
              <span className="text-ink-700">Precio suelto:</span>
              <span className="text-right font-mono">
                <MoneyAmount value={precioSuelto.toFixed(2)} />
              </span>
              <span className="text-ink-700">Precio combo:</span>
              <span className="text-right font-mono text-teresita-700 font-medium">
                <MoneyAmount value={precioComboNum.toFixed(2)} />
              </span>
              <span
                className={cn(
                  'font-medium',
                  descuento > 0 ? 'text-saffron-600' : 'text-pomodoro-600',
                )}
              >
                Descuento:
              </span>
              <span
                className={cn(
                  'text-right font-mono font-medium',
                  descuento > 0 ? 'text-saffron-600' : 'text-pomodoro-600',
                )}
              >
                <MoneyAmount value={descuento.toFixed(2)} /> ({descuentoPct.toFixed(1)}%)
              </span>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">
              Observaciones (opcional)
            </label>
            <input
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              placeholder="ej. válido todos los martes..."
              className="input"
            />
          </div>

          {error && (
            <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-cream-300 flex justify-end gap-2 bg-surface-sunken">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={guardando}>
            {guardando ? 'Guardando...' : combo ? 'Guardar cambios' : 'Crear combo'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal de creación: producto / subcategoría (tipo) / categoría
// ────────────────────────────────────────────────────────────────────────

interface TipoConCat {
  id: string;
  nombre: string;
  cocinaInterviene: boolean;
  categoria: { id: string; nombre: string; icono?: string | null };
}

function CrearModal({
  tipo,
  categorias,
  onClose,
  onCreated,
}: {
  tipo: 'producto' | 'subcategoria' | 'categoria';
  categorias: Categoria[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const titles = {
    producto: 'Nuevo producto',
    subcategoria: 'Nueva subcategoría',
    categoria: 'Nueva categoría',
  };
  const icons = {
    producto: '🍝',
    subcategoria: '🗂️',
    categoria: '📁',
  };

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-50 p-4">
      <div className="card w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col shadow-modal">
        <header className="px-5 py-4 border-b border-cream-300 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{icons[tipo]}</span>
            <div>
              <h2 className="font-display text-lg text-teresita-700">{titles[tipo]}</h2>
              <p className="text-xs text-ink-500 mt-0.5">
                {tipo === 'producto' && 'Item individual con precio'}
                {tipo === 'subcategoria' && 'Agrupa productos dentro de una categoría existente'}
                {tipo === 'categoria' && 'Sección principal del catálogo'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-ink-500 hover:text-ink-900 text-xl leading-none">✕</button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tipo === 'categoria' && <FormCategoria onClose={onClose} onCreated={onCreated} />}
          {tipo === 'subcategoria' && <FormSubcategoria categorias={categorias} onClose={onClose} onCreated={onCreated} />}
          {tipo === 'producto' && <FormProducto categorias={categorias} onClose={onClose} onCreated={onCreated} />}
        </div>
      </div>
    </div>
  );
}

function FormCategoria({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [nombre, setNombre] = useState('');
  const [icono, setIcono] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function submit() {
    if (!nombre.trim()) return setError('El nombre es obligatorio');
    setGuardando(true);
    setError(null);
    try {
      await api.post('/admin/categorias', { nombre: nombre.trim(), icono: icono.trim() || null });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear categoría');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-ink-700 mb-1">Nombre *</label>
        <input
          type="text"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          autoFocus
          placeholder="ej. Postres, Café, Helados…"
          className="input"
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') onClose(); }}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-ink-700 mb-1">
          Icono (emoji opcional)
        </label>
        <input
          type="text"
          value={icono}
          onChange={(e) => setIcono(e.target.value)}
          maxLength={4}
          placeholder="🍰"
          className="input w-24 text-center text-xl"
        />
        <p className="text-2xs text-ink-300 mt-1">Aparece en el cajero al lado del nombre.</p>
      </div>
      {error && <p className="text-sm text-pomodoro-600">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>Cancelar (Esc)</Button>
        <Button onClick={() => void submit()} disabled={guardando || !nombre.trim()}>
          {guardando ? 'Creando...' : 'Crear categoría (Enter)'}
        </Button>
      </div>
    </div>
  );
}

function FormSubcategoria({
  categorias,
  onClose,
  onCreated,
}: {
  categorias: Categoria[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [nombre, setNombre] = useState('');
  const [categoriaId, setCategoriaId] = useState(categorias[0]?.id ?? '');
  const [cocinaInterviene, setCocinaInterviene] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  async function submit() {
    if (!nombre.trim()) return setError('El nombre es obligatorio');
    if (!categoriaId) return setError('Elegí una categoría');
    setGuardando(true);
    setError(null);
    try {
      await api.post('/admin/tipos-producto', {
        nombre: nombre.trim(),
        categoriaId,
        cocinaInterviene,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear subcategoría');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-ink-700 mb-1">Categoría padre *</label>
        <select
          value={categoriaId}
          onChange={(e) => setCategoriaId(e.target.value)}
          className="input"
        >
          {categorias.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icono} {c.nombre}
            </option>
          ))}
        </select>
        <p className="text-2xs text-ink-300 mt-1">¿No está la categoría que querés? Creala primero desde "Añadir".</p>
      </div>
      <div>
        <label className="block text-sm font-medium text-ink-700 mb-1">Nombre de la subcategoría *</label>
        <input
          type="text"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          autoFocus
          placeholder="ej. Tartas dulces, Empanadas premium…"
          className="input"
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') onClose(); }}
        />
      </div>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={cocinaInterviene}
          onChange={(e) => setCocinaInterviene(e.target.checked)}
          className="w-4 h-4 mt-0.5"
        />
        <div>
          <div className="text-sm text-ink-700 font-medium">Cocina interviene</div>
          <div className="text-2xs text-ink-500">
            Si está marcado, los productos de esta subcategoría imprimen comanda en cocina al cargarlos.
          </div>
        </div>
      </label>
      {error && <p className="text-sm text-pomodoro-600">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>Cancelar (Esc)</Button>
        <Button onClick={() => void submit()} disabled={guardando || !nombre.trim() || !categoriaId}>
          {guardando ? 'Creando...' : 'Crear subcategoría (Enter)'}
        </Button>
      </div>
    </div>
  );
}

function FormProducto({
  categorias,
  onClose,
  onCreated,
}: {
  categorias: Categoria[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tipos, setTipos] = useState<TipoConCat[]>([]);
  const [categoriasLocal, setCategoriasLocal] = useState<Categoria[]>(categorias);
  const [categoriaId, setCategoriaId] = useState('');
  const [tipoProductoId, setTipoProductoId] = useState('');

  const [nombre, setNombre] = useState('');
  const [codigo, setCodigo] = useState('');
  const [precioBase, setPrecioBase] = useState('');
  const [marca, setMarca] = useState('');
  const [presentacion, setPresentacion] = useState('');
  const [formaVenta, setFormaVenta] = useState<'UNIDAD' | 'GRAMO' | 'PLANCHA' | 'PORCION'>('UNIDAD');
  const [formaVentaLabel, setFormaVentaLabel] = useState('');
  const [unidadPrecio, setUnidadPrecio] = useState<
    'POR_UNIDAD' | 'POR_GRAMO' | 'POR_KILO' | 'POR_PORCION' | 'POR_PLANCHA' | 'POR_DOCENA'
  >('POR_UNIDAD');
  const [unidadPrecioLabel, setUnidadPrecioLabel] = useState('');
  const [cantidadDefault, setCantidadDefault] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  // Quick-create inline para Categoría / Sub-categoría
  const [crearCatOpen, setCrearCatOpen] = useState(false);
  const [nuevaCatNombre, setNuevaCatNombre] = useState('');
  const [nuevaCatIcono, setNuevaCatIcono] = useState('');
  const [creandoCat, setCreandoCat] = useState(false);

  const [crearSubcatOpen, setCrearSubcatOpen] = useState(false);
  const [nuevaSubcatNombre, setNuevaSubcatNombre] = useState('');
  const [nuevaSubcatCocina, setNuevaSubcatCocina] = useState(false);
  const [creandoSubcat, setCreandoSubcat] = useState(false);

  async function refreshTipos() {
    try {
      const res = await api.get<{ tipos: TipoConCat[] }>('/admin/tipos-producto');
      setTipos(res.tipos);
    } catch { /* silencioso */ }
  }
  async function refreshCategorias() {
    try {
      const res = await api.get<{ categorias: Categoria[] }>('/catalogo/categorias');
      setCategoriasLocal(res.categorias);
    } catch { /* silencioso */ }
  }

  useEffect(() => {
    void refreshTipos();
  }, []);

  // Sub-categorías filtradas por la categoría elegida
  const subcatsDeCategoria = useMemo(() => {
    return tipos
      .filter((t) => t.categoria.id === categoriaId)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }, [tipos, categoriaId]);

  // Si la sub-cat seleccionada deja de pertenecer a la categoría → limpiar
  useEffect(() => {
    if (tipoProductoId && !subcatsDeCategoria.some((t) => t.id === tipoProductoId)) {
      setTipoProductoId('');
    }
  }, [subcatsDeCategoria, tipoProductoId]);

  async function crearCategoriaInline() {
    if (!nuevaCatNombre.trim()) return;
    setCreandoCat(true);
    setError(null);
    try {
      const r = await api.post<{ categoria: { id: string } }>('/admin/categorias', {
        nombre: nuevaCatNombre.trim(),
        icono: nuevaCatIcono.trim() || null,
      });
      await refreshCategorias();
      setCategoriaId(r.categoria.id);
      setTipoProductoId('');
      setNuevaCatNombre('');
      setNuevaCatIcono('');
      setCrearCatOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear categoría');
    } finally {
      setCreandoCat(false);
    }
  }

  async function crearSubcategoriaInline() {
    if (!nuevaSubcatNombre.trim() || !categoriaId) return;
    setCreandoSubcat(true);
    setError(null);
    try {
      const r = await api.post<{ tipo: { id: string } }>('/admin/tipos-producto', {
        nombre: nuevaSubcatNombre.trim(),
        categoriaId,
        cocinaInterviene: nuevaSubcatCocina,
      });
      await refreshTipos();
      setTipoProductoId(r.tipo.id);
      setNuevaSubcatNombre('');
      setNuevaSubcatCocina(false);
      setCrearSubcatOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear sub-categoría');
    } finally {
      setCreandoSubcat(false);
    }
  }

  async function submit() {
    if (!nombre.trim()) return setError('El nombre es obligatorio');
    if (!precioBase || !/^\d+(\.\d{1,2})?$/.test(precioBase)) return setError('Precio inválido (ej. 1500 o 1500.50)');
    if (!categoriaId) return setError('Elegí una categoría');
    if (!tipoProductoId) return setError('Elegí una sub-categoría (o creá una nueva)');
    setGuardando(true);
    setError(null);
    try {
      await api.post('/admin/productos', {
        nombre: nombre.trim(),
        tipoProductoId,
        codigo: codigo.trim() || null,
        marca: marca.trim() || null,
        presentacion: presentacion.trim() || null,
        precioBase,
        formaVenta,
        formaVentaLabel: formaVentaLabel.trim() || null,
        unidadPrecio,
        unidadPrecioLabel: unidadPrecioLabel.trim() || null,
        cantidadDefault: cantidadDefault.trim() || null,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear producto');
    } finally {
      setGuardando(false);
    }
  }

  const categoriasOrdenadas = useMemo(
    () => [...categoriasLocal].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    [categoriasLocal],
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {/* Categoría */}
        <div className="col-span-2">
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-ink-700">Categoría *</label>
            <button
              type="button"
              onClick={() => { setCrearCatOpen((v) => !v); setCrearSubcatOpen(false); }}
              className="text-xs text-teresita-700 hover:underline font-medium"
            >
              {crearCatOpen ? '× Cerrar' : '+ Nueva categoría'}
            </button>
          </div>
          <select
            value={categoriaId}
            onChange={(e) => { setCategoriaId(e.target.value); setTipoProductoId(''); }}
            className="input"
          >
            <option value="">— elegí una —</option>
            {categoriasOrdenadas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icono ? `${c.icono} ` : ''}{c.nombre}
              </option>
            ))}
          </select>
          {crearCatOpen && (
            <div className="mt-2 p-3 border border-cream-300 rounded-md bg-cream-100/40 space-y-2">
              <div className="text-2xs uppercase tracking-wider text-teresita-700 font-medium">
                Crear nueva categoría
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={nuevaCatNombre}
                  onChange={(e) => setNuevaCatNombre(e.target.value)}
                  placeholder="Nombre (ej. Postres)"
                  className="input text-sm py-1.5 flex-1"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') void crearCategoriaInline(); }}
                />
                <input
                  type="text"
                  value={nuevaCatIcono}
                  onChange={(e) => setNuevaCatIcono(e.target.value)}
                  maxLength={4}
                  placeholder="🍰"
                  className="input text-center text-lg w-16 py-1.5"
                />
                <Button
                  size="sm"
                  onClick={() => void crearCategoriaInline()}
                  disabled={creandoCat || !nuevaCatNombre.trim()}
                >
                  {creandoCat ? '...' : 'Crear'}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Sub-categoría */}
        <div className="col-span-2">
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-ink-700">
              Sub-categoría *
              {!categoriaId && (
                <span className="text-2xs text-ink-400 font-normal ml-2">
                  (elegí primero una categoría)
                </span>
              )}
            </label>
            <button
              type="button"
              onClick={() => { setCrearSubcatOpen((v) => !v); setCrearCatOpen(false); }}
              disabled={!categoriaId}
              className="text-xs text-teresita-700 hover:underline font-medium disabled:opacity-30 disabled:cursor-not-allowed disabled:no-underline"
            >
              {crearSubcatOpen ? '× Cerrar' : '+ Nueva sub-categoría'}
            </button>
          </div>
          <select
            value={tipoProductoId}
            onChange={(e) => setTipoProductoId(e.target.value)}
            disabled={!categoriaId}
            className="input disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">
              {categoriaId
                ? subcatsDeCategoria.length === 0
                  ? '— sin sub-categorías · creá una —'
                  : '— elegí una —'
                : '— elegí primero una categoría —'}
            </option>
            {subcatsDeCategoria.map((t) => (
              <option key={t.id} value={t.id}>{t.nombre}</option>
            ))}
          </select>
          {crearSubcatOpen && categoriaId && (
            <div className="mt-2 p-3 border border-cream-300 rounded-md bg-cream-100/40 space-y-2">
              <div className="text-2xs uppercase tracking-wider text-teresita-700 font-medium">
                Crear sub-categoría dentro de{' '}
                <span className="text-ink-700">
                  {categoriasOrdenadas.find((c) => c.id === categoriaId)?.nombre}
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={nuevaSubcatNombre}
                  onChange={(e) => setNuevaSubcatNombre(e.target.value)}
                  placeholder="Nombre (ej. Tartas dulces)"
                  className="input text-sm py-1.5 flex-1"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') void crearSubcategoriaInline(); }}
                />
                <Button
                  size="sm"
                  onClick={() => void crearSubcategoriaInline()}
                  disabled={creandoSubcat || !nuevaSubcatNombre.trim()}
                >
                  {creandoSubcat ? '...' : 'Crear'}
                </Button>
              </div>
              <label className="flex items-center gap-2 cursor-pointer text-2xs text-ink-700">
                <input
                  type="checkbox"
                  checked={nuevaSubcatCocina}
                  onChange={(e) => setNuevaSubcatCocina(e.target.checked)}
                  className="w-3.5 h-3.5"
                />
                Cocina interviene (imprime comanda)
              </label>
            </div>
          )}
        </div>

        <div className="col-span-2">
          <label className="block text-sm font-medium text-ink-700 mb-1">Nombre *</label>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            autoFocus
            placeholder="ej. Coca-Cola 2.25L"
            className="input"
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1">Código</label>
          <input
            type="text"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            placeholder="ej. 6020"
            className="input"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1">Precio *</label>
          <input
            type="text"
            inputMode="decimal"
            value={precioBase}
            onChange={(e) => setPrecioBase(e.target.value)}
            placeholder="ej. 2500"
            className="input font-mono"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1">Marca (opcional)</label>
          <input
            type="text"
            value={marca}
            onChange={(e) => setMarca(e.target.value)}
            placeholder="ej. Coca-Cola"
            className="input"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1">Presentación (opcional)</label>
          <input
            type="text"
            value={presentacion}
            onChange={(e) => setPresentacion(e.target.value)}
            placeholder="ej. 2.25L, 500g"
            className="input"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1">Forma de venta</label>
          <select
            value={formaVenta}
            onChange={(e) => setFormaVenta(e.target.value as 'UNIDAD' | 'GRAMO' | 'PLANCHA' | 'PORCION')}
            className="input"
          >
            <option value="UNIDAD">Unidad</option>
            <option value="GRAMO">Gramo</option>
            <option value="PORCION">Porción</option>
            <option value="PLANCHA">Plancha</option>
          </select>
          <input
            type="text"
            value={formaVentaLabel}
            onChange={(e) => setFormaVentaLabel(e.target.value)}
            maxLength={40}
            placeholder="Etiqueta personalizada (opcional)"
            className="input mt-1.5 text-sm"
          />
          <p className="text-2xs text-ink-300 mt-1">
            Si querés una nomenclatura distinta (ej. "Bolsa", "Caja"), escribila acá.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1">Unidad de precio</label>
          <select
            value={unidadPrecio}
            onChange={(e) => setUnidadPrecio(e.target.value as 'POR_UNIDAD' | 'POR_KILO' | 'POR_DOCENA' | 'POR_PORCION' | 'POR_PLANCHA' | 'POR_GRAMO')}
            className="input"
          >
            <option value="POR_UNIDAD">Por unidad</option>
            <option value="POR_KILO">Por kilo</option>
            <option value="POR_DOCENA">Por docena</option>
            <option value="POR_PORCION">Por porción</option>
            <option value="POR_PLANCHA">Por plancha</option>
          </select>
          <input
            type="text"
            value={unidadPrecioLabel}
            onChange={(e) => setUnidadPrecioLabel(e.target.value)}
            maxLength={40}
            placeholder="Etiqueta personalizada (opcional)"
            className="input mt-1.5 text-sm"
          />
          <p className="text-2xs text-ink-300 mt-1">
            ej. "Por bolsa de 5kg", "Por bandeja". El cálculo sigue el dropdown.
          </p>
        </div>

        <div className="col-span-2">
          <label className="block text-sm font-medium text-ink-700 mb-1">
            Cantidad por defecto al cargar (opcional)
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={cantidadDefault}
            onChange={(e) => setCantidadDefault(e.target.value)}
            placeholder="ej. 500 (gramos), 1 (docena)"
            className="input font-mono w-40"
          />
          <p className="text-2xs text-ink-300 mt-1">
            Para POR_KILO suelen ser 500g. Para POR_DOCENA, 1 (1 docena).
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-pomodoro-600">{error}</p>}

      <div className="flex justify-end gap-2 pt-2 border-t border-cream-200 mt-4">
        <Button variant="secondary" onClick={onClose}>Cancelar (Esc)</Button>
        <Button onClick={() => void submit()} disabled={guardando || !nombre.trim() || !categoriaId || !tipoProductoId || !precioBase}>
          {guardando ? 'Creando...' : 'Crear producto'}
        </Button>
      </div>
    </div>
  );
}
