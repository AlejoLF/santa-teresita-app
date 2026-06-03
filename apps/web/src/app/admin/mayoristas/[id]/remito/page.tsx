'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';

interface ProductoCat {
  id: string;
  nombre: string;
  marca: string | null;
  unidadPrecio: string;
  unidadPrecioLabel: string | null;
  precioUnitario: string;
}
interface Catalogo {
  lista: { id: string; nombre: string };
  productos: ProductoCat[];
}
interface Linea {
  productoId: string;
  nombre: string;
  unidadPrecio: string;
  precioUnitario: string;
  cantidad: string;
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
  const router = useRouter();
  const [cat, setCat] = useState<Catalogo | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [observaciones, setObservaciones] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<Catalogo>(`/admin/mayoristas/${id}/catalogo`);
        setCat(res);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) {
          setError('No se pudo cargar el catálogo');
        }
      }
    })();
  }, [id]);

  const filtrados = useMemo(() => {
    if (!cat) return [];
    const q = busqueda.trim().toLowerCase();
    const base = q
      ? cat.productos.filter((p) => p.nombre.toLowerCase().includes(q))
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
        },
      ];
    });
  }

  function setCantidad(productoId: string, cantidad: string) {
    setLineas((arr) => arr.map((l) => (l.productoId === productoId ? { ...l, cantidad } : l)));
  }
  function quitar(productoId: string) {
    setLineas((arr) => arr.filter((l) => l.productoId !== productoId));
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
    try {
      await api.post(`/admin/mayoristas/${id}/remitos`, {
        observaciones: observaciones || undefined,
        items: lineas.map((l) => ({
          productoId: l.productoId,
          nombre: l.nombre,
          cantidad: Number(l.cantidad),
        })),
      });
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
        <h1 className="font-display text-xl text-ink-900 mt-1">Nuevo remito</h1>
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
            placeholder="Buscar producto..."
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
                  <div key={l.productoId} className="flex items-center gap-2">
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
                      onChange={(e) => setCantidad(l.productoId, e.target.value)}
                      className="input w-20 text-sm font-mono text-right py-1"
                    />
                    <span className="w-24 text-right font-mono text-sm text-ink-900">
                      ${sub.toLocaleString('es-AR', { minimumFractionDigits: 2 })}
                    </span>
                    <button
                      onClick={() => quitar(l.productoId)}
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
              {guardando ? 'Guardando...' : 'Guardar remito'}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
