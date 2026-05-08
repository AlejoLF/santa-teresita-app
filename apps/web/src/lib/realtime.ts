/**
 * Cliente Supabase Realtime para notificaciones de cambios mid-flight.
 *
 * Caso de uso: Usuario A está editando una venta; mientras tanto, Usuario B
 * (otra PC, mobile, lo que sea) finaliza/edita la misma. El servidor aplica
 * LWW (last-write-wins) en la cloud DB, y Supabase Realtime nos empuja un
 * evento. La UI muestra un toast "Esta venta fue modificada — recargá".
 *
 * Filosofía:
 *   - Cliente único singleton para todo el bundle.
 *   - Subscripción por canal por venta (filter row=id).
 *   - El callback del consumer decide qué hacer (toast, recargar, etc.).
 *
 * Requiere las env vars públicas:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - NEXT_PUBLIC_SUPABASE_ANON_KEY
 *
 * Si no están, las funciones se vuelven no-ops (la app sigue andando sin
 * notificaciones — el LWW se aplica de todos modos en el servidor).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (typeof window !== 'undefined') {
      console.warn(
        '[realtime] NEXT_PUBLIC_SUPABASE_URL/ANON_KEY no configuradas — sin notificaciones cross-PC',
      );
    }
    return null;
  }
  client = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  return client;
}

export interface VentaCambioEvento {
  ventaId: string;
  /** Última vez que la fila fue tocada (commit_timestamp del WAL). */
  cuando: string;
  /** Nuevo estado (FINALIZADA/ANULADA/etc.). */
  nuevoEstado?: string;
  /** Total nuevo, si cambió. */
  total?: string;
}

/**
 * Suscribe a cambios en una venta específica. Devuelve un unsubscribe.
 *
 * Implementación: usamos `postgres_changes` con filter `id=eq.${ventaId}`.
 * Supabase devuelve UPDATE/DELETE events. INSERT no aplica (la venta ya
 * existe cuando el usuario la abre).
 *
 * IMPORTANTE: para que esto funcione, la tabla `ventas` debe estar en la
 * publicación `supabase_realtime` y tener REPLICA IDENTITY FULL (ver migración
 * `20260508_enable_realtime_ventas`).
 */
export function subscribirVenta(
  ventaId: string,
  onCambio: (e: VentaCambioEvento) => void,
): () => void {
  const c = getClient();
  if (!c) return () => {};

  const channel = c
    .channel(`venta:${ventaId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'ventas',
        filter: `id=eq.${ventaId}`,
      },
      (payload) => {
        const nueva = payload.new as Record<string, unknown>;
        onCambio({
          ventaId,
          cuando: payload.commit_timestamp ?? new Date().toISOString(),
          nuevoEstado: typeof nueva.estado === 'string' ? nueva.estado : undefined,
          total: typeof nueva.total === 'string' ? nueva.total : String(nueva.total ?? ''),
        });
      },
    )
    .subscribe();

  return () => {
    void c.removeChannel(channel);
  };
}

/**
 * Hook-friendly: suscribe a TODAS las nuevas ventas de la sesión actual.
 * El cajero / admin ven en tiempo real cuando aparece una venta nueva
 * (ej. cargada desde mobile o desde otra PC).
 */
export function subscribirVentasNuevas(
  onNueva: (ventaId: string) => void,
): () => void {
  const c = getClient();
  if (!c) return () => {};

  const channel = c
    .channel('ventas:nuevas')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'ventas' },
      (payload) => {
        const nueva = payload.new as { id?: string };
        if (nueva.id) onNueva(nueva.id);
      },
    )
    .subscribe();

  return () => {
    void c.removeChannel(channel);
  };
}
