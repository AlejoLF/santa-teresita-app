'use client';

import { use, useEffect, useRef, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { calcularDescuentoEfectivo } from '@sta/shared';
import { cn } from '@/lib/cn';

interface ItemVenta {
  id: string;
  productoId: string;
  nombreSnapshot: string;
  cantidad: string;
  unidad: 'UNIDAD' | 'GRAMO' | 'PLANCHA' | 'PORCION';
  precioUnitario: string;
  totalLinea: string;
  observacion?: string | null;
  modificadoresAplicados?: Array<{ opcionNombre: string; grupoNombre?: string | null }> | null;
  cocinaInterviene: boolean;
  parteDeComboInstancia?: string | null;
}

interface DeliveryInfo {
  empresaExterna: string | null;
  direccionSnapshot: Record<string, unknown> | null;
  observaciones: string | null;
}

interface VentaCompleta {
  id: string;
  numero: number;
  numeroOrdenTurno: number;
  canal: string;
  modalidad: string;
  estado: 'PROCESADA' | 'FINALIZADA' | 'ANULADA';
  total: string;
  subtotal: string;
  fechaApertura: string;
  items: ItemVenta[];
  pagos: Array<{ id: string; metodo: string; monto: string }>;
  tieneCocina: boolean;
  deliveryInfo?: DeliveryInfo | null;
}

const METODOS = [
  { key: 'EFECTIVO', label: 'EFECTIVO', icon: '💵' },
  { key: 'DEBITO', label: 'DÉBITO', icon: '💳' },
  { key: 'CREDITO_1_PAGO', label: 'CRÉDITO', icon: '💳' },
  { key: 'MERCADOPAGO_QR', label: 'MP / QR', icon: '📱' },
  { key: 'TRANSFERENCIA', label: 'TRANSFER.', icon: '🏦' },
] as const;

export default function VentaDetallePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const cobrarAutomatico = searchParams.get('cobrar') === '1';
  const [venta, setVenta] = useState<VentaCompleta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [procesando, setProcesando] = useState(false);
  const [confirmaAnular, setConfirmaAnular] = useState(false);
  const [motivoAnular, setMotivoAnular] = useState('');
  const motivoAnularRef = useRef<HTMLTextAreaElement | null>(null);
  const [mostrarCobro, setMostrarCobro] = useState(cobrarAutomatico);
  const [efectivoRecibido, setEfectivoRecibido] = useState('');
  const [mostrarSplit, setMostrarSplit] = useState(false);
  const [metodoSeleccionado, setMetodoSeleccionado] = useState<PagoLinea['metodo'] | null>(null);
  // % de descuento al efectivo en cobro simple (default 10)
  const [descuentoPctSimple, setDescuentoPctSimple] = useState<number>(10);
  const [descuentoPctSimpleInput, setDescuentoPctSimpleInput] = useState('');
  const [cuentas, setCuentas] = useState<CuentaShort[]>([]);
  const [usuario, setUsuario] = useState<{ rol: string } | null>(null);
  const [promosDetectadas, setPromosDetectadas] = useState<
    Array<{
      comboId: string;
      nombre: string;
      precioCombo: string;
      instancias: number;
      descuentoTotal: string;
    }>
  >([]);

  // Cargar usuario para mostrar botón de volver al panel admin
  useEffect(() => {
    (async () => {
      try {
        const me = await api.get<{ usuario: { rol: string } }>('/auth/me');
        setUsuario(me.usuario);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  // Cargar cuentas para resolver UUID de cuenta destino al cobrar
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ cuentas: CuentaShort[] }>('/catalogo/cuentas');
        setCuentas(res.cuentas);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  const refetch = useCallback(async () => {
    try {
      const v = await api.get<VentaCompleta>(`/ventas/${id}`);
      setVenta(v);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else setError('No se pudo cargar la venta');
    }
  }, [id, router]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Focusear el textarea de motivo cuando se abre el modal de anulación.
  // `autoFocus` solo no alcanza en Electron — el modal se monta dinámicamente
  // y a veces el focus se pierde antes de que React lo aplique. Con esto
  // garantizamos que el cajero pueda tipear el motivo sin clickear primero.
  useEffect(() => {
    if (confirmaAnular) {
      // Doble RAF para que el textarea esté pintado y el navegador haya
      // resuelto el layout antes de pedirle focus.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          motivoAnularRef.current?.focus();
        });
      });
    }
  }, [confirmaAnular]);

  // Detectar combos automáticos cuando la venta carga / cambia de items.
  // Solo si la venta está en estado PROCESADA (editable).
  useEffect(() => {
    if (!venta || venta.estado !== 'PROCESADA' || venta.items.length === 0) {
      setPromosDetectadas([]);
      return;
    }
    (async () => {
      try {
        const res = await api.post<{
          detectados: typeof promosDetectadas;
        }>('/admin/combos/detectar', {
          items: venta.items.map((i) => ({
            productoId: i.productoId,
            cantidad: Math.max(1, Math.floor(Number(i.cantidad))),
            parteDeComboInstancia: i.parteDeComboInstancia ?? undefined,
          })),
        });
        setPromosDetectadas(res.detectados);
      } catch {
        setPromosDetectadas([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venta?.id, venta?.items.length, venta?.estado]);

  if (!venta) {
    return (
      <div className="flex min-h-screen items-center justify-center text-ink-500">
        {error ?? 'Cargando...'}
      </div>
    );
  }

  const totalNum = Number(venta.total);
  // descuento aplicado al efectivo en cobro simple, según el % seleccionado
  const conDescuentoSimple = calcularDescuentoEfectivo(venta.subtotal, descuentoPctSimple);
  const habilitaDescuentoEfectivo = venta.canal === 'MOSTRADOR';
  const editable = venta.estado === 'PROCESADA';

  async function quitarItem(itemId: string) {
    if (!confirm('¿Quitar este item del pedido?')) return;
    setProcesando(true);
    try {
      const updated = await api.delete<VentaCompleta>(`/ventas/${venta!.id}/items/${itemId}`);
      setVenta(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al quitar item');
    } finally {
      setProcesando(false);
    }
  }

  async function cobrarConMetodo(metodo: PagoLinea['metodo']) {
    setProcesando(true);
    setError(null);
    try {
      const cuenta = sugerirCuenta(metodo, cuentas);
      if (!cuenta) {
        setError('No hay cuentas disponibles. Pedile al admin que configure al menos una.');
        setProcesando(false);
        return;
      }
      const aplicaDescuento = metodo === 'EFECTIVO' && habilitaDescuentoEfectivo;
      // SIEMPRE formatear con toFixed(2) — el backend rechaza con "Bad Request"
      // si el monto no matchea regex /^\d+(\.\d{1,2})?$/. Cuando un item tiene
      // modificadores (ej. porciones calientes con salsa), el venta.total que
      // viene de la API puede llegar con precision distinta. Coercer a "X.XX"
      // garantiza match con la regex.
      const montoNum = Number(aplicaDescuento ? conDescuentoSimple.total : venta!.total);
      const monto = montoNum.toFixed(2);
      const cambio =
        metodo === 'EFECTIVO' && efectivoRecibido && Number(efectivoRecibido) > montoNum
          ? (Number(efectivoRecibido) - montoNum).toFixed(2)
          : undefined;
      await api.post(`/ventas/${venta!.id}/finalizar`, {
        aplicarDescuentoEfectivo: aplicaDescuento,
        descuentoPctEfectivo: descuentoPctSimple,
        pagos: [
          {
            metodo,
            cuentaId: cuenta.id,
            monto,
            ...(cambio && { cambioDado: cambio }),
          },
        ],
      });
      router.push('/cargar-pedido');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error procesando el cobro');
    } finally {
      setProcesando(false);
    }
  }

  async function anular() {
    if (motivoAnular.trim().length < 3) {
      setError('Ingresá un motivo (mínimo 3 caracteres)');
      return;
    }
    setProcesando(true);
    try {
      await api.post(`/ventas/${venta!.id}/anular`, { motivo: motivoAnular });
      router.push('/cargar-pedido');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al anular');
    } finally {
      setProcesando(false);
    }
  }

  const estadoBadge = {
    PROCESADA: { label: 'ABIERTO', cls: 'bg-saffron-100 text-saffron-600' },
    FINALIZADA: { label: 'COBRADO', cls: 'bg-basil-100 text-basil-600' },
    ANULADA: { label: 'ANULADO', cls: 'bg-pomodoro-100 text-pomodoro-600' },
  }[venta.estado];

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-teresita-700 text-cream-50 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/cargar-pedido')}
            className="text-cream-100 hover:underline"
          >
            ← Volver al cajero
          </button>
          {usuario?.rol === 'ADMIN' && (
            <button
              onClick={() => router.push('/admin')}
              className="bg-teresita-900 hover:bg-ink-900/30 text-cream-50 px-3 py-1 rounded-md text-sm font-medium transition-colors"
              title="Volver al panel admin"
            >
              ← Panel admin
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-display text-md">
            PEDIDO #{String(venta.numeroOrdenTurno).padStart(3, '0')}
          </span>
          <span
            className={cn(
              'px-2 py-0.5 rounded text-2xs font-medium uppercase tracking-wide',
              estadoBadge.cls,
            )}
          >
            {estadoBadge.label}
          </span>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6 px-6 py-6 max-w-6xl mx-auto w-full">
        {/* Items */}
        <section>
          <div className="flex justify-between items-baseline mb-3">
            <h2 className="text-md font-medium text-ink-700">Items del pedido</h2>
            <span className="text-xs text-ink-500">
              {venta.canal.replace('_', ' ')} ·{' '}
              {new Date(venta.fechaApertura).toLocaleTimeString('es-AR', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>

          <div className="card divide-y divide-cream-200">
            {venta.items.length === 0 && (
              <p className="px-4 py-8 text-center text-ink-500 text-sm">
                Esta venta no tiene items.
              </p>
            )}
            {venta.items.map((item) => {
              // Diferenciamos modificadores "salsa incluida" (van inline al
              // lado del nombre como aclaración) de los modificadores normales
              // tipo sabor de pasta (van debajo con `›` como antes).
              const modsSalsa = (item.modificadoresAplicados ?? []).filter((m) =>
                m.grupoNombre?.startsWith('Tipo — Salsa'),
              );
              const modsOtros = (item.modificadoresAplicados ?? []).filter(
                (m) => !m.grupoNombre?.startsWith('Tipo — Salsa'),
              );
              return (
              <div key={item.id} className="px-4 py-3 flex justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-ink-900">
                      {item.nombreSnapshot}
                      {modsSalsa.map((m, i) => (
                        <span key={i} className="text-ink-500 font-normal">
                          {' '}({m.opcionNombre})
                        </span>
                      ))}
                    </span>
                    {item.cocinaInterviene && (
                      <span className="text-2xs text-saffron-600">🍳 cocina</span>
                    )}
                  </div>
                  {modsOtros.map((m, i) => (
                    <div key={i} className="text-xs text-ink-500">
                      › {m.opcionNombre}
                    </div>
                  ))}
                  {item.observacion && (
                    <div className="mt-1.5 px-3 py-2 bg-saffron-100 border-l-4 border-saffron-600 rounded-r-md">
                      <div className="text-2xs font-bold uppercase tracking-widest text-saffron-600 mb-0.5">
                        ⚠ Observación
                      </div>
                      <div className="text-base font-bold text-ink-900 leading-tight">
                        {item.observacion}
                      </div>
                    </div>
                  )}
                  <div className="text-xs text-ink-500 mt-1 font-mono">
                    {item.cantidad}{' '}
                    {item.unidad === 'GRAMO' ? 'g' : item.unidad === 'PLANCHA' ? 'pl' : 'u'}{' '}
                    × <MoneyAmount value={item.precioUnitario} />
                  </div>
                </div>
                <div className="text-right flex flex-col items-end gap-1">
                  <MoneyAmount value={item.totalLinea} className="text-md text-teresita-700" />
                  {editable && (
                    <button
                      onClick={() => quitarItem(item.id)}
                      disabled={procesando}
                      className="text-pomodoro-600 text-xs hover:underline disabled:opacity-50"
                    >
                      quitar
                    </button>
                  )}
                </div>
              </div>
              );
            })}
          </div>

          {editable && (
            <Button
              variant="secondary"
              className="mt-4"
              onClick={() =>
                router.push(`/cargar-pedido?ventaAbierta=${venta.id}`)
              }
            >
              + Agregar más items
            </Button>
          )}

          {/* Delivery info — sólo si modalidad incluye delivery */}
          {(venta.modalidad === 'DELIVERY_PROPIO' ||
            venta.modalidad === 'DELIVERY_PLATAFORMA' ||
            venta.modalidad === 'DELIVERY_DELIVERATE' ||
            venta.canal === 'DELIVERATE' ||
            venta.canal === 'PEDIDOS_YA' ||
            venta.canal === 'RAPPI' ||
            venta.canal === 'MERCADO_LIBRE') && (
            <DeliveryPanel venta={venta} editable={editable} onUpdated={refetch} />
          )}
        </section>

        {/* Totales y acciones */}
        <aside className="space-y-4">
          {/* Promos detectadas automáticamente */}
          {editable && promosDetectadas.length > 0 && (
            <div className="card p-4 border-l-4 border-saffron-600 bg-saffron-100/40">
              <div className="text-2xs uppercase tracking-wider text-saffron-600 font-semibold mb-2">
                🎁 Promos detectadas automáticamente
              </div>
              {promosDetectadas.map((p) => (
                <div
                  key={p.comboId}
                  className="flex items-baseline justify-between text-sm py-1"
                >
                  <div>
                    <span className="font-medium text-ink-900">DESCUENTO PROMO</span>{' '}
                    <span className="text-ink-700">— {p.nombre}</span>
                    {p.instancias > 1 && (
                      <span className="text-2xs text-ink-500 ml-1">×{p.instancias}</span>
                    )}
                  </div>
                  <MoneyAmount
                    value={`-${p.descuentoTotal}`}
                    className="font-mono text-saffron-600 font-medium"
                  />
                </div>
              ))}
              <div className="text-2xs text-ink-500 italic mt-1">
                Aplicado automáticamente al detectar los componentes de un combo en el pedido.
              </div>
            </div>
          )}

          <div className="card p-5">
            <div className="text-sm text-ink-500 uppercase tracking-wide mb-1">
              {venta.estado === 'PROCESADA' ? 'Total a cobrar' : 'Total'}
            </div>
            <MoneyAmount value={totalNum} hero className="text-3xl text-teresita-900" />
            {habilitaDescuentoEfectivo && editable && (
              <div className="text-xs text-basil-600 mt-2">
                Si paga en efectivo: <MoneyAmount value={conDescuentoSimple.total} className="font-semibold" /> ·
                ahorra <MoneyAmount value={conDescuentoSimple.descuento} />
              </div>
            )}
          </div>

          {editable && !mostrarCobro && (
            <div className="space-y-2">
              <Button
                fullWidth
                size="lg"
                disabled={venta.items.length === 0}
                onClick={() => setMostrarCobro(true)}
                className="text-lg py-4"
              >
                COBRAR
              </Button>
              <Button
                fullWidth
                variant="ghost"
                onClick={() => setConfirmaAnular(true)}
                className="text-pomodoro-600"
              >
                Anular pedido
              </Button>
            </div>
          )}

          {editable && mostrarCobro && !mostrarSplit && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-ink-700">Método de pago</h3>
                <button
                  onClick={() => setMostrarCobro(false)}
                  className="text-xs text-ink-500 hover:text-ink-700"
                >
                  ← cancelar
                </button>
              </div>

              {/* Selector de % de descuento al efectivo (solo mostrador) */}
              {habilitaDescuentoEfectivo && (
                <div className="bg-basil-100 px-3 py-2 rounded mb-3">
                  <div className="text-2xs text-basil-600 font-medium uppercase tracking-wider mb-1.5">
                    Descuento al efectivo
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[10, 15, 20, 25, 30].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => {
                          setDescuentoPctSimple(pct);
                          setDescuentoPctSimpleInput('');
                        }}
                        className={cn(
                          'px-2.5 py-1 rounded text-xs font-medium border transition-colors',
                          descuentoPctSimple === pct && !descuentoPctSimpleInput
                            ? 'bg-basil-600 text-white border-basil-600'
                            : 'bg-white text-basil-600 border-basil-600/40 hover:bg-basil-100',
                        )}
                      >
                        −{pct}%
                      </button>
                    ))}
                    <div className="flex items-center gap-1 ml-auto">
                      <input
                        type="number"
                        min="0"
                        max="50"
                        step="1"
                        placeholder="otro %"
                        value={descuentoPctSimpleInput}
                        onChange={(e) => {
                          const val = e.target.value;
                          setDescuentoPctSimpleInput(val);
                          const n = Number(val);
                          if (val !== '' && Number.isFinite(n) && n >= 0 && n <= 50) {
                            setDescuentoPctSimple(n);
                          }
                        }}
                        className="input text-xs py-1 px-2 w-20 font-mono"
                      />
                      <span className="text-2xs text-basil-600">%</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                {METODOS.map((m) => {
                  const esEfectivoConDesc =
                    m.key === 'EFECTIVO' && habilitaDescuentoEfectivo;
                  const seleccionado = metodoSeleccionado === m.key;
                  return (
                    <button
                      key={m.key}
                      disabled={procesando}
                      onClick={() => setMetodoSeleccionado(m.key)}
                      className={cn(
                        'card py-4 flex flex-col items-center gap-1 transition-all disabled:opacity-50 border-2',
                        seleccionado
                          ? 'border-teresita-700 bg-teresita-50 shadow-md ring-2 ring-teresita-700/20'
                          : esEfectivoConDesc
                            ? 'border-basil-600/30 bg-basil-100 hover:shadow-md'
                            : 'border-cream-300 hover:shadow-md hover:border-teresita-700/30',
                      )}
                    >
                      <span className="text-xl">{m.icon}</span>
                      <span className={cn(
                        'text-sm font-medium',
                        seleccionado ? 'text-teresita-900' : 'text-ink-900',
                      )}>
                        {m.label}
                      </span>
                      {esEfectivoConDesc && (
                        <span className="text-2xs text-basil-600 font-medium">
                          −{descuentoPctSimple}% off
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Botón Aceptar — confirma el método de pago seleccionado */}
              <div className="mt-4">
                <Button
                  fullWidth
                  size="lg"
                  disabled={procesando || !metodoSeleccionado}
                  onClick={() => metodoSeleccionado && cobrarConMetodo(metodoSeleccionado)}
                  className="text-md py-3"
                >
                  {metodoSeleccionado
                    ? `Aceptar — cobrar con ${METODOS.find((x) => x.key === metodoSeleccionado)?.label}`
                    : 'Seleccioná un método de pago'}
                </Button>
              </div>

              {/* Vuelto en efectivo (opcional) */}
              {habilitaDescuentoEfectivo && (
                <div className="mt-3 bg-cream-100 rounded-md p-3 border border-cream-300">
                  <label className="block text-2xs font-medium text-ink-700 mb-1">
                    Si paga en efectivo, ¿cuánto recibís? (opcional)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="100"
                      value={efectivoRecibido}
                      onChange={(e) => setEfectivoRecibido(e.target.value)}
                      placeholder={conDescuentoSimple.total}
                      className="input flex-1 font-mono"
                    />
                    {efectivoRecibido && Number(efectivoRecibido) >= Number(conDescuentoSimple.total) && (
                      <div className="text-right">
                        <div className="text-2xs text-ink-500">Vuelto</div>
                        <MoneyAmount
                          value={(Number(efectivoRecibido) - Number(conDescuentoSimple.total)).toFixed(2)}
                          className="text-md font-mono text-basil-600"
                        />
                      </div>
                    )}
                  </div>
                  {efectivoRecibido && Number(efectivoRecibido) < Number(conDescuentoSimple.total) && (
                    <p className="text-2xs text-pomodoro-600 mt-1">
                      Recibido es menor al total con descuento ({conDescuentoSimple.total}).
                    </p>
                  )}
                </div>
              )}

              <button
                disabled={procesando}
                onClick={() => setMostrarSplit(true)}
                className="mt-2 w-full text-xs text-teresita-700 hover:underline font-medium"
              >
                ⚖️ Pago dividido (split entre métodos)
              </button>
            </div>
          )}

          {editable && mostrarCobro && mostrarSplit && (
            <SplitPagoPanel
              ventaId={venta.id}
              total={venta.total}
              subtotal={venta.subtotal}
              habilitaDescuentoEfectivo={habilitaDescuentoEfectivo}
              onCancel={() => setMostrarSplit(false)}
              onCobrado={() => router.push('/cargar-pedido')}
            />
          )}

          {!editable && venta.pagos.length > 0 && (
            <div className="card p-4">
              <h3 className="text-sm font-medium text-ink-700 mb-2">Pagos registrados</h3>
              {venta.pagos.map((p) => (
                <div key={p.id} className="flex justify-between text-sm py-1">
                  <span>{p.metodo}</span>
                  <MoneyAmount value={p.monto} />
                </div>
              ))}
            </div>
          )}

          {error && (
            <div role="alert" className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
        </aside>
      </main>

      {/* Modal anular */}
      {confirmaAnular && (
        <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
          <div className="card w-full max-w-md p-6 shadow-modal">
            <h2 className="font-display text-lg text-pomodoro-600 mb-3">Anular pedido</h2>
            <p className="text-sm text-ink-500 mb-3">
              {venta.tieneCocina &&
                'La comanda ya fue a cocina. Se imprimirá una segunda comanda con leyenda CANCELADA.'}
            </p>
            <label htmlFor="motivo-anular" className="text-sm font-medium text-ink-700 mb-1 block">
              Motivo
            </label>
            <textarea
              id="motivo-anular"
              ref={motivoAnularRef}
              value={motivoAnular}
              onChange={(e) => setMotivoAnular(e.target.value)}
              placeholder="ej. cliente se arrepintió, error de carga..."
              className="input min-h-[80px] mb-4"
            />
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setConfirmaAnular(false)}>
                Cancelar
              </Button>
              <Button variant="destructive" onClick={anular} disabled={procesando}>
                Anular pedido
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Split de pago — múltiples métodos / cuentas para cubrir el total
// ────────────────────────────────────────────────────────────────────────

interface CuentaShort {
  id: string;
  nombre: string;
  tipo: string;
}

interface PagoLinea {
  metodo: 'EFECTIVO' | 'DEBITO' | 'CREDITO_1_PAGO' | 'MERCADOPAGO_QR' | 'TRANSFERENCIA';
  cuentaId: string;
  monto: string;
  numeroReferencia?: string;
  efectivoRecibido?: string;
}

const METODOS_SPLIT: Array<{ value: PagoLinea['metodo']; label: string; icon: string }> = [
  { value: 'EFECTIVO', label: 'Efectivo', icon: '💵' },
  { value: 'DEBITO', label: 'Débito', icon: '💳' },
  { value: 'CREDITO_1_PAGO', label: 'Crédito', icon: '💳' },
  { value: 'MERCADOPAGO_QR', label: 'MP / QR', icon: '📱' },
  { value: 'TRANSFERENCIA', label: 'Transfer.', icon: '🏦' },
];

// ────────────────────────────────────────────────────────────────────────
//   Delivery panel: elegir repartidor (Damián / DELIVERATE / otro)
// ────────────────────────────────────────────────────────────────────────

type RepartidorOpcion = 'DAMIAN' | 'DELIVERATE' | 'OTRO_EMPLEADO' | 'PLATAFORMA';

function DeliveryPanel({
  venta,
  editable,
  onUpdated,
}: {
  venta: VentaCompleta;
  editable: boolean;
  onUpdated: () => Promise<void>;
}) {
  const snap = (venta.deliveryInfo?.direccionSnapshot ?? {}) as Record<string, unknown>;
  const repartidorActual = (snap._repartidor as RepartidorOpcion | undefined) ?? null;
  const empleadoActual = (snap._empleadoNombre as string | null | undefined) ?? null;
  const empresaActual = venta.deliveryInfo?.empresaExterna ?? null;

  const [editando, setEditando] = useState(false);
  const [repartidor, setRepartidor] = useState<RepartidorOpcion | null>(repartidorActual);
  const [empleadoNombre, setEmpleadoNombre] = useState(empleadoActual ?? '');
  const [observaciones, setObservaciones] = useState(venta.deliveryInfo?.observaciones ?? '');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Si el canal viene de plataforma, sugerimos PLATAFORMA por default
  useEffect(() => {
    if (repartidor !== null) return;
    if (
      venta.canal === 'PEDIDOS_YA' ||
      venta.canal === 'RAPPI' ||
      venta.canal === 'MERCADO_LIBRE'
    ) {
      setRepartidor('PLATAFORMA');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venta.canal]);

  async function guardar() {
    if (!repartidor) return setError('Elegí quién entrega');
    if (repartidor === 'OTRO_EMPLEADO' && !empleadoNombre.trim()) {
      return setError('Falta el nombre del empleado');
    }
    setGuardando(true);
    setError(null);
    try {
      await api.put(`/ventas/${venta.id}/delivery`, {
        repartidor,
        empleadoNombre: empleadoNombre || undefined,
        empresaExterna: repartidor === 'PLATAFORMA' ? venta.canal : undefined,
        observaciones: observaciones || undefined,
        direccionSnapshot: snap,
      });
      setEditando(false);
      await onUpdated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar');
    } finally {
      setGuardando(false);
    }
  }

  // Resumen del repartidor
  const resumen = (() => {
    if (empresaActual === 'DELIVERATE') return '🛵 DELIVERATE';
    if (empresaActual && empresaActual !== 'DELIVERATE')
      return `🛵 Plataforma · ${empresaActual}`;
    if (empleadoActual) return `🛵 ${empleadoActual}`;
    return null;
  })();

  return (
    <section className="mt-6 card p-4">
      <header className="flex items-center justify-between mb-2">
        <h3 className="text-md font-medium text-ink-900">Entrega / Delivery</h3>
        {editable && !editando && (
          <button
            onClick={() => setEditando(true)}
            className="text-xs text-teresita-700 hover:underline"
          >
            {resumen ? 'Cambiar' : '+ Asignar repartidor'}
          </button>
        )}
      </header>

      {!editando && resumen && (
        <p className="text-sm text-ink-700">{resumen}</p>
      )}
      {!editando && !resumen && editable && (
        <p className="text-sm text-ink-500 italic">
          Asigná quién va a entregar este pedido para que aparezca en el ticket.
        </p>
      )}

      {editando && (
        <div className="space-y-3 mt-2">
          <div>
            <label className="block text-2xs font-medium text-ink-700 mb-1">
              ¿Quién entrega?
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { v: 'DAMIAN', label: '🛵 Damián', desc: 'Delivery propio' },
                  { v: 'DELIVERATE', label: '🛵 DELIVERATE', desc: 'Empresa tercerizada' },
                  { v: 'OTRO_EMPLEADO', label: '🛵 Otro empleado', desc: 'A definir' },
                  { v: 'PLATAFORMA', label: '🛵 Plataforma', desc: 'RAPPI / PYA / MELI' },
                ] as Array<{ v: RepartidorOpcion; label: string; desc: string }>
              ).map((opt) => (
                <button
                  key={opt.v}
                  onClick={() => setRepartidor(opt.v)}
                  className={cn(
                    'p-3 rounded-md border text-left text-sm transition-colors',
                    repartidor === opt.v
                      ? 'bg-teresita-50 border-teresita-700'
                      : 'bg-white border-cream-300 hover:bg-cream-50',
                  )}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-2xs text-ink-500">{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {repartidor === 'OTRO_EMPLEADO' && (
            <div>
              <label className="block text-2xs font-medium text-ink-700 mb-1">
                Nombre del empleado
              </label>
              <input
                type="text"
                value={empleadoNombre}
                onChange={(e) => setEmpleadoNombre(e.target.value)}
                placeholder="ej. Juan, María..."
                className="input"
              />
            </div>
          )}

          <div>
            <label className="block text-2xs font-medium text-ink-700 mb-1">
              Indicaciones para el repartidor (opcional)
            </label>
            <textarea
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              placeholder="ej. timbre roto, dejar con portero..."
              className="input min-h-[60px]"
            />
          </div>

          {error && <div className="text-pomodoro-600 text-xs">{error}</div>}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditando(false)}>
              Cancelar
            </Button>
            <Button size="sm" disabled={guardando} onClick={guardar}>
              {guardando ? 'Guardando...' : 'Guardar repartidor'}
            </Button>
          </div>
        </div>
      )}

      {!editando && venta.deliveryInfo?.observaciones && (
        <div className="mt-2 text-xs text-saffron-600 italic">
          ⚠ {venta.deliveryInfo.observaciones}
        </div>
      )}
    </section>
  );
}

function sugerirCuenta(metodo: PagoLinea['metodo'], cuentas: CuentaShort[]): CuentaShort | null {
  if (metodo === 'EFECTIVO') return cuentas.find((c) => c.tipo === 'EFECTIVO') ?? null;
  if (metodo === 'MERCADOPAGO_QR')
    return (
      cuentas.find((c) => c.nombre.toLowerCase().includes('mercadopago')) ??
      cuentas.find((c) => c.tipo === 'WALLET') ??
      null
    );
  // Tarjetas y transferencias: primer banco activo
  return cuentas.find((c) => c.tipo === 'BANCO') ?? null;
}

/**
 * Panel de pago dividido:
 *   - Cada línea declara cuánto del subtotal cubre con un método.
 *   - Para EFECTIVO se puede ingresar lo recibido en billetes para calcular vuelto.
 *   - Si hay 1+ pago en efectivo y canal mostrador, se puede aplicar 10% off
 *     SOLO sobre la porción efectivo (no sobre todo el pedido).
 */
function SplitPagoPanel({
  ventaId,
  total,
  subtotal,
  habilitaDescuentoEfectivo,
  onCancel,
  onCobrado,
}: {
  ventaId: string;
  total: string;
  subtotal: string;
  habilitaDescuentoEfectivo: boolean;
  onCancel: () => void;
  onCobrado: () => void;
}) {
  const subtotalNum = Number(subtotal);
  const totalSinDescuento = Number(total); // suele coincidir con subtotal cuando no hay desc previos
  const [cuentas, setCuentas] = useState<CuentaShort[]>([]);
  const [pagos, setPagos] = useState<PagoLinea[]>([
    { metodo: 'EFECTIVO', cuentaId: '', monto: '' },
  ]);
  const [aplicarDescuentoEfectivo, setAplicarDescuentoEfectivo] = useState(false);
  // % de descuento (10 default; admin puede subir hasta 30 con presets, o ingresar custom)
  const [descuentoPct, setDescuentoPct] = useState<number>(10);
  const [descuentoPctInput, setDescuentoPctInput] = useState<string>('');
  const [editandoCuenta, setEditandoCuenta] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ cuentas: CuentaShort[] }>('/catalogo/cuentas');
        setCuentas(res.cuentas);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  // Auto-elegir cuenta sugerida cuando se agregan/cambian métodos
  useEffect(() => {
    if (cuentas.length === 0) return;
    setPagos((arr) =>
      arr.map((p) => {
        if (p.cuentaId) return p;
        const sugerida = sugerirCuenta(p.metodo, cuentas);
        return sugerida ? { ...p, cuentaId: sugerida.id } : p;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cuentas]);

  // Modelo de cálculo (parametrizado por `descuentoPct`):
  //   - factor = (100 - pct) / 100  (ej: pct=10 → 0.9, pct=20 → 0.8)
  //   - El campo `monto` es lo que el CLIENTE entrega (neto, ya con descuento si corresponde).
  //   - Al activar el descuento, monto_neto = monto_bruto * factor
  //   - "Cubre del pedido" del efectivo = monto_neto / factor (vuelve al bruto)
  //   - Ahorro del cliente = monto_bruto - monto_neto = monto_neto * (pct/(100-pct))
  const factor = (100 - descuentoPct) / 100;
  const totalEntregado = pagos.reduce((acc, p) => acc + Number(p.monto || 0), 0);
  const efectivoNeto = pagos
    .filter((p) => p.metodo === 'EFECTIVO')
    .reduce((acc, p) => acc + Number(p.monto || 0), 0);
  const hayEfectivo = pagos.some((p) => p.metodo === 'EFECTIVO' && Number(p.monto || 0) > 0);
  const aplicaDescuento = aplicarDescuentoEfectivo && habilitaDescuentoEfectivo && hayEfectivo;
  const ahorroEfectivo = aplicaDescuento ? (efectivoNeto * descuentoPct) / (100 - descuentoPct) : 0;
  // Cubierto del subtotal: efectivo cuenta como bruto (neto/factor), tarjeta cuenta nominal
  const cubiertoSubtotal = pagos.reduce((acc, p) => {
    const m = Number(p.monto || 0);
    if (p.metodo === 'EFECTIVO' && aplicaDescuento) return acc + m / factor;
    return acc + m;
  }, 0);
  const diferencia = totalSinDescuento - cubiertoSubtotal;
  const cuadra = Math.abs(diferencia) < 0.5;

  /**
   * Cuando el usuario cambia el % o activa/desactiva el descuento, hay que
   * reescalar los montos de las líneas EFECTIVO al nuevo factor.
   */
  function reescalarEfectivo(opts: { pctViejo: number; pctNuevo: number; activarDescuento: boolean | null }) {
    const factorViejo = (100 - opts.pctViejo) / 100;
    const factorNuevo = (100 - opts.pctNuevo) / 100;
    setPagos((arr) =>
      arr.map((p) => {
        if (p.metodo !== 'EFECTIVO') return p;
        const m = Number(p.monto || 0);
        if (m === 0) return p;
        // Reconstruir bruto desde lo que está actualmente
        const bruto =
          aplicarDescuentoEfectivo && hayEfectivo ? m / factorViejo : m;
        const debeAplicar =
          opts.activarDescuento === null ? aplicarDescuentoEfectivo : opts.activarDescuento;
        const nuevoMonto = debeAplicar ? bruto * factorNuevo : bruto;
        return { ...p, monto: Number(nuevoMonto.toFixed(2)).toString() };
      }),
    );
  }

  function setLinea(idx: number, patch: Partial<PagoLinea>) {
    setPagos((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function addLinea() {
    const restoSugerido = Math.max(0, diferencia);
    // Si la primera línea ya es EFECTIVO, sugerimos DEBITO. Si es DEBITO sugerimos EFECTIVO.
    const yaTieneEfectivo = pagos.some((p) => p.metodo === 'EFECTIVO');
    const metodoSugerido: PagoLinea['metodo'] = yaTieneEfectivo ? 'DEBITO' : 'EFECTIVO';
    const sugerida = sugerirCuenta(metodoSugerido, cuentas);
    setPagos((arr) => [
      ...arr,
      {
        metodo: metodoSugerido,
        cuentaId: sugerida?.id ?? '',
        monto: restoSugerido > 0 ? restoSugerido.toFixed(2) : '',
      },
    ]);
  }
  function removeLinea(idx: number) {
    setPagos((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }
  function completarPrimero() {
    setPagos((arr) =>
      arr.map((p, i) => (i === 0 ? { ...p, monto: totalSinDescuento.toFixed(2) } : p)),
    );
  }

  async function confirmar() {
    setError(null);
    if (!cuadra) {
      setError(
        diferencia > 0
          ? `Falta cubrir $${diferencia.toFixed(2)}`
          : `Asignaste $${(-diferencia).toFixed(2)} de más`,
      );
      return;
    }
    if (pagos.some((p) => !p.cuentaId)) {
      setError('Hay un pago sin cuenta destino');
      return;
    }
    setEnviando(true);
    try {
      // Para el backend: el campo `monto` ya está en NETO (post-descuento) si el checkbox está activo,
      // porque el handler del checkbox modificó los montos cuando el usuario lo activó.
      // Mandamos tal cual lo que el cliente paga.
      const payloadPagos = pagos.map((p) => {
        const declarado = Number(p.monto || 0);
        return {
          metodo: p.metodo,
          cuentaId: p.cuentaId,
          monto: declarado.toFixed(2),
          numeroReferencia: p.numeroReferencia,
          // cambioDado: si el cajero ingresó "recibí", calcular vuelto contra el monto neto
          ...(p.metodo === 'EFECTIVO' &&
            p.efectivoRecibido &&
            Number(p.efectivoRecibido) > declarado && {
              cambioDado: (Number(p.efectivoRecibido) - declarado).toFixed(2),
            }),
        };
      });
      await api.post(`/ventas/${ventaId}/finalizar`, {
        aplicarDescuentoEfectivo: aplicaDescuento,
        descuentoPctEfectivo: descuentoPct,
        pagos: payloadPagos,
      });
      onCobrado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error procesando el cobro');
    } finally {
      setEnviando(false);
    }
  }

  // Etiqueta auto-sugerida de la cuenta para mostrar inline
  const nombreCuenta = (id: string) => cuentas.find((c) => c.id === id)?.nombre ?? '—';

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-md font-medium text-ink-700">Pago dividido</h3>
        <button onClick={onCancel} className="text-xs text-ink-500 hover:text-ink-700">
          ← cobro simple
        </button>
      </div>

      {/* Header con total */}
      <div className="bg-surface-sunken rounded-md p-3 mb-3 text-sm">
        <div className="flex justify-between font-mono">
          <span className="text-ink-700">Total del pedido:</span>
          <MoneyAmount value={totalSinDescuento.toFixed(2)} className="font-semibold" />
        </div>
        {habilitaDescuentoEfectivo && (
          <p className="text-2xs text-ink-500 mt-1">
            Si paga 100% efectivo con {descuentoPct}% off:{' '}
            <MoneyAmount
              value={(subtotalNum * factor).toFixed(2)}
              className="text-basil-600 font-medium"
            />
            · ahorra{' '}
            <MoneyAmount value={(subtotalNum * (descuentoPct / 100)).toFixed(2)} />
          </p>
        )}
      </div>

      {/* Líneas de pago */}
      <div className="space-y-2 mb-3">
        {pagos.map((p, idx) => {
          const declarado = Number(p.monto || 0);
          const esEfectivoConDesc = p.metodo === 'EFECTIVO' && aplicaDescuento;
          // El campo `monto` ya está en NETO (con el 10% descontado) cuando el checkbox está activo,
          // porque el handler del checkbox modifica los montos al activarse.
          // Lo que el cliente paga = lo que está en el campo, no hay que volver a multiplicar.
          const cobradoLinea = declarado;
          const necesitaRef = p.metodo === 'TRANSFERENCIA' || p.metodo === 'MERCADOPAGO_QR';
          const cuentaActual = nombreCuenta(p.cuentaId);

          return (
            <div
              key={idx}
              className="bg-white border border-cream-300 rounded-md p-3 space-y-2"
            >
              {/* Fila 1: método + quitar */}
              <div className="flex items-center gap-2">
                <select
                  value={p.metodo}
                  onChange={(e) => {
                    const nuevoMetodo = e.target.value as PagoLinea['metodo'];
                    const sugerida = sugerirCuenta(nuevoMetodo, cuentas);
                    setLinea(idx, {
                      metodo: nuevoMetodo,
                      cuentaId: sugerida?.id ?? p.cuentaId,
                    });
                  }}
                  className="input text-sm py-1.5 font-medium flex-1"
                >
                  {METODOS_SPLIT.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.icon} {m.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => removeLinea(idx)}
                  disabled={pagos.length === 1}
                  className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded disabled:opacity-30 text-sm"
                  title="Quitar este método"
                >
                  ✕
                </button>
              </div>

              {/* Fila 2: monto a aplicar al pedido */}
              <div>
                <label className="block text-2xs font-medium text-ink-700 mb-0.5 flex items-baseline justify-between">
                  <span>{esEfectivoConDesc ? 'Cobra al cliente' : 'Aplicar al pedido'}</span>
                  {esEfectivoConDesc && (
                    <span className="text-2xs text-basil-600 font-normal italic">
                      ✓ descuento aplicado automático
                    </span>
                  )}
                </label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    step="0.01"
                    value={p.monto}
                    onChange={(e) => setLinea(idx, { monto: e.target.value })}
                    placeholder="0.00"
                    className={cn(
                      'input text-md py-1.5 font-mono flex-1',
                      esEfectivoConDesc && 'bg-basil-100 border-basil-600 text-basil-600 font-semibold',
                    )}
                  />
                  {/* Botón "Resto": autocompleta con lo que falta para cubrir el total.
                      Considera el equivalente bruto del efectivo cuando hay descuento. */}
                  {(() => {
                    const cubiertoOtras = pagos.reduce((acc, op, i) => {
                      if (i === idx) return acc;
                      const m = Number(op.monto || 0);
                      if (op.metodo === 'EFECTIVO' && aplicaDescuento) return acc + m / factor;
                      return acc + m;
                    }, 0);
                    const restoBruto = Math.max(0, totalSinDescuento - cubiertoOtras);
                    const restoNeto =
                      p.metodo === 'EFECTIVO' && aplicaDescuento
                        ? restoBruto * factor
                        : restoBruto;
                    const yaCubierto = Math.abs(Number(p.monto || 0) - restoNeto) < 0.5;
                    if (restoNeto <= 0 || yaCubierto) return null;
                    return (
                      <button
                        type="button"
                        onClick={() => setLinea(idx, { monto: restoNeto.toFixed(2) })}
                        className="px-3 py-1.5 rounded-md bg-saffron-100 hover:bg-saffron-600 hover:text-white text-saffron-600 text-xs font-medium border border-saffron-600/40 whitespace-nowrap"
                        title="Completar con el resto que falta del pedido"
                      >
                        Resto · ${restoNeto.toFixed(0)}
                      </button>
                    );
                  })()}
                </div>
                {esEfectivoConDesc && declarado > 0 && (
                  <div className="text-2xs text-basil-600 mt-0.5">
                    ↳ Cubre <MoneyAmount value={(declarado / factor).toFixed(2)} /> del pedido
                    (cliente ahorra{' '}
                    <MoneyAmount
                      value={((declarado * descuentoPct) / (100 - descuentoPct)).toFixed(2)}
                    />
                    )
                  </div>
                )}
              </div>

              {/* Fila 3: solo efectivo — recibido en billetes */}
              {p.metodo === 'EFECTIVO' && (
                <div>
                  <label className="block text-2xs font-medium text-ink-700 mb-0.5">
                    Recibí en billetes (opcional)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="100"
                      value={p.efectivoRecibido ?? ''}
                      onChange={(e) => setLinea(idx, { efectivoRecibido: e.target.value })}
                      placeholder={cobradoLinea > 0 ? cobradoLinea.toFixed(0) : 'ej. 70000'}
                      className="input text-sm py-1.5 font-mono flex-1"
                    />
                    {p.efectivoRecibido &&
                      Number(p.efectivoRecibido) >= cobradoLinea &&
                      cobradoLinea > 0 && (
                        <div className="text-right whitespace-nowrap">
                          <div className="text-2xs text-ink-500">Vuelto</div>
                          <MoneyAmount
                            value={(Number(p.efectivoRecibido) - cobradoLinea).toFixed(2)}
                            className="text-md text-basil-600 font-semibold"
                          />
                        </div>
                      )}
                  </div>
                </div>
              )}

              {/* Fila 4: ref para transferencia/MP */}
              {necesitaRef && (
                <input
                  type="text"
                  value={p.numeroReferencia ?? ''}
                  onChange={(e) => setLinea(idx, { numeroReferencia: e.target.value })}
                  placeholder="Nº de referencia / operación"
                  className="input text-sm py-1.5 font-mono"
                />
              )}

              {/* Cuenta — oculta por default, expandible */}
              <div className="flex items-center justify-between text-2xs text-ink-500">
                <span>
                  Va a: <span className="font-medium text-ink-700">{cuentaActual}</span>
                </span>
                <button
                  onClick={() => setEditandoCuenta(editandoCuenta === idx ? null : idx)}
                  className="hover:underline"
                >
                  cambiar
                </button>
              </div>
              {editandoCuenta === idx && (
                <select
                  value={p.cuentaId}
                  onChange={(e) => {
                    setLinea(idx, { cuentaId: e.target.value });
                    setEditandoCuenta(null);
                  }}
                  className="input text-xs py-1.5"
                  autoFocus
                >
                  <option value="">— elegir —</option>
                  {cuentas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 mb-3 text-xs">
        <button onClick={addLinea} className="text-teresita-700 hover:underline">
          + Agregar otro método
        </button>
        {pagos.length === 1 && Number(pagos[0]?.monto || 0) !== totalSinDescuento && (
          <button
            onClick={completarPrimero}
            className="ml-auto text-ink-500 hover:underline"
          >
            Completar el total ({totalSinDescuento.toFixed(2)})
          </button>
        )}
      </div>

      {/* Descuento al efectivo (mostrador) — toggle + selector de %.
          Al cambiar el %, los montos efectivo se reescalan automáticamente. */}
      {habilitaDescuentoEfectivo && hayEfectivo && (
        <div className="bg-basil-100 px-3 py-3 rounded mb-3 space-y-2">
          <label className="flex items-start gap-2 cursor-pointer text-xs">
            <input
              type="checkbox"
              checked={aplicarDescuentoEfectivo}
              onChange={(e) => {
                const activar = e.target.checked;
                setAplicarDescuentoEfectivo(activar);
                reescalarEfectivo({
                  pctViejo: descuentoPct,
                  pctNuevo: descuentoPct,
                  activarDescuento: activar,
                });
              }}
              className="w-4 h-4 mt-0.5"
            />
            <span className="text-basil-600 font-medium">
              Aplicar descuento al efectivo
              <span className="block text-2xs text-ink-700 font-normal">
                Reescala automáticamente los montos en efectivo según el %.
              </span>
            </span>
          </label>

          {aplicarDescuentoEfectivo && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                {[10, 15, 20, 25, 30].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => {
                      const pctViejo = descuentoPct;
                      setDescuentoPct(pct);
                      setDescuentoPctInput('');
                      reescalarEfectivo({ pctViejo, pctNuevo: pct, activarDescuento: true });
                    }}
                    className={cn(
                      'px-2.5 py-1 rounded text-xs font-medium border transition-colors',
                      descuentoPct === pct && !descuentoPctInput
                        ? 'bg-basil-600 text-white border-basil-600'
                        : 'bg-white text-basil-600 border-basil-600/40 hover:bg-basil-100',
                    )}
                  >
                    −{pct}%
                  </button>
                ))}
                <div className="flex items-center gap-1 ml-auto">
                  <input
                    type="number"
                    min="0"
                    max="50"
                    step="1"
                    placeholder="otro %"
                    value={descuentoPctInput}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDescuentoPctInput(val);
                      const n = Number(val);
                      if (val !== '' && Number.isFinite(n) && n >= 0 && n <= 50) {
                        const pctViejo = descuentoPct;
                        setDescuentoPct(n);
                        reescalarEfectivo({
                          pctViejo,
                          pctNuevo: n,
                          activarDescuento: true,
                        });
                      }
                    }}
                    className="input text-xs py-1 px-2 w-20 font-mono"
                  />
                  <span className="text-2xs text-ink-500">%</span>
                </div>
              </div>
              <div className="text-2xs text-basil-600 italic">
                Aplicando <strong>−{descuentoPct}%</strong> al monto efectivo.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Resumen */}
      <div className="bg-surface-sunken rounded-md p-3 grid grid-cols-2 gap-1 text-sm font-mono mb-3">
        <span className="text-ink-700">A cubrir:</span>
        <MoneyAmount value={totalSinDescuento.toFixed(2)} className="text-right" />
        <span className="text-ink-700">Cubierto:</span>
        <MoneyAmount
          value={cubiertoSubtotal.toFixed(2)}
          className={cn('text-right', cuadra && 'text-basil-600 font-semibold')}
        />
        {Math.abs(diferencia) > 0.01 && (
          <>
            <span className="text-pomodoro-600 font-semibold">
              {diferencia > 0 ? 'Falta:' : 'Sobra:'}
            </span>
            <MoneyAmount
              value={Math.abs(diferencia).toFixed(2)}
              className="text-right text-pomodoro-600 font-semibold"
            />
          </>
        )}
        {aplicaDescuento && (
          <>
            <hr className="col-span-2 border-cream-300 my-1" />
            <span className="text-ink-700 font-semibold">Total a cobrar:</span>
            <MoneyAmount
              value={totalEntregado.toFixed(2)}
              className="text-right text-teresita-700 font-bold text-md"
            />
            <span className="col-span-2 text-2xs text-basil-600 text-right">
              (ahorra <MoneyAmount value={ahorroEfectivo.toFixed(2)} /> en efectivo)
            </span>
          </>
        )}
      </div>

      {error && <div className="text-pomodoro-600 text-sm mb-2">{error}</div>}

      <Button
        fullWidth
        size="lg"
        onClick={confirmar}
        disabled={enviando || !cuadra}
      >
        {enviando ? 'Cobrando...' : 'Confirmar cobro'}
      </Button>
    </div>
  );
}
