'use client';

import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

// ── Tipos (espejo de /admin/listas) ──
type TipoLista = 'PUBLICA' | 'CANAL' | 'CUSTOM';

interface ListaRow {
  id: string;
  nombre: string;
  canalDefault: string;
  tipo: TipoLista;
  ajustePctDefault: string;
  activa: boolean;
  productos: number;
}

interface ProductoLista {
  id: string;
  nombre: string;
  codigo: string | null;
  unidadPrecio: string;
  unidadPrecioLabel: string | null;
  precioBase: string;
  enLista: boolean;
  precio: string;
}
interface CategoriaLista {
  id: string;
  nombre: string;
  orden: number;
  productos: ProductoLista[];
}
interface DetalleResp {
  lista: {
    id: string;
    nombre: string;
    tipo: TipoLista;
    ajustePctDefault: string;
    activa: boolean;
    editablePorProducto: boolean;
    editableMembresia: boolean;
    editableAjuste: boolean;
  };
  categorias: CategoriaLista[];
}

const TIPO_LABEL: Record<TipoLista, string> = {
  PUBLICA: 'Pública',
  CANAL: 'Canal (derivada)',
  CUSTOM: 'Personalizada',
};
const TIPO_COLOR: Record<TipoLista, string> = {
  PUBLICA: 'bg-basil-100 text-basil-600',
  CANAL: 'bg-ocean-100 text-ocean-600',
  CUSTOM: 'bg-saffron-100 text-saffron-600',
};

export function ListasPreciosManager() {
  const [listas, setListas] = useState<ListaRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [verListaId, setVerListaId] = useState<string | null>(null);
  const [showNueva, setShowNueva] = useState(false);

  const fetchListas = useCallback(async () => {
    try {
      const res = await api.get<{ listas: ListaRow[] }>('/admin/listas');
      setListas(res.listas);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron cargar las listas');
    }
  }, []);

  useEffect(() => {
    void fetchListas();
  }, [fetchListas]);

  async function eliminarLista(l: ListaRow) {
    if (
      !confirm(
        `¿Eliminar la lista "${l.nombre}"? Los productos no se borran — solo se quita la lista.`,
      )
    )
      return;
    try {
      await api.delete(`/admin/listas/${l.id}`);
      void fetchListas();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo eliminar la lista');
    }
  }

  if (verListaId) {
    return (
      <DetalleLista
        listaId={verListaId}
        onBack={() => {
          setVerListaId(null);
          void fetchListas();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-ink-500">
          El precio al público es la base; las listas de canal (RAPPI/PYA/ML) lo siguen con su
          %. Las personalizadas tienen precios propios por producto.
        </p>
        <Button onClick={() => setShowNueva(true)}>+ Nueva lista</Button>
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-300">
            <tr>
              <th className="text-left px-4 py-2">Lista</th>
              <th className="text-left px-4 py-2">Tipo</th>
              <th className="text-right px-4 py-2">Ajuste</th>
              <th className="text-right px-4 py-2">Productos</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {listas.map((l) => (
              <tr key={l.id} className={cn('hover:bg-cream-100', !l.activa && 'opacity-50')}>
                <td className="px-4 py-3 font-medium text-ink-900">{l.nombre}</td>
                <td className="px-4 py-3">
                  <span className={cn('text-2xs font-medium px-2 py-0.5 rounded', TIPO_COLOR[l.tipo])}>
                    {TIPO_LABEL[l.tipo]}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-ink-700">
                  {l.tipo === 'PUBLICA' ? '—' : `${Number(l.ajustePctDefault).toFixed(0)}%`}
                </td>
                <td className="px-4 py-3 text-right text-ink-700">{l.productos}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {l.tipo === 'CUSTOM' && l.activa && (
                    <button
                      onClick={() => eliminarLista(l)}
                      className="text-pomodoro-600 hover:underline text-xs mr-3"
                    >
                      Eliminar
                    </button>
                  )}
                  <button
                    onClick={() => setVerListaId(l.id)}
                    className="text-teresita-700 hover:underline text-xs"
                  >
                    Ver / editar →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNueva && (
        <ModalNuevaLista
          onClose={() => setShowNueva(false)}
          onCreated={(id) => {
            setShowNueva(false);
            void fetchListas();
            setVerListaId(id);
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Detalle de una lista — vista por categoría + edición
// ────────────────────────────────────────────────────────────────────────

function DetalleLista({ listaId, onBack }: { listaId: string; onBack: () => void }) {
  const [data, setData] = useState<DetalleResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  // Estado de edición:
  const [precios, setPrecios] = useState<Record<string, string>>({}); // productoId → precio editado
  const [miembros, setMiembros] = useState<Record<string, boolean>>({}); // productoId → en lista (custom)
  const [colapsadas, setColapsadas] = useState<Record<string, boolean>>({});
  // Aumento global
  const [globalPct, setGlobalPct] = useState('');
  // Rename
  const [renombrando, setRenombrando] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState('');

  const fetchDetalle = useCallback(async () => {
    try {
      const res = await api.get<DetalleResp>(`/admin/listas/${listaId}`);
      setData(res);
      // Inicializar estado de edición
      const px: Record<string, string> = {};
      const mb: Record<string, boolean> = {};
      for (const c of res.categorias) {
        for (const p of c.productos) {
          px[p.id] = p.precio;
          mb[p.id] = p.enLista;
        }
      }
      setPrecios(px);
      setMiembros(mb);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar la lista');
    }
  }, [listaId]);

  useEffect(() => {
    void fetchDetalle();
  }, [fetchDetalle]);

  if (error) return <div className="text-pomodoro-600">{error}</div>;
  if (!data) return <div className="text-ink-500">Cargando lista...</div>;

  const { lista, categorias } = data;
  const precioOriginal = new Map<string, string>();
  for (const c of categorias) for (const p of c.productos) precioOriginal.set(p.id, p.precio);

  function aplicarGlobalPct() {
    const pct = Number(globalPct);
    if (!pct) return;
    setPrecios((prev) => {
      const next = { ...prev };
      for (const c of categorias) {
        for (const p of c.productos) {
          // Solo a los miembros (en custom) o a todos (publica)
          if (lista.tipo === 'CUSTOM' && !miembros[p.id]) continue;
          const base = Number(precioOriginal.get(p.id) ?? 0);
          next[p.id] = (base * (1 + pct / 100)).toFixed(2);
        }
      }
      return next;
    });
  }

  async function renombrar() {
    if (!nuevoNombre.trim()) return;
    try {
      await api.patch(`/admin/listas/${listaId}`, { nombre: nuevoNombre.trim() });
      setRenombrando(false);
      await fetchDetalle();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo renombrar');
    }
  }

  async function agregarCategoria(categoriaId: string) {
    try {
      await api.post(`/admin/listas/${listaId}/agregar-categoria`, { categoriaId });
      await fetchDetalle();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo agregar la categoría');
    }
  }

  async function guardar() {
    setGuardando(true);
    setError(null);
    try {
      if (lista.tipo === 'CANAL') {
        // Solo se ajusta el % global.
        await api.patch(`/admin/listas/${listaId}`, { ajustePctDefault: Number(globalPct || lista.ajustePctDefault) });
      } else {
        // PUBLICA / CUSTOM: armamos upserts (precios cambiados o miembros) + bajas.
        const upserts: Array<{ productoId: string; precioEfectivo: string }> = [];
        const remove: string[] = [];
        for (const c of categorias) {
          for (const p of c.productos) {
            const esMiembro = lista.tipo === 'CUSTOM' ? !!miembros[p.id] : true;
            const eraMiembro = p.enLista;
            if (esMiembro) {
              upserts.push({ productoId: p.id, precioEfectivo: precios[p.id] ?? p.precio });
            } else if (eraMiembro) {
              remove.push(p.id);
            }
          }
        }
        await api.put(`/admin/listas/${listaId}/precios`, { upserts, remove });
      }
      await fetchDetalle();
      setEditando(false);
      setGlobalPct('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <button onClick={onBack} className="text-sm text-ink-500 hover:underline">
            ← Volver a listas
          </button>
          {renombrando ? (
            <div className="flex items-center gap-2 mt-1">
              <input
                value={nuevoNombre}
                onChange={(e) => setNuevoNombre(e.target.value)}
                className="input w-64"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && void renombrar()}
              />
              <Button size="sm" onClick={() => void renombrar()}>
                Guardar
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setRenombrando(false)}>
                ✕
              </Button>
            </div>
          ) : (
            <h2 className="font-display text-lg text-ink-900 mt-1 flex items-center gap-2">
              {lista.nombre}
              <span
                className={cn('text-2xs font-medium px-2 py-0.5 rounded', TIPO_COLOR[lista.tipo])}
              >
                {TIPO_LABEL[lista.tipo]}
              </span>
              <button
                onClick={() => {
                  setNuevoNombre(lista.nombre);
                  setRenombrando(true);
                }}
                className="text-xs text-ink-400 hover:text-teresita-700"
                title="Renombrar lista"
              >
                ✏
              </button>
            </h2>
          )}
          {lista.tipo === 'CANAL' && (
            <p className="text-xs text-ink-500 mt-0.5">
              Precios derivados del público + {Number(lista.ajustePctDefault).toFixed(0)}%. Se
              actualizan solos cuando cambiás el público.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {!editando ? (
            <Button onClick={() => setEditando(true)}>
              {lista.tipo === 'CANAL' ? 'Editar % global' : 'Editar precios'}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => { setEditando(false); void fetchDetalle(); setGlobalPct(''); }}>
                Cancelar
              </Button>
              <Button onClick={() => void guardar()} disabled={guardando}>
                {guardando ? 'Guardando...' : 'Guardar cambios'}
              </Button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      {/* Controles de edición */}
      {editando && (
        <div className="card p-3 flex flex-wrap items-end gap-3 bg-surface-sunken">
          {lista.tipo === 'CANAL' ? (
            <div>
              <label className="block text-2xs uppercase text-ink-500 mb-1">% sobre el público</label>
              <input
                type="number"
                step="0.01"
                defaultValue={Number(lista.ajustePctDefault).toFixed(2)}
                onChange={(e) => setGlobalPct(e.target.value)}
                className="input w-32 font-mono"
              />
            </div>
          ) : (
            <>
              <div>
                <label className="block text-2xs uppercase text-ink-500 mb-1">Aumento global %</label>
                <input
                  type="number"
                  step="0.01"
                  value={globalPct}
                  onChange={(e) => setGlobalPct(e.target.value)}
                  className="input w-28 font-mono"
                  placeholder="ej. 15"
                />
              </div>
              <Button variant="secondary" size="sm" onClick={aplicarGlobalPct} disabled={!globalPct}>
                Aplicar a {lista.tipo === 'CUSTOM' ? 'los marcados' : 'todos'}
              </Button>
              <span className="text-2xs text-ink-500">
                Aplica el % sobre el precio actual; después podés ajustar cada producto a mano antes
                de guardar.
              </span>
            </>
          )}
        </div>
      )}

      {/* Productos por categoría */}
      <div className="space-y-2">
        {categorias.map((cat) => {
          // En modo VER de una custom, mostrar solo los miembros.
          const visibles =
            !editando && lista.tipo === 'CUSTOM'
              ? cat.productos.filter((p) => p.enLista)
              : cat.productos;
          if (visibles.length === 0 && !editando) return null;
          const colapsada = colapsadas[cat.id];
          return (
            <div key={cat.id} className="card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 bg-surface-sunken">
                <button
                  onClick={() => setColapsadas((c) => ({ ...c, [cat.id]: !c[cat.id] }))}
                  className="flex-1 flex items-center gap-2 text-left"
                >
                  <span className="text-ink-500">{colapsada ? '▸' : '▾'}</span>
                  <span className="font-display text-md text-ink-900">
                    {cat.nombre}{' '}
                    <span className="text-2xs text-ink-500 font-normal">
                      ({lista.tipo === 'CUSTOM' ? cat.productos.filter((p) => p.enLista).length : cat.productos.length})
                    </span>
                  </span>
                </button>
                {editando && lista.tipo === 'CUSTOM' && (
                  <button
                    onClick={() => void agregarCategoria(cat.id)}
                    className="text-2xs text-teresita-700 hover:underline whitespace-nowrap"
                    title="Agregar todos los productos de esta categoría a la lista"
                  >
                    + toda la categoría
                  </button>
                )}
              </div>
              {!colapsada && (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-cream-200">
                    {visibles.map((p) => {
                      const original = precioOriginal.get(p.id) ?? p.precio;
                      const editado = precios[p.id] ?? p.precio;
                      const cambio = editando && lista.editablePorProducto && editado !== original;
                      return (
                        <tr key={p.id}>
                          {editando && lista.editableMembresia && (
                            <td className="pl-4 py-2 w-8">
                              <input
                                type="checkbox"
                                checked={!!miembros[p.id]}
                                onChange={(e) => setMiembros((m) => ({ ...m, [p.id]: e.target.checked }))}
                                className="w-4 h-4"
                              />
                            </td>
                          )}
                          <td className="px-4 py-2 text-ink-700">
                            {p.codigo && <span className="text-ink-400 font-mono mr-2">{p.codigo}</span>}
                            {p.nombre}
                          </td>
                          <td className="px-4 py-2 text-right whitespace-nowrap">
                            {editando && lista.editablePorProducto ? (
                              <span className="inline-flex items-center gap-2">
                                {cambio && (
                                  <span className="text-2xs text-ink-400 line-through font-mono">
                                    {Number(original).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                                  </span>
                                )}
                                <input
                                  type="number"
                                  step="0.01"
                                  value={editado}
                                  onChange={(e) => setPrecios((px) => ({ ...px, [p.id]: e.target.value }))}
                                  disabled={lista.tipo === 'CUSTOM' && !miembros[p.id]}
                                  className="input w-28 text-right font-mono py-1 disabled:opacity-40"
                                />
                              </span>
                            ) : (
                              <MoneyAmount value={p.precio} />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modal nueva lista
// ────────────────────────────────────────────────────────────────────────

function ModalNuevaLista({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [nombre, setNombre] = useState('');
  const [ajuste, setAjuste] = useState('0');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!nombre.trim()) return setError('Falta el nombre');
    setGuardando(true);
    setError(null);
    try {
      const res = await api.post<{ id: string }>('/admin/listas', {
        nombre,
        ajustePctDefault: Number(ajuste) || 0,
      });
      onCreated(res.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear la lista');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-md p-5 shadow-modal">
        <h2 className="font-display text-lg text-teresita-700 mb-3">Nueva lista de precios</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">Nombre</label>
            <input
              type="text"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              className="input"
              placeholder="ej. Mayorista, Empresa X"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Ajuste % por default (sobre el público)
            </label>
            <input
              type="number"
              step="0.01"
              value={ajuste}
              onChange={(e) => setAjuste(e.target.value)}
              className="input font-mono"
              placeholder="ej. -15 para 15% de descuento"
            />
            <p className="text-2xs text-ink-500 mt-1">
              Es el precio inicial sugerido al agregar productos (después editás cada uno). Negativo
              = descuento.
            </p>
          </div>
        </div>
        {error && (
          <div className="mt-3 bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
        )}
        <footer className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={guardando}>
            {guardando ? 'Creando...' : 'Crear lista'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
