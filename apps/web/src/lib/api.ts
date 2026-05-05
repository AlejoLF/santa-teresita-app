/**
 * Cliente HTTP simple para la API. Todas las requests pasan por /api/v1/*
 * (proxied por Next a la API Fastify).
 *
 * En modo demo (NEXT_PUBLIC_DEMO_MODE=true) cortocircuitamos a un router
 * mock en memoria — no hay backend, todo el estado es local.
 *
 * Excepción: el cierre de caja en demo dispara un email real vía /api/cierre
 * (ruta server-side de Next). Es la única "ventana" abierta al mundo.
 */

import { handleMock, buildCierrePayloadFromDemo } from './demo/mocks';

const BASE_URL = '/api/v1';
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

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

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (errBody as { error?: string })?.error ?? `HTTP ${res.status}`, errBody);
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
