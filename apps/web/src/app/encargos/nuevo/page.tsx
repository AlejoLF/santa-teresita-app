'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';
import { hoyISO, isoMasDias, type FranjaEntrega, type TipoEntrega } from '@/lib/encargos';
import { coincideBusqueda } from '@/lib/busqueda';

interface Sabor {
  opcionId: string;
  grupoId: string;
  grupoNombre: string;
  nombre: string;
  deltaPrecio: string;
}
interface Producto {
  id: string;
  nombre: string;
  marca?: string | null;
  presentacion?: string | null;
  codigo?: string | null;
  precioBase: string;
  unidadPrecio: string;
  formaVenta: string;
  tipoProducto: { nombre?: string; categoria: { id: string; nombre: string } };
  sabores?: Sabor[];
  saboresResumen?: string[];
  incluyeSalsa?: 'SIMPLE' | 'ESPECIAL' | null;
}
interface Categoria {
  id: string;
  nombre: string;
}
interface ListaOpcion {
  id: string;
  nombre: string;
  canalDefault: string;
}
interface MayoristaOpcion {
  id: string;
  nombre: string;
  telefono: string | null;
  listaPreciosId: string;
}
interface Modificador {
  grupoId: string;
  grupoNombre: string;
  opcionId: string;
  opcionNombre: string;
  deltaPrecio: string;
}
interface CartLine {
  uid: string;
  productoId: string;
  nombre: string;
  unidadPrecio: string;
  precioBase: number;
  cantidad: number;
  modificadores: Modificador[];
}

function lineTotal(l: CartLine): number {
  const delta = l.modificadores.reduce((a, m) => a + Math.max(0, Number(m.deltaPrecio || 0)), 0);
  const precio = l.precioBase + delta;
  if (l.unidadPrecio === 'POR_KILO') return (l.cantidad / 1000) * precio;
  return l.cantidad * precio;
}

const PCORIGEN =
  typeof window !== 'undefined' ? localStorage.getItem('sta-pc-origen') || 'PC1' : 'PC1';

/** Comanderas donde puede salir la comanda del encargo. */
type DestinoImpresion = 'MOSTRADOR' | 'DELIVERY' | 'COCINA';
const DESTINOS_IMPRESION: Array<{ valor: DestinoImpresion; label: string; icono: string }> = [
  { valor: 'MOSTRADOR', label: 'Mostrador', icono: '🧾' },
  { valor: 'DELIVERY', label: 'Delivery', icono: '🛵' },
  { valor: 'COCINA', label: 'Cocina', icono: '🍳' },
];
/** Cada PC recuerda su comandera: la del fondo no imprime en el mostrador. */
const DESTINO_KEY = 'sta-encargos-destino';
function destinoGuardado(): DestinoImpresion {
  if (typeof window === 'undefined') return 'MOSTRADOR';
  const v = localStorage.getItem(DESTINO_KEY);
  return v === 'DELIVERY' || v === 'COCINA' ? v : 'MOSTRADOR';
}

export default function NuevoEncargoPage() {
  // useSearchParams necesita Suspense en Next 15 (CSR bailout).
  return (
    <Suspense fallback={null}>
      <NuevoEncargoInner />
    </Suspense>
  );
}

function NuevoEncargoInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Modo ADICIÓN: ?adicionDe=<ventaId> — el cliente suma productos a un encargo
  // existente. Solo se cargan items (los datos de entrega viven en el padre).
  const adicionDe = searchParams.get('adicionDe');
  const hoy = useMemo(() => hoyISO(), []);

  const [productos, setProductos] = useState<Producto[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [catSel, setCatSel] = useState<string>('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [configProd, setConfigProd] = useState<Producto | null>(null);
  const [enviando, setEnviando] = useState<null | 'cargar' | 'cobrar'>(null);
  const [error, setError] = useState<string | null>(null);
  // Arranca en MOSTRADOR y se corrige tras montar: leer localStorage durante el
  // render rompe la hidratación (el server no lo tiene).
  const [destinoImpresion, setDestinoImpresion] = useState<DestinoImpresion>('MOSTRADOR');
  useEffect(() => setDestinoImpresion(destinoGuardado()), []);
  function elegirDestino(d: DestinoImpresion) {
    setDestinoImpresion(d);
    localStorage.setItem(DESTINO_KEY, d);
  }

  // Nombres editables de las comanderas (los pone el admin en configuración).
  // Si el fetch falla, quedan los labels por defecto — no bloquea la carga.
  const [nombresComandera, setNombresComandera] = useState<Record<string, string>>({});
  useEffect(() => {
    api
      .get<{ destinos: Array<{ destino: string; nombre: string | null }> }>('/impresion/destinos')
      .then((r) => {
        const m: Record<string, string> = {};
        for (const d of r.destinos ?? []) if (d.nombre) m[d.destino] = d.nombre;
        setNombresComandera(m);
      })
      .catch(() => {});
  }, []);

  // Campos del encargo (todos obligatorios salvo indicaciones/observaciones).
  const [fechaEntrega, setFechaEntrega] = useState(isoMasDias(hoy, 1));
  const [modoHora, setModoHora] = useState<'exacta' | 'franja'>('franja');
  const [horaExacta, setHoraExacta] = useState('');
  const [franja, setFranja] = useState<FranjaEntrega | ''>('');
  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [tipoEntrega, setTipoEntrega] = useState<TipoEntrega>('RETIRO');
  const [direccion, setDireccion] = useState('');
  const [indicaciones, setIndicaciones] = useState('');
  const [observaciones, setObservaciones] = useState('');

  // ── Con qué precios y para quién ──────────────────────────────────────
  const [listas, setListas] = useState<ListaOpcion[]>([]);
  const [mayoristas, setMayoristas] = useState<MayoristaOpcion[]>([]);
  const [listaSel, setListaSel] = useState<string>('');
  const [mayoristaSel, setMayoristaSel] = useState<string>('');
  const [aCuentaCorriente, setACuentaCorriente] = useState(false);
  const [cargandoPrecios, setCargandoPrecios] = useState(false);

  const listaActiva = listas.find((l) => l.id === listaSel) ?? null;
  const mayoristaActivo = mayoristas.find((m) => m.id === mayoristaSel) ?? null;

  useEffect(() => {
    (async () => {
      try {
        const [cats, opts] = await Promise.all([
          api.getCached<{ categorias: Categoria[] }>('/catalogo/categorias', 5 * 60_000),
          api.getCached<{
            listas: ListaOpcion[];
            mayoristas: MayoristaOpcion[];
            listaLocalId: string | null;
          }>('/encargos/opciones', 5 * 60_000),
        ]);
        setCategorias(cats.categorias ?? []);
        setListas(opts.listas ?? []);
        setMayoristas(opts.mayoristas ?? []);
        setListaSel(opts.listaLocalId ?? opts.listas?.[0]?.id ?? '');
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) setError('No se pudo cargar el catálogo');
      }
    })();
  }, []);

  // El catálogo se re-pide cuando cambia la lista: los precios que se ven
  // tienen que ser los que se van a guardar. Mostrar los de mostrador mientras
  // el encargo se graba a precio mayorista sería peor que no tener el selector.
  useEffect(() => {
    if (!listaSel) return;
    let vigente = true;
    setCargandoPrecios(true);
    (async () => {
      try {
        const prods = await api.getCached<{ productos: Producto[] }>(
          `/catalogo/productos?limit=2000&listaPreciosId=${listaSel}`,
          5 * 60_000,
        );
        if (!vigente) return;
        setProductos(prods.productos ?? []);
      } catch (e) {
        if (!vigente) return;
        if (!(e instanceof ApiError) || e.status !== 401) setError('No se pudo cargar el catálogo');
      } finally {
        if (vigente) setCargandoPrecios(false);
      }
    })();
    return () => {
      vigente = false;
    };
  }, [listaSel]);

  // Lo que ya está en el changuito quedó valuado con la lista anterior. Se
  // revalúa con la nueva en vez de vaciarlo: la encargada se da cuenta tarde
  // de que era para un mayorista, y hacerla cargar todo de nuevo es la forma
  // segura de que termine no usando el selector.
  useEffect(() => {
    if (productos.length === 0) return;
    setCart((c) =>
      c.map((l) => {
        const p = productos.find((x) => x.id === l.productoId);
        if (!p) return l;
        const mods = l.modificadores.map((m) => {
          const s = p.sabores?.find((x) => x.opcionId === m.opcionId);
          return s ? { ...m, deltaPrecio: s.deltaPrecio } : m;
        });
        return { ...l, precioBase: Number(p.precioBase), modificadores: mods };
      }),
    );
    // Depende SÓLO del catálogo: si mirara el cart entraría en bucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productos]);

  // Elegir un mayorista trae su lista, que es lo que se quiere el 99% de las
  // veces. Queda cambiable después: se pidió poder usar cualquier lista con
  // cualquier cliente.
  function elegirMayorista(id: string) {
    setMayoristaSel(id);
    const m = mayoristas.find((x) => x.id === id);
    if (!m) {
      setACuentaCorriente(false);
      return;
    }
    setListaSel(m.listaPreciosId);
    if (!nombre.trim()) setNombre(m.nombre);
    if (!telefono.trim() && m.telefono) setTelefono(m.telefono);
  }

  const filtrados = useMemo(() => {
    return productos
      .filter((p) => (catSel ? p.tipoProducto.categoria.id === catSel : true))
      .filter((p) =>
        // Multi-campo, igual que el POS: nombre, marca, presentación, código,
        // sabores y sub-categoría/categoría.
        coincideBusqueda(
          busqueda,
          p.nombre,
          p.marca,
          p.presentacion,
          p.codigo,
          p.saboresResumen,
          p.tipoProducto.nombre,
          p.tipoProducto.categoria.nombre,
        ),
      )
      .slice(0, 80);
  }, [productos, busqueda, catSel]);

  function agregarLinea(p: Producto, modificadores: Modificador[], cantidad: number) {
    setCart((c) => [
      ...c,
      {
        uid: Math.random().toString(36).slice(2),
        productoId: p.id,
        nombre: p.nombre,
        unidadPrecio: p.unidadPrecio,
        precioBase: Number(p.precioBase),
        cantidad,
        modificadores,
      },
    ]);
  }

  function clickProducto(p: Producto) {
    if ((p.sabores && p.sabores.length > 0) || p.incluyeSalsa) {
      setConfigProd(p);
    } else {
      agregarLinea(p, [], p.unidadPrecio === 'POR_KILO' ? 0 : 1);
    }
  }

  const total = cart.reduce((a, l) => a + lineTotal(l), 0);

  // Validación: todos los campos obligatorios.
  const faltantes: string[] = [];
  if (cart.length === 0) faltantes.push('productos');
  // En modo adición solo hacen falta los productos (la entrega es la del padre).
  if (!adicionDe) {
    if (!fechaEntrega) faltantes.push('día');
    if (modoHora === 'exacta' && !horaExacta) faltantes.push('hora');
    if (modoHora === 'franja' && !franja) faltantes.push('franja');
    if (!nombre.trim()) faltantes.push('nombre');
    if (!telefono.trim()) faltantes.push('teléfono');
    if (tipoEntrega === 'ENVIO' && !direccion.trim()) faltantes.push('dirección');
  }
  const valido = faltantes.length === 0;

  async function enviar(accion: 'cargar' | 'cobrar') {
    if (!valido) return;
    if (accion === 'cobrar' && aCuentaCorriente) {
      setError('Este encargo va a la cuenta corriente del mayorista: no se cobra acá.');
      return;
    }
    setEnviando(accion);
    setError(null);
    try {
      if (adicionDe) {
        // Adición a un encargo existente: solo items + acción.
        const res = await api.post<{ id: string }>(`/encargos/${adicionDe}/adicion`, {
          pcOrigen: PCORIGEN,
          accion,
          items: cart.map((l) => ({
            productoId: l.productoId,
            cantidad: l.cantidad,
            modificadores: l.modificadores,
          })),
        });
        if (accion === 'cobrar') router.push(`/venta/${res.id}?cobrar=1`);
        else router.push('/encargos');
        return;
      }
      const body = {
        pcOrigen: PCORIGEN,
        accion,
        items: cart.map((l) => ({
          productoId: l.productoId,
          cantidad: l.cantidad,
          modificadores: l.modificadores,
        })),
        fechaEntrega,
        ...(modoHora === 'exacta' ? { horaEntregaExacta: horaExacta } : { franjaEntrega: franja }),
        clienteNombre: nombre.trim(),
        clienteTelefono: telefono.trim(),
        tipoEntrega,
        ...(tipoEntrega === 'ENVIO' && { direccionEntrega: direccion.trim() }),
        ...(indicaciones.trim() && { indicacionesEntrega: indicaciones.trim() }),
        ...(observaciones.trim() && { observaciones: observaciones.trim() }),
        ...(listaSel && { listaPreciosId: listaSel }),
        ...(mayoristaSel && { clienteMayoristaId: mayoristaSel }),
        cobro: aCuentaCorriente ? 'CUENTA_CORRIENTE' : 'AL_ENTREGAR',
        destinoImpresion,
      };
      const res = await api.post<{ id: string }>('/encargos', body);
      if (accion === 'cobrar') {
        router.push(`/venta/${res.id}?cobrar=1`);
      } else {
        router.push('/encargos');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar el encargo');
      setEnviando(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-3 lg:p-5">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="font-display text-lg text-wood-900">
          {adicionDe ? '➕ Agregar productos al encargo' : 'Nuevo encargo'}
        </h1>
        <button onClick={() => router.push('/encargos')} className="text-sm text-ink-500 hover:underline">
          ← Volver
        </button>
      </div>

      {error && (
        <div className="mb-3 bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">{error}</div>
      )}

      {/* ── Con qué precios y para quién ──────────────────────────────────
          Arriba de todo y siempre visible, no escondido en un desplegable: el
          error que importa evitar es cargar veinte líneas sin notar que están
          a precio de mostrador cuando eran para un mayorista. Cuando NO es la
          lista del local, el cartel cambia de color para que salte a la vista. */}
      {!adicionDe && (
        <div
          className={cn(
            'mb-3 rounded-lg border p-3',
            listaActiva && listaActiva.canalDefault !== 'LOCAL_MOSTRADOR'
              ? 'border-saffron-600/40 bg-saffron-100'
              : 'border-cream-300 bg-surface-sunken',
          )}
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-2xs uppercase tracking-wider text-ink-500 flex-1 min-w-[180px]">
              Lista de precios
              <select
                value={listaSel}
                onChange={(e) => setListaSel(e.target.value)}
                className="input w-full mt-1 text-sm font-medium"
              >
                {listas.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.nombre}
                    {l.canalDefault === 'LOCAL_MOSTRADOR' ? ' (la del local)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-2xs uppercase tracking-wider text-ink-500 flex-1 min-w-[180px]">
              Cliente mayorista
              <select
                value={mayoristaSel}
                onChange={(e) => elegirMayorista(e.target.value)}
                className="input w-full mt-1 text-sm"
              >
                <option value="">— No es de un mayorista —</option>
                {mayoristas.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nombre}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="text-2xs text-ink-700 mt-2">
            {cargandoPrecios ? (
              <span className="text-ink-500">Actualizando los precios…</span>
            ) : (
              <>
                Los precios que ves abajo son los de{' '}
                <strong>{listaActiva?.nombre ?? 'la lista elegida'}</strong>.
                {mayoristaActivo && listaActiva?.id !== mayoristaActivo.listaPreciosId && (
                  <span className="text-saffron-600">
                    {' '}
                    Ojo: no es la lista habitual de {mayoristaActivo.nombre}.
                  </span>
                )}
              </>
            )}
          </p>

          {/* El switch aparece sólo con un mayorista elegido: sin él no hay
              cuenta corriente a la que cargar la deuda. */}
          {mayoristaActivo && (
            <label className="mt-2 flex items-start gap-2 text-sm text-ink-900 cursor-pointer">
              <input
                type="checkbox"
                checked={aCuentaCorriente}
                onChange={(e) => setACuentaCorriente(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Va a la cuenta corriente de {mayoristaActivo.nombre}
                <span className="block text-2xs text-ink-500">
                  {aCuentaCorriente
                    ? 'No se cobra acá. Cuando marques la entrega se genera el remito que suma a su deuda.'
                    : 'Se cobra al entregar, como cualquier encargo.'}
                </span>
              </span>
            </label>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
        {/* Catálogo */}
        <section className="card p-3">
          <input
            type="text"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre, marca, código…"
            className="input mb-2"
            autoFocus
          />
          <div className="flex gap-1 flex-wrap mb-2">
            <button
              onClick={() => setCatSel('')}
              className={cn(
                'px-2.5 py-1 rounded text-2xs font-medium',
                !catSel ? 'bg-wood-700 text-wood-50' : 'bg-cream-200 text-ink-700',
              )}
            >
              Todas
            </button>
            {categorias.map((c) => (
              <button
                key={c.id}
                onClick={() => setCatSel(c.id)}
                className={cn(
                  'px-2.5 py-1 rounded text-2xs font-medium',
                  catSel === c.id ? 'bg-wood-700 text-wood-50' : 'bg-cream-200 text-ink-700',
                )}
              >
                {c.nombre}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-[60vh] overflow-y-auto">
            {filtrados.map((p) => (
              <button
                key={p.id}
                onClick={() => clickProducto(p)}
                className="border border-cream-300 rounded-md p-2 text-left hover:border-wood-600 hover:bg-wood-50 transition-colors"
              >
                <div className="text-sm text-ink-900 leading-tight">{p.nombre}</div>
                <div className="text-2xs font-mono text-ink-500 mt-0.5">
                  ${Number(p.precioBase).toLocaleString('es-AR')}
                  {(p.sabores?.length || p.incluyeSalsa) ? ' · elegir' : ''}
                </div>
              </button>
            ))}
            {filtrados.length === 0 && (
              <p className="col-span-full text-sm text-ink-500 py-6 text-center">Sin resultados</p>
            )}
          </div>
        </section>

        {/* Carrito + datos del encargo */}
        <aside className="space-y-3">
          {/* Carrito */}
          <section className="card p-3">
            <h2 className="font-display text-md text-wood-900 mb-2">Pedido</h2>
            {cart.length === 0 ? (
              <p className="text-sm text-ink-500">Tocá productos para agregarlos.</p>
            ) : (
              <div className="space-y-2 max-h-[28vh] overflow-y-auto">
                {cart.map((l) => (
                  <div key={l.uid} className="flex items-center gap-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="text-ink-900 truncate">
                        {l.nombre}
                        {l.modificadores.length > 0 && (
                          <span className="text-ink-500">
                            {' '}({l.modificadores.map((m) => m.opcionNombre).join(' · ')})
                          </span>
                        )}
                      </div>
                      <div className="text-2xs font-mono text-ink-500">
                        <MoneyAmount value={lineTotal(l).toFixed(2)} />
                      </div>
                    </div>
                    <input
                      type="number"
                      min="0"
                      step={l.unidadPrecio === 'POR_KILO' ? 100 : 1}
                      value={l.cantidad}
                      onChange={(e) =>
                        setCart((c) =>
                          c.map((x) =>
                            x.uid === l.uid ? { ...x, cantidad: Number(e.target.value) } : x,
                          ),
                        )
                      }
                      className="input w-16 text-sm py-1 text-right font-mono"
                    />
                    <button
                      onClick={() => setCart((c) => c.filter((x) => x.uid !== l.uid))}
                      className="text-pomodoro-600 px-1"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between border-t border-cream-300 mt-2 pt-2">
              <span className="text-sm text-ink-500 uppercase tracking-wide">Total</span>
              <MoneyAmount value={total.toFixed(2)} hero className="text-lg text-wood-700" />
            </div>
          </section>

          {/* Datos OBLIGATORIOS del encargo (ocultos en modo adición: la
              entrega/cliente son los del encargo padre) */}
          <section className="card p-3 border-t-4 border-wood-700 space-y-3">
            <h2 className="font-display text-md text-wood-900">
              {adicionDe ? 'Confirmar adición' : 'Datos del encargo'}
            </h2>
            {adicionDe && (
              <p className="text-2xs text-ink-500">
                Los productos se suman al encargo original (misma entrega y cliente). Si el
                encargo <b>todavía no se cobró</b>, se agregan al mismo total y se paga todo
                junto. Si <b>ya estaba pagado</b>, la comanda sale con <b>PAGO PARCIAL</b> hasta
                cobrar lo agregado.
              </p>
            )}

            <div className={cn('space-y-3', adicionDe && 'hidden')}>
            <div>
              <label className="block text-2xs font-semibold uppercase text-wood-700 mb-1">
                Día de entrega *
              </label>
              <input
                type="date"
                value={fechaEntrega}
                min={hoy}
                onChange={(e) => setFechaEntrega(e.target.value)}
                className="input text-sm"
              />
            </div>

            <div>
              <label className="block text-2xs font-semibold uppercase text-wood-700 mb-1">
                Horario *
              </label>
              <div className="flex gap-1 mb-1.5">
                <button
                  type="button"
                  onClick={() => setModoHora('franja')}
                  className={cn(
                    'flex-1 px-2 py-1 rounded text-xs font-medium border',
                    modoHora === 'franja'
                      ? 'bg-wood-700 text-wood-50 border-wood-700'
                      : 'bg-white text-ink-700 border-cream-300',
                  )}
                >
                  Franja
                </button>
                <button
                  type="button"
                  onClick={() => setModoHora('exacta')}
                  className={cn(
                    'flex-1 px-2 py-1 rounded text-xs font-medium border',
                    modoHora === 'exacta'
                      ? 'bg-wood-700 text-wood-50 border-wood-700'
                      : 'bg-white text-ink-700 border-cream-300',
                  )}
                >
                  Hora exacta
                </button>
              </div>
              {modoHora === 'franja' ? (
                <div className="flex gap-1">
                  {(['MANANA', 'TARDE', 'NOCHE'] as FranjaEntrega[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFranja(f)}
                      className={cn(
                        'flex-1 px-2 py-1.5 rounded text-xs font-medium border',
                        franja === f
                          ? 'bg-wood-600 text-wood-50 border-wood-600'
                          : 'bg-white text-ink-700 border-cream-300 hover:bg-wood-50',
                      )}
                    >
                      {f === 'MANANA' ? 'Mañana' : f === 'TARDE' ? 'Tarde' : 'Noche'}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  type="time"
                  value={horaExacta}
                  onChange={(e) => setHoraExacta(e.target.value)}
                  className="input text-sm"
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-2xs font-semibold uppercase text-wood-700 mb-1">
                  Nombre *
                </label>
                <input
                  type="text"
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  className="input text-sm"
                />
              </div>
              <div>
                <label className="block text-2xs font-semibold uppercase text-wood-700 mb-1">
                  Teléfono *
                </label>
                <input
                  type="tel"
                  value={telefono}
                  onChange={(e) => setTelefono(e.target.value)}
                  className="input text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-2xs font-semibold uppercase text-wood-700 mb-1">
                Entrega *
              </label>
              <div className="flex gap-1">
                {(['RETIRO', 'ENVIO'] as TipoEntrega[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTipoEntrega(t)}
                    className={cn(
                      'flex-1 px-2 py-1.5 rounded text-sm font-medium border',
                      tipoEntrega === t
                        ? 'bg-wood-700 text-wood-50 border-wood-700'
                        : 'bg-white text-ink-700 border-cream-300 hover:bg-wood-50',
                    )}
                  >
                    {t === 'RETIRO' ? '🏪 Retira en local' : '🛵 Envío'}
                  </button>
                ))}
              </div>
            </div>

            {tipoEntrega === 'ENVIO' && (
              <div>
                <label className="block text-2xs font-semibold uppercase text-wood-700 mb-1">
                  Dirección *
                </label>
                <input
                  type="text"
                  value={direccion}
                  onChange={(e) => setDireccion(e.target.value)}
                  placeholder="Calle, número, piso/dpto"
                  className="input text-sm"
                />
              </div>
            )}

            <input
              type="text"
              value={indicaciones}
              onChange={(e) => setIndicaciones(e.target.value)}
              placeholder="Indicaciones (opcional)"
              className="input text-xs py-1.5"
            />
            <input
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              placeholder="Observaciones del encargo (opcional)"
              className="input text-xs py-1.5"
            />
            </div>

            {!valido && (
              <p className="text-2xs text-pomodoro-600">Falta completar: {faltantes.join(', ')}.</p>
            )}

            {/* Comandera destino — los encargos también se toman desde PCs que
                no son la del mostrador. La elección queda recordada en esta PC.
                En una adición no se pregunta: sale por la del encargo original. */}
            {!adicionDe && (
              <div className="pt-1">
                <label className="text-2xs uppercase tracking-wide text-wood-700 font-semibold">
                  Imprimir comanda en
                </label>
                <div className="grid grid-cols-3 gap-1.5 mt-1">
                  {DESTINOS_IMPRESION.map((d) => (
                    <button
                      key={d.valor}
                      type="button"
                      onClick={() => elegirDestino(d.valor)}
                      className={cn(
                        'px-2 py-2 rounded-md border text-xs font-medium transition-colors',
                        destinoImpresion === d.valor
                          ? 'bg-wood-700 text-wood-50 border-wood-700'
                          : 'bg-white text-wood-700 border-wood-300 hover:bg-wood-50',
                      )}
                    >
                      {d.icono} {nombresComandera[d.valor] ?? d.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* A cuenta corriente no hay nada que cobrar acá: la plata entra
                cuando el mayorista salda el remito. Se muestra un solo botón
                en vez de dejar uno que el backend va a rechazar igual. */}
            {aCuentaCorriente ? (
              <div className="pt-1">
                <button
                  onClick={() => void enviar('cargar')}
                  disabled={!valido || enviando !== null}
                  className="w-full px-3 py-3 rounded-md bg-wood-700 text-wood-50 font-medium hover:bg-wood-900 disabled:opacity-40 transition-colors"
                >
                  {enviando === 'cargar' ? 'Cargando…' : '📋 Cargar a cuenta corriente'}
                </button>
                <p className="text-2xs text-ink-500 mt-1 text-center">
                  Se cobra desde Mayoristas cuando salde el remito.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  onClick={() => void enviar('cargar')}
                  disabled={!valido || enviando !== null}
                  className="px-3 py-3 rounded-md border-2 border-wood-700 text-wood-700 font-medium hover:bg-wood-50 disabled:opacity-40 transition-colors"
                >
                  {enviando === 'cargar' ? 'Cargando…' : '📋 Cargar (a pagar)'}
                </button>
                <button
                  onClick={() => void enviar('cobrar')}
                  disabled={!valido || enviando !== null}
                  className="px-3 py-3 rounded-md bg-wood-700 text-wood-50 font-medium hover:bg-wood-900 disabled:opacity-40 transition-colors"
                >
                  {enviando === 'cobrar' ? 'Yendo al cobro…' : '💵 Cobrar'}
                </button>
              </div>
            )}
          </section>
        </aside>
      </div>

      {configProd && (
        <ConfigProductoModal
          producto={configProd}
          onClose={() => setConfigProd(null)}
          onConfirm={(mods, cant) => {
            agregarLinea(configProd, mods, cant);
            setConfigProd(null);
          }}
        />
      )}
    </div>
  );
}

/** Modal simple para elegir sabor/salsa + cantidad antes de agregar al pedido. */
function ConfigProductoModal({
  producto,
  onClose,
  onConfirm,
}: {
  producto: Producto;
  onClose: () => void;
  onConfirm: (modificadores: Modificador[], cantidad: number) => void;
}) {
  // Sabores propios del producto (ej. "Ricota y espinaca" de los Ravioles).
  const opciones = producto.sabores ?? [];
  const [sel, setSel] = useState<string>('');
  // Salsa INCLUIDA de las porciones calientes — mismo comportamiento que el
  // cargar-pedido normal: se elige aparte del sabor y viaja como modificador
  // con deltaPrecio 0 (el precio de la porción ya la incluye).
  const [salsas, setSalsas] = useState<Sabor[]>([]);
  const [salsaProductoId, setSalsaProductoId] = useState<string | null>(null);
  const [salsaSel, setSalsaSel] = useState<string>('');
  const [cantidad, setCantidad] = useState(1);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    // OJO: se buscan las salsas SIEMPRE que la porción incluya salsa — antes
    // solo se buscaban si el producto no tenía sabores, y desde la reorg de
    // porciones (sabores a nivel producto) el menú de salsas no aparecía.
    if (producto.incluyeSalsa) {
      setCargando(true);
      api
        .get<{ producto: { id: string }; sabores: Sabor[] }>(`/catalogo/salsa/${producto.incluyeSalsa}`)
        .then((r) => {
          setSalsas(r.sabores ?? []);
          setSalsaProductoId(r.producto?.id ?? null);
        })
        .catch(() => setSalsas([]))
        .finally(() => setCargando(false));
    }
  }, [producto]);

  // Extras "manuales" de salsa — no son OpcionModificador reales, son etiquetas
  // frontend-only (mismo listado que el cargar-pedido normal).
  const extrasSalsa: Array<{ id: string; nombre: string }> =
    producto.incluyeSalsa === 'SIMPLE'
      ? [
          { id: '__aceite', nombre: 'Aceite' },
          { id: '__aceite_oliva', nombre: 'Aceite de oliva' },
          { id: '__manteca', nombre: 'Manteca' },
        ]
      : producto.incluyeSalsa === 'ESPECIAL'
        ? [
            { id: '__mixta', nombre: 'Mixta' },
            { id: '__rosa', nombre: 'Rosa' },
          ]
        : [];

  function confirmar() {
    const mods: Modificador[] = [];
    const op = opciones.find((o) => o.opcionId === sel);
    if (op) {
      mods.push({
        grupoId: op.grupoId,
        grupoNombre: op.grupoNombre,
        opcionId: op.opcionId,
        opcionNombre: op.nombre,
        deltaPrecio: op.deltaPrecio ?? '0',
      });
    }
    if (producto.incluyeSalsa && salsaSel) {
      const salsaReal = salsas.find((s) => s.opcionId === salsaSel);
      if (salsaReal) {
        mods.push({
          grupoId: salsaReal.grupoId,
          grupoNombre: salsaReal.grupoNombre,
          opcionId: salsaReal.opcionId,
          opcionNombre: salsaReal.nombre,
          deltaPrecio: '0', // incluida — el cargo está en la porción
        });
      } else {
        const extra = extrasSalsa.find((e) => e.id === salsaSel);
        if (extra) {
          mods.push({
            grupoId: salsaProductoId ?? '__salsa',
            grupoNombre:
              producto.incluyeSalsa === 'SIMPLE' ? 'Tipo — Salsa simple' : 'Tipo — Salsa especial',
            opcionId: extra.id,
            opcionNombre: extra.nombre,
            deltaPrecio: '0',
          });
        }
      }
    }
    onConfirm(mods, cantidad);
  }

  return (
    <div className="fixed inset-0 bg-ink-900/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-4 shadow-modal border-t-4 border-wood-700" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-display text-md text-wood-900 mb-2">{producto.nombre}</h3>
        {cargando ? (
          <p className="text-sm text-ink-500 py-4">Cargando opciones…</p>
        ) : (
          <div className="max-h-[52vh] overflow-y-auto mb-3 space-y-3">
            {/* Sabor del producto (si tiene) */}
            {opciones.length > 0 && (
              <div>
                <div className="text-2xs font-semibold uppercase tracking-wider text-wood-700 mb-1">
                  Sabor *
                </div>
                <div className="divide-y divide-cream-200 border border-cream-200 rounded-md">
                  {opciones.map((o) => (
                    <button
                      key={o.opcionId}
                      onClick={() => setSel(o.opcionId)}
                      className={cn(
                        'w-full text-left px-2 py-2 text-sm flex justify-between items-center',
                        sel === o.opcionId ? 'bg-wood-100' : 'hover:bg-cream-100',
                      )}
                    >
                      <span>{o.nombre}</span>
                      {Number(o.deltaPrecio) > 0 && (
                        <span className="text-2xs font-mono text-ink-500">+${Number(o.deltaPrecio).toLocaleString('es-AR')}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Salsa incluida (porciones calientes) — igual que el cargar-pedido */}
            {producto.incluyeSalsa && (
              <div>
                <div className="text-2xs font-semibold uppercase tracking-wider text-wood-700 mb-1">
                  Salsa {producto.incluyeSalsa === 'SIMPLE' ? 'simple' : 'especial'} (incluida)
                </div>
                <div className="divide-y divide-cream-200 border border-cream-200 rounded-md">
                  {[...salsas.map((s) => ({ id: s.opcionId, nombre: s.nombre })), ...extrasSalsa].map(
                    (s) => (
                      <button
                        key={s.id}
                        onClick={() => setSalsaSel(salsaSel === s.id ? '' : s.id)}
                        className={cn(
                          'w-full text-left px-2 py-2 text-sm flex justify-between items-center',
                          salsaSel === s.id ? 'bg-wood-100' : 'hover:bg-cream-100',
                        )}
                      >
                        <span>{s.nombre}</span>
                        {salsaSel === s.id && <span className="text-wood-700 text-xs">✓</span>}
                      </button>
                    ),
                  )}
                  {salsas.length === 0 && extrasSalsa.length === 0 && (
                    <p className="text-sm text-ink-500 px-2 py-2">Cargando salsas…</p>
                  )}
                </div>
              </div>
            )}
            {opciones.length === 0 && !producto.incluyeSalsa && (
              <p className="text-sm text-ink-500 py-3">Sin opciones — se agrega directo.</p>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="text-sm text-ink-700">Cantidad</label>
          <input
            type="number"
            min="1"
            value={cantidad}
            onChange={(e) => setCantidad(Number(e.target.value))}
            className="input w-20 text-sm py-1 text-right font-mono"
          />
          <button
            onClick={confirmar}
            disabled={opciones.length > 0 && !sel}
            className="ml-auto px-4 py-2 rounded-md bg-wood-700 text-wood-50 text-sm font-medium hover:bg-wood-900 disabled:opacity-40"
          >
            Agregar
          </button>
        </div>
      </div>
    </div>
  );
}
