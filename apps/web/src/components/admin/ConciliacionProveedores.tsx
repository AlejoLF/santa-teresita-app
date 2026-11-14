'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { MoneyAmount } from '@/components/ui/MoneyAmount';

/**
 * Ordenar las cuentas de proveedores (14/11). Sólo aparece si hay algo que
 * hacer: facturas que ya no deben nada y siguen "pendientes", o pagos sin
 * factura que coinciden exacto con una. Todo tildado por defecto; la
 * encargada destilda lo que no corresponda y aplica.
 */

interface Plan {
  cerrar: Array<{ facturaId: string; proveedor: string; numero: string; total: string; pagado: string }>;
  imputar: Array<{ movimientoId: string; facturaId: string; proveedor: string; fechaPago: string; monto: string; factura: string; fechaFactura: string }>;
  historicos: Array<{ proveedor: string; cantidad: number; total: string }>;
}

const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

export function ConciliacionProveedores({ onAplicada }: { onAplicada: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [cerrar, setCerrar] = useState<Set<string>>(new Set());
  const [imputar, setImputar] = useState<Set<string>>(new Set());
  const [estado, setEstado] = useState<'idle' | 'aplicando' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const p = await api.get<Plan>('/admin/proveedores/conciliacion');
      setPlan(p);
      setCerrar(new Set(p.cerrar.map((c) => c.facturaId)));
      setImputar(new Set(p.imputar.map((i) => i.movimientoId)));
    } catch {
      setPlan(null);
    }
  }, []);
  useEffect(() => { void cargar(); }, [cargar]);

  if (msg && estado === 'idle') {
    return <div className="rounded-lg border border-basil-600/30 bg-basil-100 p-3 text-sm text-ink-900">✓ {msg}</div>;
  }
  if (!plan || (plan.cerrar.length === 0 && plan.imputar.length === 0)) return null;

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id); else n.add(id);
    setter(n);
  };

  async function aplicar() {
    setEstado('aplicando');
    try {
      const r = await api.post<{ cerradas: number; imputadas: number }>('/admin/proveedores/conciliacion/aplicar', { cerrar: [...cerrar], imputar: [...imputar] });
      setMsg(`Listo: ${r.cerradas} factura(s) marcadas como pagadas y ${r.imputadas} pago(s) atados a su factura.`);
      setEstado('idle');
      onAplicada();
      void cargar();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'No se pudo aplicar');
      setEstado('error');
    }
  }

  return (
    <div className="rounded-lg border border-saffron-600/30 bg-saffron-100 p-3 text-sm text-ink-900 space-y-2">
      <p>
        <strong>Hay cuentas de proveedores para ordenar.</strong>{' '}
        {plan.cerrar.length > 0 && <>{plan.cerrar.length} factura(s) ya pagadas siguen figurando pendientes. </>}
        {plan.imputar.length > 0 && <>{plan.imputar.length} pago(s) sin factura coinciden exacto con una factura del mismo proveedor. </>}
        Revisá y aplicá: nada se borra.
      </p>
      <div className="flex flex-wrap gap-2 items-center">
        <Button size="sm" disabled={estado === 'aplicando' || (cerrar.size === 0 && imputar.size === 0)} onClick={() => void aplicar()}>
          {estado === 'aplicando' ? 'Aplicando…' : `Aplicar lo tildado (${cerrar.size + imputar.size})`}
        </Button>
        <button type="button" className="text-xs underline" onClick={() => setAbierto((v) => !v)}>{abierto ? 'ocultar' : 'ver el detalle'}</button>
        {estado === 'error' && msg && <span className="text-xs text-pomodoro-600">{msg}</span>}
      </div>
      {abierto && (
        <div className="space-y-3 text-xs">
          {plan.cerrar.length > 0 && (
            <div>
              <p className="font-medium mb-1">Facturas que ya no deben nada → pasan a pagadas</p>
              <ul className="space-y-0.5">
                {plan.cerrar.map((c) => (
                  <li key={c.facturaId}>
                    <label className="flex gap-2 items-center cursor-pointer">
                      <input type="checkbox" checked={cerrar.has(c.facturaId)} onChange={() => toggle(cerrar, setCerrar, c.facturaId)} />
                      <span>{c.proveedor} · {c.numero} · total <MoneyAmount value={c.total} /> · pagado <MoneyAmount value={c.pagado} /></span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.imputar.length > 0 && (
            <div>
              <p className="font-medium mb-1">Pagos sin factura del mismo monto que una factura → se atan a esa factura y queda pagada</p>
              <ul className="space-y-0.5">
                {plan.imputar.map((i) => (
                  <li key={i.movimientoId}>
                    <label className="flex gap-2 items-center cursor-pointer">
                      <input type="checkbox" checked={imputar.has(i.movimientoId)} onChange={() => toggle(imputar, setImputar, i.movimientoId)} />
                      <span>{i.proveedor} · pago del {fecha(i.fechaPago)} por <MoneyAmount value={i.monto} /> → factura {i.factura} del {fecha(i.fechaFactura)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.historicos.length > 0 && (
            <div>
              <p className="font-medium mb-1">Pagos viejos sin factura que quedan como históricos (ya saldados, no son saldo a favor)</p>
              <ul className="space-y-0.5 text-ink-700">
                {plan.historicos.map((h) => (
                  <li key={h.proveedor}>{h.proveedor}: {h.cantidad} pago(s) por <MoneyAmount value={h.total} /></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
