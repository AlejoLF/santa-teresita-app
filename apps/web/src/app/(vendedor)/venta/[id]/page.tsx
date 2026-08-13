'use client';

import { use, useEffect, useRef, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { ObservacionEditable } from '@/components/ObservacionEditable';
import { calcularDescuentoEfectivo } from '@sta/shared';
import { cn } from '@/lib/cn';
import { useVentaWatch } from '@/hooks/useVentaWatch';

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
  /** Encargos (pedidos futuros): mismo flujo de cobro, pero en tema marrón. */
  esEncargo?: boolean;
  estadoCobroEncargo?: 'A_PAGAR' | 'COBRADO';
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
  const [motivosSugeridos, setMotivosSugeridos] = useState<string[]>([]);
  const motivoAnularRef = useRef<HTMLTextAreaElement | null>(null);
  const [mostrarCobro, setMostrarCobro] = useState(cobrarAutomatico);
  const [efectivoRecibido, setEfectivoRecibido] = useState('');
  const [mostrarSplit, setMostrarSplit] = useState(false);
  const [metodoSeleccionado, setMetodoSeleccionado] = useState<PagoLinea['metodo'] | null>(null);
  // % de descuento en cobro simple (default 10, configurable). Aplica a
  // cualquier medio de pago.
  const [descuentoPctSimple, setDescuentoPctSimple] = useState<number>(10);
  const [descuentoPctSimpleInput, setDescuentoPctSimpleInput] = useState('');
  // Tope que el cajero puede aplicar (config descuento_manual_max_vendedor_pct).
  // Debe coincidir con el cap del server, sino el cobro tira "total insuficiente".
  const [maxDescuento, setMaxDescuento] = useState<number>(30);
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
        const me = await api.getCached<{ usuario: { rol: string } }>('/auth/me', 5 * 60_000);
        setUsuario(me.usuario);
      } catch {
        /* silencioso */
      }
    })();
  }, []);

  // Config de descuentos: el default automático y el TOPE que el cajero puede
  // aplicar. Mantener el tope alineado con el server evita el bug de "total
  // pagado insuficiente" al elegir un % distinto del default.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.getCached<Record<string, string>>('/configuracion/publico', 5 * 60_000);
        const max = Number(cfg['descuento_manual_max_vendedor_pct']);
        if (Number.isFinite(max) && max > 0) setMaxDescuento(Math.min(100, max));
        const def = Number(cfg['descuento_efectivo_pct']);
        if (Number.isFinite(def) && def >= 0) setDescuentoPctSimple(def);
      } catch {
        /* silencioso — quedan los defaults (10 / 30) */
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

  // Realtime: nos avisa si otro cliente (otra PC, mobile, sync agent)
  // modificó la venta mientras la teníamos abierta. La política es LWW
  // en el servidor; el aviso en UI es para que el cajero recargue antes
  // de seguir tipeando sobre datos viejos.
  const avisoRemoto = useVentaWatch(venta?.id ?? null);
  const [avisoVisible, setAvisoVisible] = useState(false);
  useEffect(() => {
    if (avisoRemoto) setAvisoVisible(true);
  }, [avisoRemoto]);

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
      // Motivos sugeridos (lista configurable). Si falla, quedan los chips vacíos
      // y el cajero igual puede escribir el motivo a mano.
      if (motivosSugeridos.length === 0) {
        api
          .get<{ opciones: Array<{ etiqueta: string }> }>('/configuracion/opciones/motivo_anulacion')
          .then((r) => setMotivosSugeridos(r.opciones.map((o) => o.etiqueta)))
          .catch(() => {});
      }
    }
  }, [confirmaAnular, motivosSugeridos.length]);

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
  // El descuento manual es una decisión de mostrador: los canales de
  // plataforma traen su propio precio y recargo, no se tocan.
  const habilitaDescuento = venta.canal === 'MOSTRADOR';
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
      // Solo aplicamos descuento si el % es > 0. Si la cajera deseleccionó
      // los chips (descuentoPctSimple===0) o tipeó 0 en el custom, se finaliza
      // sin descuento.
      //
      // Vale para CUALQUIER medio de pago: el local hace promos por día con
      // tarjeta/débito, y antes el descuento estaba atado a EFECTIVO — la
      // única forma de cargarlas era bajar los precios a mano.
      const aplicaDescuento = habilitaDescuento && descuentoPctSimple > 0;
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
            // Cobro simple = un solo método, así que el % de la línea es el
            // mismo que el general. Va explícito igual para que el server use
            // siempre el mismo camino de cálculo (el del % por línea).
            descuentoPct: aplicaDescuento ? descuentoPctSimple : 0,
            ...(cambio && { cambioDado: cambio }),
          },
        ],
      });
      router.push(venta?.esEncargo ? '/encargos' : '/cargar-pedido');
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
      router.push(venta?.esEncargo ? '/encargos' : '/cargar-pedido');
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
    <div
      className={cn(
        'min-h-pantalla-solapas flex flex-col',
        venta.esEncargo && 'bg-surface-app-encargos',
      )}
    >
      <header
        className={cn(
          'px-6 py-3 flex items-center justify-between',
          venta.esEncargo ? 'bg-wood-700 text-wood-50' : 'bg-teresita-700 text-cream-50',
        )}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push(venta.esEncargo ? '/encargos' : '/cargar-pedido')}
            className={venta.esEncargo ? 'text-wood-100 hover:underline' : 'text-cream-100 hover:underline'}
          >
            ← Volver {venta.esEncargo ? 'a encargos' : 'al cajero'}
          </button>
          {usuario?.rol === 'ADMIN' && (
            <button
              onClick={() => router.push('/admin')}
              className={cn(
                'px-3 py-1 rounded-md text-sm font-medium transition-colors',
                venta.esEncargo
                  ? 'bg-wood-900 hover:bg-ink-900/30 text-wood-50'
                  : 'bg-teresita-900 hover:bg-ink-900/30 text-cream-50',
              )}
              title="Volver al panel admin"
            >
              ← Panel admin
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-display text-md">
            {venta.esEncargo ? '📦 ENCARGO' : 'PEDIDO'} #
            {String(venta.numeroOrdenTurno).padStart(3, '0')}
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

      {/* Toast Realtime: aviso de modificación remota mid-flight */}
      {avisoVisible && avisoRemoto && (
        <div className="bg-saffron-600 text-white px-4 py-2 flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <span>⚠</span>
            <span>
              Esta venta fue modificada por otro usuario
              {avisoRemoto.nuevoEstado ? ` — nuevo estado: ${avisoRemoto.nuevoEstado}` : ''}
              . Recargá para ver los cambios.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setAvisoVisible(false);
                void refetch();
              }}
              className="bg-white/20 hover:bg-white/30 px-3 py-1 rounded text-2xs font-medium"
            >
              Recargar
            </button>
            <button
              onClick={() => setAvisoVisible(false)}
              className="text-white/80 hover:text-white text-lg leading-none"
              aria-label="Cerrar"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-6 px-6 py-6 max-w-6xl mx-auto w-full">
        {/* Items */}
        <section>
          <div className="flex justify-between items-baseline mb-3 gap-2 flex-wrap">
            <h2 className="text-md font-medium text-ink-700">Items del pedido</h2>
            <div className="flex items-baseline gap-2 text-xs">
              <TipoPedidoEditor
                ventaId={venta.id}
                canalActual={venta.canal}
                modalidadActual={venta.modalidad}
                editable={editable}
                onUpdated={refetch}
              />
              <span className="text-ink-500">
                ·{' '}
                {new Date(venta.fechaApertura).toLocaleTimeString('es-AR', {
                  timeZone: 'America/Argentina/Buenos_Aires',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
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
                  {/* Observación editable solo cuando la venta está en
                      estado PROCESADA (editable). Sino, render readonly
                      del bloque amarillo. */}
                  {editable ? (
                    <ObservacionEditable
                      observacion={item.observacion}
                      onSave={async (nueva) => {
                        await api.patch(`/ventas/${venta.id}/items/${item.id}`, {
                          observacion: nueva || null,
                        });
                        await refetch();
                      }}
                    />
                  ) : (
                    item.observacion && (
                      <div className="mt-1.5 px-3 py-2 bg-saffron-100 border-l-4 border-saffron-600 rounded-r-md">
                        <div className="text-2xs font-bold uppercase tracking-widest text-saffron-600 mb-0.5">
                          ⚠ Observación
                        </div>
                        <div className="text-base font-bold text-ink-900 leading-tight">
                          {item.observacion}
                        </div>
                      </div>
                    )
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
            <MoneyAmount value={totalNum} hero fit className="text-3xl text-teresita-900" />
            {habilitaDescuento && editable && (
              <div className="text-xs text-basil-600 mt-2">
                Con descuento: <MoneyAmount value={conDescuentoSimple.total} className="font-semibold" /> ·
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

              {/* Botón "Agregar envío" — solo en delivery y en los canales que
                  el admin configuró para cada envío. */}
              <AgregarEnvioPanel
                ventaId={venta.id}
                canal={venta.canal}
                modalidad={venta.modalidad}
                onAgregado={refetch}
              />

              {/* Selector de % de descuento (solo mostrador). Aplica a
                  cualquier medio de pago: el local hace promos por día con
                  tarjeta/débito, no sólo con efectivo. */}
              {habilitaDescuento && (
                <div className="bg-basil-100 px-3 py-2 rounded mb-3">
                  <div className="text-2xs text-basil-600 font-medium uppercase tracking-wider mb-1.5">
                    Descuento
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {/* Chip "Sin descuento": click → descuento 0%, queda
                        seleccionado mientras pct=0. Para cuando no corresponde
                        descuento (precio promocional, pedido especial, etc.). */}
                    <button
                      type="button"
                      onClick={() => {
                        setDescuentoPctSimple(0);
                        setDescuentoPctSimpleInput('');
                      }}
                      className={cn(
                        'px-2.5 py-1 rounded text-xs font-medium border transition-colors',
                        descuentoPctSimple === 0 && !descuentoPctSimpleInput
                          ? 'bg-ink-700 text-white border-ink-700'
                          : 'bg-white text-ink-700 border-ink-300 hover:bg-cream-100',
                      )}
                    >
                      Sin desc.
                    </button>
                    {[10, 15, 20, 25, 30].filter((p) => p <= maxDescuento).map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => {
                          // Click sobre el chip activo lo deselecciona (0%).
                          // Click sobre uno distinto lo activa.
                          const yaActivo =
                            descuentoPctSimple === pct && !descuentoPctSimpleInput;
                          setDescuentoPctSimple(yaActivo ? 0 : pct);
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
                        max={maxDescuento}
                        step="1"
                        placeholder={`otro % (máx ${maxDescuento})`}
                        value={descuentoPctSimpleInput}
                        onChange={(e) => {
                          const val = e.target.value;
                          setDescuentoPctSimpleInput(val);
                          const n = Number(val);
                          // Clamp al tope configurado para no mandar un % que el
                          // server va a capear (y descuadrar el total cobrado).
                          if (val !== '' && Number.isFinite(n) && n >= 0 && n <= maxDescuento) {
                            setDescuentoPctSimple(n);
                          }
                        }}
                        className="input text-xs py-1 px-2 w-28 font-mono"
                      />
                      <span className="text-2xs text-basil-600">%</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                {METODOS.map((m) => {
                  // El badge "−X% off" ahora sale en TODOS los métodos: el
                  // descuento dejó de estar atado al efectivo.
                  const conDescuento = habilitaDescuento && descuentoPctSimple > 0;
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
                          : conDescuento
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
                      {conDescuento && (
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
              {habilitaDescuento && (
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
              habilitaDescuento={habilitaDescuento}
              maxDescuento={maxDescuento}
              onCancel={() => setMostrarSplit(false)}
              onCobrado={() => router.push(venta?.esEncargo ? '/encargos' : '/cargar-pedido')}
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
              {venta.estado === 'FINALIZADA'
                ? 'El pedido ya se imprimió al cobrar. Donde haya salido (cocina/delivery) se imprimirá una comanda con leyenda CANCELADA.'
                : 'El pedido todavía no se imprimió, así que no sale comanda de cancelación.'}
            </p>
            <label htmlFor="motivo-anular" className="text-sm font-medium text-ink-700 mb-1 block">
              Motivo
            </label>
            {motivosSugeridos.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {motivosSugeridos.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMotivoAnular(m)}
                    className={cn(
                      'px-2 py-1 rounded text-2xs border transition-colors',
                      motivoAnular === m
                        ? 'bg-teresita-700 text-cream-50 border-teresita-700'
                        : 'bg-white border-cream-300 text-ink-700 hover:bg-cream-50',
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
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
  /** ¿Esta línea lleva descuento? Sólo cuenta si el toggle general está activo. */
  conDescuento?: boolean;
  /** % de descuento DE ESTA LÍNEA. Si no está, usa el % general del panel. */
  descuentoPct?: number;
}

const METODOS_SPLIT: Array<{ value: PagoLinea['metodo']; label: string; icon: string }> = [
  { value: 'EFECTIVO', label: 'Efectivo', icon: '💵' },
  { value: 'DEBITO', label: 'Débito', icon: '💳' },
  { value: 'CREDITO_1_PAGO', label: 'Crédito', icon: '💳' },
  { value: 'MERCADOPAGO_QR', label: 'MP / QR', icon: '📱' },
  { value: 'TRANSFERENCIA', label: 'Transfer.', icon: '🏦' },
];

// ────────────────────────────────────────────────────────────────────────
//   Panel "Agregar envío" — atajo para sumar ENV01/ENV02 al pedido
// ────────────────────────────────────────────────────────────────────────

interface EnvioOpcion {
  id: string;
  codigo: string | null;
  nombre: string;
  monto: string;
  canales: string[];
}

function AgregarEnvioPanel({
  ventaId,
  canal,
  modalidad,
  onAgregado,
}: {
  ventaId: string;
  canal: string;
  modalidad: string;
  onAgregado: () => Promise<void>;
}) {
  const [agregando, setAgregando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [envios, setEnvios] = useState<EnvioOpcion[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.get<{ envios: EnvioOpcion[] }>('/configuracion/envios');
        setEnvios(r.envios);
      } catch {
        setEnvios([]);
      }
    })();
  }, []);

  async function agregar(envio: EnvioOpcion) {
    setAgregando(envio.id);
    setError(null);
    try {
      await api.post(`/ventas/${ventaId}/envio`, { productoId: envio.id });
      await onAgregado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo agregar el envío');
    } finally {
      setAgregando(null);
    }
  }

  // Los envíos solo se ofrecen en delivery (no take-away) y solo en los canales
  // que el admin configuró para cada envío (admin → Delivery → Tipos de envío).
  const enviosVisibles =
    envios === null
      ? null
      : modalidad === 'TAKE_AWAY'
        ? []
        : envios.filter((e) => e.canales.includes(canal));

  // Si ya cargó y no hay envíos aplicables a este pedido, no mostramos el panel.
  if (enviosVisibles !== null && enviosVisibles.length === 0) return null;

  return (
    <div className="bg-saffron-100/40 border border-saffron-200 px-3 py-2 rounded mb-3">
      <div className="text-2xs text-saffron-600 font-medium uppercase tracking-wider mb-1.5">
        Agregar envío
      </div>
      <div className="grid grid-cols-2 gap-2">
        {enviosVisibles === null ? (
          <div className="text-2xs text-ink-500 col-span-2">Cargando…</div>
        ) : (
          enviosVisibles.map((envio) => (
            <button
              key={envio.id}
              type="button"
              disabled={agregando !== null}
              onClick={() => agregar(envio)}
              className="px-3 py-2 rounded border border-saffron-300 bg-white hover:bg-saffron-100 text-sm font-medium disabled:opacity-50 transition-colors text-left"
            >
              🛵 {envio.nombre}
              <div className="text-2xs text-ink-500 font-mono">
                ${Number(envio.monto).toLocaleString('es-AR')}
              </div>
            </button>
          ))
        )}
      </div>
      {error && <p className="text-2xs text-pomodoro-600 mt-1">⚠ {error}</p>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Delivery panel: elegir repartidor (Damián / DELIVERATE / otro)
// ────────────────────────────────────────────────────────────────────────

type RepartidorOpcion = 'DAMIAN' | 'DELIVERATE' | 'OTRO_EMPLEADO' | 'PLATAFORMA';

interface EmpresaDeliveryLite {
  id: string;
  nombre: string;
  comisionPct: string;
  esInterno: boolean;
}

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
  const empleadoActual = (snap._empleadoNombre as string | null | undefined) ?? null;
  const empresaActual = venta.deliveryInfo?.empresaExterna ?? null;
  const clienteNombreActual =
    typeof snap.clienteNombre === 'string' ? snap.clienteNombre : '';
  const clienteTelefonoActual =
    typeof snap.clienteTelefono === 'string' ? snap.clienteTelefono : '';
  const direccionActual = typeof snap.direccion === 'string' ? snap.direccion : '';
  const indicacionesActual =
    typeof snap.indicaciones === 'string' ? snap.indicaciones : '';

  const [editando, setEditando] = useState(false);
  const [empleadoNombre, setEmpleadoNombre] = useState(empleadoActual ?? '');
  const [observaciones, setObservaciones] = useState(venta.deliveryInfo?.observaciones ?? '');
  const [clienteNombre, setClienteNombre] = useState(clienteNombreActual);
  const [clienteTelefono, setClienteTelefono] = useState(clienteTelefonoActual);
  const [direccion, setDireccion] = useState(direccionActual);
  const [indicaciones, setIndicaciones] = useState(indicacionesActual);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Empresas de delivery configuradas (sección admin Delivery). Alimentan los
  // botones de "¿Quién entrega?". `empresaSel` guarda el id elegido, o el
  // sentinel '__otro__' para escribir un nombre a mano.
  const [empresas, setEmpresas] = useState<EmpresaDeliveryLite[]>([]);
  const [empresaSel, setEmpresaSel] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.get<{ empresas: EmpresaDeliveryLite[] }>('/configuracion/delivery-empresas');
        setEmpresas(r.empresas);
      } catch {
        setEmpresas([]);
      }
    })();
  }, []);

  // Pre-seleccionar la empresa según lo ya guardado (match por nombre con la
  // lista). Si había un nombre que no matchea ninguna empresa → '__otro__'.
  useEffect(() => {
    if (empresaSel !== null || empresas.length === 0) return;
    const nombreGuardado = empleadoActual ?? empresaActual ?? null;
    if (!nombreGuardado) return;
    const match = empresas.find(
      (e) => e.nombre.toLowerCase() === nombreGuardado.toLowerCase(),
    );
    setEmpresaSel(match ? match.id : '__otro__');
    if (!match) setEmpleadoNombre(nombreGuardado);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresas]);

  // Re-sincronizar campos cuando la venta se refresca (después de un PATCH
  // de canal/modalidad por ejemplo).
  useEffect(() => {
    setEmpleadoNombre(empleadoActual ?? '');
    setObservaciones(venta.deliveryInfo?.observaciones ?? '');
    setClienteNombre(clienteNombreActual);
    setClienteTelefono(clienteTelefonoActual);
    setDireccion(direccionActual);
    setIndicaciones(indicacionesActual);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venta.id, venta.deliveryInfo?.observaciones]);

  // Si el canal viene de plataforma, sugerimos esa empresa por default.
  useEffect(() => {
    if (empresaSel !== null || empresas.length === 0) return;
    const porCanal: Record<string, string> = {
      PEDIDOS_YA: 'pedidos ya',
      RAPPI: 'rappi',
      MERCADO_LIBRE: 'mercado libre',
    };
    const buscar = porCanal[venta.canal];
    if (!buscar) return;
    const match = empresas.find((e) => e.nombre.toLowerCase() === buscar);
    if (match) setEmpresaSel(match.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venta.canal, empresas]);

  async function guardar() {
    if (!empresaSel) return setError('Elegí quién entrega');
    const empresaElegida = empresas.find((e) => e.id === empresaSel);
    if (empresaSel === '__otro__' && !empleadoNombre.trim()) {
      return setError('Escribí el nombre de quién entrega');
    }
    setGuardando(true);
    setError(null);
    try {
      // Mapeamos la empresa elegida al contrato del endpoint:
      //  - interna (motoquero propio) → OTRO_EMPLEADO con empleadoNombre
      //  - externa (plataforma/empresa) → PLATAFORMA con empresaExterna
      //  - '__otro__' → OTRO_EMPLEADO con el nombre escrito a mano
      let repartidor: RepartidorOpcion;
      let empleadoNombreFinal: string | undefined;
      let empresaExternaFinal: string | undefined;
      if (empresaSel === '__otro__') {
        repartidor = 'OTRO_EMPLEADO';
        empleadoNombreFinal = empleadoNombre.trim();
      } else if (empresaElegida?.esInterno) {
        repartidor = 'OTRO_EMPLEADO';
        empleadoNombreFinal = empresaElegida.nombre;
      } else {
        repartidor = 'PLATAFORMA';
        empresaExternaFinal = empresaElegida?.nombre ?? venta.canal;
      }

      // Construimos el snapshot fresh con los datos del cliente + markers
      // del repartidor. El backend hace MERGE con el existente para que no
      // se pisen datos que el caller no envía.
      const nuevoSnap: Record<string, unknown> = {
        ...snap,
        clienteNombre: clienteNombre.trim() || null,
        clienteTelefono: clienteTelefono.trim() || null,
        direccion: direccion.trim() || null,
        indicaciones: indicaciones.trim() || null,
      };
      await api.put(`/ventas/${venta.id}/delivery`, {
        repartidor,
        empleadoNombre: empleadoNombreFinal,
        empresaExterna: empresaExternaFinal,
        observaciones: observaciones || undefined,
        direccionSnapshot: nuevoSnap,
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

      {!editando && (clienteNombreActual || direccionActual) && (
        <div className="mt-2 space-y-0.5 text-sm text-ink-700">
          {clienteNombreActual && (
            <div>
              <span className="text-2xs uppercase text-ink-500 mr-1">cliente:</span>
              {clienteNombreActual}
              {clienteTelefonoActual && (
                <span className="text-ink-500"> · {clienteTelefonoActual}</span>
              )}
            </div>
          )}
          {direccionActual && (
            <div>
              <span className="text-2xs uppercase text-ink-500 mr-1">dirección:</span>
              {direccionActual}
            </div>
          )}
          {indicacionesActual && (
            <div className="text-xs text-saffron-600">⚠ {indicacionesActual}</div>
          )}
        </div>
      )}

      {editando && (
        <div className="space-y-3 mt-2">
          {/* Datos del cliente — editables */}
          <div className="bg-cream-100 rounded p-3 space-y-2">
            <div className="text-2xs uppercase tracking-wider text-ink-700 font-semibold">
              Datos del cliente
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={clienteNombre}
                onChange={(e) => setClienteNombre(e.target.value)}
                placeholder="Nombre"
                className="input text-sm py-1"
              />
              <input
                type="tel"
                value={clienteTelefono}
                onChange={(e) => setClienteTelefono(e.target.value)}
                placeholder="Teléfono"
                className="input text-sm py-1"
              />
            </div>
            <input
              type="text"
              value={direccion}
              onChange={(e) => setDireccion(e.target.value)}
              placeholder="Dirección (calle, número, piso/dpto)"
              className="input text-sm py-1 w-full"
            />
            <input
              type="text"
              value={indicaciones}
              onChange={(e) => setIndicaciones(e.target.value)}
              placeholder="Indicaciones (entre calles, timbre, etc.)"
              className="input text-2xs py-1 w-full"
            />
          </div>

          <div>
            <label className="block text-2xs font-medium text-ink-700 mb-1">
              ¿Quién entrega?
            </label>
            <div className="grid grid-cols-2 gap-2">
              {empresas.map((emp) => (
                <button
                  key={emp.id}
                  onClick={() => setEmpresaSel(emp.id)}
                  className={cn(
                    'p-3 rounded-md border text-left text-sm transition-colors',
                    empresaSel === emp.id
                      ? 'bg-teresita-50 border-teresita-700'
                      : 'bg-white border-cream-300 hover:bg-cream-50',
                  )}
                >
                  <div className="font-medium">🛵 {emp.nombre}</div>
                  <div className="text-2xs text-ink-500">
                    {emp.esInterno ? 'Delivery propio' : 'Empresa / plataforma'}
                    {Number(emp.comisionPct) > 0 && ` · ${Number(emp.comisionPct).toFixed(0)}%`}
                  </div>
                </button>
              ))}
              <button
                onClick={() => setEmpresaSel('__otro__')}
                className={cn(
                  'p-3 rounded-md border text-left text-sm transition-colors',
                  empresaSel === '__otro__'
                    ? 'bg-teresita-50 border-teresita-700'
                    : 'bg-white border-cream-300 hover:bg-cream-50',
                )}
              >
                <div className="font-medium">🛵 Otro</div>
                <div className="text-2xs text-ink-500">Escribir a mano</div>
              </button>
            </div>
            {empresas.length === 0 && (
              <p className="text-2xs text-ink-500 mt-1">
                No hay empresas de delivery configuradas. Agregalas en Administración → Delivery.
              </p>
            )}
          </div>

          {empresaSel === '__otro__' && (
            <div>
              <label className="block text-2xs font-medium text-ink-700 mb-1">
                Nombre de quién entrega
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

// ────────────────────────────────────────────────────────────────────────
//   Editor de tipo de pedido (canal + modalidad)
// ────────────────────────────────────────────────────────────────────────

// DELIVERATE ya no es canal de ingesta: es un tipo de entrega que se asigna
// como repartidor (panel de Delivery). El pedido entra por su canal real.
const CANALES = [
  'MOSTRADOR',
  'TELEFONO',
  'WHATSAPP',
  'WEB',
  'RAPPI',
  'PEDIDOS_YA',
  'MERCADO_LIBRE',
] as const;
const MODALIDADES = [
  'TAKE_AWAY',
  'DELIVERY_PROPIO',
  'DELIVERY_PLATAFORMA',
  'DELIVERY_DELIVERATE',
] as const;

function TipoPedidoEditor({
  ventaId,
  canalActual,
  modalidadActual,
  editable,
  onUpdated,
}: {
  ventaId: string;
  canalActual: string;
  modalidadActual: string;
  editable: boolean;
  onUpdated: () => Promise<void> | void;
}) {
  const [editando, setEditando] = useState(false);
  const [canal, setCanal] = useState(canalActual);
  const [modalidad, setModalidad] = useState(modalidadActual);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCanal(canalActual);
    setModalidad(modalidadActual);
  }, [canalActual, modalidadActual]);

  // Aplica el cambio APENAS se elige del desplegable (sin botones ✓/✗ chiquitos
  // que nadie veía). Así al pasar a delivery aparecen al toque los campos de
  // envío/dirección y los botones grandes de Cobrar/Guardar de la pantalla.
  async function aplicar(nuevoCanal: string, nuevaModalidad: string) {
    setCanal(nuevoCanal);
    setModalidad(nuevaModalidad);
    setGuardando(true);
    setError(null);
    try {
      await api.patch(`/ventas/${ventaId}`, { canal: nuevoCanal, modalidad: nuevaModalidad });
      await onUpdated();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Error al guardar');
      // Rollback visual al valor real.
      setCanal(canalActual);
      setModalidad(modalidadActual);
    } finally {
      setGuardando(false);
    }
  }

  // Canal → modalidad por defecto (mismo mapeo que cargar-pedido).
  function modalidadDefault(c: string): string {
    if (c === 'MOSTRADOR') return 'TAKE_AWAY';
    if (c === 'TELEFONO' || c === 'WHATSAPP' || c === 'WEB') return 'DELIVERY_PROPIO';
    return 'DELIVERY_PLATAFORMA';
  }

  if (!editando) {
    return (
      <span className="flex items-baseline gap-1">
        <span className="text-ink-700">
          {canalActual.replace('_', ' ')}
          {modalidadActual !== 'TAKE_AWAY' && (
            <span className="text-ink-500"> · {modalidadActual.replace(/_/g, ' ')}</span>
          )}
        </span>
        {editable && (
          <button
            onClick={() => setEditando(true)}
            className="text-2xs text-teresita-700 hover:underline"
            title="Cambiar tipo de pedido"
          >
            ✏️
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 bg-cream-100 px-2 py-1 rounded">
      <select
        value={canal}
        disabled={guardando}
        onChange={(e) => void aplicar(e.target.value, modalidadDefault(e.target.value))}
        className="text-sm border border-cream-300 rounded px-2 py-1 disabled:opacity-60"
      >
        {CANALES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        value={modalidad}
        disabled={guardando}
        onChange={(e) => void aplicar(canal, e.target.value)}
        className="text-sm border border-cream-300 rounded px-2 py-1 disabled:opacity-60"
      >
        {MODALIDADES.map((m) => (
          <option key={m} value={m}>
            {m.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      {guardando ? (
        <span className="text-2xs text-ink-500 animate-pulse">guardando…</span>
      ) : (
        <button
          onClick={() => setEditando(false)}
          className="text-xs px-2.5 py-1 rounded-md bg-teresita-700 text-cream-50 font-medium hover:bg-teresita-900"
          title="Terminar de editar el tipo de pedido"
        >
          Listo
        </button>
      )}
      {error && <span className="text-2xs text-pomodoro-600 ml-1">{error}</span>}
    </span>
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
 *   - En canal mostrador se puede aplicar un descuento % sobre TODAS las
 *     líneas, cualquiera sea el medio de pago (antes era sólo la porción en
 *     efectivo, y las promos con tarjeta no se podían cargar).
 */
function SplitPagoPanel({
  ventaId,
  total,
  subtotal,
  habilitaDescuento,
  maxDescuento,
  onCancel,
  onCobrado,
}: {
  ventaId: string;
  total: string;
  subtotal: string;
  habilitaDescuento: boolean;
  /**
   * Tope que el cajero puede aplicar (config `descuento_manual_max_vendedor_pct`).
   * El server capea a este valor SIN avisar: si la pantalla dejaba pedir más,
   * el cobro salía rechazado con "total pagado insuficiente" y nadie entendía
   * por qué. Acá se usa para que no se pueda ni tipear un % que el server
   * después va a recortar.
   */
  maxDescuento: number;
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

  // Modelo de cálculo, AHORA POR LÍNEA (antes había un único factor global):
  //   - El campo `monto` es lo que el CLIENTE entrega por esa línea (neto).
  //   - pct de la línea = el suyo si lo tiene, si no el % general del panel.
  //     Una línea con `conDescuento=false` va a 0% aunque el toggle esté activo:
  //     ese es justamente el caso "paga con tarjeta sin promo y el resto en
  //     efectivo con 10%".
  //   - factor = (100 - pct)/100 → bruto = neto / factor = lo que cubre del pedido
  //   - ahorro de la línea = bruto - neto = neto * pct/(100-pct)
  const hayMonto = pagos.some((p) => Number(p.monto || 0) > 0);
  const descuentoActivo = aplicarDescuentoEfectivo && habilitaDescuento && hayMonto;
  const pctDeLinea = (p: PagoLinea) =>
    descuentoActivo && p.conDescuento !== false ? (p.descuentoPct ?? descuentoPct) : 0;
  const factorDeLinea = (p: PagoLinea) => (100 - pctDeLinea(p)) / 100;
  const brutoDeLinea = (p: PagoLinea) => Number(p.monto || 0) / factorDeLinea(p);
  const ahorroDeLinea = (p: PagoLinea) => brutoDeLinea(p) - Number(p.monto || 0);

  const totalEntregado = pagos.reduce((acc, p) => acc + Number(p.monto || 0), 0);
  const ahorroEfectivo = pagos.reduce((acc, p) => acc + ahorroDeLinea(p), 0);
  // Cubierto del subtotal: cada línea cuenta por su BRUTO, que es lo que
  // realmente descuenta del pedido.
  const cubiertoSubtotal = pagos.reduce((acc, p) => acc + brutoDeLinea(p), 0);
  const diferencia = totalSinDescuento - cubiertoSubtotal;
  const cuadra = Math.abs(diferencia) < 0.5;
  // ¿Hay % distintos conviviendo? Cambia el texto del resumen, así la cajera
  // ve de un vistazo que el descuento no es parejo.
  const aplicaDescuento = descuentoActivo && ahorroEfectivo > 0;
  const pctsEnUso = Array.from(
    new Set(pagos.filter((p) => Number(p.monto || 0) > 0).map(pctDeLinea)),
  );
  const descuentoDiferenciado = aplicaDescuento && pctsEnUso.length > 1;

  /**
   * Reescala el monto de una línea al cambiarle el % (o al prenderle/apagarle
   * el descuento), MANTENIENDO CONSTANTE lo que esa línea cubre del pedido.
   *
   * Es la operación que espera la cajera: "esta parte cubre $10.000 del
   * pedido; con 10% off el cliente me da $9.000". Si en cambio dejáramos fijo
   * el neto, cambiar el % descuadraría el pedido en cada click.
   */
  function reescalarLinea(
    p: PagoLinea,
    opts: { pctNuevo: number; conDescuentoNuevo: boolean },
  ): PagoLinea {
    const m = Number(p.monto || 0);
    const siguiente = { ...p, conDescuento: opts.conDescuentoNuevo, descuentoPct: opts.pctNuevo };
    if (m === 0) return siguiente;
    const bruto = m / factorDeLinea(p); // con el pct VIEJO
    const factorNuevo = (100 - (opts.conDescuentoNuevo ? opts.pctNuevo : 0)) / 100;
    return { ...siguiente, monto: (bruto * factorNuevo).toFixed(2) };
  }

  /** Cambia una sola línea. */
  function setDescuentoLinea(idx: number, opts: { pctNuevo: number; conDescuentoNuevo: boolean }) {
    setPagos((arr) => arr.map((p, i) => (i === idx ? reescalarLinea(p, opts) : p)));
  }

  /** Aplica el mismo % a TODAS las líneas (atajo del caso parejo, el más común). */
  function reescalarTodas(opts: { pctNuevo: number; activarDescuento: boolean | null }) {
    const activar = opts.activarDescuento ?? aplicarDescuentoEfectivo;
    setPagos((arr) =>
      arr.map((p) =>
        reescalarLinea(p, { pctNuevo: opts.pctNuevo, conDescuentoNuevo: activar }),
      ),
    );
  }

  function setLinea(idx: number, patch: Partial<PagoLinea>) {
    setPagos((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function addLinea() {
    // `diferencia` está en BRUTO (lo que falta cubrir del pedido). El campo de
    // la línea es NETO, así que hay que pasarlo por el factor que le va a
    // tocar a la línea nueva — si no, con descuento activo la línea nace
    // descuadrada.
    const restoBruto = Math.max(0, diferencia);
    // Si la primera línea ya es EFECTIVO, sugerimos DEBITO. Si es DEBITO sugerimos EFECTIVO.
    const yaTieneEfectivo = pagos.some((p) => p.metodo === 'EFECTIVO');
    const metodoSugerido: PagoLinea['metodo'] = yaTieneEfectivo ? 'DEBITO' : 'EFECTIVO';
    const sugerida = sugerirCuenta(metodoSugerido, cuentas);
    const factorNueva = descuentoActivo ? (100 - descuentoPct) / 100 : 1;
    setPagos((arr) => [
      ...arr,
      {
        metodo: metodoSugerido,
        cuentaId: sugerida?.id ?? '',
        monto: restoBruto > 0 ? (restoBruto * factorNueva).toFixed(2) : '',
        conDescuento: descuentoActivo,
        descuentoPct,
      },
    ]);
  }
  function removeLinea(idx: number) {
    setPagos((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }
  function completarPrimero() {
    setPagos((arr) =>
      arr.map((p, i) =>
        i === 0
          ? { ...p, monto: (totalSinDescuento * factorDeLinea(p)).toFixed(2) }
          : p,
      ),
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
      // Mandamos tal cual lo que el cliente paga, más el % de CADA línea.
      const payloadPagos = pagos.map((p) => {
        const declarado = Number(p.monto || 0);
        return {
          metodo: p.metodo,
          cuentaId: p.cuentaId,
          monto: declarado.toFixed(2),
          descuentoPct: pctDeLinea(p),
          numeroReferencia: p.numeroReferencia,
          // cambioDado: si el cajero ingresó "recibí", calcular vuelto contra el monto neto
          ...(p.metodo === 'EFECTIVO' &&
            p.efectivoRecibido &&
            Number(p.efectivoRecibido) > declarado && {
              cambioDado: (Number(p.efectivoRecibido) - declarado).toFixed(2),
            }),
        };
      });
      // Los dos campos viejos van igual, por la ventana entre el deploy de web
      // (Vercel) y el de API (Railway): si el API todavía no entiende el % por
      // línea, tiene que llegar al MISMO total igual.
      //
      // Para eso no mandamos `descuentoPct` crudo sino el % EQUIVALENTE: el
      // único global que produce el mismo descuento total. Con N = neto
      // cobrado y D = ahorro real, el API viejo calcula D' = N·p/(100−p);
      // despejando p = 100·D/(N+D) da D' = D exacto.
      const pctEquivalente =
        aplicaDescuento && totalEntregado + ahorroEfectivo > 0
          ? (100 * ahorroEfectivo) / (totalEntregado + ahorroEfectivo)
          : descuentoPct;
      await api.post(`/ventas/${ventaId}/finalizar`, {
        aplicarDescuentoEfectivo: aplicaDescuento,
        descuentoPctEfectivo: Number(pctEquivalente.toFixed(4)),
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
        {habilitaDescuento && (
          <p className="text-2xs text-ink-500 mt-1">
            Si paga todo con {descuentoPct}% off:{' '}
            <MoneyAmount
              value={(subtotalNum * ((100 - descuentoPct) / 100)).toFixed(2)}
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
          // Cada línea decide: el toggle general la habilita, pero el % es suyo
          // y puede ser 0 (esa línea paga sin promo).
          const pctLinea = pctDeLinea(p);
          const esEfectivoConDesc = pctLinea > 0;
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
                      ✓ −{pctLinea}% aplicado
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
                    const cubiertoOtras = pagos.reduce(
                      (acc, op, i) => (i === idx ? acc : acc + brutoDeLinea(op)),
                      0,
                    );
                    const restoBruto = Math.max(0, totalSinDescuento - cubiertoOtras);
                    // El resto se convierte con el factor DE ESTA línea, que
                    // puede no ser el de las otras.
                    const restoNeto = restoBruto * factorDeLinea(p);
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
                    ↳ Cubre <MoneyAmount value={brutoDeLinea(p).toFixed(2)} /> del pedido
                    (cliente ahorra <MoneyAmount value={ahorroDeLinea(p).toFixed(2)} />)
                  </div>
                )}
              </div>

              {/* Descuento DE ESTA LÍNEA. Aparece sólo con el descuento general
                  activo: es el caso "una parte con promo y la otra no". */}
              {descuentoActivo && (
                <div className="flex items-center gap-2 flex-wrap bg-basil-100/60 rounded px-2 py-1.5">
                  <label className="flex items-center gap-1.5 cursor-pointer text-2xs font-medium text-basil-600">
                    <input
                      type="checkbox"
                      checked={p.conDescuento !== false}
                      onChange={(e) =>
                        setDescuentoLinea(idx, {
                          pctNuevo: p.descuentoPct ?? descuentoPct,
                          conDescuentoNuevo: e.target.checked,
                        })
                      }
                      className="w-3.5 h-3.5"
                    />
                    Descuento en {METODOS_SPLIT.find((m) => m.value === p.metodo)?.label}
                  </label>
                  {p.conDescuento !== false && (
                    <div className="flex items-center gap-1 ml-auto">
                      <input
                        type="number"
                        min="0"
                        max={maxDescuento}
                        step="1"
                        value={p.descuentoPct ?? descuentoPct}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (!Number.isFinite(n) || n < 0 || n > maxDescuento) return;
                          setDescuentoLinea(idx, { pctNuevo: n, conDescuentoNuevo: true });
                        }}
                        className="input text-2xs py-0.5 px-1.5 w-16 font-mono"
                      />
                      <span className="text-2xs text-ink-500">% off</span>
                    </div>
                  )}
                  {p.conDescuento === false && (
                    <span className="ml-auto text-2xs text-ink-500 italic">
                      paga precio de lista
                    </span>
                  )}
                </div>
              )}

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

      {/* Descuento manual (mostrador) — toggle + selector de %.
          Al cambiar el %, TODOS los montos se reescalan automáticamente.
          Aplica a cualquier medio de pago, no sólo efectivo. */}
      {habilitaDescuento && hayMonto && (
        <div className="bg-basil-100 px-3 py-3 rounded mb-3 space-y-2">
          <label className="flex items-start gap-2 cursor-pointer text-xs">
            <input
              type="checkbox"
              checked={aplicarDescuentoEfectivo}
              onChange={(e) => {
                const activar = e.target.checked;
                setAplicarDescuentoEfectivo(activar);
                reescalarTodas({ pctNuevo: descuentoPct, activarDescuento: activar });
              }}
              className="w-4 h-4 mt-0.5"
            />
            <span className="text-basil-600 font-medium">
              Aplicar descuento
              <span className="block text-2xs text-ink-700 font-normal">
                Arranca con el mismo % en todos los métodos. Después podés
                sacárselo a uno o ponerle otro %, arriba en cada método.
              </span>
            </span>
          </label>

          {aplicarDescuentoEfectivo && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-1.5">
                {[10, 15, 20, 25, 30].filter((pct) => pct <= maxDescuento).map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => {
                      setDescuentoPct(pct);
                      setDescuentoPctInput('');
                      reescalarTodas({ pctNuevo: pct, activarDescuento: true });
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
                    max={maxDescuento}
                    step="1"
                    placeholder={`otro % (máx ${maxDescuento})`}
                    value={descuentoPctInput}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDescuentoPctInput(val);
                      const n = Number(val);
                      if (val !== '' && Number.isFinite(n) && n >= 0 && n <= maxDescuento) {
                        setDescuentoPct(n);
                        reescalarTodas({ pctNuevo: n, activarDescuento: true });
                      }
                    }}
                    className="input text-xs py-1 px-2 w-20 font-mono"
                  />
                  <span className="text-2xs text-ink-500">%</span>
                </div>
              </div>
              <div className="text-2xs text-basil-600 italic">
                {descuentoDiferenciado ? (
                  <>
                    Descuento <strong>distinto por método</strong> — mirá el % de
                    cada uno arriba.
                  </>
                ) : (
                  <>
                    Aplicando <strong>−{descuentoPct}%</strong> a todos los métodos.
                    Para diferenciarlo, cambiá el % arriba en cada método.
                  </>
                )}
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
              (ahorra <MoneyAmount value={ahorroEfectivo.toFixed(2)} />)
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
