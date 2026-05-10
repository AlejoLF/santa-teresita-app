'use client';

import { use, useEffect, useState, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface Factura {
  id: string;
  tipoComprobante: string;
  puntoVenta: string | null;
  numero: string;
  fechaEmision: string;
  fechaVencimiento: string | null;
  total: string;
  totalPagado: string;
  saldo: string;
  estado: string;
}

interface Proveedor {
  id: string;
  nombre: string;
}

interface DetalleResp {
  proveedor: Proveedor;
  facturas: Factura[];
  saldoAdeudado: string;
}

interface Cuenta {
  id: string;
  nombre: string;
  tipo: 'EFECTIVO' | 'BANCO' | 'WALLET';
  saldoActual: string;
}

type Step = 1 | 2 | 3 | 4;

interface FacturaSel {
  facturaId: string;
  numero: string;
  saldo: string; // saldo total de la factura
  montoAplicar: string; // cuánto aplicar en esta operación
  vencimiento: string | null;
}

interface PagoLinea {
  cuentaId: string;
  metodo: 'EFECTIVO' | 'TRANSFERENCIA' | 'DEPOSITO' | 'CHEQUE' | 'MERCADOPAGO_QR' | 'OTRO';
  monto: string;
  numeroReferencia: string;
}

const METODOS = [
  { value: 'EFECTIVO', label: 'Efectivo', cuentaTipo: 'EFECTIVO' },
  { value: 'TRANSFERENCIA', label: 'Transferencia', cuentaTipo: 'BANCO' },
  { value: 'DEPOSITO', label: 'Depósito', cuentaTipo: 'BANCO' },
  { value: 'MERCADOPAGO_QR', label: 'MercadoPago', cuentaTipo: 'WALLET' },
  { value: 'CHEQUE', label: 'Cheque', cuentaTipo: 'BANCO' },
  { value: 'OTRO', label: 'Otro', cuentaTipo: null },
] as const;

export default function PagarFacturasPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: proveedorId } = use(params);
  const search = useSearchParams();
  const router = useRouter();
  const facturasParam = search.get('facturas') ?? '';
  const idsPreseleccionadas = facturasParam.split(',').filter(Boolean);

  const [step, setStep] = useState<Step>(1);
  const [data, setData] = useState<DetalleResp | null>(null);
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  // Modo del pago: contra facturas específicas o "a cuenta" (saldo cuenta corriente).
  const [modo, setModo] = useState<'facturas' | 'a_cuenta'>('facturas');
  const [montoACuenta, setMontoACuenta] = useState('');

  const [seleccion, setSeleccion] = useState<FacturaSel[]>([]);
  const [pagos, setPagos] = useState<PagoLinea[]>([
    { cuentaId: '', metodo: 'EFECTIVO', monto: '', numeroReferencia: '' },
  ]);
  const [observaciones, setObservaciones] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [det, cs] = await Promise.all([
          api.get<DetalleResp>(`/admin/proveedores/${proveedorId}`),
          api.get<{ cuentas: Cuenta[] }>('/admin/cuentas'),
        ]);
        setData(det);
        setCuentas(cs.cuentas);

        // Pre-seleccionar facturas si vinieron en URL
        const facsPendientes = det.facturas.filter((f) =>
          ['PENDIENTE_PAGO', 'PAGADA_PARCIAL'].includes(f.estado),
        );
        const inicial: FacturaSel[] = facsPendientes
          .filter((f) => idsPreseleccionadas.includes(f.id))
          .map((f) => ({
            facturaId: f.id,
            numero: f.numero,
            saldo: f.saldo,
            montoAplicar: f.saldo,
            vencimiento: f.fechaVencimiento,
          }));
        setSeleccion(inicial);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) {
          setError('Error al cargar datos');
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proveedorId]);

  const totalAPagar = useMemo(() => {
    if (modo === 'a_cuenta') return Number(montoACuenta || 0);
    return seleccion.reduce((acc, s) => acc + Number(s.montoAplicar || 0), 0);
  }, [modo, montoACuenta, seleccion]);

  const totalAsignado = useMemo(
    () => pagos.reduce((acc, p) => acc + Number(p.monto || 0), 0),
    [pagos],
  );

  const diferencia = totalAsignado - totalAPagar;

  // Auto-fill: cuando hay UNA sola cuenta destino, el monto = total. Solo
  // cuando la encargada agrega una 2da cuenta empieza a distribuir manualmente.
  // Antes el campo arrancaba vacío y había que retipear el total — fricción
  // innecesaria en el caso simple (que es el 90%).
  useEffect(() => {
    if (pagos.length === 1 && totalAPagar > 0) {
      const totalStr = totalAPagar.toFixed(2);
      if (pagos[0]!.monto !== totalStr) {
        setPagos((arr) => arr.map((p, i) => (i === 0 ? { ...p, monto: totalStr } : p)));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalAPagar, pagos.length]);

  if (error) return <div className="text-pomodoro-600 p-6">{error}</div>;
  if (!data) return <div className="text-ink-500 p-6">Cargando...</div>;

  const facturasPendientes = data.facturas.filter((f) =>
    ['PENDIENTE_PAGO', 'PAGADA_PARCIAL'].includes(f.estado),
  );

  // ────── Step 1 helpers ──────
  function toggleFactura(f: Factura) {
    const idx = seleccion.findIndex((s) => s.facturaId === f.id);
    if (idx >= 0) {
      setSeleccion((arr) => arr.filter((_, i) => i !== idx));
    } else {
      setSeleccion((arr) => [
        ...arr,
        {
          facturaId: f.id,
          numero: f.numero,
          saldo: f.saldo,
          montoAplicar: f.saldo,
          vencimiento: f.fechaVencimiento,
        },
      ]);
    }
  }
  function setMontoAplicar(facturaId: string, monto: string) {
    setSeleccion((arr) =>
      arr.map((s) => (s.facturaId === facturaId ? { ...s, montoAplicar: monto } : s)),
    );
  }

  // ────── Step 2 helpers ──────
  function addPagoLinea() {
    setPagos((arr) => [
      ...arr,
      { cuentaId: '', metodo: 'TRANSFERENCIA', monto: '', numeroReferencia: '' },
    ]);
  }
  function removePagoLinea(idx: number) {
    setPagos((arr) => arr.filter((_, i) => i !== idx));
  }
  function setPagoLinea(idx: number, patch: Partial<PagoLinea>) {
    setPagos((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  // ────── Submit ──────
  async function confirmar() {
    setError(null);
    setEnviando(true);
    try {
      if (modo === 'a_cuenta') {
        // Pago a cuenta corriente: sin factura específica
        await api.post('/admin/pagos-a-cuenta', {
          proveedorId,
          pagos: pagos.map((p) => ({
            cuentaId: p.cuentaId,
            metodo: p.metodo,
            monto: p.monto,
            numeroReferencia: p.numeroReferencia || undefined,
          })),
          observaciones: observaciones || undefined,
        });
      } else {
        await api.post('/admin/pagos-multicuenta', {
          proveedorId,
          facturas: seleccion.map((s) => ({
            facturaId: s.facturaId,
            montoAplicar: s.montoAplicar,
          })),
          pagos: pagos.map((p) => ({
            cuentaId: p.cuentaId,
            metodo: p.metodo,
            monto: p.monto,
            numeroReferencia: p.numeroReferencia || undefined,
          })),
          observaciones: observaciones || undefined,
        });
      }
      // ✓ Pago registrado — volver al detalle
      router.push(`/admin/insumos/${proveedorId}?pagado=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al registrar el pago');
    } finally {
      setEnviando(false);
    }
  }

  // ────── Validaciones por paso ──────
  const step1Valido =
    modo === 'a_cuenta'
      ? Number(montoACuenta) > 0
      : seleccion.length > 0 && seleccion.every((s) => Number(s.montoAplicar) > 0);
  const step2Valido =
    pagos.length > 0 &&
    pagos.every((p) => p.cuentaId && Number(p.monto) > 0) &&
    Math.abs(diferencia) < 0.01;

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <header>
        <Link
          href={`/admin/insumos/${proveedorId}`}
          className="text-sm text-ink-500 hover:underline"
        >
          ← Volver al proveedor
        </Link>
        <h1 className="font-display text-xl text-ink-900 mt-1">
          Pagar facturas — {data.proveedor.nombre}
        </h1>
      </header>

      {/* Stepper */}
      <Stepper step={step} onStep={(s) => setStep(s)} />

      {error && (
        <div className="bg-pomodoro-100 text-pomodoro-600 px-4 py-2 rounded text-sm">{error}</div>
      )}

      {/* Step 1: seleccionar facturas o pago a cuenta */}
      {step === 1 && (
        <section className="card overflow-hidden">
          <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
            <h2 className="font-display text-md text-ink-900">
              Paso 1 · {modo === 'facturas' ? 'Seleccionar facturas' : 'Pago a cuenta corriente'}
            </h2>
          </header>

          {/* Toggle modo */}
          <div className="px-4 pt-3 pb-2 border-b border-cream-200 bg-cream-50">
            <div className="text-2xs text-ink-500 uppercase tracking-wider mb-2">
              Tipo de pago
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setModo('facturas')}
                className={cn(
                  'px-3 py-2 rounded-md text-sm font-medium border transition-colors text-left flex-1',
                  modo === 'facturas'
                    ? 'bg-teresita-50 border-teresita-700 text-teresita-700'
                    : 'bg-white border-cream-300 text-ink-700 hover:bg-cream-50',
                )}
              >
                <div>📄 Pagar facturas específicas</div>
                <div className="text-2xs text-ink-500 font-normal mt-0.5">
                  El monto se aplica contra una o varias facturas pendientes.
                </div>
              </button>
              <button
                type="button"
                onClick={() => setModo('a_cuenta')}
                className={cn(
                  'px-3 py-2 rounded-md text-sm font-medium border transition-colors text-left flex-1',
                  modo === 'a_cuenta'
                    ? 'bg-teresita-50 border-teresita-700 text-teresita-700'
                    : 'bg-white border-cream-300 text-ink-700 hover:bg-cream-50',
                )}
              >
                <div>💰 Pago a cuenta corriente</div>
                <div className="text-2xs text-ink-500 font-normal mt-0.5">
                  Pago parcial al saldo total adeudado, sin asociar a una factura puntual.
                </div>
              </button>
            </div>
          </div>

          {modo === 'a_cuenta' ? (
            <div className="px-5 py-5 space-y-3">
              <div className="bg-saffron-100/40 border border-saffron-600/30 rounded-md px-3 py-2 text-xs text-ink-700 space-y-1">
                <div>
                  Este pago se va a registrar como egreso al proveedor pero{' '}
                  <strong>no va a cancelar ninguna factura puntual</strong>. Se usa cuando el
                  dueño paga, ej, $1.200.000 de un saldo total de $2.500.000 sin que el
                  monto coincida con facturas específicas.
                </div>
                <div className="text-pomodoro-600">
                  ⚠ El saldo adeudado del proveedor <strong>NO baja automáticamente</strong>.
                  Para imputar este pago a facturas, después usá "Pagar facturas específicas".
                </div>
                <div className="text-2xs text-ink-500">
                  Si querés que el saldo baje automáticamente FIFO, mejor hacé el egreso
                  desde Movimientos → categoría "Insumos (compras a proveedores)" + proveedor.
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1">
                  Monto a pagar
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={montoACuenta}
                  onChange={(e) => setMontoACuenta(e.target.value)}
                  className="input font-mono text-lg"
                  placeholder="0.00"
                  autoFocus
                />
                <div className="text-2xs text-ink-500 mt-1">
                  Saldo adeudado actual del proveedor:{' '}
                  <MoneyAmount
                    value={data.saldoAdeudado}
                    className="text-pomodoro-600 font-medium"
                  />
                </div>
              </div>
            </div>
          ) : facturasPendientes.length === 0 ? (
            <div className="px-4 py-8 text-center text-ink-500">
              Sin facturas pendientes con este proveedor.
              <div className="mt-2 text-xs">
                Si querés pagar a cuenta corriente, cambiá el modo arriba.
              </div>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
                <tr>
                  <th className="text-left px-4 py-2 w-10">✓</th>
                  <th className="text-left px-4 py-2">Factura</th>
                  <th className="text-left px-4 py-2">Vence</th>
                  <th className="text-right px-4 py-2">Total</th>
                  <th className="text-right px-4 py-2">Saldo</th>
                  <th className="text-right px-4 py-2">A aplicar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {facturasPendientes.map((f) => {
                  const sel = seleccion.find((s) => s.facturaId === f.id);
                  const venc = f.fechaVencimiento ? new Date(f.fechaVencimiento) : null;
                  const vencido = venc && venc.getTime() < Date.now();
                  return (
                    <tr key={f.id} className={cn(sel && 'bg-teresita-50')}>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={!!sel}
                          onChange={() => toggleFactura(f)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-2xs text-ink-500">
                          {f.tipoComprobante.replace('_', ' ')}
                        </div>
                        <div className="font-mono">
                          {f.puntoVenta ? `${f.puntoVenta}-` : ''}
                          {f.numero}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {venc ? (
                          <span className={cn(vencido && 'text-pomodoro-600 font-semibold')}>
                            {vencido && '⚠ '}
                            {venc.toLocaleDateString('es-AR')}
                          </span>
                        ) : (
                          <span className="text-ink-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <MoneyAmount value={f.total} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <MoneyAmount value={f.saldo} className="text-pomodoro-600" />
                      </td>
                      <td className="px-4 py-3 text-right">
                        {sel ? (
                          <input
                            type="number"
                            step="0.01"
                            value={sel.montoAplicar}
                            max={f.saldo}
                            onChange={(e) => setMontoAplicar(f.id, e.target.value)}
                            className="input w-32 text-right font-mono py-1"
                          />
                        ) : (
                          <span className="text-ink-300">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <footer className="px-4 py-3 border-t border-cream-300 bg-surface-sunken flex justify-between items-center">
            <div className="text-sm">
              {modo === 'a_cuenta' ? (
                <>
                  Pago a cuenta · Total:{' '}
                  <MoneyAmount
                    value={totalAPagar.toFixed(2)}
                    className="font-medium text-teresita-700"
                  />
                </>
              ) : (
                <>
                  Seleccionadas: <span className="font-medium">{seleccion.length}</span> · Total
                  a pagar:{' '}
                  <MoneyAmount
                    value={totalAPagar.toFixed(2)}
                    className="font-medium text-teresita-700"
                  />
                </>
              )}
            </div>
            <Button disabled={!step1Valido} onClick={() => setStep(2)}>
              Siguiente →
            </Button>
          </footer>
        </section>
      )}

      {/* Step 2: distribuir entre cuentas */}
      {step === 2 && (
        <section className="card">
          <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
            <h2 className="font-display text-md text-ink-900">
              Paso 2 · Distribuir entre cuentas
            </h2>
          </header>
          <div className="px-4 py-3 space-y-3">
            <div className="text-sm text-ink-500">
              Total a pagar:{' '}
              <MoneyAmount
                value={totalAPagar.toFixed(2)}
                className="font-medium text-ink-900"
              />
            </div>

            <div className="space-y-2">
              {pagos.map((p, idx) => {
                const cuenta = cuentas.find((c) => c.id === p.cuentaId);
                return (
                  <div
                    key={idx}
                    className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end border border-cream-300 rounded-md p-3 bg-white"
                  >
                    <div>
                      <label className="block text-2xs font-medium text-ink-700 mb-1">
                        Cuenta
                      </label>
                      <select
                        value={p.cuentaId}
                        onChange={(e) => setPagoLinea(idx, { cuentaId: e.target.value })}
                        className="input text-sm py-1.5"
                      >
                        <option value="">Elegí cuenta...</option>
                        {cuentas.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.nombre} ({c.tipo})
                          </option>
                        ))}
                      </select>
                      {cuenta && (
                        <div className="text-2xs text-ink-500 mt-0.5">
                          Saldo:{' '}
                          <MoneyAmount value={cuenta.saldoActual} />
                        </div>
                      )}
                    </div>
                    <div>
                      <label className="block text-2xs font-medium text-ink-700 mb-1">
                        Método
                      </label>
                      <select
                        value={p.metodo}
                        onChange={(e) =>
                          setPagoLinea(idx, { metodo: e.target.value as PagoLinea['metodo'] })
                        }
                        className="input text-sm py-1.5"
                      >
                        {METODOS.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-2xs font-medium text-ink-700 mb-1">
                        Monto
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        value={p.monto}
                        onChange={(e) => setPagoLinea(idx, { monto: e.target.value })}
                        className="input text-sm py-1.5 font-mono"
                        placeholder="0.00"
                      />
                    </div>
                    <button
                      onClick={() => removePagoLinea(idx)}
                      disabled={pagos.length === 1}
                      className="text-pomodoro-600 hover:bg-pomodoro-100 px-3 py-1 rounded text-sm disabled:opacity-30"
                    >
                      ✕
                    </button>
                    {(p.metodo === 'TRANSFERENCIA' || p.metodo === 'CHEQUE' || p.metodo === 'DEPOSITO') && (
                      <div className="col-span-4">
                        <label className="block text-2xs font-medium text-ink-700 mb-1">
                          Nº de operación / referencia
                        </label>
                        <input
                          type="text"
                          value={p.numeroReferencia}
                          onChange={(e) =>
                            setPagoLinea(idx, { numeroReferencia: e.target.value })
                          }
                          className="input text-sm py-1.5 font-mono"
                          placeholder="ej. OP-12345"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <Button variant="secondary" size="sm" onClick={addPagoLinea}>
              + Agregar otra cuenta
            </Button>

            {/* Resumen de balance */}
            <div className="bg-surface-sunken rounded-md p-3 mt-3 grid grid-cols-2 gap-2 text-sm">
              <span className="text-ink-700">Asignado:</span>
              <MoneyAmount
                value={totalAsignado.toFixed(2)}
                className={cn(
                  'text-right font-mono',
                  Math.abs(diferencia) < 0.01 ? 'text-basil-600 font-medium' : 'text-ink-700',
                )}
              />
              <span className="text-ink-700">Diferencia:</span>
              <span
                className={cn(
                  'text-right font-mono',
                  Math.abs(diferencia) < 0.01 ? 'text-basil-600' : 'text-pomodoro-600 font-semibold',
                )}
              >
                {Math.abs(diferencia) < 0.01 ? '✓ ' : ''}
                <MoneyAmount value={diferencia.toFixed(2)} />
              </span>
            </div>
          </div>
          <footer className="px-4 py-3 border-t border-cream-300 bg-surface-sunken flex justify-between">
            <Button variant="secondary" onClick={() => setStep(1)}>
              ← Atrás
            </Button>
            <Button disabled={!step2Valido} onClick={() => setStep(4)}>
              Siguiente →
            </Button>
          </footer>
        </section>
      )}

      {/* Step 4 = confirmación (saltamos paso 3 matricial — el backend hace FIFO automático) */}
      {step === 4 && (
        <section className="card">
          <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
            <h2 className="font-display text-md text-ink-900">Confirmar pago</h2>
          </header>
          <div className="px-5 py-4 space-y-4">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <span className="text-ink-500">Proveedor:</span>
              <span className="font-medium">{data.proveedor.nombre}</span>
              <span className="text-ink-500">Total:</span>
              <MoneyAmount value={totalAPagar.toFixed(2)} className="text-md text-teresita-700 font-semibold" />
              <span className="text-ink-500">Fecha:</span>
              <span>{new Date().toLocaleDateString('es-AR')}</span>
            </div>

            {modo === 'a_cuenta' ? (
              <div className="bg-cream-100 border border-cream-300 rounded-md px-3 py-3 text-sm">
                <div className="text-2xs uppercase tracking-wider text-ink-500 mb-1">
                  Pago a cuenta corriente
                </div>
                <div className="text-ink-900">
                  No se aplica contra ninguna factura específica. Disminuye el saldo total
                  adeudado del proveedor en{' '}
                  <MoneyAmount
                    value={totalAPagar.toFixed(2)}
                    className="font-semibold text-teresita-700"
                  />
                  .
                </div>
              </div>
            ) : (
              <div>
                <h3 className="text-sm font-medium text-ink-700 mb-2">Facturas a cancelar</h3>
                <ul className="text-sm space-y-1">
                  {seleccion.map((s) => (
                    <li key={s.facturaId} className="flex justify-between">
                      <span>· {s.numero}</span>
                      <MoneyAmount value={s.montoAplicar} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <h3 className="text-sm font-medium text-ink-700 mb-2">Pagos que se generan</h3>
              <ul className="text-sm space-y-1">
                {pagos.map((p, idx) => {
                  const cuenta = cuentas.find((c) => c.id === p.cuentaId);
                  const metodo = METODOS.find((m) => m.value === p.metodo);
                  return (
                    <li key={idx} className="flex justify-between">
                      <span>
                        · {cuenta?.nombre ?? '—'} · {metodo?.label}
                        {p.numeroReferencia && ` · ${p.numeroReferencia}`}
                      </span>
                      <MoneyAmount value={p.monto} />
                    </li>
                  );
                })}
              </ul>
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1">
                Observaciones (opcional)
              </label>
              <textarea
                value={observaciones}
                onChange={(e) => setObservaciones(e.target.value)}
                className="input min-h-[60px]"
                placeholder="ej. transferencia hecha desde HB Santander..."
              />
            </div>

            <div className="bg-saffron-100 text-saffron-600 text-xs px-3 py-2 rounded">
              ⚠ Una vez confirmado, los saldos de las cuentas y facturas se actualizan en el momento.
            </div>
          </div>
          <footer className="px-4 py-3 border-t border-cream-300 bg-surface-sunken flex justify-between">
            <Button variant="secondary" onClick={() => setStep(2)}>
              ← Atrás
            </Button>
            <Button onClick={confirmar} disabled={enviando}>
              {enviando ? 'Registrando...' : '✓ Confirmar y registrar pago'}
            </Button>
          </footer>
        </section>
      )}
    </div>
  );
}

function Stepper({ step, onStep }: { step: Step; onStep: (s: Step) => void }) {
  const steps: Array<{ n: Step; label: string }> = [
    { n: 1, label: 'Facturas' },
    { n: 2, label: 'Cuentas' },
    { n: 4, label: 'Confirmar' },
  ];
  return (
    <nav className="flex items-center gap-2 text-sm">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2">
          <button
            onClick={() => step >= s.n && onStep(s.n)}
            disabled={step < s.n}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors',
              step === s.n && 'bg-teresita-700 text-cream-50',
              step > s.n && 'bg-teresita-50 text-teresita-700 hover:bg-teresita-100',
              step < s.n && 'text-ink-300 cursor-not-allowed',
            )}
          >
            <span
              className={cn(
                'w-6 h-6 rounded-full font-mono flex items-center justify-center text-xs',
                step === s.n && 'bg-cream-50 text-teresita-700',
                step > s.n && 'bg-teresita-700 text-cream-50',
                step < s.n && 'border border-cream-300',
              )}
            >
              {step > s.n ? '✓' : i + 1}
            </span>
            {s.label}
          </button>
          {i < steps.length - 1 && (
            <span className="text-ink-300 text-xs">→</span>
          )}
        </div>
      ))}
    </nav>
  );
}
