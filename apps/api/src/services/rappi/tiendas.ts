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
  let mensaje = r.body?.message ?? r.texto ?? null;
  // "Access is denied" es el 401 documentado de este endpoint. Con el mismo
  // token, listar tiendas y abrir/cerrar andan (30/09): no es la credencial,
  // es que RAPPI no deja cambiar el estado de integración de esta tienda
  // desde la API. Decirlo ahorra ir a buscar el motivo al registro.
  if (r.status === 401 || r.status === 403) {
    mensaje = `RAPPI no permite ${integrada ? 'activar' : 'desactivar'} la integración de esta tienda con estas credenciales (${mensaje ?? r.status}). Si el checklist del Integrations Manager ya marca "Enable/disable de tienda" como adoptado, no hace falta: la tienda la asoció RAPPI. Si no, pedirles ese permiso.`;
  }
  return { ok: r.ok, status: r.status, mensaje };
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
const UTILS = '/api/rest-ops-utils';

export interface FranjaRappi {
  day: string;
  starts_time: string;
  ends_time: string;
}

/**
 * Los horarios de la tienda en RAPPI, sacados de NUESTRA configuración de
 * turnos (`sesiones_horarios`): no se cargan dos veces.
 *
 * El portal (api-reference/store-schedules) los modela como FRANJAS sueltas,
 * una por día: `POST /api/rest-ops-utils/store/schedule/{storeId}` con
 * `{ day, starts_time, ends_time }` crea UNA franja, `GET` devuelve las que
 * hay (`storeScheduleDays[].storeSchedules[]`, con id) y `DELETE
 * …/{storeId}/{storeScheduleId}` borra una. No hay "reemplazar todo": por eso
 * `enviarHorarios` sincroniza (lee, borra lo que sobra, crea lo que falta) en
 * vez de mandar una lista, y correrlo dos veces no duplica nada.
 *
 * Todo con el token de *utils*, que es otro login con las mismas
 * credenciales — ver el comentario en `login()` de cliente.ts.
 */
export function armarHorariosRappi(horarios: Array<{ diasSemana: number[]; horaInicio: string; horaFin: string }>): FranjaRappi[] {
  const hhmmss = (hhmm: string) => (hhmm.length === 5 ? `${hhmm}:00` : hhmm);
  const franjas: FranjaRappi[] = [];
  for (const h of horarios) {
    const inicio = hhmmss(h.horaInicio);
    const fin = hhmmss(h.horaFin);
    for (const d of [...new Set(h.diasSemana)].sort((a, b) => a - b)) {
      const day = DIAS[d];
      if (!day) continue;
      if (fin > inicio) {
        franjas.push({ day, starts_time: inicio, ends_time: fin });
      } else {
        // Un turno que cruza medianoche (22:00→02:00) son dos franjas en RAPPI.
        franjas.push({ day, starts_time: inicio, ends_time: '23:59:59' });
        franjas.push({ day: DIAS[(d + 1) % 7] ?? 'sun', starts_time: '00:00:00', ends_time: fin });
      }
    }
  }
  // Sin duplicados y en orden estable (el orden de llamadas sale de acá).
  const vistos = new Set<string>();
  return franjas.filter((f) => {
    const k = `${f.day}|${f.starts_time}|${f.ends_time}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

interface HorariosActualesRappi {
  storeScheduleDays?: Array<{
    day?: string;
    storeSchedules?: Array<{ id?: number | string; startsTime?: string; endsTime?: string }>;
  }>;
}

export async function enviarHorarios(storeId: string) {
  const cfg = await getConfigHorarios();
  const deseadas = armarHorariosRappi(cfg.horarios);
  const base = `${UTILS}/store/schedule/${encodeURIComponent(storeId)}`;
  const clave = (f: FranjaRappi) => `${f.day}|${f.starts_time}|${f.ends_time}`;

  const actual = await llamarRappi<HorariosActualesRappi>({
    arbol: 'legacy',
    metodo: 'GET',
    ruta: base,
    contexto: `leer los horarios de la tienda ${storeId}`,
    token: 'utils',
  });
  if (!actual.ok) {
    const detalle = actual.body !== null ? JSON.stringify(actual.body).slice(0, 300) : (actual.texto ?? '').slice(0, 300);
    throw new RappiError(
      `RAPPI respondió ${actual.status} al leer los horarios de la tienda ${storeId}${detalle ? `: ${detalle}` : ''}`,
      actual.status,
      actual.body ?? actual.texto,
    );
  }
  const existentes = (actual.body?.storeScheduleDays ?? []).flatMap((d) =>
    (d.storeSchedules ?? []).map((f) => ({
      id: String(f.id ?? ''),
      franja: { day: String(d.day ?? ''), starts_time: String(f.startsTime ?? ''), ends_time: String(f.endsTime ?? '') },
    })),
  );
  const quiero = new Set(deseadas.map(clave));
  const hay = new Set(existentes.map((e) => clave(e.franja)));

  const fallas: string[] = [];
  let borradas = 0;
  for (const e of existentes) {
    if (quiero.has(clave(e.franja)) || !e.id) continue;
    const r = await llamarRappi({
      arbol: 'legacy',
      metodo: 'DELETE',
      ruta: `${base}/${encodeURIComponent(e.id)}`,
      contexto: `borrar la franja ${e.franja.day} ${e.franja.starts_time}–${e.franja.ends_time} de la tienda ${storeId}`,
      token: 'utils',
    });
    if (r.ok) borradas += 1;
    else fallas.push(`borrar ${e.franja.day} ${e.franja.starts_time}–${e.franja.ends_time}: ${r.status}`);
  }
  let creadas = 0;
  for (const f of deseadas) {
    if (hay.has(clave(f))) continue;
    const r = await llamarRappi<{ message?: string }>({
      arbol: 'legacy',
      metodo: 'POST',
      ruta: base,
      body: f,
      contexto: `crear la franja ${f.day} ${f.starts_time}–${f.ends_time} de la tienda ${storeId}`,
      token: 'utils',
    });
    if (r.ok) creadas += 1;
    else fallas.push(`crear ${f.day} ${f.starts_time}–${f.ends_time}: ${r.status}${r.body?.message ? ` ${r.body.message}` : ''}`);
  }
  const sinCambios = deseadas.length - creadas - fallas.filter((x) => x.startsWith('crear')).length;
  const partes = [
    creadas ? `${creadas} franja/s creada/s` : null,
    borradas ? `${borradas} borrada/s` : null,
    sinCambios ? `${sinCambios} ya estaba/n` : null,
  ].filter(Boolean);
  return {
    ok: fallas.length === 0,
    status: fallas.length ? 207 : 200,
    creadas,
    borradas,
    sinCambios,
    fallas,
    enviado: deseadas,
    detalle: fallas.length
      ? `RAPPI rechazó ${fallas.length} de ${fallas.length + creadas + borradas} cambio/s: ${fallas.join('; ').slice(0, 400)}`
      : `Horarios sincronizados en RAPPI: ${partes.join(', ') || 'no había nada que mandar'} (${deseadas.length} franja/s en total).`,
  };
}
