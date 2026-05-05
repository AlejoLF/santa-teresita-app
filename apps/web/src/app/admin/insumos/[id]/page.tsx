'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import {
  InsumoAutocomplete,
  type InsumoSuggestion,
} from '@/components/admin/InsumoAutocomplete';
import { cn } from '@/lib/cn';

interface Proveedor {
  id: string;
  nombre: string;
  razonSocial: string | null;
  cuit: string | null;
  telefono: string | null;
  email: string | null;
  categoriaPrincipal: string | null;
  plazoPagoDias: number;
}

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
  estado: 'PENDIENTE_VALIDACION' | 'PENDIENTE_PAGO' | 'PAGADA_PARCIAL' | 'PAGADA' | 'ANULADA';
  observaciones: string | null;
}

interface DetalleResp {
  proveedor: Proveedor;
  facturas: Factura[];
  saldoAdeudado: string;
}

export default function DetalleProveedorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<DetalleResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get<DetalleResp>(`/admin/proveedores/${id}`);
      setData(res);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudo cargar el proveedor');
      }
    }
  }, [id]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (error) return <div className="text-pomodoro-600">{error}</div>;
  if (!data) return <div className="text-ink-500">Cargando...</div>;

  const facturasPendientes = data.facturas.filter((f) =>
    ['PENDIENTE_PAGO', 'PAGADA_PARCIAL'].includes(f.estado),
  );
  const facturasPagadas = data.facturas.filter((f) => f.estado === 'PAGADA');

  function toggleSeleccion(facturaId: string) {
    setSeleccion((s) => {
      const ns = new Set(s);
      if (ns.has(facturaId)) ns.delete(facturaId);
      else ns.add(facturaId);
      return ns;
    });
  }

  const seleccionadasIds = Array.from(seleccion);

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/insumos" className="text-sm text-ink-500 hover:underline">
            ← Volver a proveedores
          </Link>
          <h1 className="font-display text-xl text-ink-900 mt-1">{data.proveedor.nombre}</h1>
          <p className="text-sm text-ink-500">
            {data.proveedor.categoriaPrincipal ?? '—'}
            {data.proveedor.cuit && ` · CUIT ${data.proveedor.cuit}`}
            {data.proveedor.telefono && ` · ${data.proveedor.telefono}`}
          </p>
        </div>
        <div className="text-right space-y-1">
          <div>
            <div className="text-2xs text-ink-500 uppercase">Saldo adeudado</div>
            <MoneyAmount
              value={data.saldoAdeudado}
              className={cn(
                'text-xl',
                Number(data.saldoAdeudado) > 0 ? 'text-pomodoro-600' : 'text-basil-600',
              )}
            />
          </div>
          <Link
            href={`/admin/insumos/${id}/compras`}
            className="inline-block text-xs text-teresita-700 hover:underline"
          >
            📊 Ver historial de compras →
          </Link>
        </div>
      </header>

      {/* Facturas pendientes */}
      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken flex items-center justify-between">
          <h2 className="font-display text-md text-ink-900">
            Facturas pendientes ({facturasPendientes.length})
          </h2>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowForm(true)}>
              + Cargar factura
            </Button>
            <Button
              size="sm"
              disabled={seleccion.size === 0}
              onClick={() => {
                const url = `/admin/insumos/${id}/pagar?facturas=${seleccionadasIds.join(',')}`;
                window.location.href = url;
              }}
            >
              Pagar seleccionadas ({seleccion.size})
            </Button>
          </div>
        </header>
        {facturasPendientes.length === 0 ? (
          <div className="px-4 py-8 text-center text-ink-500 text-sm">
            Sin facturas pendientes con este proveedor.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-4 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={seleccion.size === facturasPendientes.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSeleccion(new Set(facturasPendientes.map((f) => f.id)));
                      } else {
                        setSeleccion(new Set());
                      }
                    }}
                  />
                </th>
                <th className="text-left px-4 py-2">Comprobante</th>
                <th className="text-left px-4 py-2">Fecha</th>
                <th className="text-left px-4 py-2">Vence</th>
                <th className="text-right px-4 py-2">Total</th>
                <th className="text-right px-4 py-2">Pagado</th>
                <th className="text-right px-4 py-2">Saldo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {facturasPendientes.map((f) => {
                const venc = f.fechaVencimiento ? new Date(f.fechaVencimiento) : null;
                const vencido = venc && venc.getTime() < Date.now();
                const checked = seleccion.has(f.id);
                return (
                  <tr
                    key={f.id}
                    className={cn(
                      'hover:bg-cream-50',
                      checked && 'bg-teresita-50',
                    )}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSeleccion(f.id)}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-ink-500">
                        {f.tipoComprobante.replace('_', ' ')}
                      </div>
                      <Link
                        href={`/admin/facturas/${f.id}`}
                        className="font-mono text-ink-700 hover:text-teresita-700 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {f.puntoVenta ? `${f.puntoVenta}-` : ''}
                        {f.numero}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-ink-700">
                      {new Date(f.fechaEmision).toLocaleDateString('es-AR')}
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
                    <td className="px-4 py-3 text-right text-ink-500">
                      <MoneyAmount value={f.totalPagado} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <MoneyAmount value={f.saldo} className="text-pomodoro-600 font-medium" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Facturas pagadas */}
      {facturasPagadas.length > 0 && (
        <section className="card overflow-hidden">
          <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
            <h2 className="font-display text-md text-ink-900">
              Pagadas ({facturasPagadas.length})
            </h2>
          </header>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-cream-200">
              {facturasPagadas.slice(0, 10).map((f) => (
                <tr key={f.id} className="opacity-70 hover:opacity-100">
                  <td className="px-4 py-2 font-mono">
                    <Link
                      href={`/admin/facturas/${f.id}`}
                      className="text-ink-700 hover:text-teresita-700 hover:underline"
                    >
                      {f.puntoVenta ? `${f.puntoVenta}-` : ''}
                      {f.numero}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-500">
                    {new Date(f.fechaEmision).toLocaleDateString('es-AR')}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <MoneyAmount value={f.total} className="text-basil-600" />
                  </td>
                  <td className="px-4 py-2 text-right text-2xs text-basil-600">✓ pagada</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {showForm && (
        <FormNuevaFactura
          proveedorId={id}
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            void fetchData();
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Form crear factura — con desglose de items + autocomplete de insumos
// ────────────────────────────────────────────────────────────────────────

interface ItemLinea {
  insumoId: string | null;
  descripcion: string;
  cantidad: string;
  unidad: string;
  precioUnitario: string;
  alicuotaIva: string; // ej '21'
}

function lineaVacia(): ItemLinea {
  return {
    insumoId: null,
    descripcion: '',
    cantidad: '1',
    unidad: 'UNIDAD',
    precioUnitario: '',
    alicuotaIva: '21',
  };
}

function subtotalLinea(l: ItemLinea): number {
  return Number(l.cantidad || 0) * Number(l.precioUnitario || 0);
}

interface PagoLineaForm {
  cuentaId: string;
  metodo: 'EFECTIVO' | 'TRANSFERENCIA' | 'DEPOSITO' | 'CHEQUE' | 'MERCADOPAGO_QR' | 'OTRO';
  monto: string;
  numeroReferencia: string;
}

interface CuentaShort {
  id: string;
  nombre: string;
  tipo: 'EFECTIVO' | 'BANCO' | 'WALLET';
  saldoActual: string;
}

const METODOS_PAGO = [
  { value: 'EFECTIVO', label: 'Efectivo' },
  { value: 'TRANSFERENCIA', label: 'Transferencia' },
  { value: 'DEPOSITO', label: 'Depósito' },
  { value: 'MERCADOPAGO_QR', label: 'MercadoPago' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'OTRO', label: 'Otro' },
] as const;

function FormNuevaFactura({
  proveedorId,
  onClose,
  onCreated,
}: {
  proveedorId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [tipoComprobante, setTipoComprobante] = useState('FACTURA_B');
  const [puntoVenta, setPuntoVenta] = useState('');
  const [numero, setNumero] = useState('');
  const [fechaEmision, setFechaEmision] = useState(new Date().toISOString().slice(0, 10));
  const [fechaVencimiento, setFechaVencimiento] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [items, setItems] = useState<ItemLinea[]>([lineaVacia()]);
  const [usarItems, setUsarItems] = useState(true);
  const [netoManual, setNetoManual] = useState('');
  const [ivaManual, setIvaManual] = useState('');
  // Pago opcional
  const [pagarAhora, setPagarAhora] = useState(false);
  const [cuentas, setCuentas] = useState<CuentaShort[]>([]);
  const [pagos, setPagos] = useState<PagoLineaForm[]>([
    { cuentaId: '', metodo: 'EFECTIVO', monto: '', numeroReferencia: '' },
  ]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cargar cuentas la primera vez que el usuario activa "Pagar ahora"
  useEffect(() => {
    if (pagarAhora && cuentas.length === 0) {
      (async () => {
        try {
          const res = await api.get<{ cuentas: CuentaShort[] }>('/admin/cuentas');
          setCuentas(res.cuentas);
        } catch {
          /* silencioso */
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagarAhora]);

  function setLinea(idx: number, patch: Partial<ItemLinea>) {
    setItems((arr) => arr.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLinea() {
    setItems((arr) => [...arr, lineaVacia()]);
  }
  function removeLinea(idx: number) {
    setItems((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }

  // Cálculos automáticos a partir de los items
  const calculados = items.reduce(
    (acc, l) => {
      const sub = subtotalLinea(l);
      const ivaPct = Number(l.alicuotaIva || 0);
      acc.neto += sub;
      acc.iva += sub * (ivaPct / 100);
      return acc;
    },
    { neto: 0, iva: 0 },
  );

  const neto = usarItems ? calculados.neto.toFixed(2) : netoManual || '0';
  const iva = usarItems ? calculados.iva.toFixed(2) : ivaManual || '0';
  const total = (Number(neto) + Number(iva)).toFixed(2);

  // Pago helpers
  function addPagoLinea() {
    setPagos((arr) => [
      ...arr,
      { cuentaId: '', metodo: 'TRANSFERENCIA', monto: '', numeroReferencia: '' },
    ]);
  }
  function removePagoLinea(idx: number) {
    setPagos((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));
  }
  function setPagoLinea(idx: number, patch: Partial<PagoLineaForm>) {
    setPagos((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function autocompletarMontoTotal() {
    setPagos((arr) =>
      arr.length === 1 && arr[0]
        ? [{ ...arr[0], monto: total }]
        : arr,
    );
  }

  const totalPagos = pagos.reduce((acc, p) => acc + Number(p.monto || 0), 0);
  const diferenciaPago = Number(total) - totalPagos;
  const pagoCompleto = pagarAhora && Math.abs(diferenciaPago) < 0.01;
  const pagoParcial = pagarAhora && totalPagos > 0 && diferenciaPago > 0.01;

  async function submit() {
    setError(null);
    if (!numero) return setError('Falta el número de factura');
    if (Number(neto) <= 0) return setError('La factura debe tener neto > 0');

    if (usarItems) {
      const incompletos = items.some(
        (l) => !l.descripcion.trim() || Number(l.cantidad) <= 0 || Number(l.precioUnitario) <= 0,
      );
      if (incompletos) {
        return setError('Hay items incompletos. Completalos o desmarcá "Cargar items detallados".');
      }
    }

    if (pagarAhora) {
      if (totalPagos <= 0) {
        return setError('Si vas a pagar ahora, asigná al menos un monto a una cuenta');
      }
      if (totalPagos > Number(total) + 0.01) {
        return setError('Los pagos asignados superan el total de la factura');
      }
      const pagoSinCuenta = pagos.some((p) => Number(p.monto) > 0 && !p.cuentaId);
      if (pagoSinCuenta) return setError('Hay un pago sin cuenta seleccionada');
    }

    setGuardando(true);
    try {
      // 1. Crear la factura
      const factura = await api.post<{ id: string }>('/admin/facturas', {
        proveedorId,
        tipoComprobante,
        puntoVenta: puntoVenta || undefined,
        numero,
        fechaEmision,
        fechaVencimiento: fechaVencimiento || undefined,
        neto,
        iva,
        total,
        observaciones: observaciones || undefined,
        items: usarItems
          ? items.map((l) => ({
              insumoId: l.insumoId,
              descripcion: l.descripcion.trim(),
              cantidad: l.cantidad,
              unidad: l.unidad,
              precioUnitario: l.precioUnitario,
              alicuotaIva: l.alicuotaIva,
              subtotal: subtotalLinea(l).toFixed(2),
            }))
          : [],
      });

      // 2. Si pagar ahora, registrar el pago multi-cuenta
      if (pagarAhora && totalPagos > 0) {
        const pagosValidos = pagos.filter((p) => Number(p.monto) > 0 && p.cuentaId);
        await api.post('/admin/pagos-multicuenta', {
          proveedorId,
          facturas: [
            {
              facturaId: factura.id,
              montoAplicar: totalPagos.toFixed(2),
            },
          ],
          pagos: pagosValidos.map((p) => ({
            cuentaId: p.cuentaId,
            metodo: p.metodo,
            monto: p.monto,
            numeroReferencia: p.numeroReferencia || undefined,
          })),
          observaciones: pagoParcial
            ? `Pago parcial al cargar la factura. Saldo pendiente.`
            : undefined,
        });
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear la factura');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-40 p-4">
      <div className="card w-full max-w-3xl shadow-modal max-h-[95vh] flex flex-col">
        <header className="px-5 py-4 border-b border-cream-300 flex justify-between items-center">
          <h2 className="font-display text-lg text-teresita-700">Nueva factura</h2>
          <button
            onClick={onClose}
            className="text-ink-500 hover:text-ink-900 text-xl leading-none"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Datos del comprobante */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Comprobante</label>
              <select
                value={tipoComprobante}
                onChange={(e) => setTipoComprobante(e.target.value)}
                className="input"
              >
                <option value="FACTURA_A">Factura A</option>
                <option value="FACTURA_B">Factura B</option>
                <option value="FACTURA_C">Factura C</option>
                <option value="TICKET">Ticket</option>
                <option value="REMITO">Remito</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Pto. venta</label>
              <input
                type="text"
                value={puntoVenta}
                onChange={(e) => setPuntoVenta(e.target.value)}
                className="input font-mono"
                placeholder="0001"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Número</label>
              <input
                type="text"
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                className="input font-mono"
                placeholder="00012345"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">Emisión</label>
              <input
                type="date"
                value={fechaEmision}
                onChange={(e) => setFechaEmision(e.target.value)}
                className="input"
              />
            </div>
          </section>

          <section className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700 mb-1">
                Vencimiento (opcional)
              </label>
              <input
                type="date"
                value={fechaVencimiento}
                onChange={(e) => setFechaVencimiento(e.target.value)}
                className="input"
              />
            </div>
          </section>

          <hr className="border-cream-300" />

          {/* Items */}
          <section>
            <header className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-display text-md text-ink-900">Productos / items</h3>
                <p className="text-xs text-ink-500">
                  Cargar el detalle permite ver evolución de precios y reportes por proveedor.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={usarItems}
                  onChange={(e) => setUsarItems(e.target.checked)}
                  className="w-4 h-4"
                />
                Cargar items detallados
              </label>
            </header>

            {usarItems ? (
              <div className="space-y-2">
                {items.map((l, idx) => (
                  <ItemRow
                    key={idx}
                    linea={l}
                    proveedorId={proveedorId}
                    onChange={(patch) => setLinea(idx, patch)}
                    onRemove={() => removeLinea(idx)}
                    canRemove={items.length > 1}
                  />
                ))}
                <button
                  type="button"
                  onClick={addLinea}
                  className="text-sm text-teresita-700 hover:underline"
                >
                  + Agregar otro item
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-700 mb-1">Neto</label>
                  <input
                    type="number"
                    step="0.01"
                    value={netoManual}
                    onChange={(e) => setNetoManual(e.target.value)}
                    className="input font-mono"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-700 mb-1">IVA 21%</label>
                  <input
                    type="number"
                    step="0.01"
                    value={ivaManual}
                    onChange={(e) => setIvaManual(e.target.value)}
                    className="input font-mono"
                    placeholder="0.00"
                  />
                </div>
              </div>
            )}
          </section>

          {/* Totales */}
          <section className="bg-surface-sunken rounded-md p-3 grid grid-cols-3 gap-3 text-sm font-mono">
            <div>
              <div className="text-2xs text-ink-500 uppercase">Neto</div>
              <MoneyAmount value={neto} />
            </div>
            <div>
              <div className="text-2xs text-ink-500 uppercase">IVA</div>
              <MoneyAmount value={iva} />
            </div>
            <div>
              <div className="text-2xs text-ink-500 uppercase">Total</div>
              <MoneyAmount value={total} className="text-md text-teresita-700 font-semibold" />
            </div>
          </section>

          <div>
            <label className="block text-xs font-medium text-ink-700 mb-1">
              Observaciones (opcional)
            </label>
            <input
              type="text"
              value={observaciones}
              onChange={(e) => setObservaciones(e.target.value)}
              className="input"
            />
          </div>

          <hr className="border-cream-300" />

          {/* Pago opcional */}
          <section>
            <header className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-display text-md text-ink-900">¿Pagar ahora?</h3>
                <p className="text-xs text-ink-500">
                  Si dejás esto desactivado, la factura queda como deuda y se paga después.
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={pagarAhora}
                  onChange={(e) => {
                    setPagarAhora(e.target.checked);
                    if (e.target.checked && pagos.length === 1 && !pagos[0]?.monto) {
                      // Pre-llenar con el total de la factura
                      setPagos((arr) =>
                        arr[0] ? [{ ...arr[0], monto: total }] : arr,
                      );
                    }
                  }}
                  className="w-4 h-4"
                />
                Pagar ahora
              </label>
            </header>

            {pagarAhora && (
              <div className="space-y-2">
                {pagos.map((p, idx) => {
                  const cuenta = cuentas.find((c) => c.id === p.cuentaId);
                  const necesitaRef = ['TRANSFERENCIA', 'CHEQUE', 'DEPOSITO'].includes(p.metodo);
                  return (
                    <div
                      key={idx}
                      className="grid grid-cols-[1fr_120px_120px_30px] gap-2 items-end bg-white border border-cream-300 rounded-md p-3"
                    >
                      <div>
                        <label className="block text-2xs font-medium text-ink-500 mb-0.5">
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
                              {c.nombre}
                            </option>
                          ))}
                        </select>
                        {cuenta && (
                          <div className="text-2xs text-ink-500 mt-0.5">
                            Saldo: <MoneyAmount value={cuenta.saldoActual} />
                          </div>
                        )}
                      </div>
                      <div>
                        <label className="block text-2xs font-medium text-ink-500 mb-0.5">
                          Método
                        </label>
                        <select
                          value={p.metodo}
                          onChange={(e) =>
                            setPagoLinea(idx, {
                              metodo: e.target.value as PagoLineaForm['metodo'],
                            })
                          }
                          className="input text-sm py-1.5"
                        >
                          {METODOS_PAGO.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-2xs font-medium text-ink-500 mb-0.5">
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
                        type="button"
                        onClick={() => removePagoLinea(idx)}
                        disabled={pagos.length === 1}
                        className="text-pomodoro-600 hover:bg-pomodoro-100 px-2 py-1 rounded disabled:opacity-30 self-center"
                      >
                        ✕
                      </button>
                      {necesitaRef && (
                        <div className="col-span-4">
                          <input
                            type="text"
                            value={p.numeroReferencia}
                            onChange={(e) =>
                              setPagoLinea(idx, { numeroReferencia: e.target.value })
                            }
                            className="input text-sm py-1.5 font-mono"
                            placeholder="Nº de operación / referencia (opcional)"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className="flex justify-between items-center pt-1">
                  <button
                    type="button"
                    onClick={addPagoLinea}
                    className="text-sm text-teresita-700 hover:underline"
                  >
                    + Agregar otra cuenta
                  </button>
                  {pagos.length === 1 && Number(pagos[0]?.monto || 0) !== Number(total) && (
                    <button
                      type="button"
                      onClick={autocompletarMontoTotal}
                      className="text-xs text-ink-500 hover:underline"
                    >
                      Cobrar el total ({total})
                    </button>
                  )}
                </div>

                {/* Resumen del pago */}
                <div
                  className={cn(
                    'rounded-md p-3 grid grid-cols-2 gap-2 text-sm',
                    pagoCompleto && 'bg-basil-100 text-basil-600',
                    pagoParcial && 'bg-saffron-100 text-saffron-600',
                    !pagoCompleto && !pagoParcial && totalPagos > 0 && 'bg-pomodoro-100 text-pomodoro-600',
                    totalPagos === 0 && 'bg-cream-200 text-ink-500',
                  )}
                >
                  <span>Asignado:</span>
                  <span className="text-right font-mono">
                    <MoneyAmount value={totalPagos.toFixed(2)} />
                  </span>
                  <span>
                    {diferenciaPago > 0
                      ? 'Queda como deuda:'
                      : diferenciaPago < 0
                        ? 'Excedente (no permitido):'
                        : 'Diferencia:'}
                  </span>
                  <span className="text-right font-mono">
                    {pagoCompleto && '✓ '}
                    <MoneyAmount value={diferenciaPago.toFixed(2)} />
                  </span>
                </div>
              </div>
            )}
          </section>

          {error && (
            <div className="bg-pomodoro-100 text-pomodoro-600 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-cream-300 bg-surface-sunken flex justify-between items-center">
          <p className="text-xs text-ink-500">
            {pagarAhora
              ? pagoCompleto
                ? 'La factura se carga y se paga al instante.'
                : pagoParcial
                  ? `Pago parcial. Quedan ${Number(diferenciaPago).toFixed(2)} como deuda.`
                  : 'Asigná los montos a las cuentas que vas a usar.'
              : 'La factura queda como DEUDA. Pagás después con una o varias cuentas.'}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              onClick={submit}
              disabled={guardando || (pagarAhora && diferenciaPago < -0.01)}
            >
              {guardando
                ? 'Guardando...'
                : pagarAhora
                  ? pagoCompleto
                    ? 'Cargar y pagar'
                    : pagoParcial
                      ? 'Cargar con pago parcial'
                      : 'Cargar y pagar'
                  : 'Cargar como deuda'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function ItemRow({
  linea,
  proveedorId,
  onChange,
  onRemove,
  canRemove,
}: {
  linea: ItemLinea;
  proveedorId: string;
  onChange: (patch: Partial<ItemLinea>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const subtotal = subtotalLinea(linea);
  return (
    <div className="grid grid-cols-[1fr_70px_70px_100px_60px_100px_30px] gap-2 items-end bg-white border border-cream-300 rounded-md p-2">
      <div>
        <label className="block text-2xs font-medium text-ink-500 mb-0.5">Producto</label>
        <InsumoAutocomplete
          value={linea.descripcion}
          onChangeText={(t) => onChange({ descripcion: t })}
          onSelect={(s: InsumoSuggestion | null) => {
            if (s) {
              onChange({
                insumoId: s.id,
                descripcion: s.nombre,
                unidad: s.unidadCompra,
                precioUnitario:
                  s.proveedoresVinculo?.[0]?.precioUltimo ?? linea.precioUnitario,
              });
            } else {
              onChange({ insumoId: null });
            }
          }}
          proveedorId={proveedorId}
          selectedInsumoId={linea.insumoId}
        />
      </div>
      <div>
        <label className="block text-2xs font-medium text-ink-500 mb-0.5">Cant.</label>
        <input
          type="number"
          step="0.001"
          value={linea.cantidad}
          onChange={(e) => onChange({ cantidad: e.target.value })}
          className="input text-sm py-1.5 font-mono"
        />
      </div>
      <div>
        <label className="block text-2xs font-medium text-ink-500 mb-0.5">Unid.</label>
        <select
          value={linea.unidad}
          onChange={(e) => onChange({ unidad: e.target.value })}
          className="input text-sm py-1.5"
        >
          <option value="UNIDAD">u</option>
          <option value="KG">kg</option>
          <option value="GRAMOS">g</option>
          <option value="LITRO">L</option>
          <option value="CAJA">caja</option>
          <option value="BOLSA">bolsa</option>
          <option value="PAQUETE">paq</option>
          <option value="DOCENA">doc</option>
          <option value="OTRO">otro</option>
        </select>
      </div>
      <div>
        <label className="block text-2xs font-medium text-ink-500 mb-0.5">Precio u.</label>
        <input
          type="number"
          step="0.0001"
          value={linea.precioUnitario}
          onChange={(e) => onChange({ precioUnitario: e.target.value })}
          className="input text-sm py-1.5 font-mono"
          placeholder="0.00"
        />
      </div>
      <div>
        <label className="block text-2xs font-medium text-ink-500 mb-0.5">IVA%</label>
        <select
          value={linea.alicuotaIva}
          onChange={(e) => onChange({ alicuotaIva: e.target.value })}
          className="input text-sm py-1.5"
        >
          <option value="0">0</option>
          <option value="10.5">10.5</option>
          <option value="21">21</option>
          <option value="27">27</option>
        </select>
      </div>
      <div className="text-right">
        <div className="text-2xs text-ink-500 mb-0.5">Subt.</div>
        <MoneyAmount value={subtotal.toFixed(2)} className="text-sm font-mono" />
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        className="text-pomodoro-600 hover:bg-pomodoro-100 rounded px-1 disabled:opacity-30 self-center"
        aria-label="Quitar item"
      >
        ✕
      </button>
    </div>
  );
}
