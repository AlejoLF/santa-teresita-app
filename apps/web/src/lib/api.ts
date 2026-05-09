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
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export { ApiError };
