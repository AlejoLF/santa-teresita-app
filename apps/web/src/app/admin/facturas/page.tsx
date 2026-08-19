'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';
import {
  useBusquedaPaginada,
  BuscadorFiltros,
  Paginacion,
} from '@/components/admin/BusquedaTabla';

interface FacturaRow {
  id: string;
  numero: string;
  puntoVenta: string | null;
  tipoComprobante: string;
  total: string;
  estado: string;
  origen: string;
  ocrConfianza: string | null;
  fechaEmision: string;
  creadoAt: string;
  proveedor: { id: string; nombre: string };
  itemsCount: number;
}

const FILTROS: { key: string; label: string }[] = [
  { key: 'PENDIENTE_VALIDACION', label: 'Sin validar' },
  { key: 'PENDIENTE_PAGO', label: 'Con deuda' },
  { key: 'PAGADA', label: 'Pagadas' },
  { key: '', label: 'Todas' },
];

const estadoBadgeMap: Record<string, { label: string; cls: string }> = {
  PENDIENTE_VALIDACION: { label: 'sin validar', cls: 'bg-saffron-100 text-saffron-600' },
  PENDIENTE_PAGO: { label: 'deuda', cls: 'bg-pomodoro-100 text-pomodoro-600' },
  PAGADA_PARCIAL: { label: 'pagada parcial', cls: 'bg-saffron-100 text-saffron-600' },
  PAGADA: { label: 'pagada', cls: 'bg-basil-100 text-basil-600' },
  ANULADA: { label: 'anulada', cls: 'bg-cream-200 text-ink-500' },
};

export default function FacturasInboxPage() {
  const [filtro, setFiltro] = useState('PENDIENTE_VALIDACION');

  // Objeto estable: si se recreara en cada render, el hook refetchearía en loop.
  const paramsExtra = useMemo(() => ({ estado: filtro }), [filtro]);

  const b = useBusquedaPaginada<FacturaRow>({
    endpoint: '/admin/facturas',
    extraerItems: (res) => (res as { facturas?: FacturaRow[] }).facturas ?? [],
    paramsExtra,
  });

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <header>
        <h1 className="font-display text-xl text-ink-900">Facturas recibidas</h1>
        <p className="text-sm text-ink-500">Compras a proveedores. Las cargadas por OCR esperan tu validación.</p>
      </header>

      <BuscadorFiltros
        q={b.q}
        onQ={b.setQ}
        periodo={b.periodo}
        onPeriodo={b.setPeriodo}
        desde={b.desde}
        onDesde={b.setDesde}
        hasta={b.hasta}
        onHasta={b.setHasta}
        placeholder="🔎 Buscar: nº de factura, punto de venta, proveedor, total…"
        total={b.meta.total}
        loading={b.loading}
        onLimpiar={b.limpiar}
        hayFiltro={b.hayFiltro}
        exportar={{ path: b.pathExport, nombre: 'facturas.xlsx' }}
      >
        <select
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          className="input w-auto"
        >
          {FILTROS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </BuscadorFiltros>

      {b.error && <p className="text-pomodoro-600 text-sm">{b.error}</p>}

      {b.loading && b.items.length === 0 ? (
        <p className="text-ink-500 text-sm p-4">Cargando…</p>
      ) : b.items.length === 0 ? (
        <div className="card p-8 text-center text-ink-500">
          {b.hayFiltro
            ? 'Ninguna factura coincide con la búsqueda.'
            : filtro === 'PENDIENTE_VALIDACION'
              ? '✅ No hay facturas pendientes de validar.'
              : 'No hay facturas en este estado.'}
        </div>
      ) : (
        <section className="card overflow-hidden">
          <ul className="divide-y divide-cream-200">
            {b.items.map((f) => {
              const badge = estadoBadgeMap[f.estado] ?? { label: f.estado, cls: 'bg-cream-200 text-ink-500' };
              const esOcr = f.origen === 'TELEGRAM_OCR' || f.origen === 'PROGRAMA_FOTO';
              return (
                <li key={f.id}>
                  <Link href={`/admin/facturas/${f.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-cream-50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-ink-900 font-medium truncate">{f.proveedor.nombre}</span>
                        {esOcr && <span className="text-2xs" title="Cargada por OCR">🧾</span>}
                        <span className={cn('text-2xs font-medium px-1.5 py-0.5 rounded uppercase tracking-wider', badge.cls)}>{badge.label}</span>
                      </div>
                      <div className="text-2xs text-ink-500 font-mono">
                        {f.tipoComprobante.replace('_', ' ')} {f.puntoVenta ? `${f.puntoVenta}-` : ''}
                        {f.numero} · {new Date(f.fechaEmision).toLocaleDateString('es-AR', { timeZone: 'UTC' })} · {f.itemsCount} item{f.itemsCount === 1 ? '' : 's'}
                        {f.ocrConfianza != null && ` · OCR ${Math.round(Number(f.ocrConfianza) * 100)}%`}
                      </div>
                    </div>
                    <MoneyAmount value={f.total} className="text-md text-ink-900 font-medium shrink-0" />
                    <span className="text-ink-300">›</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <Paginacion
            page={b.meta.page}
            totalPages={b.meta.totalPages}
            total={b.meta.total}
            pageSize={b.meta.pageSize}
            onPage={b.setPage}
            loading={b.loading}
          />
        </section>
      )}
    </div>
  );
}
