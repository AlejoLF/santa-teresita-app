'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
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
  observaciones: string | null;
  items: FacturaItem[];
  pagosFactura: PagoFactura[];
}

export default function FacturaDetallePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [factura, setFactura] = useState<FacturaDetalle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<FacturaDetalle>(`/admin/facturas/${id}`);
        setFactura(res);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) {
          setError('No se pudo cargar la factura');
        }
      }
    })();
  }, [id]);

  if (error) return <div className="text-pomodoro-600 p-6">{error}</div>;
  if (!factura) return <div className="text-ink-500 p-6">Cargando...</div>;

  const estadoBadge = {
    PENDIENTE_VALIDACION: { label: 'sin validar', cls: 'bg-saffron-100 text-saffron-600' },
    PENDIENTE_PAGO: { label: 'deuda', cls: 'bg-pomodoro-100 text-pomodoro-600' },
    PAGADA_PARCIAL: { label: 'pagada parcial', cls: 'bg-saffron-100 text-saffron-600' },
    PAGADA: { label: 'pagada', cls: 'bg-basil-100 text-basil-600' },
    ANULADA: { label: 'anulada', cls: 'bg-cream-200 text-ink-500' },
  }[factura.estado] ?? { label: factura.estado, cls: 'bg-cream-200 text-ink-500' };

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <header>
        <Link
          href={`/admin/insumos/${factura.proveedor.id}`}
          className="text-sm text-ink-500 hover:underline"
        >
          ← Volver a {factura.proveedor.nombre}
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
              {new Date(factura.fechaEmision).toLocaleDateString('es-AR')}
              {factura.fechaVencimiento &&
                ` · Vence ${new Date(factura.fechaVencimiento).toLocaleDateString('es-AR')}`}
            </p>
          </div>
          <span
            className={cn(
              'text-2xs font-medium px-2 py-0.5 rounded uppercase tracking-wider',
              estadoBadge.cls,
            )}
          >
            {estadoBadge.label}
          </span>
        </div>
      </header>

      {/* Items */}
      {factura.items.length > 0 ? (
        <section className="card overflow-hidden">
          <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
            <h2 className="font-display text-md text-ink-900">
              Productos ({factura.items.length})
            </h2>
          </header>
          <table className="w-full text-sm">
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
                    {it.insumo && (
                      <div className="text-2xs text-ink-500">
                        ↳ {it.insumo.categoria}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink-700">
                    {Number(it.cantidad).toFixed(2)} {it.unidad.toLowerCase()}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink-700">
                    <MoneyAmount value={it.precioUnitario} />
                  </td>
                  <td className="px-4 py-2 text-right text-2xs text-ink-500">
                    {Number(it.alicuotaIva).toFixed(0)}%
                  </td>
                  <td className="px-4 py-2 text-right">
                    <MoneyAmount value={it.subtotal} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <section className="card p-4 text-sm text-ink-500 italic">
          Esta factura se cargó sin desglose de items.
        </section>
      )}

      {/* Totales */}
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
          <span className="border-t border-cream-300 pt-2 font-semibold text-ink-900">
            Total:
          </span>
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

      {/* Pagos aplicados */}
      {factura.pagosFactura.length > 0 && (
        <section className="card p-5">
          <h2 className="font-display text-md text-ink-900 mb-3">Pagos aplicados</h2>
          <ul className="space-y-1 text-sm">
            {factura.pagosFactura.map((pf) => (
              <li
                key={pf.id}
                className="flex justify-between border-b border-cream-200 pb-2 last:border-0"
              >
                <div>
                  <div className="text-ink-700">
                    {pf.pago.cuenta.nombre} · {pf.pago.metodo}
                  </div>
                  <div className="text-2xs text-ink-500">
                    {new Date(pf.pago.fecha).toLocaleDateString('es-AR')}
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
    </div>
  );
}
