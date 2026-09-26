import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * La firma de los webhooks de RAPPI.
 *
 *   Rappi-Signature: t=1695750000,sign=<hex>
 *   sign = HMAC-SHA256( secret, `${t}.${cuerpo crudo}` )
 *
 * Se firma el cuerpo **tal cual llegó**, byte por byte. Por eso el parser del
 * plugin de canal guarda `req.rawBody` antes de parsear: un `JSON.parse` +
 * `JSON.stringify` reordena claves y cambia espacios, el hash da distinto, y se
 * rechaza una firma que era válida. (docs/RAPPI-API-REFERENCE.md → La firma.)
 */

export type VerificacionFirma =
  | { ok: true }
  | { ok: false; motivo: 'SIN_HEADER' | 'HEADER_MALFORMADO' | 'NO_COINCIDE' };

export function firmarRappi(secreto: string, timestamp: string, cuerpoCrudo: string): string {
  return createHmac('sha256', secreto).update(`${timestamp}.${cuerpoCrudo}`, 'utf8').digest('hex');
}

/** Parsea `t=...,sign=...` (en cualquier orden, con o sin espacios). */
export function parsearHeaderFirma(header: string): { t: string; sign: string } | null {
  const partes: Record<string, string> = {};
  for (const trozo of header.split(',')) {
    const i = trozo.indexOf('=');
    if (i <= 0) continue;
    partes[trozo.slice(0, i).trim().toLowerCase()] = trozo.slice(i + 1).trim();
  }
  if (!partes.t || !partes.sign) return null;
  return { t: partes.t, sign: partes.sign };
}

export function verificarFirmaRappi(
  header: string | undefined,
  cuerpoCrudo: string,
  secreto: string,
): VerificacionFirma {
  if (!header) return { ok: false, motivo: 'SIN_HEADER' };
  const parsed = parsearHeaderFirma(header);
  if (!parsed) return { ok: false, motivo: 'HEADER_MALFORMADO' };
  const esperado = firmarRappi(secreto, parsed.t, cuerpoCrudo);
  const recibido = parsed.sign.toLowerCase();
  // Comparación en tiempo constante: no filtrar por timing cuánto coincide.
  if (recibido.length !== esperado.length) return { ok: false, motivo: 'NO_COINCIDE' };
  const iguales = timingSafeEqual(Buffer.from(recibido, 'utf8'), Buffer.from(esperado, 'utf8'));
  return iguales ? { ok: true } : { ok: false, motivo: 'NO_COINCIDE' };
}
