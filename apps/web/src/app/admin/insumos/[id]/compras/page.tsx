'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

type Periodo = 'semana' | 'mes' | 'trimestre' | 'anio' | 'todo';

interface HistoricoPunto {
  fecha: string;
  precio: string;
  cantidad: string;
  numero: string;
}

interface Compra {
  insumoId: string | null;
  nombre: string;
  categoria: string | null;
  unidad: string;
  totalCantidad: string;
  totalGastado: string;
  ocurrencias: number;
  precioMin: number;
  precioMax: number;
  precioActual: number;
  aumentoPct: number;
  historico: HistoricoPunto[];
}

interface Reporte {
  proveedor: { id: string; nombre: string };
  periodo: Periodo;
  desde: string;
  hasta: string;
  compras: Compra[];
  totalGastadoPeriodo: string;
  cantidadInsumos: number;
  cantidadFacturas: number;
}

const PERIODOS: Array<{ key: Periodo; label: string }> = [
  { key: 'semana', label: 'Última semana' },
  { key: 'mes', label: 'Último mes' },
  { key: 'trimestre', label: 'Último trimestre' },
  { key: 'anio', label: 'Último año' },
  { key: 'todo', label: 'Todo el tiempo' },
];

export default function ComprasProveedorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [periodo, setPeriodo] = useState<Periodo>('mes');
  const [data, setData] = useState<Reporte | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandida, setExpandida] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get<Reporte>(
        `/admin/proveedores/${id}/compras?periodo=${periodo}`,
      );
      setData(res);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudo cargar el reporte');
      }
    }
  }, [id, periodo]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (error) return <div className="text-pomodoro-600 p-6">{error}</div>;
  if (!data) return <div className="text-ink-500 p-6">Cargando...</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <header>
        <Link href={`/admin/insumos/${id}`} className="text-sm text-ink-500 hover:underline">
          ← Volver al proveedor
        </Link>
        <h1 className="font-display text-xl text-ink-900 mt-1">
          Compras a {data.proveedor.nombre}
        </h1>
      </header>

      {/* Filtro de período */}
      <nav className="flex flex-wrap gap-2">
        {PERIODOS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriodo(p.key)}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              periodo === p.key
                ? 'bg-teresita-700 text-cream-50'
                : 'bg-cream-200 text-ink-700 hover:bg-cream-300',
            )}
          >
            {p.label}
          </button>
        ))}
      </nav>

      {/* KPIs */}
      <section className="grid grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Total gastado</div>
          <MoneyAmount
            value={data.totalGastadoPeriodo}
            hero
            className="text-2xl text-teresita-700"
          />
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Insumos distintos</div>
          <span className="hero-number text-2xl text-ink-900">{data.cantidadInsumos}</span>
        </div>
        <div className="card p-4">
          <div className="text-2xs text-ink-500 uppercase tracking-wide">Facturas</div>
          <span className="hero-number text-2xl text-ink-900">{data.cantidadFacturas}</span>
        </div>
      </section>

      {/* Tabla de compras */}
      <section className="card overflow-hidden">
        <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
          <h2 className="font-display text-md text-ink-900">
            Productos comprados ({data.compras.length})
          </h2>
          <p className="text-xs text-ink-500">
            Ordenados por mayor aumento de precio. Click en una fila para ver el histórico.
          </p>
        </header>

        {data.compras.length === 0 ? (
          <div className="px-4 py-8 text-center text-ink-500">
            Sin compras a este proveedor en el período seleccionado.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase tracking-wider text-ink-500 border-b border-cream-200">
              <tr>
                <th className="text-left px-4 py-2">Producto</th>
                <th className="text-right px-4 py-2">Cantidad total</th>
                <th className="text-right px-4 py-2">Veces</th>
                <th className="text-right px-4 py-2">Precio min</th>
                <th className="text-right px-4 py-2">Precio actual</th>
                <th className="text-right px-4 py-2">Variación</th>
                <th className="text-right px-4 py-2">Total gastado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {data.compras.map((c) => {
                const key = c.insumoId ?? c.nombre;
                const isExpanded = expandida === key;
                const aumentoColor =
                  c.aumentoPct > 30
                    ? 'text-pomodoro-600 font-semibold'
                    : c.aumentoPct > 10
                      ? 'text-saffron-600'
                      : c.aumentoPct < -5
                        ? 'text-basil-600'
                        : 'text-ink-500';
                return (
                  <>
                    <tr
                      key={key}
                      onClick={() => setExpandida(isExpanded ? null : key)}
                      className={cn(
                        'cursor-pointer hover:bg-cream-50',
                        isExpanded && 'bg-teresita-50',
                      )}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink-900">{c.nombre}</div>
                        <div className="text-2xs text-ink-500">
                          {c.categoria ?? 'sin categoría'} · {c.unidad}
                          {!c.insumoId && (
                            <span className="ml-2 text-saffron-600">
                              ⚠ no vinculado al catálogo
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-ink-700">
                        {Number(c.totalCantidad).toFixed(c.unidad === 'KG' ? 2 : 0)}{' '}
                        <span className="text-2xs text-ink-500">{c.unidad.toLowerCase()}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-ink-500">{c.ocurrencias}</td>
                      <td className="px-4 py-3 text-right text-ink-500 font-mono">
                        <MoneyAmount value={c.precioMin.toFixed(2)} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <MoneyAmount
                          value={c.precioActual.toFixed(2)}
                          className="text-teresita-700 font-medium"
                        />
                      </td>
                      <td
                        className={cn('px-4 py-3 text-right font-mono text-sm', aumentoColor)}
                      >
                        {c.aumentoPct > 0 ? '↑' : c.aumentoPct < 0 ? '↓' : '→'}{' '}
                        {Math.abs(c.aumentoPct).toFixed(1)}%
                      </td>
                      <td className="px-4 py-3 text-right">
                        <MoneyAmount value={c.totalGastado} />
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-teresita-50">
                        <td colSpan={7} className="px-4 py-3">
                          <h4 className="text-xs font-medium text-ink-700 mb-2">
                            Histórico de compras
                          </h4>
                          <ul className="space-y-1 text-xs font-mono">
                            {c.historico.map((h, i) => {
                              const ant = c.historico[i - 1];
                              const delta =
                                ant && Number(ant.precio) > 0
                                  ? ((Number(h.precio) - Number(ant.precio)) /
                                      Number(ant.precio)) *
                                    100
                                  : 0;
                              return (
                                <li
                                  key={i}
                                  className="flex justify-between gap-2 py-1 border-b border-cream-200 last:border-0"
                                >
                                  <span className="text-ink-500 w-24">
                                    {new Date(h.fecha).toLocaleDateString('es-AR')}
                                  </span>
                                  <span className="text-ink-700 flex-1">FB {h.numero}</span>
                                  <span className="w-20 text-right">
                                    {Number(h.cantidad).toFixed(2)} {c.unidad.toLowerCase()}
                                  </span>
                                  <span className="w-24 text-right">
                                    <MoneyAmount value={h.precio} />
                                  </span>
                                  {i > 0 && (
                                    <span
                                      className={cn(
                                        'w-16 text-right',
                                        delta > 0 && 'text-pomodoro-600',
                                        delta < 0 && 'text-basil-600',
                                        delta === 0 && 'text-ink-300',
                                      )}
                                    >
                                      {delta > 0 ? '+' : ''}
                                      {delta.toFixed(1)}%
                                    </span>
                                  )}
                                  {i === 0 && (
                                    <span className="w-16 text-right text-ink-300">—</span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
