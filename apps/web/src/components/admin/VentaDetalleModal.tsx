'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

const TZ_AR = 'America/Argentina/Buenos_Aires';

interface ItemVenta {
  id: string;
  nombreSnapshot: string;
  cantidad: string;
  unidad: 'UNIDAD' | 'GRAMO' | 'PLANCHA' | 'PORCION';
  precioUnitario: string;
  totalLinea: string;
  observacion?: string | null;
  modificadoresAplicados?: Array<{ opcionNombre: string; grupoNombre?: string | null }> | null;
  cocinaInterviene: boolean;
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
  deliveryInfo?: {
    empresaExterna: string | null;
    direccionSnapshot: Record<string, unknown> | null;
    observaciones: string | null;
  } | null;
}

const ESTADO_BADGE: Record<string, { label: string; cls: string }> = {
  PROCESADA: { label: 'ABIERTO', cls: 'bg-saffron-100 text-saffron-600' },
  FINALIZADA: { label: 'COBRADO', cls: 'bg-basil-100 text-basil-600' },
  ANULADA: { label: 'ANULADO', cls: 'bg-pomodoro-100 text-pomodoro-600' },
};

const METODO_LABEL: Record<string, string> = {
  EFECTIVO: '💵 Efectivo',
  DEBITO: '💳 Débito',
  CREDITO_1_PAGO: '💳 Crédito',
  CREDITO_CUOTAS: '💳 Crédito cuotas',
  MERCADOPAGO_QR: '📱 MP / QR',
  TRANSFERENCIA: '🏦 Transferencia',
  TARJETA_NARANJA: '💳 Naranja',
};

/**
 * Vista de SOLO LECTURA del contenido de un pedido, en tarjeta flotante.
 * Se abre desde el dashboard de ventas (admin) para ver qué tiene un pedido
 * sin navegar a la página completa del cajero (que tiene botones de "volver"
 * que sacaban al usuario del listado). Cerrar con la ✕, click afuera o Esc.
 */
export function VentaDetalleModal({
  ventaId,
  onClose,
}: {
  ventaId: string;
  onClose: () => void;
}) {
  const [venta, setVenta] = useState<VentaCompleta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setVenta(null);
    setError(null);
    api
      .get<VentaCompleta>(`/ventas/${ventaId}`)
      .then((v) => {
        if (!cancel) setVenta(v);
      })
      .catch(() => {
        if (!cancel) setError('No se pudo cargar el pedido.');
      });
    return () => {
      cancel = true;
    };
  }, [ventaId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const snap = (venta?.deliveryInfo?.direccionSnapshot ?? {}) as Record<string, unknown>;
  const clienteNombre = typeof snap.clienteNombre === 'string' ? snap.clienteNombre : '';
  const clienteTelefono = typeof snap.clienteTelefono === 'string' ? snap.clienteTelefono : '';
  const direccion = typeof snap.direccion === 'string' ? snap.direccion : '';
  const indicaciones = typeof snap.indicaciones === 'string' ? snap.indicaciones : '';
  const repartidor =
    venta?.deliveryInfo?.empresaExterna ??
    (typeof snap._empleadoNombre === 'string' ? snap._empleadoNombre : '') ??
    '';
  const tieneDelivery = Boolean(clienteNombre || direccion || clienteTelefono || repartidor);
  const badge = venta ? ESTADO_BADGE[venta.estado] : null;

  return (
    <div
      className="fixed inset-0 bg-ink-900/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl max-h-[88vh] flex flex-col shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 py-3 border-b border-cream-300 bg-surface-sunken flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-display text-md text-ink-900 whitespace-nowrap">
              Pedido #{venta ? String(venta.numeroOrdenTurno).padStart(3, '0') : '…'}
            </span>
            {badge && (
              <span
                className={cn(
                  'px-2 py-0.5 rounded text-2xs font-medium uppercase tracking-wide',
                  badge.cls,
                )}
              >
                {badge.label}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-ink-500 hover:text-ink-900 text-xl leading-none px-1"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </header>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {error ? (
            <p className="text-pomodoro-600 text-sm py-6 text-center">{error}</p>
          ) : !venta ? (
            <p className="text-ink-500 text-sm py-6 text-center">Cargando pedido…</p>
          ) : (
            <>
              {/* Meta */}
              <div className="text-xs text-ink-500 flex flex-wrap gap-x-3 gap-y-1">
                <span className="font-mono">venta #{venta.numero}</span>
                <span>· {venta.canal.replace(/_/g, ' ')}</span>
                {venta.modalidad !== 'TAKE_AWAY' && (
                  <span>· {venta.modalidad.replace(/_/g, ' ').toLowerCase()}</span>
                )}
                <span>
                  ·{' '}
                  {new Date(venta.fechaApertura).toLocaleString('es-AR', {
                    timeZone: TZ_AR,
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              {/* Cliente / delivery */}
              {tieneDelivery && (
                <div className="bg-cream-100 rounded-md px-3 py-2 text-sm space-y-0.5 border border-cream-300">
                  {clienteNombre && (
                    <div>
                      <span className="text-2xs uppercase text-ink-500 mr-1">cliente:</span>
                      <span className="text-ink-900">{clienteNombre}</span>
                      {clienteTelefono && <span className="text-ink-500"> · {clienteTelefono}</span>}
                    </div>
                  )}
                  {direccion && (
                    <div>
                      <span className="text-2xs uppercase text-ink-500 mr-1">dirección:</span>
                      <span className="text-ink-700">{direccion}</span>
                    </div>
                  )}
                  {indicaciones && (
                    <div className="text-xs text-saffron-600">⚠ {indicaciones}</div>
                  )}
                  {repartidor && (
                    <div>
                      <span className="text-2xs uppercase text-ink-500 mr-1">reparte:</span>
                      <span className="text-ink-700">🛵 {repartidor}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Items */}
              <div className="card divide-y divide-cream-200">
                {venta.items.length === 0 && (
                  <p className="px-4 py-6 text-center text-ink-500 text-sm">
                    Este pedido no tiene items.
                  </p>
                )}
                {venta.items.map((item) => {
                  const mods = item.modificadoresAplicados ?? [];
                  const modsSalsa = mods.filter((m) => m.grupoNombre?.startsWith('Tipo — Salsa'));
                  const modsOtros = mods.filter((m) => !m.grupoNombre?.startsWith('Tipo — Salsa'));
                  return (
                    <div key={item.id} className="px-4 py-2.5 flex justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="font-medium text-ink-900">
                            {item.nombreSnapshot}
                            {modsSalsa.map((m, i) => (
                              <span key={i} className="text-ink-500 font-normal">
                                {' '}
                                ({m.opcionNombre})
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
                          <div className="text-xs text-saffron-600 mt-0.5">⚠ {item.observacion}</div>
                        )}
                        <div className="text-xs text-ink-500 mt-0.5 font-mono">
                          {item.cantidad}{' '}
                          {item.unidad === 'GRAMO' ? 'g' : item.unidad === 'PLANCHA' ? 'pl' : 'u'} ×{' '}
                          <MoneyAmount value={item.precioUnitario} />
                        </div>
                      </div>
                      <MoneyAmount
                        value={item.totalLinea}
                        className="text-md text-teresita-700 whitespace-nowrap"
                      />
                    </div>
                  );
                })}
              </div>

              {/* Totales */}
              <div className="space-y-1">
                <div className="flex justify-between text-sm text-ink-500">
                  <span>Subtotal</span>
                  <MoneyAmount value={venta.subtotal} className="font-mono" />
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-sm font-medium text-ink-700">Total</span>
                  <MoneyAmount
                    value={venta.total}
                    className="font-mono text-lg text-teresita-900 font-bold"
                  />
                </div>
              </div>

              {/* Pagos */}
              {venta.pagos.length > 0 && (
                <div className="border-t border-cream-200 pt-3">
                  <h3 className="text-2xs uppercase tracking-wider text-ink-500 mb-1">
                    Pago{venta.pagos.length > 1 ? 's' : ''}
                  </h3>
                  {venta.pagos.map((p) => (
                    <div key={p.id} className="flex justify-between text-sm py-0.5">
                      <span className="text-ink-700">{METODO_LABEL[p.metodo] ?? p.metodo}</span>
                      <MoneyAmount value={p.monto} className="font-mono" />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
