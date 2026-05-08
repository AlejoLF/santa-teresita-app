/**
 * Flusher en background del outbox.
 *
 * Cada FLUSH_INTERVAL_MS (default 5s) toma el siguiente evento pendiente
 * y lo reintenta contra la API local (que a su vez habla con la cloud).
 * Si publica OK lo borra; si falla, incrementa attempts + backoff.
 *
 * Diseño:
 *   - Procesa ONE evento por tick para no monopolizar el loop. Los
 *     siguientes esperan al próximo tick (5s después).
 *   - Si hay 10 eventos pendientes, se procesan en ~50s (uno por tick).
 *     Más lento que paralelo pero más resiliente: si un evento es problema-
 *     tico (ej. datos corruptos que tiran 400), no bloquea a los otros.
 *   - El backoff exponencial en outbox.ts evita martillar la API cuando
 *     un evento sigue fallando.
 *
 * Cómo se invoca:
 *   En server.ts, después de listen():
 *     startOutboxFlusher({ apiBaseUrl: `http://127.0.0.1:${port}/api/v1` });
 */

import { nextPending, deletePending, markFailed } from './outbox.js';

let timer: NodeJS.Timeout | null = null;
const FLUSH_INTERVAL_MS = 5000;

export interface FlusherConfig {
  apiBaseUrl: string;
  /** Token compartido para que el flusher se autentique sin sesión real. */
  agentToken?: string;
}

/**
 * Procesa UN evento. Returns:
 *   - 'flushed'    si publicó OK (y borró)
 *   - 'failed'     si reintentó y falló (lo dejó marcado para próximo retry)
 *   - 'idle'       si no había nada pendiente
 */
async function flushOnce(cfg: FlusherConfig): Promise<'flushed' | 'failed' | 'idle'> {
  const event = nextPending();
  if (!event) return 'idle';

  // El URL del evento puede venir relativo (`/ventas`) o absoluto (`/api/v1/ventas`).
  // Normalizamos: si arranca con `/api/v1` lo dejamos; sino, prependeamos.
  const url = event.url.startsWith('/api/v1')
    ? `${cfg.apiBaseUrl.replace(/\/api\/v1$/, '')}${event.url}`
    : `${cfg.apiBaseUrl}${event.url.startsWith('/') ? '' : '/'}${event.url}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(event.headers_json ? (JSON.parse(event.headers_json) as Record<string, string>) : {}),
  };
  // Token de agente (compartido con local-agent) — bypassa auth de sesión.
  if (cfg.agentToken) headers['X-Agent-Token'] = cfg.agentToken;

  try {
    const res = await fetch(url, {
      method: event.method,
      headers,
      body: event.body_json ?? undefined,
    });
    if (res.ok || res.status === 200 || res.status === 201 || res.status === 204) {
      deletePending(event.id);
      return 'flushed';
    }
    // 4xx (auth, validación, etc.): es un error de datos, no de red. Igual
    // marcamos failed con backoff, pero podría ser irrecuperable. Cuando llegue
    // a 20 attempts queda abandonado para revisión manual.
    markFailed(event.id, `HTTP ${res.status} ${res.statusText}`);
    return 'failed';
  } catch (e) {
    // Error de red (cloud sigue caída). Marcamos failed con backoff.
    markFailed(event.id, e instanceof Error ? e.message : String(e));
    return 'failed';
  }
}

export function startOutboxFlusher(cfg: FlusherConfig): void {
  if (timer) return; // Ya corre.
  // Tick inicial inmediato (no esperar 5s al boot si hay pendientes).
  void flushOnce(cfg).catch(() => {});
  timer = setInterval(() => {
    void flushOnce(cfg).catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

export function stopOutboxFlusher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
