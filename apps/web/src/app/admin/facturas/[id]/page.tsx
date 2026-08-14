'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { Button } from '@/components/ui/Button';
import { usePrompt } from '@/components/ui/usePrompt';
import { cn } from '@/lib/cn';

interface FacturaItem {
  id: string;
  descripcion: string;
  cantidad: string;
  unidad: string;
  precioUnitario: string;
  alicuotaIva: string;
  subtotal: string;
  insumo: { id: string; nombre: string; categoria: string } | null;
}

interface PagoFactura {
  id: string;
  montoAplicado: string;
  pago: {
    id: string;
    metodo: string;
    numeroReferencia: string | null;
    fecha: string;
    cuenta: { nombre: string };
  };
}

interface FacturaDetalle {
  id: string;
  proveedor: { id: string; nombre: string };
  tipoComprobante: string;
  puntoVenta: string | null;
  numero: string;
  fechaEmision: string;
  fechaVencimiento: string | null;
  netoGravado: string;
  iva21: string;
  total: string;
  totalPagado: string;
  saldo: string;
  estado: string;
  origen: string;
  ocrConfianza: string | null;
  observaciones: string | null;
  items: FacturaItem[];
  pagosFactura: PagoFactura[];
}

const TIPOS = ['FACTURA_A', 'FACTURA_B', 'FACTURA_C', 'FACTURA_X', 'NOTA_CREDITO', 'NOTA_DEBITO', 'TICKET', 'REMITO', 'OTRO'];

const estadoBadgeMap: Record<string, { label: string; cls: string }> = {
  PENDIENTE_VALIDACION: { label: 'sin validar', cls: 'bg-saffron-100 text-saffron-600' },
  PENDIENTE_PAGO: { label: 'deuda', cls: 'bg-pomodoro-100 text-pomodoro-600' },
  PAGADA_PARCIAL: { label: 'pagada parcial', cls: 'bg-saffron-100 text-saffron-600' },
  PAGADA: { label: 'pagada', cls: 'bg-basil-100 text-basil-600' },
  ANULADA: { label: 'anulada', cls: 'bg-cream-200 text-ink-500' },
};

export default function FacturaDetallePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { prompt, promptModal } = usePrompt();
  const [factura, setFactura] = useState<FacturaDetalle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function cargar() {
    try {
      const res = await api.get<FacturaDetalle>(`/admin/facturas/${id}`);
      setFactura(res);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) setError('No se pudo cargar la factura');
    }
  }

  if (error) return <div className="text-pomodoro-600 p-6">{error}</div>;
  if (!factura) return <div className="text-ink-500 p-6">Cargando...</div>;

  const esValidacion = factura.estado === 'PENDIENTE_VALIDACION';
  const estadoBadge = estadoBadgeMap[factura.estado] ?? { label: factura.estado, cls: 'bg-cream-200 text-ink-500' };

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {promptModal}
      <header>
        <Link href="/admin/facturas" className="text-sm text-ink-500 hover:underline">
          ← Volver a facturas
        </Link>
        <div className="flex items-baseline justify-between mt-1">
          <div>
            <h1 className="font-display text-xl text-ink-900">
              {factura.tipoComprobante.replace('_', ' ')}{' '}
              <span className="font-mono">
                {factura.puntoVenta ? `${factura.puntoVenta}-` : ''}
                {factura.numero}
              </span>
            </h1>
            <p className="text-sm text-ink-500">
              {factura.proveedor.nombre} · Emitida el{' '}
              {new Date(factura.fechaEmision).toLocaleDateString('es-AR', { timeZone: 'UTC' })}
            </p>
          </div>
          <span className={cn('text-2xs font-medium px-2 py-0.5 rounded uppercase tracking-wider', estadoBadge.cls)}>
            {estadoBadge.label}
          </span>
        </div>
      </header>

      {esValidacion ? (
        <ValidacionForm factura={factura} onDone={() => router.push('/admin/facturas')} onReload={cargar} prompt={prompt} />
      ) : (
        <ReadOnlyView factura={factura} />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Modo validación (OCR sin validar) — editable + Aceptar / Rechazar
// ────────────────────────────────────────────────────────────────────────

interface ItemEdit {
  descripcion: string;
  cantidad: string;
  unidad: string;
  precioUnitario: string;
  alicuotaIva: string;
  subtotal: string;
}

function ValidacionForm({
  factura,
  onDone,
  onReload,
  prompt,
}: {
  factura: FacturaDetalle;
  onDone: () => void;
  onReload: () => Promise<void>;
  prompt: ReturnType<typeof usePrompt>['prompt'];
}) {
  const [tipo, setTipo] = useState(factura.tipoComprobante);
  const [puntoVenta, setPuntoVenta] = useState(factura.puntoVenta ?? '');
  const [numero, setNumero] = useState(factura.numero);
  const [fechaEmision, setFechaEmision] = useState(factura.fechaEmision.slice(0, 10));
  const [fechaVto, setFechaVto] = useState(factura.fechaVencimiento?.slice(0, 10) ?? '');
  const [neto, setNeto] = useState(factura.netoGravado);
  const [iva, setIva] = useState(factura.iva21);
  const [total, setTotal] = useState(factura.total);
  const [observaciones, setObservaciones] = useState(factura.observaciones ?? '');
  const [items, setItems] = useState<ItemEdit[]>(
    factura.items.map((it) => ({
      descripcion: it.descripcion,
      cantidad: it.cantidad,
      unidad: it.unidad,
      precioUnitario: it.precioUnitario,
      alicuotaIva: it.alicuotaIva,
      subtotal: it.subtotal,
    })),
  );
  const [busy, setBusy] = useState<null | 'guardar' | 'aceptar' | 'rechazar'>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const sumaItems = items.reduce((a, it) => a + (Number(it.subtotal) || 0), 0);
  const descuadre = items.length > 0 && Math.abs(sumaItems - Number(total)) > Number(total) * 0.02;

  function setItem(idx: number, patch: Partial<ItemEdit>) {
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it;
        const next = { ...it, ...patch };
        // Auto-recalcular subtotal si cambió cantidad o precio (no si editan subtotal directo).
        if (('cantidad' in patch || 'precioUnitario' in patch) && !('subtotal' in patch)) {
          const sub = (Number(next.cantidad) || 0) * (Number(next.precioUnitario) || 0);
          next.subtotal = sub ? sub.toFixed(2) : '0';
        }
        return next;
      }),
    );
  }

  function addItem() {
    setItems((p) => [...p, { descripcion: '', cantidad: '1', unidad: 'u', precioUnitario: '0', alicuotaIva: '21', subtotal: '0' }]);
  }
  function delItem(idx: number) {
    setItems((p) => p.filter((_, i) => i !== idx));
  }

  function buildPatch() {
    const dec = (v: string) => (v === '' ? '0' : Number(v).toFixed(2));
    return {
      tipoComprobante: tipo,
      puntoVenta: puntoVenta || null,
      numero,
      fechaEmision,
      fechaVencimiento: fechaVto || null,
      neto: dec(neto),
      iva: dec(iva),
      total: dec(total),
      observaciones: observaciones || null,
      items: items
        .filter((it) => it.descripcion.trim())
        .map((it) => ({
          descripcion: it.descripcion,
          cantidad: (Number(it.cantidad) || 0).toFixed(3),
          unidad: it.unidad || 'u',
          precioUnitario: (Number(it.precioUnitario) || 0).toFixed(4),
          alicuotaIva: (Number(it.alicuotaIva) || 0).toFixed(2),
          subtotal: (Number(it.subtotal) || 0).toFixed(2),
        })),
    };
  }

  async function guardar(): Promise<boolean> {
    setMsg(null);
    try {
      await api.patch(`/admin/facturas/${factura.id}`, buildPatch());
      return true;
    } catch (e) {
      setMsg(e instanceof ApiError ? `Error al guardar: ${e.message}` : 'Error al guardar');
      return false;
    }
  }

  async function onGuardar() {
    setBusy('guardar');
    const ok = await guardar();
    if (ok) {
      setMsg('Cambios guardados ✓');
      await onReload();
    }
    setBusy(null);
  }

  async function onAceptar() {
    if (!numero.trim() || Number(total) <= 0) {
      setMsg('Falta el número o el total de la factura.');
      return;
    }
    setBusy('aceptar');
    const ok = await guardar();
    if (!ok) return setBusy(null);
    try {
      await api.post(`/admin/facturas/${factura.id}/validar`, undefined);
      onDone();
    } catch (e) {
      setMsg(e instanceof ApiError ? `Error al aceptar: ${e.message}` : 'Error al aceptar');
      setBusy(null);
    }
  }

  async function onRechazar() {
    const motivo = await prompt({
      title: 'Rechazar factura',
      message: 'Se va a anular. ¿Por qué? (opcional)',
      placeholder: 'OCR ilegible, duplicada, no es factura…',
      confirmLabel: 'Rechazar',
    });
    if (motivo === null) return;
    setBusy('rechazar');
    try {
      await api.post(`/admin/facturas/${factura.id}/anular`, { motivo: motivo || undefined });
      onDone();
    } catch (e) {
      setMsg(e instanceof ApiError ? `Error al rechazar: ${e.message}` : 'Error al rechazar');
      setBusy(null);
    }
  }

  const inputSm = 'input py-1 text-sm';

  return (
    <div className="space-y-4">
      {/* Banner OCR */}
      <div className="card p-4 bg-saffron-50 border border-saffron-200 flex items-start gap-3">
        <span className="text-xl">🧾</span>
        <div className="text-sm text-ink-700">
          <p className="font-medium text-ink-900">
            Cargada por OCR{factura.origen === 'TELEGRAM_OCR' ? ' (Telegram)' : ''} — revisá los datos antes de aceptar.
          </p>
          <p className="text-2xs text-ink-500 mt-0.5">
            {factura.ocrConfianza != null && `Confianza del lector: ${Math.round(Number(factura.ocrConfianza) * 100)}%. `}
            Corregí lo que esté mal y tocá <b>Aceptar</b>. Aceptar NO mueve plata — solo pasa la factura a “deuda” para pagarla después.
          </p>
        </div>
      </div>

      {/* Cabecera editable */}
      <section className="card p-5 space-y-3">
        <h2 className="font-display text-md text-ink-900">Datos del comprobante</h2>
        <SelectorProveedor factura={factura} onReload={onReload} />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <label className="text-2xs uppercase tracking-wider text-ink-500">
            Tipo
            <select className={inputSm} value={tipo} onChange={(e) => setTipo(e.target.value)}>
              {TIPOS.map((t) => (
                <option key={t} value={t}>
                  {t.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="text-2xs uppercase tracking-wider text-ink-500">
            Pto. venta
            <input className={inputSm} value={puntoVenta} onChange={(e) => setPuntoVenta(e.target.value)} />
          </label>
          <label className="text-2xs uppercase tracking-wider text-ink-500">
            Número
            <input className={inputSm} value={numero} onChange={(e) => setNumero(e.target.value)} />
          </label>
          <label className="text-2xs uppercase tracking-wider text-ink-500">
            Emisión
            <input type="date" className={inputSm} value={fechaEmision} onChange={(e) => setFechaEmision(e.target.value)} />
          </label>
          <label className="text-2xs uppercase tracking-wider text-ink-500">
            Vencimiento
            <input type="date" className={inputSm} value={fechaVto} onChange={(e) => setFechaVto(e.target.value)} />
          </label>
        </div>
      </section>

      {/* Items editables */}
      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken flex items-center justify-between">
          <h2 className="font-display text-md text-ink-900">Productos ({items.length})</h2>
          <Button variant="ghost" size="sm" onClick={addItem} type="button">
            + Agregar item
          </Button>
        </header>
        <div className="overflow-x-auto hidden md:block">
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-3 py-2">Descripción</th>
                <th className="text-right px-2 py-2 w-20">Cant.</th>
                <th className="text-left px-2 py-2 w-16">Un.</th>
                <th className="text-right px-2 py-2 w-24">Precio u.</th>
                <th className="text-right px-2 py-2 w-16">IVA%</th>
                <th className="text-right px-2 py-2 w-28">Subtotal</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {items.map((it, idx) => (
                <tr key={idx}>
                  <td className="px-2 py-1">
                    <input className={inputSm} value={it.descripcion} onChange={(e) => setItem(idx, { descripcion: e.target.value })} />
                  </td>
                  <td className="px-1 py-1">
                    <input className={cn(inputSm, 'text-right font-mono')} value={it.cantidad} onChange={(e) => setItem(idx, { cantidad: e.target.value })} />
                  </td>
                  <td className="px-1 py-1">
                    <input className={inputSm} value={it.unidad} onChange={(e) => setItem(idx, { unidad: e.target.value })} />
                  </td>
                  <td className="px-1 py-1">
                    <input className={cn(inputSm, 'text-right font-mono')} value={it.precioUnitario} onChange={(e) => setItem(idx, { precioUnitario: e.target.value })} />
                  </td>
                  <td className="px-1 py-1">
                    <input className={cn(inputSm, 'text-right font-mono')} value={it.alicuotaIva} onChange={(e) => setItem(idx, { alicuotaIva: e.target.value })} />
                  </td>
                  <td className="px-1 py-1">
                    <input className={cn(inputSm, 'text-right font-mono')} value={it.subtotal} onChange={(e) => setItem(idx, { subtotal: e.target.value })} />
                  </td>
                  <td className="px-1 py-1 text-center">
                    <button type="button" onClick={() => delItem(idx)} className="text-pomodoro-500 hover:text-pomodoro-700 text-lg leading-none" title="Quitar">
                      ×
                    </button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-3 text-center text-ink-500 italic text-sm">
                    Sin items. Agregá al menos uno o aceptá sin desglose.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Tarjetas editables (mobile) */}
        <div className="md:hidden divide-y divide-cream-200">
          {items.length === 0 && (
            <div className="p-4 text-center text-ink-500 italic text-sm">
              Sin items. Agregá al menos uno o aceptá sin desglose.
            </div>
          )}
          {items.map((it, idx) => (
            <div key={idx} className="p-3 space-y-2">
              <div className="flex items-start gap-2">
                <input
                  className={cn(inputSm, 'flex-1')}
                  value={it.descripcion}
                  onChange={(e) => setItem(idx, { descripcion: e.target.value })}
                  placeholder="Descripción"
                />
                <button
                  type="button"
                  onClick={() => delItem(idx)}
                  className="text-pomodoro-500 hover:text-pomodoro-700 text-lg leading-none px-1 pt-1.5"
                  title="Quitar"
                >
                  ×
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <label className="text-2xs uppercase tracking-wider text-ink-500">
                  Cant.
                  <input
                    className={cn(inputSm, 'text-right font-mono')}
                    value={it.cantidad}
                    onChange={(e) => setItem(idx, { cantidad: e.target.value })}
                  />
                </label>
                <label className="text-2xs uppercase tracking-wider text-ink-500">
                  Un.
                  <input
                    className={inputSm}
                    value={it.unidad}
                    onChange={(e) => setItem(idx, { unidad: e.target.value })}
                  />
                </label>
                <label className="text-2xs uppercase tracking-wider text-ink-500">
                  Precio u.
                  <input
                    className={cn(inputSm, 'text-right font-mono')}
                    value={it.precioUnitario}
                    onChange={(e) => setItem(idx, { precioUnitario: e.target.value })}
                  />
                </label>
                <label className="text-2xs uppercase tracking-wider text-ink-500">
                  IVA%
                  <input
                    className={cn(inputSm, 'text-right font-mono')}
                    value={it.alicuotaIva}
                    onChange={(e) => setItem(idx, { alicuotaIva: e.target.value })}
                  />
                </label>
              </div>
              <label className="block text-2xs uppercase tracking-wider text-ink-500">
                Subtotal
                <input
                  className={cn(inputSm, 'text-right font-mono')}
                  value={it.subtotal}
                  onChange={(e) => setItem(idx, { subtotal: e.target.value })}
                />
              </label>
            </div>
          ))}
        </div>
      </section>

      {/* Totales editables */}
      <section className="card p-5">
        <div className="grid grid-cols-2 gap-2 text-sm font-mono max-w-sm ml-auto items-center">
          <span className="text-ink-500">Neto gravado:</span>
          <input className={cn(inputSm, 'text-right font-mono')} value={neto} onChange={(e) => setNeto(e.target.value)} />
          <span className="text-ink-500">IVA 21%:</span>
          <input className={cn(inputSm, 'text-right font-mono')} value={iva} onChange={(e) => setIva(e.target.value)} />
          <span className="font-semibold text-ink-900 pt-1">Total:</span>
          <input className={cn(inputSm, 'text-right font-mono font-semibold text-teresita-700')} value={total} onChange={(e) => setTotal(e.target.value)} />
        </div>
        {descuadre && (
          <p className="text-2xs text-pomodoro-600 text-right mt-2">
            ⚠ Los items suman {sumaItems.toFixed(2)} pero el total dice {Number(total).toFixed(2)}. Revisá.
          </p>
        )}
      </section>

      {/* Observaciones */}
      <section className="card p-5">
        <label className="text-2xs uppercase tracking-wider text-ink-500">
          Observaciones
          <textarea className="input text-sm" rows={2} value={observaciones} onChange={(e) => setObservaciones(e.target.value)} />
        </label>
      </section>

      {msg && <p className={cn('text-sm', msg.startsWith('Error') || msg.startsWith('Falta') ? 'text-pomodoro-600' : 'text-basil-600')}>{msg}</p>}

      {/* Acciones */}
      <div className="flex items-center justify-between gap-3 sticky bottom-0 bg-cream-50/80 backdrop-blur py-3">
        <Button variant="destructive" onClick={onRechazar} disabled={busy !== null} type="button">
          {busy === 'rechazar' ? 'Rechazando…' : 'Rechazar'}
        </Button>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onGuardar} disabled={busy !== null} type="button">
            {busy === 'guardar' ? 'Guardando…' : 'Guardar borrador'}
          </Button>
          <Button variant="primary" onClick={onAceptar} disabled={busy !== null} type="button">
            {busy === 'aceptar' ? 'Aceptando…' : 'Aceptar factura'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Proveedor de la factura — con memoria
// ────────────────────────────────────────────────────────────────────────

/**
 * El nombre impreso en la factura casi nunca es el que usamos en el sistema
 * ("GRAFIPACK SAN MARTIN S.R.L." contra "Grafipack"). Acá se corrige, y si se
 * deja tildado "Recordar", la próxima factura con ese mismo nombre impreso
 * entra derecho al proveedor correcto sin que nadie toque nada.
 */
function SelectorProveedor({
  factura,
  onReload,
}: {
  factura: FacturaDetalle;
  onReload: () => Promise<void>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [proveedores, setProveedores] = useState<Array<{ id: string; nombre: string }>>([]);
  const [elegido, setElegido] = useState('');
  const [recordar, setRecordar] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!abierto || proveedores.length) return;
    void (async () => {
      try {
        const res = await api.get<{ proveedores: Array<{ id: string; nombre: string }> }>(
          '/admin/proveedores',
        );
        setProveedores(res.proveedores ?? []);
      } catch {
        setMsg('No pude traer la lista de proveedores.');
      }
    })();
  }, [abierto, proveedores.length]);

  async function guardar() {
    if (!elegido) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.patch<{ aliasGuardado: string | null; aliasConflicto: string | null }>(
        `/admin/facturas/${factura.id}/proveedor`,
        { proveedorId: elegido, guardarAlias: recordar },
      );
      if (r.aliasConflicto) {
        // No se pisa en silencio: redirigir facturas futuras sin avisar es
        // peor que no recordar nada.
        setMsg(
          `Cambié el proveedor, pero NO guardé el vínculo: "${r.aliasConflicto}" ya está` +
            ' asociado a otro proveedor. Corregilo desde la ficha del proveedor.',
        );
      } else {
        setAbierto(false);
      }
      await onReload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'No pude cambiar el proveedor.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-sm text-ink-500">
      <div className="flex items-center gap-2 flex-wrap">
        <span>
          Proveedor: <span className="text-ink-900 font-medium">{factura.proveedor.nombre}</span>
        </span>
        <button
          type="button"
          onClick={() => setAbierto((v) => !v)}
          className="text-2xs text-teresita-700 hover:underline"
        >
          {abierto ? 'cancelar' : 'no es este'}
        </button>
      </div>

      {abierto && (
        <div className="mt-2 bg-surface-sunken rounded-md p-3 space-y-2">
          <p className="text-2xs text-ink-500">
            Elegí el proveedor que ya tenés cargado. El nombre que trajo la factura fue{' '}
            <span className="font-medium text-ink-700">{factura.proveedor.nombre}</span>.
          </p>
          <select
            value={elegido}
            onChange={(e) => setElegido(e.target.value)}
            className="input text-sm py-1.5 w-full"
          >
            <option value="">— elegir proveedor —</option>
            {proveedores
              .filter((p) => p.id !== factura.proveedor.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
          </select>
          <label className="flex items-start gap-2 cursor-pointer text-2xs text-ink-700">
            <input
              type="checkbox"
              checked={recordar}
              onChange={(e) => setRecordar(e.target.checked)}
              className="w-3.5 h-3.5 mt-0.5"
            />
            <span>
              Recordar para la próxima
              <span className="block text-ink-500">
                Las facturas que vengan con el nombre{' '}
                <span className="font-medium">{factura.proveedor.nombre}</span> van a ir solas a
                este proveedor. Se puede cambiar después.
              </span>
            </span>
          </label>
          {msg && <p className="text-2xs text-pomodoro-600">{msg}</p>}
          <Button size="sm" onClick={guardar} disabled={busy || !elegido}>
            {busy ? 'Guardando...' : 'Cambiar proveedor'}
          </Button>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
//   Vista read-only (estados ya validados)
// ────────────────────────────────────────────────────────────────────────

function ReadOnlyView({ factura }: { factura: FacturaDetalle }) {
  return (
    <>
      {factura.items.length > 0 ? (
        <section className="card overflow-hidden">
          <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
            <h2 className="font-display text-md text-ink-900">Productos ({factura.items.length})</h2>
          </header>
          <table className="w-full text-sm hidden md:table">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-4 py-2">Producto</th>
                <th className="text-right px-4 py-2">Cantidad</th>
                <th className="text-right px-4 py-2">Precio u.</th>
                <th className="text-right px-4 py-2">IVA%</th>
                <th className="text-right px-4 py-2">Subtotal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {factura.items.map((it) => (
                <tr key={it.id}>
                  <td className="px-4 py-2">
                    <div className="text-ink-900">{it.descripcion}</div>
                    {it.insumo && <div className="text-2xs text-ink-500">↳ {it.insumo.categoria}</div>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink-700">
                    {Number(it.cantidad).toFixed(2)} {it.unidad.toLowerCase()}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink-700">
                    <MoneyAmount value={it.precioUnitario} />
                  </td>
                  <td className="px-4 py-2 text-right text-2xs text-ink-500">{Number(it.alicuotaIva).toFixed(0)}%</td>
                  <td className="px-4 py-2 text-right">
                    <MoneyAmount value={it.subtotal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Tarjetas (mobile) */}
          <div className="md:hidden divide-y divide-cream-200">
            {factura.items.map((it) => (
              <div key={it.id} className="p-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-ink-900 truncate">{it.descripcion}</div>
                  <div className="text-2xs font-mono text-ink-500 truncate">
                    {Number(it.cantidad).toFixed(2)} {it.unidad.toLowerCase()} ×{' '}
                    <MoneyAmount value={it.precioUnitario} /> · IVA{' '}
                    {Number(it.alicuotaIva).toFixed(0)}%
                    {it.insumo && ` · ↳ ${it.insumo.categoria}`}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <MoneyAmount value={it.subtotal} className="text-md" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="card p-4 text-sm text-ink-500 italic">Esta factura se cargó sin desglose de items.</section>
      )}

      <section className="card p-5">
        <div className="grid grid-cols-2 gap-2 text-sm font-mono max-w-sm ml-auto">
          <span className="text-ink-500">Neto gravado:</span>
          <span className="text-right">
            <MoneyAmount value={factura.netoGravado} />
          </span>
          <span className="text-ink-500">IVA 21%:</span>
          <span className="text-right">
            <MoneyAmount value={factura.iva21} />
          </span>
          <span className="border-t border-cream-300 pt-2 font-semibold text-ink-900">Total:</span>
          <span className="border-t border-cream-300 pt-2 text-right font-semibold">
            <MoneyAmount value={factura.total} className="text-md text-teresita-700" />
          </span>
          {Number(factura.totalPagado) > 0 && (
            <>
              <span className="text-ink-500">Pagado:</span>
              <span className="text-right text-basil-600">
                <MoneyAmount value={factura.totalPagado} />
              </span>
              <span className="font-medium text-pomodoro-600">Saldo:</span>
              <span className="text-right font-medium text-pomodoro-600">
                <MoneyAmount value={factura.saldo} />
              </span>
            </>
          )}
        </div>
      </section>

      {factura.pagosFactura.length > 0 && (
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Pagos aplicados</h2>
          <ul className="space-y-1 text-sm">
            {factura.pagosFactura.map((pf) => (
              <li key={pf.id} className="flex justify-between border-b border-cream-200 pb-2 last:border-0">
                <div>
                  <div className="text-ink-700">
                    {pf.pago.cuenta.nombre} · {pf.pago.metodo}
                  </div>
                  <div className="text-2xs text-ink-500">
                    {new Date(pf.pago.fecha).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}
                    {pf.pago.numeroReferencia && ` · ref. ${pf.pago.numeroReferencia}`}
                  </div>
                </div>
                <MoneyAmount value={pf.montoAplicado} className="text-basil-600 font-medium" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {factura.observaciones && (
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-2">Observaciones</h2>
          <p className="text-sm text-ink-700 italic">{factura.observaciones}</p>
        </section>
      )}
    </>
  );
}
