'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

interface AuditEntry {
  id: string;
  accion: string;
  fecha: string;
  usuarioNombre: string | null;
  valorAnterior: Record<string, unknown> | null;
  valorNuevo: Record<string, unknown> | null;
}

interface MovimientoDetalle {
  id: string;
  tipo: string;
  monto: string;
  fechaComputo: string;
  estado: string;
  observacion: string | null;
  cuentaOrigenId: string | null;
  cuentaDestinoId: string | null;
  categoriaId: string;
  cuentaOrigen?: { nombre: string } | null;
  cuentaDestino?: { nombre: string } | null;
  categoria: { nombre: string };
  usuario: { nombre: string };
  audits: AuditEntry[];
  modificado: boolean;
  anulado: boolean;
}

interface Cuenta {
  id: string;
  nombre: string;
  tipo: string;
}

interface CategoriaShort {
  id: string;
  nombre: string;
  tipo: 'INGRESO' | 'EGRESO' | 'TRANSFERENCIA' | 'AMBOS';
}

/** Categorías "simples" (sin datos extra requeridos) son intercambiables.
 *  Sueldos y Adelanto a empleado son intercambiables entre sí (ambas usan
 *  empleadoId). Insumos no se puede cambiar a otra ni viceversa. */
function categoriaCompatible(actualNombre: string, candidata: CategoriaShort): boolean {
  const requiereExtra = (n: string) =>
    /sueldo|adelanto a empleado|insumos.*proveedor/i.test(n);
  const aExtra = requiereExtra(actualNombre);
  const bExtra = requiereExtra(candidata.nombre);
  if (!aExtra && !bExtra) return true;
  // Sueldos ↔ Adelanto a empleado intercambiables
  return (
    /sueldo|adelanto a empleado/i.test(actualNombre) &&
    /sueldo|adelanto a empleado/i.test(candidata.nombre)
  );
}

/**
 * Modal de detalle/edición de un movimiento.
 *
 * Muestra todos los datos + el historial de auditoría (cuándo se editó,
 * por quién, qué cambió). Permite editar monto / observación y anular el
 * movimiento. Cualquier mutación dispara onUpdated() para refrescar la
 * lista del caller.
 */
export function MovimientoDetailModal({
  movimientoId,
  cuentas,
  onClose,
  onUpdated,
}: {
  movimientoId: string;
  cuentas: Cuenta[];
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [det, setDet] = useState<MovimientoDetalle | null>(null);
  const [categorias, setCategorias] = useState<CategoriaShort[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState(false);
  const [montoEdit, setMontoEdit] = useState('');
  const [obsEdit, setObsEdit] = useState('');
  const [cuentaOrigenEdit, setCuentaOrigenEdit] = useState<string>('');
  const [cuentaDestinoEdit, setCuentaDestinoEdit] = useState<string>('');
  const [categoriaEdit, setCategoriaEdit] = useState<string>('');
  const [fechaEdit, setFechaEdit] = useState<string>('');
  const [confirmAnular, setConfirmAnular] = useState(false);
  const [motivoAnular, setMotivoAnular] = useState('');
  const [enviando, setEnviando] = useState(false);

  async function load() {
    try {
      const [r, cats] = await Promise.all([
        api.get<MovimientoDetalle>(`/admin/movimientos/${movimientoId}`),
        categorias.length === 0
          ? api.get<{ categorias: CategoriaShort[] }>('/admin/categorias-movimiento')
          : Promise.resolve({ categorias }),
      ]);
      setDet(r);
      setMontoEdit(r.monto);
      setObsEdit(r.observacion ?? '');
      setCuentaOrigenEdit(r.cuentaOrigenId ?? '');
      setCuentaDestinoEdit(r.cuentaDestinoId ?? '');
      setCategoriaEdit(r.categoriaId);
      // datetime-local quiere "YYYY-MM-DDTHH:MM" sin segundos ni zona
      setFechaEdit(new Date(r.fechaComputo).toISOString().slice(0, 16));
      if ('categorias' in cats && cats.categorias.length > 0) {
        setCategorias(cats.categorias);
      }
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else setError('Error cargando detalle');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movimientoId]);

  async function guardarEdicion() {
    if (!det) return;
    setEnviando(true);
    setError(null);
    try {
      // Solo mandamos los campos que cambiaron — el backend audit-loggea
      // todos así que enviar valores no cambiados infla el log sin razón.
      const patch: Record<string, unknown> = {};
      if (montoEdit !== det.monto) patch.monto = montoEdit;
      if (obsEdit !== (det.observacion ?? '')) patch.observacion = obsEdit.trim() || null;
      if (cuentaOrigenEdit !== (det.cuentaOrigenId ?? '')) {
        patch.cuentaOrigenId = cuentaOrigenEdit || null;
      }
      if (cuentaDestinoEdit !== (det.cuentaDestinoId ?? '')) {
        patch.cuentaDestinoId = cuentaDestinoEdit || null;
      }
      if (categoriaEdit !== det.categoriaId) patch.categoriaId = categoriaEdit;
      const fechaIso = new Date(fechaEdit).toISOString();
      if (fechaIso !== det.fechaComputo) patch.fechaComputo = fechaIso;
      if (Object.keys(patch).length === 0) {
        setEditando(false);
        return;
      }
      await api.patch(`/admin/movimientos/${movimientoId}`, patch);
      setEditando(false);
      onUpdated();
      await load();
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else setError('Error guardando');
    } finally {
      setEnviando(false);
    }
  }

  async function anular() {
    if (!motivoAnular.trim() || motivoAnular.trim().length < 3) {
      setError('Motivo de anulación: mínimo 3 caracteres');
      return;
    }
    setEnviando(true);
    setError(null);
    try {
      await api.post(`/admin/movimientos/${movimientoId}/anular`, {
        motivo: motivoAnular.trim(),
      });
      onUpdated();
      onClose();
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
      else setError('Error anulando');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink-900/50 flex items-start justify-center p-4 pt-12 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-modal w-full max-w-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-cream-300 flex items-center justify-between">
          <h2 className="font-display text-md text-ink-900">Detalle de movimiento</h2>
          <button
            onClick={onClose}
            className="text-ink-500 hover:text-pomodoro-600 text-2xl leading-none"
          >
            ×
          </button>
        </header>

        <div className="px-5 py-4 space-y-4 max-h-[75vh] overflow-y-auto">
          {error && (
            <div className="bg-pomodoro-100 text-pomodoro-600 text-sm px-3 py-2 rounded">
              {error}
            </div>
          )}
          {!det && !error && <p className="text-ink-500 text-sm">Cargando...</p>}
          {det && (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-2xs uppercase tracking-wider text-ink-500">Tipo</div>
                  <div className="font-medium text-ink-900">
                    {det.tipo.toLowerCase().replace('_', ' ')}
                    {det.anulado && (
                      <span className="ml-2 text-2xs px-2 py-0.5 bg-pomodoro-100 text-pomodoro-600 rounded">
                        ANULADO
                      </span>
                    )}
                    {det.modificado && !det.anulado && (
                      <span className="ml-2 text-2xs px-2 py-0.5 bg-saffron-100 text-saffron-600 rounded">
                        MODIFICADO
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-2xs uppercase tracking-wider text-ink-500">Categoría</div>
                  {editando ? (
                    <select
                      value={categoriaEdit}
                      onChange={(e) => setCategoriaEdit(e.target.value)}
                      className="input text-sm py-1"
                    >
                      {categorias
                        .filter(
                          (c) =>
                            (c.tipo === det.tipo || c.tipo === 'AMBOS') &&
                            categoriaCompatible(det.categoria.nombre, c),
                        )
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.nombre}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <div className="font-medium text-ink-900">{det.categoria.nombre}</div>
                  )}
                </div>
                <div>
                  <div className="text-2xs uppercase tracking-wider text-ink-500">Fecha</div>
                  {editando ? (
                    <input
                      type="datetime-local"
                      value={fechaEdit}
                      onChange={(e) => setFechaEdit(e.target.value)}
                      className="input text-sm py-1 font-mono"
                    />
                  ) : (
                    <div className="font-mono text-ink-700 text-xs">
                      {new Date(det.fechaComputo).toLocaleString('es-AR', {
                        timeZone: 'America/Argentina/Buenos_Aires',
                      })}
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-2xs uppercase tracking-wider text-ink-500">Cargado por</div>
                  <div className="text-ink-700">{det.usuario.nombre}</div>
                </div>
                <div>
                  <div className="text-2xs uppercase tracking-wider text-ink-500">
                    {det.tipo === 'TRANSFERENCIA_INTERNA' ? 'Origen → Destino' : 'Cuenta'}
                  </div>
                  {editando ? (
                    <div className="space-y-1">
                      {(det.tipo === 'EGRESO' || det.tipo === 'TRANSFERENCIA_INTERNA') && (
                        <select
                          value={cuentaOrigenEdit}
                          onChange={(e) => setCuentaOrigenEdit(e.target.value)}
                          className="input text-sm py-1 w-full"
                        >
                          <option value="">— sin cuenta —</option>
                          {cuentas.map((c) => (
                            <option key={c.id} value={c.id}>
                              {det.tipo === 'TRANSFERENCIA_INTERNA' ? 'Origen: ' : ''}
                              {c.nombre}
                            </option>
                          ))}
                        </select>
                      )}
                      {(det.tipo === 'INGRESO' || det.tipo === 'TRANSFERENCIA_INTERNA') && (
                        <select
                          value={cuentaDestinoEdit}
                          onChange={(e) => setCuentaDestinoEdit(e.target.value)}
                          className="input text-sm py-1 w-full"
                        >
                          <option value="">— sin cuenta —</option>
                          {cuentas.map((c) => (
                            <option key={c.id} value={c.id}>
                              {det.tipo === 'TRANSFERENCIA_INTERNA' ? 'Destino: ' : ''}
                              {c.nombre}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ) : (
                    <div className="text-ink-700 text-sm">
                      {det.tipo === 'TRANSFERENCIA_INTERNA'
                        ? `${det.cuentaOrigen?.nombre ?? '—'} → ${det.cuentaDestino?.nombre ?? '—'}`
                        : (det.cuentaOrigen?.nombre ?? det.cuentaDestino?.nombre ?? '—')}
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-2xs uppercase tracking-wider text-ink-500">Monto</div>
                  {editando ? (
                    <input
                      type="number"
                      step="0.01"
                      value={montoEdit}
                      onChange={(e) => setMontoEdit(e.target.value)}
                      className="input text-sm font-mono"
                    />
                  ) : (
                    <MoneyAmount value={det.monto} className="text-md text-ink-900" />
                  )}
                </div>
              </div>

              <div>
                <div className="text-2xs uppercase tracking-wider text-ink-500 mb-1">
                  Observación
                </div>
                {editando ? (
                  <textarea
                    value={obsEdit}
                    onChange={(e) => setObsEdit(e.target.value)}
                    rows={3}
                    maxLength={500}
                    className="input text-sm w-full"
                  />
                ) : (
                  <p className="text-sm text-ink-700 italic whitespace-pre-wrap">
                    {det.observacion || (
                      <span className="text-ink-300">— sin observación —</span>
                    )}
                  </p>
                )}
              </div>

              {det.audits.length > 0 && (
                <div className="border-t border-cream-200 pt-3">
                  <div className="text-2xs uppercase tracking-wider text-ink-500 mb-2">
                    Historial de cambios ({det.audits.length})
                  </div>
                  <ul className="space-y-2">
                    {det.audits.map((a) => (
                      <li
                        key={a.id}
                        className={cn(
                          'text-xs px-3 py-2 rounded border-l-4',
                          a.accion === 'INSERT' && 'border-basil-600 bg-basil-50',
                          a.accion === 'UPDATE' && 'border-saffron-600 bg-saffron-50',
                          a.accion === 'TRANSITION' && 'border-pomodoro-600 bg-pomodoro-50',
                        )}
                      >
                        <div className="flex items-baseline justify-between mb-1">
                          <span className="font-semibold text-ink-900">
                            {a.accion === 'INSERT' && 'Creado'}
                            {a.accion === 'UPDATE' && 'Modificado'}
                            {a.accion === 'TRANSITION' && 'Anulado'}
                          </span>
                          <span className="font-mono text-ink-500">
                            {new Date(a.fecha).toLocaleString('es-AR', {
                              timeZone: 'America/Argentina/Buenos_Aires',
                            })}
                            {a.usuarioNombre && <> · {a.usuarioNombre}</>}
                          </span>
                        </div>
                        {a.accion === 'UPDATE' && a.valorAnterior && a.valorNuevo && (
                          <ChangesDiff before={a.valorAnterior} after={a.valorNuevo} />
                        )}
                        {a.accion === 'TRANSITION' && a.valorNuevo && (
                          <div className="text-ink-700">
                            Motivo: {(a.valorNuevo as { motivo?: string }).motivo ?? '—'}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {confirmAnular && (
                <div className="border-t border-cream-300 pt-3 bg-pomodoro-50/40 -mx-5 px-5 -mb-4 pb-4">
                  <div className="text-sm text-pomodoro-600 font-medium mb-1">
                    Confirmar anulación
                  </div>
                  <textarea
                    value={motivoAnular}
                    onChange={(e) => setMotivoAnular(e.target.value)}
                    placeholder="Motivo (mín. 3 caracteres)"
                    rows={2}
                    className="input text-sm w-full"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {det && !det.anulado && (
          <footer className="px-5 py-3 border-t border-cream-300 bg-surface-sunken flex items-center justify-between">
            {confirmAnular ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setConfirmAnular(false)}
                  disabled={enviando}
                >
                  Cancelar
                </Button>
                <Button
                  className="bg-pomodoro-600 hover:bg-pomodoro-700"
                  onClick={anular}
                  disabled={enviando}
                >
                  {enviando ? 'Anulando…' : 'Sí, anular movimiento'}
                </Button>
              </>
            ) : editando ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setEditando(false)}
                  disabled={enviando}
                >
                  Cancelar
                </Button>
                <Button onClick={guardarEdicion} disabled={enviando}>
                  {enviando ? 'Guardando…' : 'Guardar cambios'}
                </Button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setConfirmAnular(true)}
                  className="text-sm text-pomodoro-600 hover:underline"
                >
                  🗑️ Anular
                </button>
                <Button onClick={() => setEditando(true)}>✏️ Editar</Button>
              </>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

function ChangesDiff({
  before,
  after,
}: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}) {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  return (
    <ul className="space-y-0.5 mt-1">
      {keys.map((k) => {
        const b = before[k];
        const a = after[k];
        if (JSON.stringify(b) === JSON.stringify(a)) return null;
        return (
          <li key={k} className="font-mono text-2xs">
            <span className="text-ink-500">{k}:</span>{' '}
            <span className="text-pomodoro-600 line-through">{stringify(b)}</span>{' '}
            <span className="text-ink-300">→</span>{' '}
            <span className="text-basil-600">{stringify(a)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
