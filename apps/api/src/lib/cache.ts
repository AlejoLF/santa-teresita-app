/**
 * Cache in-memory simple con TTL para reducir round-trips a Supabase.
 *
 * Caso de uso: el catálogo (categorías, productos, listas de precios) cambia
 * pocas veces por día pero se lee cientos de veces. En cloud-first, sin
 * cache, cada request va de La Plata → São Paulo → vuelta. Con cache de
 * 60s, ~95% de los hits se sirven de RAM.
 *
 * Tradeoffs:
 *   - In-memory: si reiniciás la PC pierde el cache (no problema, repuebla
 *     en el primer hit). Si querés persistencia, usar SQLite local.
 *   - TTL: cambio en cloud (ej. la encargada actualiza un precio) se ve a
 *     lo sumo 60s después. Para lograr push instantáneo habría que sumar
 *     Supabase Realtime a `productos`/`precios_por_lista` (defer al alpha
 *     siguiente).
 *   - Por-PC: cada API local tiene su cache aislado. No hay deduplicación
 *     entre PCs — pero el costo es bajo (cada PC hace 1 req/min en lugar
 *     de 100/min).
 *
 * Uso:
 *   const data = await getCached('catalogo:productos:all', 60_000, async () => {
 *     return await prisma.producto.findMany({ ... });
 *   });
 *   invalidate('catalogo:'); // borrar todo lo que matchee el prefijo
 */

interface Entry<T = unknown> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export async function getCached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }
  const value = await fetcher();
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/**
 * Borra entradas cuyo key empieza con `prefix`. Llamar después de cualquier
 * mutación que invalide el cache (ej. admin actualiza un producto →
 * invalidate('catalogo:')).
 */
export function invalidate(prefix: string): number {
  let n = 0;
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) {
      store.delete(k);
      n++;
    }
  }
  return n;
}

/** Stats para debugging (lo expone el endpoint /admin/cache/stats si quisiéramos). */
export function cacheStats(): { keys: number; entries: Array<{ key: string; ageMs: number; ttlRemaining: number }> } {
  const now = Date.now();
  const entries: Array<{ key: string; ageMs: number; ttlRemaining: number }> = [];
  for (const [k, v] of store.entries()) {
    entries.push({
      key: k,
      ageMs: 0, // no trackeamos creadoAt para keepit simple
      ttlRemaining: Math.max(0, v.expiresAt - now),
    });
  }
  return { keys: store.size, entries };
}

/** Solo para tests. */
export function _resetCache(): void {
  store.clear();
}
