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
 * `POST /orders/{id}/ready-for-pickup` — avisa al repartidor (si no hay uno
 * asignado, RAPPI apura la asignación). RAPPI deja de actuar después de tres
 * requests por orden, así que acá se reintenta UNA sola vez, y sólo ante un
 * 424 o un 5xx: ese es el "no pude procesarlo" de un sistema de ellos
 * (`error.ready_for_pickup.unsuccessful`), no un error de la orden. En DEV
 * pasa con las órdenes del simulador, que no tienen repartidor que asignar.
 * Un 400 es "transición inválida" (la orden no está TAKEN) y no se reintenta.
 */
export async function listaParaRetiro(idExterno: string, rastro: Rastro = {}) {
  const pedir = () =>
    llamarRappi({
      arbol: 'legacy',
      metodo: 'POST',
      ruta: `${LEGACY}/orders/${encodeURIComponent(idExterno)}/ready-for-pickup`,
      contexto: `orden ${idExterno} lista para retiro`,
      ventaId: rastro.ventaId,
    });
  let r = await pedir();
  let reintentado = false;
  if (!r.ok && (r.status === 424 || r.status >= 500)) {
    await new Promise((res) => setTimeout(res, 1500));
    r = await pedir();
    reintentado = true;
  }
  if (r.ok) await auditar(rastro, 'LISTA_PARA_RETIRO', { idExterno, reintentado });
  let detalle: string;
  if (r.ok) {
    detalle = `RAPPI avisó al repartidor que la orden está lista${reintentado ? ' (al segundo intento)' : ''}.`;
  } else if (r.status === 424 || r.status >= 500) {
    detalle = `${describirRespuesta(r.status, r.body, r.texto)} — RAPPI no pudo procesar el aviso al repartidor (se intentó dos veces). La orden sigue tomada y el pedido sigue en curso; no insistas: RAPPI corta a la tercera. En DEV pasa con las órdenes del simulador, que no tienen repartidor.`;
  } else if (r.status === 400) {
    detalle = `${describirRespuesta(r.status, r.body, r.texto)} — la orden no está en TAKEN: primero hay que tomarla.`;
  } else {
    detalle = describirRespuesta(r.status, r.body, r.texto);
  }
  return { ok: r.ok, status: r.status, respuesta: r.body ?? r.texto, detalle, reintentado };
}
