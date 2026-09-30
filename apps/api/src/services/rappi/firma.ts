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

/**
 * `secreto` puede ser una clave o varias: RAPPI entrega el secreto del webhook
 * como DOS claves separadas por coma (incidente 30/09: con las dos pegadas en
 * `RAPPI_WEBHOOK_SECRET`, RAPPI firmaba con una y acá se verificaba contra
 * el texto entero → "Firma inválida" en todos los tests). Vale si coincide
 * con cualquiera.
 */
export function verificarFirmaRappi(
  header: string | undefined,
  cuerpoCrudo: string,
  secreto: string | string[],
): VerificacionFirma {
  if (!header) return { ok: false, motivo: 'SIN_HEADER' };
  const parsed = parsearHeaderFirma(header);
  if (!parsed) return { ok: false, motivo: 'HEADER_MALFORMADO' };
  const recibido = parsed.sign.toLowerCase();
  const claves = Array.isArray(secreto) ? secreto : [secreto];
  let ok = false;
  for (const clave of claves) {
    const esperado = firmarRappi(clave, parsed.t, cuerpoCrudo);
    // Comparación en tiempo constante: no filtrar por timing cuánto coincide.
    if (recibido.length !== esperado.length) continue;
    if (timingSafeEqual(Buffer.from(recibido, 'utf8'), Buffer.from(esperado, 'utf8'))) ok = true;
  }
  return ok ? { ok: true } : { ok: false, motivo: 'NO_COINCIDE' };
}
