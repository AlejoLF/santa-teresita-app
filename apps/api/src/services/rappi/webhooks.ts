import { llamarRappi } from './cliente.js';

/**
 * Suscripción de webhooks a nivel INTEGRACIÓN y aprovisionamiento de tiendas —
 * lo que el checklist llama "Auto-onboarding". Los webhooks por tienda del
 * portal NO cuentan para esa capacidad. docs/RAPPI-API-REFERENCE.md.
 */

const LEGACY = '/api/v2/restaurants-integrations-public-api';

export const EVENTOS_WEBHOOK = [
  'NEW_ORDER',
  'NEW_ORDER_SCHEDULED',
  'NEW_ORDER_SCHEDULED_CANCELLED',
  'ORDER_EVENT_CANCEL',
  'ORDER_OTHER_EVENT',
  'MENU_APPROVED',
  'MENU_REJECTED',
  'PING',
  'STORE_CONNECTIVITY',
  'ORDER_RT_TRACKING',
  'STORE_PROVISIONING_STATUS',
] as const;
export type EventoWebhook = (typeof EVENTOS_WEBHOOK)[number];

/** `POST /clients/{clientId}/webhooks`. Si no va `secret`, RAPPI no firma. */
export async function suscribirWebhookIntegracion(args: {
  clientId: string;
  evento: EventoWebhook;
  url: string;
  secret: string | null;
}) {
  const r = await llamarRappi({
    arbol: 'legacy',
    metodo: 'POST',
    ruta: `${LEGACY}/clients/${encodeURIComponent(args.clientId)}/webhooks`,
    body: { event: args.evento, url: args.url, ...(args.secret && { secret: args.secret }) },
    contexto: `suscribir webhook ${args.evento}`,
  });
  return { ok: r.ok, status: r.status, respuesta: r.body ?? r.texto };
}

/** `POST /stores/provisioning` — responde 202; el resultado llega por STORE_PROVISIONING_STATUS. */
export async function aprovisionarTienda(args: {
  storeId: string;
  nombre: string;
  storeIntegrationId?: string | null;
}) {
  const r = await llamarRappi<{
    batch_id?: string;
    accepted?: Array<{ store_id: string; integration_id: string }>;
    rejected?: Array<{ store_id: string; reason: string }>;
  }>({
    arbol: 'legacy',
    metodo: 'POST',
    ruta: `${LEGACY}/stores/provisioning`,
    body: {
      stores: [
        {
          store_id: args.storeId,
          name: args.nombre,
          status: 'ACTIVE',
          ping_active: true,
          get_menu_active: true,
          cancellation_events: true,
          other_events: true,
          ...(args.storeIntegrationId && { store_integration_id: args.storeIntegrationId }),
        },
      ],
    },
    contexto: `aprovisionar tienda ${args.storeId}`,
  });
  return {
    ok: r.ok,
    status: r.status,
    batchId: r.body?.batch_id ?? null,
    aceptadas: r.body?.accepted ?? [],
    rechazadas: r.body?.rejected ?? [],
    respuesta: r.body ?? r.texto,
  };
}

// ─── PING ────────────────────────────────────────────────────────────────
// RAPPI manda PING para detectar caídas. No se guarda cada uno en el buzón
// (lo llenaría de ruido y desplazaría los pedidos): se recuerda el último, que
// es lo que la pantalla necesita mostrar: "RAPPI nos vio hace 2 minutos".
let ultimoPingAt: string | null = null;
export function registrarPing(): void {
  ultimoPingAt = new Date().toISOString();
}
export function ultimoPing(): string | null {
  return ultimoPingAt;
}
