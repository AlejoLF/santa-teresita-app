'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';
import {
  cuandoLabel,
  fechaLargaDia,
  hoyISO,
  type FranjaEntrega,
  type EstadoCobro,
  type TipoEntrega,
} from '@/lib/encargos';

interface VentaEncargo {
  id: string;
  numero: number;
  numeroOrdenTurno: number;
  estado: 'PROCESADA' | 'FINALIZADA' | 'ANULADA';
  total: string;
  subtotal: string;
  estadoCobroEncargo: EstadoCobro;
  /** Entrega: cuándo se lo llevó el cliente. null = pendiente de retiro. */
  retiradoAt: string | null;
  tipoEntregaEncargo: 'RETIRO' | 'ENVIO' | null;
  fechaEntregaPromesa: string | null;
  horaEntregaExacta: string | null;
  franjaEntrega: FranjaEntrega | null;
  items: Array<{
    id: string;
    nombreSnapshot: string;
    cantidad: string;
    unidad: string;
    precioUnitario: string;
    totalLinea: string;
    observacion?: string | null;
    modificadoresAplicados?: Array<{ opcionNombre: string; grupoNombre?: string | null }> | null;
  }>;
  pagos: Array<{ id: string; metodo: string; monto: string }>;
  deliveryInfo?: { direccionSnapshot: Record<string, unknown> | null } | null;
  observaciones?: string | null;
  encargoPadreId?: string | null;
  // Adiciones ("modificación adicional al pedido X") con su propia secuencia de pago.
  adicionesEncargo?: Array<{
    id: string;
    numeroOrdenTurno: number;
    total: string;
    estado: 'PROCESADA' | 'FINALIZADA' | 'ANULADA';
    estadoCobroEncargo: EstadoCobro;
    items: Array<{ id: string; nombreSnapshot: string; cantidad: string; totalLinea: string }>;
  }>;
}

const METODO_LABEL: Record<string, string> = {
  EFECTIVO: '💵 Efectivo',
  DEBITO: '💳 Débito',
  CREDITO_1_PAGO: '💳 Crédito',
  MERCADOPAGO_QR: '📱 MP / QR',
  TRANSFERENCIA: '🏦 Transferencia',
};

export function EncargoDetalleModal({
  encargoId,
  onClose,
  onChanged,
}: {
  encargoId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [v, setV] = useState<VentaEncargo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anulando, setAnulando] = useState(false);
  const [editing, setEditing] = useState(false);

  const recargar = () =>
    api
      .get<VentaEncargo>(`/ventas/${encargoId}`)
      .then((res) => setV(res))
      .catch(() => setError('No se pudo cargar el encargo.'));

  useEffect(() => {
    let cancel = false;
    api
      .get<VentaEncargo>(`/ventas/${encargoId}`)
      .then((res) => !cancel && setV(res))
      .catch(() => !cancel && setError('No se pudo cargar el encargo.'));
    return () => {
      cancel = true;
    };
  }, [encargoId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const snap = (v?.deliveryInfo?.direccionSnapshot ?? {}) as Record<string, unknown>;
  const cliente = typeof snap.clienteNombre === 'string' ? snap.clienteNombre : '';
  const telefono = typeof snap.clienteTelefono === 'string' ? snap.clienteTelefono : '';
  const direccion = typeof snap.direccion === 'string' ? snap.direccion : '';
  const indicaciones = typeof snap.indicaciones === 'string' ? snap.indicaciones : '';

  const adiciones = v?.adicionesEncargo ?? [];
  const partesPagadas = v
    ? [v.estadoCobroEncargo === 'COBRADO', ...adiciones.map((a) => a.estadoCobroEncargo === 'COBRADO')]
    : [];
  const todoCobrado = partesPagadas.length > 0 && partesPagadas.every(Boolean);
  const nadaCobrado = partesPagadas.every((p) => !p);
  const parcial = !todoCobrado && !nadaCobrado;
  const cobrado = todoCobrado;
  const totalMerged = v
    ? Number(v.total) + adiciones.reduce((a, x) => a + Number(x.total), 0)
    : 0;
  const saldoPendiente = v
    ? (v.estadoCobroEncargo === 'A_PAGAR' ? Number(v.total) : 0) +
      adiciones.filter((a) => a.estadoCobroEncargo === 'A_PAGAR').reduce((a, x) => a + Number(x.total), 0)
    : 0;
  const adicionPendiente = adiciones.find((a) => a.estadoCobroEncargo === 'A_PAGAR');
  // Editable: cualquier encargo no anulado (los COBRADOS también — el cliente
  // cambia dirección/horario después de pagar; el server re-imprime la comanda).
  const editable = v?.estado !== 'ANULADA';
  const puedeAnular = v?.estado === 'PROCESADA' && v?.estadoCobroEncargo === 'A_PAGAR' && adiciones.length === 0;
  const [reimprimiendo, setReimprimiendo] = useState(false);
  // Al tocar "Re-imprimir" se abre el selector de comandera (Mostrador /
  // Delivery / Cocina) y recién al elegir una se manda a imprimir.
  const [pickerImpresion, setPickerImpresion] = useState(false);
  const [reimprimioOk, setReimprimioOk] = useState<string | null>(null);

  const DESTINOS_IMPRESION = [
    { valor: 'MOSTRADOR', label: '🧾 Mostrador' },
    { valor: 'DELIVERY', label: '🛵 Delivery' },
    { valor: 'COCINA', label: '🍳 Cocina' },
  ] as const;

  const [marcandoRetiro, setMarcandoRetiro] = useState(false);

  /**
   * Marca (o desmarca) el retiro. No toca la caja ni el estado de cobro: un
   * encargo se puede retirar impago, y en ese caso sigue figurando como "a pagar".
   */
  async function toggleRetirado() {
    if (!v) return;
    const retirar = !v.retiradoAt;
    if (!retirar && !confirm('¿Desmarcar el retiro de este encargo?')) return;
    setMarcandoRetiro(true);
    try {
      const actualizado = await api.post<VentaEncargo>(`/encargos/${v.id}/retirar`, {
        retirado: retirar,
      });
      setV(actualizado);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo marcar el retiro.');
    } finally {
      setMarcandoRetiro(false);
    }
  }

  async function reimprimir(destino: 'MOSTRADOR' | 'DELIVERY' | 'COCINA') {
    if (!v) return;
    setReimprimiendo(true);
    setReimprimioOk(null);
    try {
      await api.post(`/encargos/${v.id}/reimprimir`, { destino });
      setPickerImpresion(false);
      const label = DESTINOS_IMPRESION.find((d) => d.valor === destino)?.label ?? destino;
      setReimprimioOk(label);
      setTimeout(() => setReimprimioOk(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo re-imprimir.');
    } finally {
      setReimprimiendo(false);
    }
  }

  async function anular() {
    if (!v) return;
    if (!confirm(`¿Anular el encargo #${v.numeroOrdenTurno}?`)) return;
    setAnulando(true);
    try {
      await api.post(`/ventas/${v.id}/anular`, { motivo: 'Encargo anulado' });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo anular.');
    } finally {
      setAnulando(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-ink-900/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl max-h-[88vh] flex flex-col shadow-modal border-t-4 border-wood-700"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-cream-300 bg-wood-50 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-display text-md text-wood-900 whitespace-nowrap">
              📦 Encargo #{v ? String(v.numeroOrdenTurno).padStart(3, '0') : '…'}
            </span>
            {v && (
              <span
                className={cn(
                  'px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wide',
                  cobrado
                    ? 'bg-basil-100 text-basil-600'
                    : parcial
                      ? 'bg-saffron-600 text-white'
                      : 'bg-saffron-100 text-saffron-600',
                )}
              >
                {cobrado ? 'COBRADO' : parcial ? 'PAGO PARCIAL' : 'A PAGAR'}
              </span>
            )}
            {/* El retiro es independiente del cobro: puede estar retirado e impago. */}
            {v?.retiradoAt && (
              <span className="px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wide bg-basil-100 text-basil-600 whitespace-nowrap">
                ✅ RETIRADO
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

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {error ? (
            <p className="text-pomodoro-600 text-sm py-6 text-center">{error}</p>
          ) : !v ? (
            <p className="text-ink-500 text-sm py-6 text-center">Cargando encargo…</p>
          ) : (
            <>
              {editing && v ? (
                <EncargoEditForm
                  venta={v}
                  onCancel={() => setEditing(false)}
                  onSaved={async () => {
                    await recargar();
                    onChanged();
                    setEditing(false);
                  }}
                />
              ) : (
                <>
              {/* Entrega */}
              <div className="bg-wood-100/60 rounded-md px-3 py-2.5 border border-wood-200 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <div className="text-2xs uppercase text-wood-700/70">Día de entrega</div>
                  <div className="font-semibold text-wood-900">
                    {v.fechaEntregaPromesa ? fechaLargaDia(v.fechaEntregaPromesa.slice(0, 10)) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-2xs uppercase text-wood-700/70">Horario</div>
                  <div className="font-semibold text-wood-900">
                    {cuandoLabel({
                      horaEntregaExacta: v.horaEntregaExacta,
                      franjaEntrega: v.franjaEntrega,
                    })}
                  </div>
                </div>
                <div>
                  <div className="text-2xs uppercase text-wood-700/70">Modo</div>
                  <div className="text-ink-900">
                    {v.tipoEntregaEncargo === 'ENVIO' ? '🛵 Envío a domicilio' : '🏪 Retira en local'}
                  </div>
                </div>
                <div>
                  <div className="text-2xs uppercase text-wood-700/70">Venta #</div>
                  <div className="font-mono text-ink-700">{v.numero}</div>
                </div>
              </div>

              {/* Cliente */}
              <div className="text-sm space-y-0.5">
                {cliente && (
                  <div>
                    <span className="text-2xs uppercase text-ink-500 mr-1">cliente:</span>
                    <span className="text-ink-900">{cliente}</span>
                    {telefono && <span className="text-ink-500"> · {telefono}</span>}
                  </div>
                )}
                {direccion && (
                  <div>
                    <span className="text-2xs uppercase text-ink-500 mr-1">dirección:</span>
                    <span className="text-ink-700">{direccion}</span>
                  </div>
                )}
                {indicaciones && <div className="text-xs text-saffron-600">⚠ {indicaciones}</div>}
                {v.observaciones && (
                  <div className="text-xs text-wood-700 font-medium">📝 {v.observaciones}</div>
                )}
              </div>
                </>
              )}

              {/* Items */}
              <div className="card divide-y divide-cream-200">
                {v.items.map((item) => {
                  const mods = (item.modificadoresAplicados ?? []).filter(
                    (m) => !m.grupoNombre?.startsWith('Tipo — Salsa'),
                  );
                  const salsa = (item.modificadoresAplicados ?? []).filter((m) =>
                    m.grupoNombre?.startsWith('Tipo — Salsa'),
                  );
                  return (
                    <div key={item.id} className="px-4 py-2.5 flex justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-ink-900">
                          {item.nombreSnapshot}
                          {salsa.map((m, i) => (
                            <span key={i} className="text-ink-500 font-normal">
                              {' '}
                              ({m.opcionNombre})
                            </span>
                          ))}
                        </span>
                        {mods.map((m, i) => (
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
                        className="text-md text-wood-700 whitespace-nowrap"
                      />
                    </div>
                  );
                })}
              </div>

              {/* Adiciones (modificaciones adicionales, cada una con su pago) */}
              {adiciones.map((a, i) => (
                <div key={a.id} className="card border border-wood-200">
                  <div className="px-4 py-1.5 bg-wood-100/60 flex items-center justify-between">
                    <span className="text-2xs font-semibold uppercase tracking-wide text-wood-900">
                      ➕ Adición {i + 1} · #{String(a.numeroOrdenTurno).padStart(3, '0')}
                    </span>
                    <span
                      className={cn(
                        'px-1.5 py-0.5 rounded text-2xs font-bold uppercase',
                        a.estadoCobroEncargo === 'COBRADO'
                          ? 'bg-basil-100 text-basil-600'
                          : 'bg-saffron-100 text-saffron-600',
                      )}
                    >
                      {a.estadoCobroEncargo === 'COBRADO' ? 'PAGADA' : 'A PAGAR'}
                    </span>
                  </div>
                  <div className="divide-y divide-cream-200">
                    {a.items.map((it) => (
                      <div key={it.id} className="px-4 py-1.5 flex justify-between text-sm">
                        <span className="text-ink-900">
                          <span className="font-mono text-ink-500">{it.cantidad}×</span>{' '}
                          {it.nombreSnapshot}
                        </span>
                        <MoneyAmount value={it.totalLinea} className="text-wood-700" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Total (fusionado con adiciones) */}
              <div className="space-y-0.5">
                <div className="flex justify-between items-baseline">
                  <span className="text-sm font-medium text-ink-700">Total</span>
                  <MoneyAmount
                    value={totalMerged.toFixed(2)}
                    className="font-mono text-lg text-wood-900 font-bold"
                  />
                </div>
                {parcial && (
                  <div className="flex justify-between items-baseline text-saffron-600">
                    <span className="text-xs font-medium">Falta pagar</span>
                    <MoneyAmount value={saldoPendiente.toFixed(2)} className="font-mono text-sm font-bold" />
                  </div>
                )}
              </div>

              {v.pagos.length > 0 && (
                <div className="border-t border-cream-200 pt-3">
                  <h3 className="text-2xs uppercase tracking-wider text-ink-500 mb-1">Pago</h3>
                  {v.pagos.map((p) => (
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

        {/* Acciones */}
        {v && v.estado !== 'ANULADA' && !editing && (
          <footer className="px-5 py-3 border-t border-cream-300 bg-wood-50 flex flex-wrap justify-end gap-2 shrink-0">
            {reimprimioOk && (
              <span className="text-2xs text-basil-600 self-center mr-auto">
                ✓ Comanda enviada a {reimprimioOk}
              </span>
            )}
            {pickerImpresion ? (
              <span className="flex items-center gap-1.5 flex-wrap">
                <span className="text-2xs text-ink-500 mr-0.5">Imprimir en:</span>
                {DESTINOS_IMPRESION.map((d) => (
                  <button
                    key={d.valor}
                    onClick={() => void reimprimir(d.valor)}
                    disabled={reimprimiendo}
                    className="px-2.5 py-2 text-sm rounded-md border border-wood-300 bg-wood-100 text-wood-900 font-medium hover:bg-wood-200 transition-colors disabled:opacity-50"
                  >
                    {reimprimiendo ? '…' : d.label}
                  </button>
                ))}
                <button
                  onClick={() => setPickerImpresion(false)}
                  disabled={reimprimiendo}
                  className="text-ink-500 hover:text-ink-900 text-lg leading-none px-1"
                  title="Cancelar"
                >
                  ✕
                </button>
              </span>
            ) : (
              <button
                onClick={() => setPickerImpresion(true)}
                className="px-3 py-2 text-sm rounded-md border border-cream-300 text-ink-700 hover:bg-cream-200 transition-colors"
                title="Vuelve a imprimir la comanda del encargo — elegí la comandera"
              >
                🖨 Re-imprimir…
              </button>
            )}
            {/* Retiro: disponible pagado o impago (son cosas distintas). El
                footer ya no se renderiza para encargos anulados. */}
            <button
              onClick={() => void toggleRetirado()}
              disabled={marcandoRetiro}
              className={cn(
                'px-3 py-2 text-sm rounded-md font-medium transition-colors disabled:opacity-50',
                v.retiradoAt
                  ? 'border border-cream-300 text-ink-700 hover:bg-cream-200'
                  : 'bg-basil-600 text-white hover:bg-basil-600/85',
              )}
              title={
                v.retiradoAt
                  ? 'Desmarcar el retiro (volver a pendiente)'
                  : 'El cliente ya se llevó el encargo'
              }
            >
              {marcandoRetiro ? '…' : v.retiradoAt ? '↩️ Sin retirar' : '✅ Marcar retirado'}
            </button>
            {editable && (
              <>
                <button
                  onClick={() => setEditing(true)}
                  className="px-3 py-2 text-sm rounded-md border border-cream-300 text-ink-700 hover:bg-cream-200 transition-colors"
                >
                  ✏️ Editar
                </button>
                <button
                  onClick={() => router.push(`/encargos/nuevo?adicionDe=${v.id}`)}
                  className="px-3 py-2 text-sm rounded-md border border-wood-300 bg-wood-100 text-wood-900 font-medium hover:bg-wood-200 transition-colors"
                  title="El cliente suma productos al encargo — se cobra aparte"
                >
                  ➕ Adicionar
                </button>
              </>
            )}
            {puedeAnular && (
              <button
                onClick={anular}
                disabled={anulando}
                className="px-3 py-2 text-sm rounded-md text-pomodoro-600 hover:bg-pomodoro-100 transition-colors disabled:opacity-50"
              >
                Anular
              </button>
            )}
            {v.estadoCobroEncargo === 'A_PAGAR' && v.estado === 'PROCESADA' && (
              <button
                onClick={() => router.push(`/venta/${v.id}?cobrar=1`)}
                className="px-4 py-2 text-sm rounded-md bg-wood-700 text-wood-50 font-medium hover:bg-wood-900 transition-colors"
              >
                💵 Cobrar
              </button>
            )}
            {v.estadoCobroEncargo === 'COBRADO' && adicionPendiente && (
              <button
                onClick={() => router.push(`/venta/${adicionPendiente.id}?cobrar=1`)}
                className="px-4 py-2 text-sm rounded-md bg-wood-700 text-wood-50 font-medium hover:bg-wood-900 transition-colors"
              >
                💵 Cobrar saldo (<MoneyAmount value={saldoPendiente.toFixed(2)} />)
              </button>
            )}
            {cobrado && !adicionPendiente && (
              <span className="text-2xs text-basil-600 self-center">
                ✓ Cobrado — registrado en la caja del día del cobro
              </span>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

/** Formulario inline para editar los datos de entrega de un encargo A_PAGAR. */
function EncargoEditForm({
  venta,
  onCancel,
  onSaved,
}: {
  venta: VentaEncargo;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const snap = (venta.deliveryInfo?.direccionSnapshot ?? {}) as Record<string, unknown>;
  const [fecha, setFecha] = useState(venta.fechaEntregaPromesa?.slice(0, 10) ?? '');
  const [modoHora, setModoHora] = useState<'exacta' | 'franja'>(
    venta.horaEntregaExacta ? 'exacta' : 'franja',
  );
  const [horaExacta, setHoraExacta] = useState(venta.horaEntregaExacta ?? '');
  const [franja, setFranja] = useState<FranjaEntrega | ''>(venta.franjaEntrega ?? '');
  const [nombre, setNombre] = useState(typeof snap.clienteNombre === 'string' ? snap.clienteNombre : '');
  const [telefono, setTelefono] = useState(
    typeof snap.clienteTelefono === 'string' ? snap.clienteTelefono : '',
  );
  const [tipoEntrega, setTipoEntrega] = useState<TipoEntrega>(venta.tipoEntregaEncargo ?? 'RETIRO');
  const [direccion, setDireccion] = useState(typeof snap.direccion === 'string' ? snap.direccion : '');
  const [indicaciones, setIndicaciones] = useState(
    typeof snap.indicaciones === 'string' ? snap.indicaciones : '',
  );
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valido =
    !!fecha &&
    (modoHora === 'exacta' ? !!horaExacta : !!franja) &&
    !!nombre.trim() &&
    !!telefono.trim() &&
    (tipoEntrega !== 'ENVIO' || !!direccion.trim());

  async function guardar() {
    if (!valido) return;
    setGuardando(true);
    setErr(null);
    try {
      await api.patch(`/encargos/${venta.id}`, {
        fechaEntrega: fecha,
        horaEntregaExacta: modoHora === 'exacta' ? horaExacta : null,
        franjaEntrega: modoHora === 'franja' ? franja : null,
        clienteNombre: nombre.trim(),
        clienteTelefono: telefono.trim(),
        tipoEntrega,
        direccionEntrega: tipoEntrega === 'ENVIO' ? direccion.trim() : null,
        indicacionesEntrega: indicaciones.trim() || null,
      });
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo guardar');
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="text-2xs uppercase tracking-wider text-wood-700 font-semibold">Editar encargo</div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-2xs text-ink-500 mb-0.5">Día *</label>
          <input
            type="date"
            value={fecha}
            min={hoyISO()}
            onChange={(e) => setFecha(e.target.value)}
            className="input text-sm py-1"
          />
        </div>
        <div>
          <label className="block text-2xs text-ink-500 mb-0.5">Horario *</label>
          <div className="flex gap-1 mb-1">
            <button
              type="button"
              onClick={() => setModoHora('franja')}
              className={cn('flex-1 px-1 py-0.5 rounded text-2xs border', modoHora === 'franja' ? 'bg-wood-700 text-wood-50 border-wood-700' : 'bg-white border-cream-300')}
            >
              Franja
            </button>
            <button
              type="button"
              onClick={() => setModoHora('exacta')}
              className={cn('flex-1 px-1 py-0.5 rounded text-2xs border', modoHora === 'exacta' ? 'bg-wood-700 text-wood-50 border-wood-700' : 'bg-white border-cream-300')}
            >
              Hora
            </button>
          </div>
          {modoHora === 'exacta' ? (
            <input type="time" value={horaExacta} onChange={(e) => setHoraExacta(e.target.value)} className="input text-sm py-1" />
          ) : (
            <div className="flex gap-1">
              {(['MANANA', 'TARDE', 'NOCHE'] as FranjaEntrega[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFranja(f)}
                  className={cn('flex-1 px-1 py-1 rounded text-2xs border', franja === f ? 'bg-wood-600 text-wood-50 border-wood-600' : 'bg-white border-cream-300')}
                >
                  {f === 'MANANA' ? 'Mañ' : f === 'TARDE' ? 'Tar' : 'Noc'}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="block text-2xs text-ink-500 mb-0.5">Nombre *</label>
          <input type="text" value={nombre} onChange={(e) => setNombre(e.target.value)} className="input text-sm py-1" />
        </div>
        <div>
          <label className="block text-2xs text-ink-500 mb-0.5">Teléfono *</label>
          <input type="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)} className="input text-sm py-1" />
        </div>
      </div>
      <div className="flex gap-1">
        {(['RETIRO', 'ENVIO'] as TipoEntrega[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTipoEntrega(t)}
            className={cn('flex-1 px-2 py-1 rounded text-xs border', tipoEntrega === t ? 'bg-wood-700 text-wood-50 border-wood-700' : 'bg-white border-cream-300')}
          >
            {t === 'RETIRO' ? '🏪 Retira' : '🛵 Envío'}
          </button>
        ))}
      </div>
      {tipoEntrega === 'ENVIO' && (
        <input
          type="text"
          value={direccion}
          onChange={(e) => setDireccion(e.target.value)}
          placeholder="Dirección *"
          className="input text-sm py-1"
        />
      )}
      <input
        type="text"
        value={indicaciones}
        onChange={(e) => setIndicaciones(e.target.value)}
        placeholder="Indicaciones (opcional)"
        className="input text-xs py-1"
      />
      {err && <p className="text-2xs text-pomodoro-600">{err}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded-md border border-cream-300 text-ink-700 hover:bg-cream-200">
          Cancelar
        </button>
        <button
          onClick={guardar}
          disabled={!valido || guardando}
          className="px-4 py-1.5 text-sm rounded-md bg-wood-700 text-wood-50 font-medium hover:bg-wood-900 disabled:opacity-40"
        >
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </div>
  );
}
