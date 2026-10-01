import { llamarRappi } from './cliente.js';
import { recordAudit } from '../audit.js';
import { ReglaNegocioError } from '../errores.js';

/**
 * Capacidades de "Órdenes" del checklist: tomar, rechazar, lista para retiro.
 * docs/RAPPI-API-REFERENCE.md → Órdenes. Se usan las rutas legacy porque son
 * las que el checklist nombra.
 *
 * `idExterno` es el `order_id` de RAPPI (= `Venta.idExternoCanal`).
 */

const LEGACY = '/api/v2/restaurants-integrations-public-api';

export const CANCEL_TYPES = [
  'ITEM_WRONG_PRICE',
  'ITEM_NOT_FOUND',
  'ITEM_OUT_OF_STOCK',
  'ORDER_MISSING_INFORMATION',
  'ORDER_MISSING_ADDRESS_INFORMATION',
  'ORDER_TOTAL_INCORRECT',
] as const;
export type CancelType = (typeof CANCEL_TYPES)[number];

/** Los que exigen decir QUÉ ítems. */
export const CANCEL_TYPES_POR_ITEM: ReadonlySet<string> = new Set([
  'ITEM_WRONG_PRICE',
  'ITEM_NOT_FOUND',
  'ITEM_OUT_OF_STOCK',
]);

interface Rastro {
  ventaId?: string;
  usuarioId?: string | null;
}

/**
 * RAPPI contesta los errores con un `message` que a veces es OTRO JSON en
 * texto: `"424 {\"code\":\"error.ready_for_pickup.unsuccessful\",\"message\":\"No se
 * pudo…\"}"`. Se desarma para mostrar el código y el texto, no el JSON crudo.
 */
function describirRespuesta(status: number, body: unknown, texto: string | null): string {
  const message = (body as { message?: unknown } | null)?.message;
  let crudo = typeof message === 'string' ? message : texto ?? (body ? JSON.stringify(body) : '');
  const anidado = /\{.*\}/s.exec(crudo)?.[0];
  if (anidado) {
    try {
      const j = JSON.parse(anidado) as { code?: string; message?: string };
      if (j.code || j.message) crudo = [j.code, j.message].filter(Boolean).join(' · ');
    } catch {
      /* no era JSON: se muestra tal cual */
    }
  }
  return `RAPPI respondió ${status}${crudo ? `: ${crudo.slice(0, 240)}` : ''}`;
}

async function auditar(rastro: Rastro, accion: string, detalle: Record<string, unknown>) {
  if (!rastro.ventaId) return;
  try {
    await recordAudit({
      tabla: 'ventas',
      registroId: rastro.ventaId,
      accion: 'UPDATE',
      usuarioId: rastro.usuarioId ?? null,
      pcOrigen: 'CANAL:RAPPI',
      valorNuevo: { rappi: accion, ...detalle },
    });
  } catch (e) {
    console.error('[rappi] no se pudo auditar la orden:', e);
  }
}

/**
 * `PUT /orders/{id}/take[/{cookingTime}]` — el REQUERIDO "Tomar la orden".
 * RAPPI cancela sola lo que no se toma en 6 minutos.
 */
export async function tomarOrden(
  idExterno: string,
  opts: { tiempoCocinaMin?: number | null } & Rastro = {},
) {
  const sufijo =
    opts.tiempoCocinaMin && opts.tiempoCocinaMin > 0 ? `/${Math.round(opts.tiempoCocinaMin)}` : '';
  const r = await llamarRappi({
    arbol: 'legacy',
    metodo: 'PUT',
    ruta: `${LEGACY}/orders/${encodeURIComponent(idExterno)}/take${sufijo}`,
    contexto: `tomar orden ${idExterno}`,
    ventaId: opts.ventaId,
  });
  if (r.ok) await auditar(opts, 'TOMADA', { idExterno, tiempoCocinaMin: opts.tiempoCocinaMin ?? null });
  return {
    ok: r.ok,
    status: r.status,
    respuesta: r.body ?? r.texto,
    detalle: r.ok
      ? `RAPPI tomó la orden${opts.tiempoCocinaMin ? ` (${Math.round(opts.tiempoCocinaMin)} min de cocina)` : ''}.`
      : `${describirRespuesta(r.status, r.body, r.texto)}${r.status === 400 ? ' — la orden ya no está en SENT (ya se tomó, se rechazó o venció a los 6 minutos).' : ''}`,
  };
}

/** `PUT /orders/{id}/reject` — sólo órdenes en estado SENT. */
export async function rechazarOrden(
  idExterno: string,
  args: { cancelType: CancelType; reason: string; itemsSkus?: string[] } & Rastro,
) {
  if (CANCEL_TYPES_POR_ITEM.has(args.cancelType) && !(args.itemsSkus?.length)) {
    throw new ReglaNegocioError(`El motivo ${args.cancelType} exige decir qué productos (items_skus).`);
  }
  const r = await llamarRappi({
    arbol: 'legacy',
    metodo: 'PUT',
    ruta: `${LEGACY}/orders/${encodeURIComponent(idExterno)}/reject`,
    body: {
      reason: args.reason,
      cancel_type: args.cancelType,
      ...(args.itemsSkus?.length && { items_skus: args.itemsSkus }),
    },
    contexto: `rechazar orden ${idExterno} (${args.cancelType})`,
    ventaId: args.ventaId,
  });
  if (r.ok) await auditar(args, 'RECHAZADA', { idExterno, cancelType: args.cancelType, reason: args.reason });
  return {
    ok: r.ok,
    status: r.status,
    respuesta: r.body ?? r.texto,
    detalle: r.ok
      ? 'RAPPI rechazó la orden y le avisa al cliente.'
      : `${describirRespuesta(r.status, r.body, r.texto)}${r.status === 400 ? ' — sólo se puede rechazar una orden en SENT: si ya se tomó, hay que cancelarla desde RAPPI.' : ''}`,
  };
}

/**
 * "Lista para retiro". Dos caminos, porque en DEV el legacy falla:
 *
 *  1. Legacy `POST /orders/{id}/ready-for-pickup` (el que nombra el checklist).
 *     Avisa al repartidor; si no hay uno asignado, RAPPI apura la asignación.
 *     Con las órdenes del simulador contesta `424
 *     error.ready_for_pickup.unsuccessful` (01/10): falló el sistema de
 *     asignación de ellos, no la orden. Deja de actuar a la tercera request,
 *     así que acá se le pega UNA sola vez.
 *  2. Si eso da 424/5xx, la API nueva
 *     `POST /restaurants/orders/v1/stores/{storeId}/orders/{id}/ready-for-pickup`
 *     — es la que usa el propio portal, donde "Listo" sí anda. Documentada con
 *     `x-authorization: bearer <token>` (sin dos puntos): se prueba primero
 *     con el header de siempre y, ante un 401, con el plano.
 *
 * Un 400 es "transición inválida" (la orden no está TAKEN) en cualquiera de
 * los dos y no se insiste.
 */
export async function listaParaRetiro(idExterno: string, rastro: Rastro & { storeId?: string | null } = {}) {
  const legacy = await llamarRappi({
    arbol: 'legacy',
    metodo: 'POST',
    ruta: `${LEGACY}/orders/${encodeURIComponent(idExterno)}/ready-for-pickup`,
    contexto: `orden ${idExterno} lista para retiro`,
    ventaId: rastro.ventaId,
  });
  let r = legacy;
  let porApiNueva = false;
  if (!legacy.ok && (legacy.status === 424 || legacy.status >= 500) && rastro.storeId) {
    const nueva = (authPlano: boolean) =>
      llamarRappi({
        arbol: 'nuevo',
        metodo: 'POST',
        ruta: `/restaurants/orders/v1/stores/${encodeURIComponent(rastro.storeId!)}/orders/${encodeURIComponent(idExterno)}/ready-for-pickup`,
        contexto: `orden ${idExterno} lista para retiro (API nueva${authPlano ? ', header plano' : ''}; el legacy dio ${legacy.status})`,
        ventaId: rastro.ventaId,
        authPlano,
      });
    r = await nueva(false);
    if (r.status === 401) r = await nueva(true);
    porApiNueva = true;
  }
  if (r.ok) await auditar(rastro, 'LISTA_PARA_RETIRO', { idExterno, porApiNueva });
  let detalle: string;
  if (r.ok) {
    detalle = `RAPPI avisó al repartidor que la orden está lista${porApiNueva ? ` (por la API nueva: la legacy respondió ${legacy.status})` : ''}.`;
  } else if (legacy.status === 424 || legacy.status >= 500) {
    detalle = `${describirRespuesta(legacy.status, legacy.body, legacy.texto)} — RAPPI no pudo procesar el aviso al repartidor${porApiNueva ? `, y por la API nueva tampoco (${describirRespuesta(r.status, r.body, r.texto)})` : ''}. La orden sigue tomada y el pedido sigue en curso; no insistas: RAPPI corta a la tercera. En DEV pasa con las órdenes del simulador, que no tienen repartidor.`;
  } else if (r.status === 400) {
    detalle = `${describirRespuesta(r.status, r.body, r.texto)} — la orden no está en TAKEN: primero hay que tomarla.`;
  } else {
    detalle = describirRespuesta(r.status, r.body, r.texto);
  }
  return { ok: r.ok, status: r.status, respuesta: r.body ?? r.texto, detalle, porApiNueva };
}
