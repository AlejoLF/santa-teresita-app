'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { cn } from '@/lib/cn';

interface PedidoAbierto {
  id: string;
  numero: number;
  numeroOrdenTurno: number;
  canal: string;
  estado: string;
  total: string;
  fechaApertura: string;
  pcOrigen?: string;
}

interface PedidoDetalle extends PedidoAbierto {
  items: Array<{ id: string; nombreSnapshot: string; cantidad: string; unidad: string }>;
  tieneCocina: boolean;
}

interface AbiertasResp {
  ventas: PedidoDetalle[];
}

// Antes: 8000ms. Ahora 15s — alivia carga sobre Supabase + el cache
// cliente del prefetch hace que la primera carga sea instantánea. Si la
// vendedora necesita ver un pedido más rápido, refresca con F5.
const POLL_MS = 15000;

function horaCorta(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function summaryItems(items: PedidoDetalle['items']): string {
  if (items.length === 0) return 'Sin items';
  const primero = items[0];
  if (!primero) return 'Sin items';
  const cantStr =
    primero.unidad === 'GRAMO'
      ? `${Number(primero.cantidad).toFixed(0)}g`
      : primero.unidad === 'PLANCHA'
        ? `${primero.cantidad}pl`
        : `${Number(primero.cantidad).toFixed(0)}u`;
  const base = `${cantStr} ${primero.nombreSnapshot}`;
  if (items.length === 1) return base;
  return `${base} +${items.length - 1} más`;
}

function tiempoTranscurrido(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

function urgencia(iso: string): 'fresh' | 'medio' | 'viejo' {
  const min = (Date.now() - new Date(iso).getTime()) / 60000;
  if (min < 10) return 'fresh';
  if (min < 25) return 'medio';
  return 'viejo';
}

export function PedidosAbiertosList({ className }: { className?: string }) {
  const [pedidos, setPedidos] = useState<PedidoDetalle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPedidos = useCallback(async () => {
    try {
      const res = await api.get<AbiertasResp>('/ventas/abiertas');
      setPedidos(res.ventas);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError('Sesión expirada');
        return;
      }
      setError('No se pudieron cargar los pedidos abiertos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPedidos();
    const id = setInterval(fetchPedidos, POLL_MS);
    return () => clearInterval(id);
  }, [fetchPedidos]);

  const total = pedidos.length;

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <header className="px-4 py-3 border-b border-cream-300 bg-surface-sunken">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-md text-teresita-700">PEDIDOS ABIERTOS</h2>
          <span
            className={cn(
              'text-xs font-mono px-2 py-0.5 rounded-full',
              total === 0
                ? 'bg-cream-200 text-ink-500'
                : total > 5
                  ? 'bg-saffron-100 text-saffron-600'
                  : 'bg-teresita-50 text-teresita-700',
            )}
          >
            {total}
          </span>
        </div>
        <p className="text-xs text-ink-500 mt-0.5">Cargá un producto para empezar un pedido nuevo</p>
      </header>

      <div className="flex-1 overflow-y-auto">
        {loading && pedidos.length === 0 && (
          <p className="px-4 py-8 text-center text-ink-300 text-sm">Cargando...</p>
        )}
        {!loading && pedidos.length === 0 && !error && (
          <div className="px-4 py-12 text-center">
            <div className="text-3xl mb-2">✨</div>
            <p className="text-sm text-ink-500">Sin pedidos abiertos</p>
            <p className="text-xs text-ink-300 mt-1">
              Cuando envíes un pedido, va a aparecer acá hasta que lo cobres
            </p>
          </div>
        )}
        {pedidos.map((p) => {
          const u = urgencia(p.fechaApertura);
          return (
            <div
              key={p.id}
              className="px-4 py-3 border-b border-cream-200 hover:bg-cream-100 transition-colors"
            >
              <Link href={`/venta/${p.id}`} className="block">
                <div className="flex items-baseline justify-between mb-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-md text-ink-900 font-semibold">
                      #{String(p.numeroOrdenTurno).padStart(3, '0')}
                    </span>
                    <span className="font-mono text-xs text-ink-500">
                      {horaCorta(p.fechaApertura)}
                    </span>
                    {p.tieneCocina && (
                      <span className="text-2xs text-saffron-600" title="Tiene items en cocina">
                        🍳
                      </span>
                    )}
                  </div>
                  <MoneyAmount value={p.total} className="text-md text-teresita-700" />
                </div>
                <div className="text-xs text-ink-700 line-clamp-1 mb-1">
                  {summaryItems(p.items)}
                </div>
                <div className="flex items-center justify-between text-2xs">
                  <span className="text-ink-500">
                    {p.canal.replace('_', ' ')}
                    {p.pcOrigen && ` · ${p.pcOrigen}`}
                  </span>
                  <span
                    className={cn(
                      'font-mono',
                      u === 'fresh' && 'text-basil-600',
                      u === 'medio' && 'text-saffron-600',
                      u === 'viejo' && 'text-pomodoro-600 font-semibold',
                    )}
                  >
                    {u === 'viejo' && '⚠ '}
                    hace {tiempoTranscurrido(p.fechaApertura)}
                  </span>
                </div>
              </Link>
              <div className="flex gap-2 mt-2">
                <Link
                  href={`/venta/${p.id}`}
                  className="flex-1 text-center text-xs py-1.5 rounded bg-cream-200 text-ink-700 hover:bg-cream-300 font-medium"
                >
                  Ver pedido
                </Link>
                <Link
                  href={`/venta/${p.id}?cobrar=1`}
                  className="flex-1 text-center text-xs py-1.5 rounded bg-teresita-700 text-cream-50 hover:bg-teresita-900 font-medium"
                >
                  Cobrar →
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="px-3 py-2 bg-pomodoro-100 text-pomodoro-600 text-xs">{error}</div>
      )}

      <footer className="border-t border-cream-300 px-4 py-2 text-xs text-ink-500 text-center bg-surface-sunken">
        actualiza cada 15 segundos
      </footer>
    </div>
  );
}
