'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';
import { useBusquedaPaginada, BuscadorFiltros, Paginacion } from '@/components/admin/BusquedaTabla';

/**
 * Buscador de Insumos y proveedores: facturas, notas de crédito y pagos en una
 * sola lista, con los mismos filtros que Aportes y egresos (texto, tipo,
 * estado, fecha, sesión) y export a Excel.
 *
 * Con `proveedorId` va adentro de la ficha de un proveedor y busca sólo ahí.
 * Los pagos son los MISMOS movimientos que se ven en Aportes y egresos.
 */

interface Fila {
  clase: 'FACTURA' | 'NOTA_CREDITO' | 'PAGO';
  id: string;
  fecha: string;
  proveedorId: string;
  proveedorNombre: string;
  descripcion: string;
  detalle: string | null;
  monto: string;
  saldo: string | null;
  estado: string;
  historico?: boolean;
}

const CLASES = [
  { key: '', label: 'Facturas y pagos' },
  { key: 'FACTURA', label: 'Sólo facturas' },
  { key: 'NOTA_CREDITO', label: 'Sólo notas de crédito' },
  { key: 'PAGO', label: 'Sólo pagos' },
];
const ESTADOS = [
  { key: '', label: 'Cualquier estado' },
  { key: 'PENDIENTE', label: 'Pendientes' },
  { key: 'PAGADA', label: 'Pagadas' },
  { key: 'ANULADA', label: 'Anuladas' },
];

const BADGE_CLASE: Record<Fila['clase'], { label: string; cls: string }> = {
  FACTURA: { label: 'factura', cls: 'bg-cream-200 text-ink-700' },
  NOTA_CREDITO: { label: 'nota crédito', cls: 'bg-basil-100 text-basil-600' },
  PAGO: { label: 'pago', cls: 'bg-teresita-100 text-teresita-700' },
};

function badgeEstado(f: Fila): { label: string; cls: string } | null {
  if (f.historico) return { label: 'saldado · sin factura', cls: 'bg-cream-200 text-ink-500' };
  switch (f.estado) {
    case 'PAGADA':
      return { label: 'pagada', cls: 'bg-basil-100 text-basil-600' };
    case 'PAGADA_PARCIAL':
      return { label: 'pago parcial', cls: 'bg-saffron-100 text-saffron-600' };
    case 'PENDIENTE_PAGO':
      return f.clase === 'NOTA_CREDITO'
        ? { label: 'a favor', cls: 'bg-basil-100 text-basil-600' }
        : { label: 'pendiente', cls: 'bg-pomodoro-100 text-pomodoro-600' };
    case 'PENDIENTE_VALIDACION':
      return { label: 'a validar', cls: 'bg-saffron-100 text-saffron-600' };
    case 'ANULADA':
    case 'ANULADO':
      return { label: 'anulado', cls: 'bg-cream-200 text-ink-500 line-through' };
    default:
      return null;
  }
}

export function ActividadProveedores({
  proveedorId,
  proveedorNombre,
}: {
  proveedorId?: string;
  proveedorNombre?: string;
}) {
  const [clase, setClase] = useState('');
  const [estado, setEstado] = useState('');
  const paramsExtra = useMemo(
    () => ({ clase, estado, ...(proveedorId && { proveedorId }) }),
    [clase, estado, proveedorId],
  );
  const b = useBusquedaPaginada<Fila>({
    endpoint: '/admin/proveedores/actividad',
    extraerItems: (res) => (res as { filas?: Fila[] }).filas ?? [],
    paramsExtra,
  });
  const sumas = (b.respuesta as { sumas?: { facturado: string; pagado: string } } | null)?.sumas;
  const hayFiltro = b.hayFiltro || !!clase || !!estado;

  return (
    <div className="space-y-2">
      <BuscadorFiltros
        q={b.q}
        onQ={b.setQ}
        periodo={b.periodo}
        onPeriodo={b.setPeriodo}
        desde={b.desde}
        onDesde={b.setDesde}
        hasta={b.hasta}
        onHasta={b.setHasta}
        placeholder={
          proveedorId
            ? '🔎 Buscar: nº de factura, monto, cuenta, referencia, observación…'
            : '🔎 Buscar: proveedor, nº de factura, monto, cuenta, referencia…'
        }
        total={b.meta.total}
        loading={b.loading}
        onLimpiar={() => {
          b.limpiar();
          setClase('');
          setEstado('');
        }}
        hayFiltro={hayFiltro}
        exportar={{ path: b.pathExport, nombre: 'proveedores.xlsx' }}
      >
        <select value={clase} onChange={(e) => setClase(e.target.value)} className="input w-auto">
          {CLASES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        <select value={estado} onChange={(e) => setEstado(e.target.value)} className="input w-auto">
          {ESTADOS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </BuscadorFiltros>

      {sumas && b.meta.total > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-1 text-xs text-ink-500">
          <span>
            Facturado en lo buscado: <MoneyAmount value={sumas.facturado} className="text-ink-900 font-medium" />
          </span>
          <span>
            Pagado en lo buscado: <MoneyAmount value={sumas.pagado} className="text-teresita-700 font-medium" />
          </span>
          {proveedorId && (
            <Link
              href={`/admin/movimientos?entidadId=${proveedorId}&entidadNombre=${encodeURIComponent(proveedorNombre ?? '')}`}
              className="ml-auto text-teresita-700 hover:underline"
            >
              Ver sus pagos en Aportes y egresos →
            </Link>
          )}
        </div>
      )}

      {b.error && <p className="text-pomodoro-600 text-sm">{b.error}</p>}

      <section className="card overflow-hidden">
        {b.loading && b.items.length === 0 ? (
          <p className="text-ink-500 text-sm p-4">Cargando…</p>
        ) : b.items.length === 0 ? (
          <p className="text-center text-ink-500 text-sm p-6">
            {hayFiltro ? 'Nada coincide con la búsqueda.' : 'Todavía no hay facturas ni pagos.'}
          </p>
        ) : (
          <ul className="divide-y divide-cream-200">
            {b.items.map((f) => {
              const bc = BADGE_CLASE[f.clase];
              const be = badgeEstado(f);
              const href =
                f.clase === 'PAGO'
                  ? `/admin/movimientos?entidadId=${f.proveedorId}&entidadNombre=${encodeURIComponent(f.proveedorNombre)}`
                  : `/admin/facturas/${f.id}`;
              const anulado = f.estado === 'ANULADA' || f.estado === 'ANULADO';
              return (
                <li key={`${f.clase}-${f.id}`}>
                  <Link href={href} className="flex items-start gap-3 px-4 py-2.5 hover:bg-cream-50 transition-colors">
                    <span className="text-2xs font-mono text-ink-500 w-[4.5rem] shrink-0 pt-0.5">
                      {new Date(f.fecha).toLocaleDateString('es-AR', {
                        // Las facturas guardan sólo el día (medianoche UTC).
                        ...(f.clase !== 'PAGO' && { timeZone: 'UTC' }),
                        day: '2-digit',
                        month: '2-digit',
                        year: '2-digit',
                      })}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={cn('text-2xs font-medium px-1.5 py-0.5 rounded uppercase tracking-wider', bc.cls)}>
                          {bc.label}
                        </span>
                        {!proveedorId && <span className="text-sm font-medium text-ink-900 truncate">{f.proveedorNombre}</span>}
                        <span className={cn('text-sm text-ink-700 truncate', anulado && 'line-through text-ink-500')}>
                          {f.descripcion}
                        </span>
                        {be && (
                          <span className={cn('text-2xs font-medium px-1.5 py-0.5 rounded uppercase tracking-wider', be.cls)}>
                            {be.label}
                          </span>
                        )}
                      </div>
                      {f.detalle && <div className="text-2xs text-ink-500 truncate">{f.detalle}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <MoneyAmount
                        value={f.monto}
                        className={cn(
                          'text-sm font-medium',
                          f.clase === 'PAGO' ? 'text-teresita-700' : 'text-ink-900',
                          anulado && 'line-through text-ink-500',
                        )}
                      />
                      {f.saldo != null && Number(f.saldo) > 0.01 && f.estado !== 'PAGADA' && !anulado && (
                        <div className="text-2xs text-pomodoro-600">
                          debe <MoneyAmount value={f.saldo} />
                        </div>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <Paginacion
          page={b.meta.page}
          totalPages={b.meta.totalPages}
          total={b.meta.total}
          pageSize={b.meta.pageSize}
          onPage={b.setPage}
          loading={b.loading}
        />
      </section>
    </div>
  );
}
