'use client';

import { Suspense, use, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { coincideBusqueda } from '@/lib/busqueda';
import { cn } from '@/lib/cn';

interface OpcionCat {
  opcionId: string;
  nombre: string;
  codigo: string | null;
  /** Ya resuelto contra la lista de precios de ESTE cliente. */
  deltaPrecio: string;
}
interface GrupoCat {
  grupoId: string;
  grupoNombre: string;
  obligatorio: boolean;
  tipoSeleccion: 'UNICA' | 'MULTIPLE';
  opciones: OpcionCat[];
}
interface ProductoCat {
  id: string;
  nombre: string;
  marca: string | null;
  codigo?: string | null;
  presentacion?: string | null;
  unidadPrecio: string;
  unidadPrecioLabel: string | null;
  precioUnitario: string;
  grupos: GrupoCat[];
}
interface ModificadorLinea {
  grupoId: string;
  grupoNombre: string;
  opcionId: string;
  opcionNombre: string;
  deltaPrecio: string;
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
  /** Precio de lista del producto, SIN los sabores. */
  precioBase: string;
  /** Lo que se cobra: `precioBase` + la suma de los deltas. */
  precioUnitario: string;
  cantidad: string;
  modificadores: ModificadorLinea[];
  /**
   * Clave estable de React. Incluye los sabores elegidos: dos líneas del mismo
   * producto con sabores distintos son líneas DISTINTAS, no una con cantidad 2.
   */
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
    modificadores: ModificadorLinea[] | null;
  }>;
}

/** Clave de una línea: producto + combinación de sabores. */
function keyDeLinea(productoId: string, mods: ModificadorLinea[]): string {
  const ids = mods.map((m) => m.opcionId).sort();
  return ids.length ? `${productoId}:${ids.join('-')}` : productoId;
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
  // Default prendido: el flujo normal es entregarle el remito a la empresa
  // junto con la mercadería. La encargada lo destilda cuando sólo quiere
  // dejarlo cargado (o cuando está corrigiendo uno y no hace falta el papel).
  const [imprimirAlGuardar, setImprimirAlGuardar] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Producto cuyo sabor se está eligiendo (modal). */
  const [eligiendo, setEligiendo] = useState<ProductoCat | null>(null);

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
            const mods = it.modificadores ?? [];
            // Los deltas se re-leen del catálogo actual (igual que el precio):
            // así el editor muestra lo mismo que va a recalcular el backend.
            const modsFrescos = mods.map((m) => {
              const g = p?.grupos.find((x) => x.grupoId === m.grupoId);
              const o = g?.opciones.find((x) => x.opcionId === m.opcionId);
              return { ...m, deltaPrecio: o?.deltaPrecio ?? m.deltaPrecio };
            });
            const base = p?.precioUnitario ?? it.precioUnitario;
            const delta = modsFrescos.reduce((a, m) => a + Number(m.deltaPrecio || 0), 0);
            return {
              productoId: it.productoId,
              nombre: p?.nombre ?? it.nombre,
              unidadPrecio: p?.unidadPrecio ?? 'POR_UNIDAD',
              precioBase: base,
              precioUnitario: p ? (Number(base) + delta).toFixed(2) : it.precioUnitario,
              cantidad: it.cantidad,
              modificadores: modsFrescos,
              key: it.productoId ? keyDeLinea(it.productoId, modsFrescos) : `libre-${i}`,
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

  /**
   * Agrega una línea con los sabores ya elegidos.
   *
   * La misma combinación producto+sabores suma cantidad; una combinación
   * distinta es una línea nueva. Si sumara todo junto, un remito con dos
   * gustos de pizza saldría con un precio solo y equivocado.
   */
  function agregarLinea(p: ProductoCat, mods: ModificadorLinea[]) {
    const key = keyDeLinea(p.id, mods);
    const delta = mods.reduce((a, m) => a + Number(m.deltaPrecio || 0), 0);
    setLineas((arr) => {
      if (arr.some((l) => l.key === key)) {
        return arr.map((l) =>
          l.key === key ? { ...l, cantidad: String(Number(l.cantidad) + 1) } : l,
        );
      }
      return [
        ...arr,
        {
          productoId: p.id,
          nombre: p.nombre,
          unidadPrecio: p.unidadPrecio,
          precioBase: p.precioUnitario,
          precioUnitario: (Number(p.precioUnitario) + delta).toFixed(2),
          cantidad: '1',
          modificadores: mods,
          key,
        },
      ];
    });
  }

  /** Click en un producto: si tiene sabores, primero hay que elegirlos. */
  function agregar(p: ProductoCat) {
    const conOpciones = p.grupos.filter((g) => g.opciones.length > 0);
    if (conOpciones.length > 0) {
      setEligiendo(p);
      return;
    }
    agregarLinea(p, []);
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
      ...(l.modificadores.length ? { modificadores: l.modificadores } : {}),
      ...(l.productoId ? {} : { precioUnitario: Number(l.precioUnitario).toFixed(2) }),
    }));
    try {
      let guardadoId = remitoId;
      if (remitoId) {
        await api.put(`/admin/mayoristas/remitos/${remitoId}`, {
          observaciones: observaciones || null,
          items,
        });
      } else {
        const creado = await api.post<{ id: string }>(`/admin/mayoristas/${id}/remitos`, {
          observaciones: observaciones || undefined,
          items,
        });
        guardadoId = creado.id;
      }

      // La impresión va DESPUÉS de guardar y en su propio try: si la comandera
      // falla, el remito ya quedó guardado y no se pierde el trabajo de
      // cargarlo. Avisamos y seguimos — desde la ficha del cliente se puede
      // re-imprimir cuando quiera.
      if (imprimirAlGuardar && guardadoId) {
        try {
          await api.post(`/admin/mayoristas/remitos/${guardadoId}/imprimir`, {});
        } catch {
          setError(
            'El remito se guardó, pero no se pudo mandar a imprimir. ' +
              'Podés imprimirlo desde la ficha del cliente.',
          );
          setGuardando(false);
          return;
        }
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
                    {p.grupos.some((g) => g.opciones.length > 0) && (
                      <span className="text-2xs text-teresita-700 ml-2">elegir sabor</span>
                    )}
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
                      {l.modificadores.length > 0 && (
                        <div className="text-2xs text-teresita-700 truncate">
                          {l.modificadores.map((m) => m.opcionNombre).join(' · ')}
                        </div>
                      )}
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
            <label
              className={cn(
                'flex items-center gap-2 px-2 py-2 rounded cursor-pointer text-sm transition-colors',
                imprimirAlGuardar
                  ? 'bg-wood-100 text-wood-900'
                  : 'text-ink-500 hover:bg-cream-100',
              )}
            >
              <input
                type="checkbox"
                checked={imprimirAlGuardar}
                onChange={(e) => setImprimirAlGuardar(e.target.checked)}
                className="w-4 h-4 shrink-0"
              />
              <span aria-hidden>🖨</span>
              <span className="font-medium">Imprimir al guardar</span>
            </label>

            <Button
              fullWidth
              onClick={() => void guardar()}
              disabled={guardando || lineas.length === 0}
            >
              {guardando
                ? 'Guardando...'
                : `${editando ? 'Guardar cambios' : 'Guardar remito'}${
                    imprimirAlGuardar ? ' e imprimir' : ''
                  }`}
            </Button>
          </div>
        </section>
      </div>

      {eligiendo && (
        <ModalSabores
          producto={eligiendo}
          onCancel={() => setEligiendo(null)}
          onConfirm={(mods) => {
            agregarLinea(eligiendo, mods);
            setEligiendo(null);
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Elegir sabores antes de agregar la línea
// ────────────────────────────────────────────────────────────────────────
//
// Es el mismo gesto que en Cargar pedido, pero acotado: acá no hay cantidades
// por sabor ni observaciones — un remito de mayorista es una entrega, no una
// comanda de cocina.

function ModalSabores({
  producto,
  onCancel,
  onConfirm,
}: {
  producto: ProductoCat;
  onCancel: () => void;
  onConfirm: (mods: ModificadorLinea[]) => void;
}) {
  const grupos = producto.grupos.filter((g) => g.opciones.length > 0);
  // grupoId → opcionIds elegidas.
  const [sel, setSel] = useState<Record<string, string[]>>({});

  function toggle(g: GrupoCat, opcionId: string) {
    setSel((prev) => {
      const actual = prev[g.grupoId] ?? [];
      if (g.tipoSeleccion === 'UNICA') {
        return { ...prev, [g.grupoId]: actual[0] === opcionId ? [] : [opcionId] };
      }
      return {
        ...prev,
        [g.grupoId]: actual.includes(opcionId)
          ? actual.filter((x) => x !== opcionId)
          : [...actual, opcionId],
      };
    });
  }

  const elegidos: ModificadorLinea[] = grupos.flatMap((g) =>
    (sel[g.grupoId] ?? []).flatMap((opcionId) => {
      const o = g.opciones.find((x) => x.opcionId === opcionId);
      if (!o) return [];
      return [
        {
          grupoId: g.grupoId,
          grupoNombre: g.grupoNombre,
          opcionId: o.opcionId,
          opcionNombre: o.nombre,
          deltaPrecio: o.deltaPrecio,
        },
      ];
    }),
  );
  const delta = elegidos.reduce((a, m) => a + Number(m.deltaPrecio || 0), 0);
  const faltaObligatorio = grupos.some((g) => g.obligatorio && (sel[g.grupoId] ?? []).length === 0);

  return (
    <div
      className="fixed inset-0 z-50 bg-ink-900/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onCancel}
    >
      <div
        className="card w-full sm:max-w-lg max-h-[85vh] overflow-y-auto p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3 className="font-display text-md text-ink-900">{producto.nombre}</h3>
          <p className="text-2xs text-ink-500">
            Precio de lista: $
            {Number(producto.precioUnitario).toLocaleString('es-AR', { minimumFractionDigits: 2 })}
          </p>
        </header>

        {grupos.map((g) => (
          <section key={g.grupoId}>
            <h4 className="text-sm font-medium text-ink-700 mb-1">
              {g.grupoNombre}
              {g.obligatorio && <span className="text-pomodoro-600 ml-1">*</span>}
              <span className="text-2xs text-ink-400 ml-2">
                {g.tipoSeleccion === 'UNICA' ? 'elegí uno' : 'podés elegir varios'}
              </span>
            </h4>
            <div className="grid grid-cols-2 gap-1">
              {g.opciones.map((o) => {
                const activa = (sel[g.grupoId] ?? []).includes(o.opcionId);
                return (
                  <button
                    key={o.opcionId}
                    type="button"
                    onClick={() => toggle(g, o.opcionId)}
                    className={cn(
                      'text-left text-sm px-2 py-1.5 rounded border transition-colors',
                      activa
                        ? 'border-teresita-700 bg-teresita-50 text-teresita-800'
                        : 'border-cream-300 text-ink-700 hover:bg-cream-100',
                    )}
                  >
                    {o.nombre}
                    {Number(o.deltaPrecio) !== 0 && (
                      <span className="text-2xs text-ink-500 ml-1">
                        +${Number(o.deltaPrecio).toLocaleString('es-AR')}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        <div className="border-t border-cream-300 pt-3 flex items-center justify-between gap-2">
          <span className="text-sm text-ink-500">
            Queda en{' '}
            <strong className="text-ink-900">
              <MoneyAmount value={(Number(producto.precioUnitario) + delta).toFixed(2)} />
            </strong>
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={onCancel}>
              Cancelar
            </Button>
            <Button size="sm" onClick={() => onConfirm(elegidos)} disabled={faltaObligatorio}>
              Agregar
            </Button>
          </div>
        </div>
        {faltaObligatorio && (
          <p className="text-2xs text-pomodoro-600">Falta elegir un sabor obligatorio (*).</p>
        )}
      </div>
    </div>
  );
}
