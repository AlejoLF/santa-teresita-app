/**
 * Cliente HTTP para la API.
 *
 * BASE_URL:
 *   - Modo dev / desktop bundleado: `/api/v1` (relativo, proxied por Next).
 *   - Modo Vercel + API local cross-origin: `${NEXT_PUBLIC_API_URL}/api/v1`
 *     donde NEXT_PUBLIC_API_URL=http://127.0.0.1:3001. El browser hace
 *     fetch directo al API local de cada PC. El API responde con CORS
 *     allowlist + el web manda token en Authorization header (no usa
 *     cookies por restricciones SameSite/Secure cross-origin).
 *
 * Auth:
 *   - Si hay token en localStorage (tras login exitoso), se manda como
 *     `Authorization: Bearer <token>`.
 *   - Si no hay token, se envía igual con `credentials: 'include'` para
 *     que la cookie funcione (mismo-origen / dev).
 *   - 401 → limpia el token (sesión expirada).
 *
 * En modo demo (NEXT_PUBLIC_DEMO_MODE=true) cortocircuitamos a un router
 * mock en memoria — no hay backend.
 */

// El módulo demo SOLO se carga cuando NEXT_PUBLIC_DEMO_MODE='true'.

const RAW_API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const BASE_URL = RAW_API_URL ? `${RAW_API_URL.replace(/\/$/, '')}/api/v1` : '/api/v1';
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

const TOKEN_KEY = 'sta_auth_token';

export function setAuthToken(token: string): void {
  try {
    if (typeof window !== 'undefined') {
      // Limpiar cache cliente al cambiar de sesión: si el usuario anterior
      // era VENDEDOR y este es ADMIN (o viceversa), el /auth/me cacheado
      // tiene datos del usuario viejo y los layouts redirigen mal.
      // Igual con /catalogo/cuentas etc — pueden depender del rol.
      memCache.clear();
      window.localStorage.setItem(TOKEN_KEY, token);
    }
  } catch {
    /* localStorage bloqueado (modo privado) — la cookie hace fallback */
  }
}

export function getAuthToken(): string | null {
  try {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem(TOKEN_KEY);
    }
  } catch {
    /* idem */
  }
  return null;
}

export function clearAuthToken(): void {
  try {
    if (typeof window !== 'undefined') {
      // Idem setAuthToken: al cerrar sesión limpiamos el cache para que el
      // próximo login no vea datos del usuario anterior.
      memCache.clear();
      window.localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* idem */
  }
}

let demoModulePromise:
  | Promise<typeof import('./demo/mocks')>
  | null = null;

function getDemoModule() {
  if (!demoModulePromise) demoModulePromise = import('./demo/mocks');
  return demoModulePromise;
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (DEMO_MODE) {
    const { handleMock, buildCierrePayloadFromDemo } = await getDemoModule();
    // Caso especial: cerrar caja → además del mock, dispara email real
    if (path === '/admin/caja/sesion-actual/cerrar' && method === 'POST') {
      const b = (body ?? {}) as { existenciaFinal?: string; observaciones?: string };
      const payload = buildCierrePayloadFromDemo({
        contado: b.existenciaFinal,
        observaciones: b.observaciones,
      });
      try {
        const emailRes = await fetch('/api/cierre', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const emailBody = await emailRes.json().catch(() => ({}));
        if (!emailRes.ok) {
          throw new ApiError(
            emailRes.status,
            (emailBody as { error?: string })?.error ?? 'No se pudo enviar el email del cierre',
            emailBody,
          );
        }
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(0, e instanceof Error ? e.message : 'Error de red enviando el cierre', undefined);
      }
      // Y procesamos el mock (que solo devuelve ok)
      handleMock(method, path, body);
      return undefined as T;
    }

    const res = handleMock(method, path, body);
    if (res.status >= 400) {
      throw new ApiError(res.status, (res.body as { error?: string })?.error ?? `HTTP ${res.status}`, res.body);
    }
    return res.body as T;
  }

  const isWrite = method !== 'GET';
  const token = getAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Error de red (cloud caída, internet flaky, etc.). Para writes, auto-
    // encolamos en el outbox local — el flusher en background los va a
    // reintentar cuando la cloud vuelva. Para reads, propagamos el error
    // (los reads no se pueden "encolar", el usuario tiene que reintentar).
    if (isWrite) {
      try {
        await fetch(`${BASE_URL}/sync/queue`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ method, url: path, body }),
        });
        // Devolvemos un objeto especial que el caller puede detectar para
        // mostrar UX optimista ("guardado, sincronizando...").
        throw new ApiError(
          202,
          'Sin conexión — guardado localmente, se va a sincronizar cuando vuelva',
          { queued: true },
        );
      } catch (queueErr) {
        if (queueErr instanceof ApiError) throw queueErr;
        // Si NI la API local responde (catastrófico — la API local crasheó),
        // tiramos el error original.
        throw new ApiError(
          0,
          e instanceof Error ? e.message : 'Error de red',
          undefined,
        );
      }
    }
    throw new ApiError(0, e instanceof Error ? e.message : 'Error de red', undefined);
  }
  if (!res.ok) {
    if (res.status === 401) {
      // Sesión expirada/invalidada — limpiamos el token de localStorage
      // para que el próximo render redirija a /login. El layout de cada
      // sección hace el redirect cuando /auth/me devuelve 401.
      clearAuthToken();
    }
    const errBody = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (errBody as { error?: string })?.error ?? `HTTP ${res.status}`, errBody);
  }
  // Logout exitoso → limpiamos el token (la cookie ya la limpia el server)
  if (path === '/auth/logout' && method === 'POST') {
    clearAuthToken();
  }
  // Si fue un write a admin que afecta catálogo, invalidamos el cache
  // cliente para que el usuario vea su cambio al instante (sin esperar TTL).
  // El cache del API server ya se invalida vía hook onResponse.
  if (
    isWrite &&
    /\/admin\/(productos|categorias|tipos-producto|precios|listas-precios|grupos-modificador|opciones-modificador|cuentas)\b/.test(
      path,
    )
  ) {
    for (const k of memCache.keys()) {
      if (k.startsWith('/catalogo')) memCache.delete(k);
    }
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Cliente-side cache para reads frecuentes ──────────────────────────
//
// Por qué: en cross-origin (Vercel ↔ API local en La Plata o donde sea),
// cada request tiene latencia inevitable. Si el catálogo no cambió hace
// 1 minuto, no tiene sentido pegarle a Supabase otra vez. El cache vive
// en RAM del browser (igual que el del API process en alpha.8) y se
// limpia al cerrar la pestaña.
//
// Diferencia con el cache del API: este es por-tab. Múltiples requests
// simultáneos del mismo path se deduplican (returning la misma promise).

interface CachedEntry {
  data: unknown;
  expiresAt: number;
  /** Promise inflight si la primera request todavía no terminó — para deduplicar. */
  inflight?: Promise<unknown>;
}

const memCache = new Map<string, CachedEntry>();

async function getCached<T>(path: string, ttlMs: number): Promise<T> {
  const now = Date.now();
  const hit = memCache.get(path);
  if (hit) {
    if (hit.expiresAt > now) return hit.data as T;
    if (hit.inflight) return hit.inflight as Promise<T>;
  }
  const promise = request<T>('GET', path);
  memCache.set(path, { data: undefined, expiresAt: 0, inflight: promise });
  try {
    const data = await promise;
    memCache.set(path, { data, expiresAt: now + ttlMs });
    return data;
  } catch (e) {
    memCache.delete(path); // no cacheamos errores
    throw e;
  }
}

/** Invalida una entrada del cache cliente. Usar después de mutaciones. */
export function invalidateClientCache(pathPrefix: string): void {
  for (const k of memCache.keys()) {
    if (k.startsWith(pathPrefix)) memCache.delete(k);
  }
}

/**
 * Fire-and-forget GET para precalentar el cache cliente. Útil después del
 * login para que cuando el usuario navegue a cargar-pedido el catálogo ya
 * esté cacheado tanto en el cliente como en el API local.
 *
 * Si la request falla, no propagamos — el caller hará la llamada normal
 * después y verá el error si persiste.
 */
export function prefetch(path: string, ttlMs = 5 * 60_000): void {
  if (DEMO_MODE) return; // en demo es todo mock instantáneo, no hace falta
  void getCached(path, ttlMs).catch(() => {
    /* swallow — el caller real reintentará */
  });
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  /** GET con cache cliente. TTL en ms. Devuelve respuesta cacheada si está fresh. */
  getCached: <T>(path: string, ttlMs: number) => getCached<T>(path, ttlMs),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export { ApiError };
