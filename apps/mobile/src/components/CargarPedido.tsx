'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Sabor {
  opcionId: string;
  grupoId: string;
  grupoNombre: string;
  nombre: string;
  deltaPrecio: string;
  codigo: string | null;
}

interface Producto {
  id: string;
  codigo: string | null;
  nombre: string;
  precioBase: string;
  formaVenta: string;
  unidadPrecio: string;
  cantidadDefault: string | null;
  incluyeSalsa: 'SIMPLE' | 'ESPECIAL' | null;
  tipo: { id: string; nombre: string; cocinaInterviene: boolean };
  categoriaId: string;
  sabores: Sabor[];
}

interface Categoria {
  id: string;
  nombre: string;
  icono: string | null;
}

interface CartItem {
  productoId: string;
  nombre: string;
  precioUnitario: number;
  cantidad: number;
  opcionId?: string;
  opcionNombre?: string;
  observacion?: string;
}

const CANALES = ['MOSTRADOR', 'TELEFONO', 'WHATSAPP', 'RAPPI', 'PEDIDOS_YA', 'DELIVERATE'] as const;
const MODALIDADES = ['TAKE_AWAY', 'DELIVERY_PROPIO', 'DELIVERY_PLATAFORMA'] as const;
const METODOS = [
  { value: 'EFECTIVO', label: 'Efectivo (-10%)' },
  { value: 'DEBITO', label: 'Débito' },
  { value: 'CREDITO_1_PAGO', label: 'Crédito 1 pago' },
  { value: 'TRANSFERENCIA', label: 'Transferencia' },
  { value: 'MERCADOPAGO_QR', label: 'MercadoPago QR' },
  { value: 'OTRO', label: 'Otro' },
];

function formatARS(n: number) {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(n);
}

export function CargarPedido({ nombre, rol }: { nombre: string; rol: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [catActiva, setCatActiva] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [productoSeleccionado, setProductoSeleccionado] = useState<Producto | null>(null);
  const [carrito, setCarrito] = useState<CartItem[]>([]);
  const [mostrarCobro, setMostrarCobro] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [exito, setExito] = useState<{ numero: number; total: number } | null>(null);

  useEffect(() => {
    fetch('/api/catalogo/full')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { categorias: Categoria[]; productos: Producto[] }) => {
        setCategorias(data.categorias);
        setProductos(data.productos);
        if (data.categorias.length > 0) setCatActiva(data.categorias[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error cargando catálogo'))
      .finally(() => setLoading(false));
  }, []);

  const productosFiltrados = useMemo(() => {
    let lista = productos;
    if (catActiva) lista = lista.filter((p) => p.categoriaId === catActiva);
    if (busqueda.trim()) {
      const q = busqueda.toLowerCase().trim();
      // Si es solo dígitos, buscamos por código
      if (/^\d+$/.test(q)) {
        lista = lista.filter((p) => p.codigo?.includes(q));
      } else {
        lista = lista.filter((p) => p.nombre.toLowerCase().includes(q));
      }
    }
    return lista.slice(0, 80); // límite UI para perf
  }, [productos, catActiva, busqueda]);

  const subtotalCarrito = carrito.reduce((s, it) => s + it.precioUnitario * it.cantidad, 0);

  function agregarAlCarrito(item: CartItem) {
    setCarrito((c) => [...c, item]);
    setProductoSeleccionado(null);
  }

  function quitarDelCarrito(idx: number) {
    setCarrito((c) => c.filter((_, i) => i !== idx));
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  if (exito) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-cream-100 px-6 text-center safe-top safe-bottom">
        <div className="text-6xl mb-4">✓</div>
        <h1 className="font-display text-2xl text-teresita-700 mb-2">Pedido cargado</h1>
        <p className="text-ink-700 mb-1">Venta Nº {exito.numero}</p>
        <p className="text-3xl font-mono text-teresita-900 mb-8">{formatARS(exito.total)}</p>
        <button
          onClick={() => {
            setCarrito([]);
            setExito(null);
          }}
          className="bg-teresita-700 text-cream-50 px-6 py-3 rounded-md font-semibold"
        >
          Cargar otro pedido
        </button>
        {rol === 'ADMIN' && (
          <button
            onClick={() => router.push('/')}
            className="mt-3 text-sm text-ink-500 underline"
          >
            Volver al panel
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-cream-100 safe-top">
      <header className="bg-teresita-700 text-cream-50 px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <div>
          <p className="font-display text-md leading-tight">Cargar pedido</p>
          <p className="text-2xs text-cream-100/80">{nombre}</p>
        </div>
        <div className="flex items-center gap-2">
          {rol === 'ADMIN' && (
            <button
              onClick={() => router.push('/')}
              className="text-2xs px-2 py-1 rounded bg-cream-50 text-teresita-700"
            >
              Panel
            </button>
          )}
          <button
            onClick={logout}
            className="text-2xs px-2 py-1 rounded bg-teresita-900/30 text-cream-50"
          >
            Salir
          </button>
        </div>
      </header>

      {/* Búsqueda */}
      <div className="px-3 py-2 bg-white border-b border-cream-300 sticky top-[56px] z-10">
        <input
          type="search"
          inputMode="search"
          placeholder="Buscar por nombre o código…"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          className="w-full px-3 py-2 rounded-md border border-cream-300 text-sm"
        />
      </div>

      {/* Tabs categorías */}
      {categorias.length > 0 && (
        <nav className="bg-white border-b border-cream-300 overflow-x-auto whitespace-nowrap px-2 py-2 flex gap-2">
          {categorias.map((c) => (
            <button
              key={c.id}
              onClick={() => setCatActiva(c.id)}
              className={
                catActiva === c.id
                  ? 'px-3 py-1 rounded-full bg-teresita-700 text-cream-50 text-2xs font-medium'
                  : 'px-3 py-1 rounded-full bg-cream-100 text-ink-700 text-2xs'
              }
            >
              {c.icono ? `${c.icono} ` : ''}
              {c.nombre}
            </button>
          ))}
        </nav>
      )}

      {/* Lista productos */}
      <main className="flex-1 overflow-y-auto px-3 py-2 pb-32">
        {loading && <p className="text-center text-ink-500 mt-8">Cargando catálogo…</p>}
        {error && <p className="text-center text-pomodoro-600 mt-8">Error: {error}</p>}
        {!loading && !error && productosFiltrados.length === 0 && (
          <p className="text-center text-ink-500 mt-8">Sin resultados</p>
        )}
        <ul className="space-y-2">
          {productosFiltrados.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setProductoSeleccionado(p)}
                className="w-full flex items-center justify-between bg-white rounded-md border border-cream-300 px-3 py-2 text-left hover:bg-cream-100"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink-900 truncate">{p.nombre}</div>
                  <div className="text-2xs text-ink-500">
                    {p.codigo ? `#${p.codigo} · ` : ''}
                    {p.tipo.nombre}
                    {p.sabores.length > 0 ? ` · ${p.sabores.length} sabores` : ''}
                  </div>
                </div>
                <div className="text-sm font-mono text-teresita-700 ml-2 shrink-0">
                  {formatARS(Number(p.precioBase))}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </main>

      {/* Carrito flotante */}
      {carrito.length > 0 && (
        <button
          onClick={() => setMostrarCobro(true)}
          className="fixed bottom-4 left-4 right-4 bg-teresita-700 text-cream-50 px-4 py-3 rounded-md font-semibold shadow-lg flex items-center justify-between safe-bottom"
        >
          <span>
            {carrito.length} ítem{carrito.length === 1 ? '' : 's'} · {formatARS(subtotalCarrito)}
          </span>
          <span>Cobrar →</span>
        </button>
      )}

      {/* Modal selector de producto */}
      {productoSeleccionado && (
        <ProductoModal
          producto={productoSeleccionado}
          onCerrar={() => setProductoSeleccionado(null)}
          onAgregar={agregarAlCarrito}
        />
      )}

      {/* Modal cobro */}
      {mostrarCobro && (
        <CobroModal
          carrito={carrito}
          subtotal={subtotalCarrito}
          enviando={enviando}
          onCerrar={() => setMostrarCobro(false)}
          onQuitarItem={quitarDelCarrito}
          onConfirmar={async (payload) => {
            setEnviando(true);
            try {
              const r = await fetch('/api/ventas', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
              });
              const data = await r.json();
              if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
              setMostrarCobro(false);
              setExito({ numero: data.numero, total: Number(data.total) });
            } catch (e) {
              alert(e instanceof Error ? e.message : 'Error guardando la venta');
            } finally {
              setEnviando(false);
            }
          }}
        />
      )}
    </div>
  );
}

function ProductoModal({
  producto,
  onCerrar,
  onAgregar,
}: {
  producto: Producto;
  onCerrar: () => void;
  onAgregar: (item: CartItem) => void;
}) {
  const [cantidad, setCantidad] = useState<number>(Number(producto.cantidadDefault ?? 1));
  const [sabor, setSabor] = useState<Sabor | null>(
    producto.sabores.length > 0 ? producto.sabores[0] : null,
  );
  const [obs, setObs] = useState('');

  const precioFinal = Number(producto.precioBase) + Number(sabor?.deltaPrecio ?? 0);
  const total = precioFinal * cantidad;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end" onClick={onCerrar}>
      <div
        className="bg-white w-full rounded-t-xl p-4 max-h-[85vh] overflow-y-auto safe-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="font-display text-lg text-teresita-700">{producto.nombre}</h2>
            <p className="text-2xs text-ink-500">{producto.tipo.nombre}</p>
          </div>
          <button onClick={onCerrar} className="text-ink-500 text-2xl leading-none">
            ×
          </button>
        </div>

        {producto.sabores.length > 0 && (
          <div className="mb-3">
            <label className="block text-2xs font-semibold text-ink-700 mb-1 uppercase">
              {producto.sabores[0].grupoNombre}
            </label>
            <div className="grid grid-cols-2 gap-1">
              {producto.sabores.map((s) => (
                <button
                  key={s.opcionId}
                  onClick={() => setSabor(s)}
                  className={
                    sabor?.opcionId === s.opcionId
                      ? 'px-2 py-2 text-xs rounded border bg-teresita-700 text-cream-50 border-teresita-700'
                      : 'px-2 py-2 text-xs rounded border bg-white text-ink-700 border-cream-300'
                  }
                >
                  {s.nombre}
                  {Number(s.deltaPrecio) !== 0 && (
                    <span className="block text-2xs opacity-80">
                      {Number(s.deltaPrecio) > 0 ? '+' : ''}
                      {formatARS(Number(s.deltaPrecio))}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mb-3">
          <label className="block text-2xs font-semibold text-ink-700 mb-1 uppercase">
            Cantidad
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setCantidad((c) => Math.max(0.5, c - 1))}
              className="w-10 h-10 rounded-full bg-cream-100 text-xl font-bold text-ink-700"
            >
              −
            </button>
            <input
              type="number"
              inputMode="decimal"
              value={cantidad}
              onChange={(e) => setCantidad(Number(e.target.value) || 0)}
              className="flex-1 text-center text-lg font-mono border border-cream-300 rounded-md py-2"
              step="0.5"
              min="0"
            />
            <button
              onClick={() => setCantidad((c) => c + 1)}
              className="w-10 h-10 rounded-full bg-cream-100 text-xl font-bold text-ink-700"
            >
              +
            </button>
          </div>
        </div>

        <div className="mb-3">
          <label className="block text-2xs font-semibold text-ink-700 mb-1 uppercase">
            Observación (opcional)
          </label>
          <input
            type="text"
            value={obs}
            onChange={(e) => setObs(e.target.value)}
            placeholder="ej: sin sal, bien tostado…"
            className="w-full px-3 py-2 rounded-md border border-cream-300 text-sm"
          />
        </div>

        <div className="flex items-center justify-between mb-3 pt-3 border-t border-cream-300">
          <span className="text-2xs text-ink-500">
            {formatARS(precioFinal)} × {cantidad}
          </span>
          <span className="text-lg font-mono text-teresita-900">{formatARS(total)}</span>
        </div>

        <button
          onClick={() =>
            onAgregar({
              productoId: producto.id,
              nombre: sabor ? `${producto.nombre} (${sabor.nombre})` : producto.nombre,
              precioUnitario: precioFinal,
              cantidad,
              opcionId: sabor?.opcionId,
              opcionNombre: sabor?.nombre,
              observacion: obs || undefined,
            })
          }
          disabled={cantidad <= 0}
          className="w-full bg-teresita-700 text-cream-50 px-4 py-3 rounded-md font-semibold disabled:opacity-50"
        >
          Agregar al carrito
        </button>
      </div>
    </div>
  );
}

interface CobroPayload {
  items: Array<{
    productoId: string;
    cantidad: number;
    opcionId?: string;
    opcionNombre?: string;
    precioUnitario: string;
    observacion?: string;
  }>;
  cobro: { metodo: string; monto: string; numeroReferencia?: string };
  canal: string;
  modalidad: string;
  cliente?: { nombre: string; telefono?: string };
  direccion?: { calle: string; numero: string; observaciones?: string };
}

function CobroModal({
  carrito,
  subtotal,
  enviando,
  onCerrar,
  onQuitarItem,
  onConfirmar,
}: {
  carrito: CartItem[];
  subtotal: number;
  enviando: boolean;
  onCerrar: () => void;
  onQuitarItem: (idx: number) => void;
  onConfirmar: (payload: CobroPayload) => Promise<void> | void;
}) {
  const [canal, setCanal] = useState<string>('MOSTRADOR');
  const [modalidad, setModalidad] = useState<string>('TAKE_AWAY');
  const [metodo, setMetodo] = useState<string>('EFECTIVO');
  const [referencia, setReferencia] = useState('');
  const [clienteNombre, setClienteNombre] = useState('');
  const [clienteTel, setClienteTel] = useState('');
  const [calle, setCalle] = useState('');
  const [numero, setNumero] = useState('');

  const requiereDelivery =
    modalidad === 'DELIVERY_PROPIO' || modalidad === 'DELIVERY_PLATAFORMA';
  const aplicaDescEfectivo = metodo === 'EFECTIVO';
  const descuento = aplicaDescEfectivo ? Math.round(subtotal * 0.1 * 100) / 100 : 0;
  const total = subtotal - descuento;

  const submit = () => {
    if (requiereDelivery && (!calle || !numero)) {
      alert('Para delivery, completá calle y número');
      return;
    }
    void onConfirmar({
      items: carrito.map((it) => ({
        productoId: it.productoId,
        cantidad: it.cantidad,
        opcionId: it.opcionId,
        opcionNombre: it.opcionNombre,
        precioUnitario: it.precioUnitario.toFixed(2),
        observacion: it.observacion,
      })),
      cobro: {
        metodo,
        monto: total.toFixed(2),
        numeroReferencia: referencia || undefined,
      },
      canal,
      modalidad,
      cliente: clienteNombre
        ? { nombre: clienteNombre, telefono: clienteTel || undefined }
        : undefined,
      direccion: requiereDelivery
        ? { calle, numero }
        : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onCerrar}>
      <div
        className="absolute inset-x-0 bottom-0 bg-white rounded-t-xl p-4 max-h-[90vh] overflow-y-auto safe-bottom"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h2 className="font-display text-lg text-teresita-700">Cobrar pedido</h2>
          <button onClick={onCerrar} className="text-ink-500 text-2xl leading-none">
            ×
          </button>
        </div>

        {/* Items resumen */}
        <ul className="mb-4 space-y-1">
          {carrito.map((it, idx) => (
            <li key={idx} className="flex items-center justify-between text-sm">
              <span className="truncate min-w-0">
                {it.cantidad} × {it.nombre}
              </span>
              <span className="flex items-center gap-2 ml-2 shrink-0">
                <span className="font-mono">{formatARS(it.precioUnitario * it.cantidad)}</span>
                <button
                  onClick={() => onQuitarItem(idx)}
                  className="text-pomodoro-600 text-xs"
                  title="Quitar"
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>

        {/* Totales */}
        <div className="mb-4 pt-2 border-t border-cream-300 text-sm">
          <div className="flex justify-between">
            <span className="text-ink-500">Subtotal</span>
            <span className="font-mono">{formatARS(subtotal)}</span>
          </div>
          {aplicaDescEfectivo && (
            <div className="flex justify-between text-teresita-700">
              <span>Descuento efectivo (10%)</span>
              <span className="font-mono">-{formatARS(descuento)}</span>
            </div>
          )}
          <div className="flex justify-between text-lg font-bold mt-1 pt-1 border-t border-cream-200">
            <span>Total</span>
            <span className="font-mono text-teresita-900">{formatARS(total)}</span>
          </div>
        </div>

        {/* Selectores */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <label className="block">
            <span className="block text-2xs font-semibold uppercase text-ink-700 mb-1">Canal</span>
            <select
              value={canal}
              onChange={(e) => setCanal(e.target.value)}
              className="w-full text-sm border border-cream-300 rounded-md py-2 px-2"
            >
              {CANALES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-2xs font-semibold uppercase text-ink-700 mb-1">
              Modalidad
            </span>
            <select
              value={modalidad}
              onChange={(e) => setModalidad(e.target.value)}
              className="w-full text-sm border border-cream-300 rounded-md py-2 px-2"
            >
              {MODALIDADES.map((m) => (
                <option key={m} value={m}>
                  {m.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block mb-3">
          <span className="block text-2xs font-semibold uppercase text-ink-700 mb-1">
            Método de pago
          </span>
          <select
            value={metodo}
            onChange={(e) => setMetodo(e.target.value)}
            className="w-full text-sm border border-cream-300 rounded-md py-2 px-2"
          >
            {METODOS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        {(metodo === 'TRANSFERENCIA' || metodo === 'MERCADOPAGO_QR') && (
          <label className="block mb-3">
            <span className="block text-2xs font-semibold uppercase text-ink-700 mb-1">
              Nº referencia (opcional)
            </span>
            <input
              type="text"
              value={referencia}
              onChange={(e) => setReferencia(e.target.value)}
              className="w-full text-sm border border-cream-300 rounded-md py-2 px-2"
            />
          </label>
        )}

        {/* Cliente */}
        <details className="mb-3">
          <summary className="text-2xs font-semibold uppercase text-ink-700 cursor-pointer">
            Datos del cliente {requiereDelivery ? '(requerido)' : '(opcional)'}
          </summary>
          <div className="mt-2 space-y-2">
            <input
              type="text"
              value={clienteNombre}
              onChange={(e) => setClienteNombre(e.target.value)}
              placeholder="Nombre"
              className="w-full text-sm border border-cream-300 rounded-md py-2 px-2"
            />
            <input
              type="tel"
              value={clienteTel}
              onChange={(e) => setClienteTel(e.target.value)}
              placeholder="Teléfono"
              className="w-full text-sm border border-cream-300 rounded-md py-2 px-2"
            />
            {requiereDelivery && (
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="text"
                  value={calle}
                  onChange={(e) => setCalle(e.target.value)}
                  placeholder="Calle"
                  className="col-span-2 text-sm border border-cream-300 rounded-md py-2 px-2"
                />
                <input
                  type="text"
                  value={numero}
                  onChange={(e) => setNumero(e.target.value)}
                  placeholder="Nº"
                  className="text-sm border border-cream-300 rounded-md py-2 px-2"
                />
              </div>
            )}
          </div>
        </details>

        <button
          onClick={submit}
          disabled={enviando || carrito.length === 0}
          className="w-full bg-teresita-700 text-cream-50 px-4 py-3 rounded-md font-semibold disabled:opacity-50"
        >
          {enviando ? 'Guardando…' : `Confirmar venta · ${formatARS(total)}`}
        </button>
      </div>
    </div>
  );
}
