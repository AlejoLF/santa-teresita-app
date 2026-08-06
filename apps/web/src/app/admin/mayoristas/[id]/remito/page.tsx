'use client';

import { Suspense, use, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { coincideBusqueda } from '@/lib/busqueda';

interface ProductoCat {
  id: string;
  nombre: string;
  marca: string | null;
  codigo?: string | null;
  presentacion?: string | null;
  unidadPrecio: string;
  unidadPrecioLabel: string | null;
  precioUnitario: string;
}
interface Catalogo {
  lista: { id: string; nombre: string };
  productos: ProductoCat[];
}
interface Linea {
  /** `null` para ítems libres (cargados por API sin producto del catálogo). */
  productoId: string | null;
  nombre: string;
  unidadPrecio: string;
  precioUnitario: string;
  cantidad: string;
  /** Clave estable de React: los ítems libres no tienen productoId. */
  key: string;
}
interface RemitoExistente {
  id: string;
  numero: number;
  estado: 'PENDIENTE' | 'PAGADO' | 'ANULADO';
  observaciones: string | null;
  items: Array<{
    productoId: string | null;
    nombre: string;
    cantidad: string;
    precioUnitario: string;
  }>;
}

/** Subtotal de una línea, espejo de subtotalItem del backend. */
function calcSubtotal(cantidad: number, precio: number, unidadPrecio: string): number {
  if (unidadPrecio === 'POR_KILO') return (cantidad / 1000) * precio;
  return cantidad * precio;
}

export default function NuevoRemitoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  // useSearchParams obliga a un límite de Suspense o el build de Next falla.
  return (
    <Suspense fallback={<div className="text-ink-500 p-6">Cargando...</div>}>
      <EditorRemito clienteId={id} />
    </Suspense>
  );
}

function EditorRemito({ clienteId: id }: { clienteId: string }) {
  const router = useRouter();
  // `?editar=<remitoId>` → misma pantalla, pero precargada y guardando con PUT.
  // Reusar el editor en vez de escribir uno aparte evita que creación y edición
  // se vayan separando (y con ellas, el total que calcula cada una).
  const remitoId = useSearchParams().get('editar');
  const editando = Boolean(remitoId);
  const [cat, setCat] = useState<Catalogo | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [observaciones, setObservaciones] = useState('');
  const [numeroEditado, setNumeroEditado] = useState<number | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<Catalogo>(`/admin/mayoristas/${id}/catalogo`);
        setCat(res);
        if (!remitoId) return;
        const rem = await api.get<RemitoExistente>(`/admin/mayoristas/remitos/${remitoId}`);
        if (rem.estado !== 'PENDIENTE') {
          setError(
            rem.estado === 'PAGADO'
              ? 'Este remito ya está cobrado. Marcalo como pendiente para poder editarlo.'
              : 'Este remito está anulado y no se puede editar.',
          );
          return;
        }
        setNumeroEditado(rem.numero);
        setObservaciones(rem.observaciones ?? '');
        // El precio/unidad se toman del catálogo actual cuando el ítem tiene
        // producto: así el editor muestra lo mismo que va a recalcular el
        // backend al guardar. Los ítems libres conservan su precio manual.
        setLineas(
          rem.items.map((it, i) => {
            const p = it.productoId ? res.productos.find((x) => x.id === it.productoId) : undefined;
            return {
              productoId: it.productoId,
              nombre: p?.nombre ?? it.nombre,
              unidadPrecio: p?.unidadPrecio ?? 'POR_UNIDAD',
              precioUnitario: p?.precioUnitario ?? it.precioUnitario,
              cantidad: it.cantidad,
              key: it.productoId ?? `libre-${i}`,
            };
          }),
        );
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) {
          setError('No se pudo cargar el remito');
        }
      }
    })();
  }, [id, remitoId]);

  const filtrados = useMemo(() => {
    if (!cat) return [];
    const base = busqueda.trim()
      ? cat.productos.filter((p) =>
          coincideBusqueda(busqueda, p.nombre, p.marca, p.codigo, p.presentacion),
        )
      : cat.productos;
    return base.slice(0, 60);
  }, [cat, busqueda]);

  function agregar(p: ProductoCat) {
    setLineas((arr) => {
      const ya = arr.find((l) => l.productoId === p.id);
      if (ya) {
        return arr.map((l) =>
          l.productoId === p.id ? { ...l, cantidad: String(Number(l.cantidad) + 1) } : l,
        );
      }
      return [
        ...arr,
        {
          productoId: p.id,
          nombre: p.nombre,
          unidadPrecio: p.unidadPrecio,
          precioUnitario: p.precioUnitario,
          cantidad: '1',
          key: p.id,
        },
      ];
    });
  }

  // Por `key`, no por productoId: los ítems libres lo tienen en null y dos de
  // ellos se pisarían entre sí.
  function setCantidad(key: string, cantidad: string) {
    setLineas((arr) => arr.map((l) => (l.key === key ? { ...l, cantidad } : l)));
  }
  function quitar(key: string) {
    setLineas((arr) => arr.filter((l) => l.key !== key));
  }

  const total = lineas.reduce(
    (acc, l) =>
      acc + calcSubtotal(Number(l.cantidad || 0), Number(l.precioUnitario), l.unidadPrecio),
    0,
  );

  async function guardar() {
    setError(null);
    if (lineas.length === 0) return setError('Agregá al menos un producto');
    if (lineas.some((l) => Number(l.cantidad || 0) <= 0)) {
      return setError('Cada línea tiene que tener cantidad > 0');
    }
    setGuardando(true);
    // Los ítems libres mandan su precio manual; los del catálogo NO, porque el
    // backend los resuelve contra la lista del cliente (precio autoritativo).
    const items = lineas.map((l) => ({
      productoId: l.productoId ?? undefined,
      nombre: l.nombre,
      cantidad: Number(l.cantidad),
      ...(l.productoId ? {} : { precioUnitario: Number(l.precioUnitario).toFixed(2) }),
    }));
    try {
      if (remitoId) {
        await api.put(`/admin/mayoristas/remitos/${remitoId}`, {
          observaciones: observaciones || null,
          items,
        });
      } else {
        await api.post(`/admin/mayoristas/${id}/remitos`, {
          observaciones: observaciones || undefined,
          items,
        });
      }
      router.push(`/admin/mayoristas/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar el remito');
      setGuardando(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header>
        <Link href={`/admin/mayoristas/${id}`} className="text-sm text-ink-500 hover:underline">
          ← Volver a la cuenta
        </Link>
        <h1 className="font-display text-xl text-ink-900 mt-1">
          {editando ? `Editar remito${numeroEditado ? ` #${numeroEditado}` : ''}` : 'Nuevo remito'}
        </h1>
        {cat && <p className="text-sm text-ink-500">Precios de la lista: {cat.lista.nombre}</p>}
      </header>

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Catálogo */}
        <section className="card p-4">
          <h2 className="font-display text-md text-ink-900 mb-2">Productos</h2>
          <input
            type="text"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            className="input mb-3"
            placeholder="Buscar por nombre, marca, código..."
            autoFocus
          />
          {!cat ? (
            <p className="text-sm text-ink-500">Cargando catálogo...</p>
          ) : (
            <div className="max-h-[420px] overflow-y-auto divide-y divide-cream-200">
              {filtrados.map((p) => (
                <button
                  key={p.id}
                  onClick={() => agregar(p)}
                  className="w-full flex items-center justify-between gap-2 py-2 px-1 text-left hover:bg-cream-100 rounded"
                >
                  <span className="text-sm text-ink-700">
                    {p.nombre}
                    {p.marca && <span className="text-ink-400"> · {p.marca}</span>}
                  </span>
                  <span className="text-xs font-mono text-ink-500 whitespace-nowrap">
                    ${Number(p.precioUnitario).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    {p.unidadPrecioLabel ? ` /${p.unidadPrecioLabel}` : ''}
                  </span>
                </button>
              ))}
              {filtrados.length === 0 && (
                <p className="text-sm text-ink-500 py-4 text-center">Sin resultados</p>
              )}
            </div>
          )}
        </section>

        {/* Remito en construcción */}
        <section className="card p-4 flex flex-col">
          <h2 className="font-display text-md text-ink-900 mb-2">Remito</h2>
          {lineas.length === 0 ? (
            <p className="text-sm text-ink-500 flex-1">
              Tocá productos de la izquierda para agregarlos.
            </p>
          ) : (
            <div className="flex-1 space-y-2 overflow-y-auto max-h-[360px]">
              {lineas.map((l) => {
                const sub = calcSubtotal(
                  Number(l.cantidad || 0),
                  Number(l.precioUnitario),
                  l.unidadPrecio,
                );
                return (
                  <div key={l.key} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-ink-700 truncate">{l.nombre}</div>
                      <div className="text-2xs text-ink-500">
                        $
                        {Number(l.precioUnitario).toLocaleString('es-AR', {
                          minimumFractionDigits: 2,
                        })}
                        {l.unidadPrecio === 'POR_KILO' ? ' /kg (cant. en gramos)' : ' c/u'}
                      </div>
                    </div>
                    <input
                      type="number"
                      step="0.001"
                      value={l.cantidad}
                      onChange={(e) => setCantidad(l.key, e.target.value)}
                      className="input w-20 text-sm font-mono text-right py-1"
                    />
                    <span className="w-24 text-right font-mono text-sm text-ink-900">
                      ${sub.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    </span>
                    <button
                      onClick={() => quitar(l.key)}
                      className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="border-t border-cream-300 mt-3 pt-3 space-y-3">
            <input
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              className="input text-sm"
              placeholder="Observaciones del remito (opcional)"
            />
            <div className="flex items-center justify-between">
              <span className="text-sm text-ink-500 uppercase tracking-wide">Total</span>
              <MoneyAmount value={total.toFixed(2)} hero className="text-lg text-teresita-700" />
            </div>
            <Button
              fullWidth
              onClick={() => void guardar()}
              disabled={guardando || lineas.length === 0}
            >
              {guardando ? 'Guardando...' : editando ? 'Guardar cambios' : 'Guardar remito'}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
