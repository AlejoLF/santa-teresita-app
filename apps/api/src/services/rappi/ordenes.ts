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
  return { ok: r.ok, status: r.status, respuesta: r.body ?? r.texto };
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
  return { ok: r.ok, status: r.status, respuesta: r.body ?? r.texto };
}

/** `POST /orders/{id}/ready-for-pickup` — avisa al repartidor. RAPPI deja de actuar después de tres. */
export async function listaParaRetiro(idExterno: string, rastro: Rastro = {}) {
  const r = await llamarRappi({
    arbol: 'legacy',
    metodo: 'POST',
    ruta: `${LEGACY}/orders/${encodeURIComponent(idExterno)}/ready-for-pickup`,
    contexto: `orden ${idExterno} lista para retiro`,
    ventaId: rastro.ventaId,
  });
  if (r.ok) await auditar(rastro, 'LISTA_PARA_RETIRO', { idExterno });
  return { ok: r.ok, status: r.status, respuesta: r.body ?? r.texto };
}
