import { llamarRappi, RappiError } from './cliente.js';
import { getConfigHorarios } from '../horarios.js';

/**
 * Capacidades de "Tiendas" del checklist de certificación de RAPPI.
 * docs/RAPPI-API-REFERENCE.md → Tiendas y Disponibilidad.
 */

const LEGACY = '/api/v2/restaurants-integrations-public-api';

export interface TiendaRappi {
  integrationId: string;
  rappiId: string;
  name: string;
}

/** `GET /stores-pa` — las tiendas de la cuenta. Es el mejor primer test: sólo lee. */
export async function listarTiendas(): Promise<TiendaRappi[]> {
  const r = await llamarRappi<TiendaRappi[]>({
    arbol: 'legacy',
    metodo: 'GET',
    ruta: `${LEGACY}/stores-pa`,
    contexto: 'listar tiendas',
  });
  if (!r.ok || !Array.isArray(r.body)) {
    // RappiError, no Error: así el panel dice "RAPPI respondió 404: …" con el
    // cuerpo, en vez de un STA-SRV opaco que obliga a ir a buscar el registro.
    const detalle = r.body !== null ? JSON.stringify(r.body).slice(0, 300) : (r.texto ?? '').slice(0, 300);
    throw new RappiError(
      r.ok
        ? `RAPPI respondió ${r.status} al listar tiendas, pero no con una lista: ${detalle || '(vacío)'}`
        : `RAPPI respondió ${r.status} al listar tiendas${detalle ? `: ${detalle}` : ''}`,
      r.status,
      r.body ?? r.texto,
    );
  }
  return r.body.map((t) => ({
    integrationId: String(t.integrationId ?? ''),
    rappiId: String(t.rappiId ?? ''),
    name: String(t.name ?? ''),
  }));
}

/**
 * `PUT /stores-pa/{id}/status?integrated=` — si la tienda opera POR ESTA
 * integración (true) o vuelve a manejarse a mano desde el portal (false).
 * Es el REQUERIDO "Enable/disable de tienda".
 */
export async function setTiendaIntegrada(storeId: string, integrada: boolean) {
  const r = await llamarRappi<{ message?: string }>({
    arbol: 'legacy',
    metodo: 'PUT',
    ruta: `${LEGACY}/stores-pa/${encodeURIComponent(storeId)}/status`,
    query: { integrated: integrada },
    contexto: `${integrada ? 'activar' : 'desactivar'} integración de la tienda ${storeId}`,
  });
  return { ok: r.ok, status: r.status, mensaje: r.body?.message ?? r.texto ?? null };
}

/**
 * `PUT /availability/stores/enable` — si la tienda está ABIERTA para recibir
 * pedidos ahora mismo. Distinto de "integrada": una tienda integrada se puede
 * apagar un rato (se quedaron sin gas) sin desconectar la integración.
 */
export async function setTiendaHabilitada(storeId: string, habilitada: boolean) {
  const r = await llamarRappi<{
    results?: Array<{
      store_id: number | string;
      is_enabled: boolean;
      operation_result: boolean;
      operation_result_type: string;
      operation_result_message: string;
      suspended_reason: string | null;
    }>;
  }>({
    arbol: 'legacy',
    metodo: 'PUT',
    ruta: `${LEGACY}/availability/stores/enable`,
    body: { stores: [{ store_id: storeId, is_enabled: habilitada }] },
    contexto: `${habilitada ? 'abrir' : 'cerrar'} la tienda ${storeId} en RAPPI`,
  });
  const res = r.body?.results?.[0];
  return {
    ok: r.ok && (res?.operation_result ?? true),
    status: r.status,
    resultado: res ?? null,
    mensaje: res?.operation_result_message ?? r.texto ?? null,
  };
}

/** `POST /availability/stores` — ¿está abierta cada tienda? `{ id: true/false }`. */
export async function estadoTiendas(storeIds: string[]): Promise<Record<string, boolean>> {
  const r = await llamarRappi<Record<string, boolean>>({
    arbol: 'legacy',
    metodo: 'POST',
    ruta: `${LEGACY}/availability/stores`,
    body: storeIds.map((s) => (Number.isFinite(Number(s)) ? Number(s) : s)),
    contexto: 'consultar si las tiendas están abiertas',
  });
  return r.ok && r.body && typeof r.body === 'object' ? r.body : {};
}

const DIAS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Los horarios de la tienda en RAPPI, sacados de NUESTRA configuración de
 * turnos (`sesiones_horarios`): no se cargan dos veces.
 *
 * `POST /api/rest-ops-utils/store/schedule/{storeId}` — va con el token de
 * *utils*, que es otro login. Se asume el dominio legacy (es `/api/...` y no
 * `/restaurants/...`); si RAPPI contesta 404 ahí, el registro lo muestra y es
 * un cambio de una línea.
 */
export function armarHorariosRappi(horarios: Array<{ diasSemana: number[]; horaInicio: string; horaFin: string }>) {
  const hhmmss = (hhmm: string) => (hhmm.length === 5 ? `${hhmm}:00` : hhmm);
  return {
    schedule_details: horarios
      .filter((h) => h.diasSemana.length > 0)
      .map((h) => ({
        days: [...new Set(h.diasSemana)]
          .sort((a, b) => a - b)
          .map((d) => DIAS[d] ?? 'mon')
          .join(','),
        starts_time: hhmmss(h.horaInicio),
        ends_time: hhmmss(h.horaFin),
      })),
  };
}

export async function enviarHorarios(storeId: string) {
  const cfg = await getConfigHorarios();
  const body = armarHorariosRappi(cfg.horarios);
  const r = await llamarRappi({
    arbol: 'legacy',
    metodo: 'POST',
    ruta: `/api/rest-ops-utils/store/schedule/${encodeURIComponent(storeId)}`,
    body,
    contexto: `enviar horarios de la tienda ${storeId}`,
    token: 'utils',
  });
  return { ok: r.ok, status: r.status, enviado: body, respuesta: r.body ?? r.texto };
}
