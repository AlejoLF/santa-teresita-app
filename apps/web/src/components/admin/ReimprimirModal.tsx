'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

interface VentaPreview {
  id: string;
  numero: number;
  numeroOrdenTurno: number;
  fechaApertura: string;
  fechaFinalizacion?: string | null;
  canal: string;
  modalidad: string;
  estado: string;
  total: string;
  subtotal: string;
  descuentoTotal: string;
  tieneCocina: boolean;
  items: Array<{
    id: string;
    nombreSnapshot: string;
    cantidad: string;
    unidad: string;
    precioUnitario: string;
    totalLinea: string;
    observacion?: string | null;
    modificadoresAplicados?: Array<{ opcionNombre?: string }> | null;
  }>;
  pagos: Array<{ id: string; metodo: string; monto: string }>;
  deliveryInfo?: {
    empresaExterna?: string | null;
    direccionSnapshot?: Record<string, unknown> | null;
  } | null;
}

type Destino = 'MOSTRADOR' | 'COCINA' | 'DELIVERY';

/**
 * Modal de re-impresión. Muestra preview de la venta (datos, items, totales,
 * repartidor si aplica) y permite a la encargada elegir qué destinos
 * re-imprimir. La preview es un texto simple — no busca emular fielmente el
 * ticket térmico, alcanza con que la encargada confirme "es el pedido
 * correcto" antes de gastar papel.
 */
export function ReimprimirModal({
  ventaId,
  onClose,
}: {
  ventaId: string;
  onClose: () => void;
}) {
  const [venta, setVenta] = useState<VentaPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [done, setDone] = useState<Destino[] | null>(null);
  const [seleccion, setSeleccion] = useState<Record<Destino, boolean>>({
    MOSTRADOR: true,
    COCINA: true,
    DELIVERY: true,
  });

  useEffect(() => {
    let cancelled = false;
    api
      .get<VentaPreview>(`/ventas/${ventaId}`)
      .then((v) => {
        if (cancelled) return;
        setVenta(v);
        // Heurística: pre-seleccionar destinos que aplican según canal + cocina
        const esMostrador = v.canal === 'MOSTRADOR';
        const esDeliveryPropio =
          v.canal === 'TELEFONO' || v.canal === 'WHATSAPP' || v.canal === 'WEB';
        setSeleccion({
          MOSTRADOR: esMostrador,
          COCINA: v.tieneCocina ||
            v.canal === 'RAPPI' ||
            v.canal === 'PEDIDOS_YA' ||
            v.canal === 'MERCADO_LIBRE' ||
            v.canal === 'DELIVERATE',
          DELIVERY: esDeliveryPropio,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Error cargando venta');
      });
    return () => {
      cancelled = true;
    };
  }, [ventaId]);

  async function reimprimir() {
    const destinos = (Object.entries(seleccion) as Array<[Destino, boolean]>)
      .filter(([, on]) => on)
      .map(([d]) => d);
    if (destinos.length === 0) {
      setError('Elegí al menos un destino');
      return;
    }
    setEnviando(true);
    setError(null);
    try {
      const r = await api.post<{ destinos: Destino[] }>(
        `/admin/ventas/${ventaId}/reimprimir`,
        { destinos },
      );
      setDone(r.destinos);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Error al re-imprimir');
    } finally {
      setEnviando(false);
    }
  }

  const cliente = (() => {
    if (!venta?.deliveryInfo?.direccionSnapshot) return null;
    const s = venta.deliveryInfo.direccionSnapshot;
    return {
      nombre: typeof s.clienteNombre === 'string' ? s.clienteNombre : null,
      telefono: typeof s.clienteTelefono === 'string' ? s.clienteTelefono : null,
      direccion: typeof s.direccion === 'string' ? s.direccion : null,
      indicaciones: typeof s.indicaciones === 'string' ? s.indicaciones : null,
      repartidor:
        venta.deliveryInfo.empresaExterna ??
        (typeof s._empleadoNombre === 'string'
          ? s._empleadoNombre
          : typeof s._empresaExterna === 'string'
            ? s._empresaExterna
            : null),
    };
  })();

  return (
    <div
      className="fixed inset-0 z-50 bg-ink-900/50 flex items-start justify-center p-4 pt-12 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-modal w-full max-w-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-cream-300 flex items-center justify-between">
          <h2 className="font-display text-md text-ink-900">
            Re-imprimir venta {venta ? `#${venta.numero}` : ''}
          </h2>
          <button
            onClick={onClose}
            className="text-ink-500 hover:text-pomodoro-600 text-2xl leading-none"
            aria-label="Cerrar"
          >
            ×
          </button>
        </header>

        <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
          {error && (
            <div className="bg-pomodoro-100 text-pomodoro-600 text-sm px-3 py-2 rounded">
              {error}
            </div>
          )}

          {done && (
            <div className="bg-basil-100 text-basil-600 text-sm px-3 py-2 rounded">
              ✓ Re-impresión enviada a: {done.join(', ')}. Los tickets salen como
              "REIMPRESIÓN" para que la cocina no procese de nuevo.
            </div>
          )}

          {!venta && !error && (
            <p className="text-ink-500 text-sm">Cargando preview…</p>
          )}

          {venta && (
            <>
              {/* Vista previa del pedido */}
              <div className="bg-surface-sunken rounded-md p-3 font-mono text-xs whitespace-pre-wrap leading-relaxed">
                <div className="text-center font-bold mb-2">SANTA TERESITA PASTAS</div>
                <div className="text-center mb-1">Pedido #{venta.numeroOrdenTurno}</div>
                <div className="text-center mb-2 text-ink-500">
                  Venta {venta.numero} ·{' '}
                  {new Date(venta.fechaApertura).toLocaleString('es-AR', {
                    timeZone: 'America/Argentina/Buenos_Aires',
                  })}
                </div>
                <div className="border-t border-dashed border-ink-300 my-2" />
                {cliente && (
                  <div className="mb-2 text-ink-700">
                    {cliente.nombre && <div>Cliente: {cliente.nombre}</div>}
                    {cliente.telefono && <div>Tel: {cliente.telefono}</div>}
                    {cliente.direccion && <div>Dir: {cliente.direccion}</div>}
                    {cliente.indicaciones && <div>Ref: {cliente.indicaciones}</div>}
                    {cliente.repartidor && (
                      <div className="font-bold">Repartidor: {cliente.repartidor}</div>
                    )}
                    <div className="border-t border-dashed border-ink-300 my-2" />
                  </div>
                )}
                {venta.items.map((it) => (
                  <div key={it.id} className="mb-1">
                    <div>
                      <span className="font-bold">{it.cantidad}</span> {it.nombreSnapshot}{' '}
                      <span className="text-ink-500">— ${Number(it.totalLinea).toFixed(2)}</span>
                    </div>
                    {(it.modificadoresAplicados ?? [])
                      .map((m) => m?.opcionNombre)
                      .filter(Boolean)
                      .map((n, i) => (
                        <div key={i} className="pl-3 text-ink-500">
                          › {n}
                        </div>
                      ))}
                    {it.observacion && (
                      <div className="pl-3 text-saffron-600 font-bold">⚠ {it.observacion}</div>
                    )}
                  </div>
                ))}
                <div className="border-t border-dashed border-ink-300 my-2" />
                <div className="text-right">Subtotal: ${Number(venta.subtotal).toFixed(2)}</div>
                {Number(venta.descuentoTotal) > 0 && (
                  <div className="text-right">
                    Descuento: -${Number(venta.descuentoTotal).toFixed(2)}
                  </div>
                )}
                <div className="text-right font-bold text-base">
                  TOTAL: ${Number(venta.total).toFixed(2)}
                </div>
                {venta.pagos.length > 0 && (
                  <div className="mt-2 text-ink-700">
                    Pago: {venta.pagos.map((p) => p.metodo).join(' + ')}
                  </div>
                )}
              </div>

              {/* Selectores de destino */}
              <div>
                <div className="text-2xs uppercase tracking-wider text-ink-500 mb-1">
                  Re-imprimir en:
                </div>
                <div className="space-y-1">
                  {(['MOSTRADOR', 'COCINA', 'DELIVERY'] as Destino[]).map((d) => (
                    <label
                      key={d}
                      className={cn(
                        'flex items-center gap-2 text-sm px-2 py-1 rounded',
                        seleccion[d] && 'bg-teresita-50',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={seleccion[d]}
                        onChange={(e) =>
                          setSeleccion((s) => ({ ...s, [d]: e.target.checked }))
                        }
                      />
                      <span className="font-medium">{d}</span>
                      <span className="text-2xs text-ink-500">
                        {d === 'MOSTRADOR' && '(ticket cliente)'}
                        {d === 'COCINA' && '(comanda cocina con items)'}
                        {d === 'DELIVERY' && '(ticket motoquero)'}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-2xs text-ink-500 mt-1">
                  Los destinos que no aplican al canal de esta venta se ignoran.
                </p>
              </div>
            </>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-cream-300 bg-surface-sunken flex items-center justify-between">
          <Button variant="secondary" onClick={onClose}>
            {done ? 'Cerrar' : 'Cancelar'}
          </Button>
          {!done && venta && (
            <Button onClick={reimprimir} disabled={enviando}>
              {enviando ? 'Enviando…' : '🖨 Re-imprimir'}
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
