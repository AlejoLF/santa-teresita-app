import { config } from '../config.js';

/**
 * La URL con la que las plataformas (RAPPI, PYA…) tienen que llegar a esta
 * API. Es lo que la pantalla de Integraciones muestra para copiar.
 *
 * Si `API_WEBHOOK_URL` está seteada (Railway: el dominio público del servicio
 * de la API), manda ésa. Si no, se usa el host con el que llegó el request:
 * desde el navegador en la nube es el dominio del web (que reenvía `/api/v1`
 * a la API, así que sirve), pero desde el .exe es 127.0.0.1 — y eso no le
 * sirve a nadie de afuera, por eso se avisa con `esLocal`.
 */
export function basePublica(req: { headers: Record<string, unknown> }): { base: string; esLocal: boolean } {
  const fija = config.API_WEBHOOK_URL?.trim().replace(/\/+$/, '');
  if (fija) return { base: `${fija}/api/v1`, esLocal: false };
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
  const host = (req.headers['x-forwarded-host'] as string) ?? (req.headers.host as string) ?? '';
  return {
    base: `${proto}://${host}/api/v1`,
    esLocal: /^(127\.0\.0\.1|localhost|\[?::1\]?)(:|$)/.test(host),
  };
}
