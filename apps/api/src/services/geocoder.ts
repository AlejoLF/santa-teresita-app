import { Prisma } from '@sta/db';
import { prisma } from '@sta/db/client';
import { config } from '../config.js';
import { recordAudit } from './audit.js';

/**
 * Geocoder batch — resuelve lat/lng de las direcciones de delivery vía
 * Nominatim (OpenStreetMap). Es el "job batch (próxima iteración)" que
 * prometía el banner del mapa de analytics.
 *
 * Corre SOLO en el server LAN (STA_ROLE='server') — una única instancia
 * para todo el sistema, respetando el rate-limit de Nominatim (1 req/seg).
 * Cada update va con recordAudit → outbox_events → el replicator lo empuja
 * a Supabase → la PWA y el espejo del dueño lo ven sin tocar nada.
 *
 * Estados en `direccion_snapshot` (JSONB):
 *   - éxito        → + { lat, lng, geo_fuente: 'nominatim', geo_at } (audit ✓)
 *   - intento fail → + { geo_intentos: n } (solo local, sin audit — ruido)
 *   - agotado (3)  → + { geo_fallido: true } (audit ✓ — estado final, el
 *                    contador de "pendientes" de analytics lo excluye)
 *
 * Direcciones de La Plata ("44 e. 12 y 13", "12 nro 1234"): se intenta la
 * dirección cruda y una variante normalizada "Calle N NNNN". Best-effort —
 * lo que no resuelve queda marcado y no se reintenta para siempre.
 */

const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const FIRST_SWEEP_DELAY_MS = 20_000; // dejar que el server termine de arrancar
const BATCH_POR_SWEEP = 30;
const MAX_INTENTOS = 3;
const NOMINATIM_DELAY_MS = 1_100; // ToS Nominatim: máx 1 req/seg
const USER_AGENT = 'SantaTeresitaApp/1.0 (alejolafalce@gmail.com)';
// Bounding box de Gran La Plata (lon W, lat N, lon E, lat S) — restringe
// resultados: una "calle 44" de otra ciudad no matchea.
const VIEWBOX = '-58.15,-34.75,-57.75,-35.10';

function log(msg: string): void {
  console.log(`[geocoder] ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Candidato = {
  id: string;
  direccion: string | null;
  intentos: number;
};

/** Variantes de query para una dirección platense (cruda + normalizada). */
function variantes(direccion: string): string[] {
  const out: string[] = [];
  const dir = direccion.replace(/\s+/g, ' ').trim();
  out.push(dir);
  // "12 nro 1234" / "12 n° 1234" / "12 1234" → "Calle 12 1234"
  const m = dir.match(/^(\d{1,3})\s*(?:n°?\.?|nro\.?|nº|#)?\s*(\d{2,5})\b/i);
  if (m && !/^calle/i.test(dir)) {
    const norm = `Calle ${m[1]} ${m[2]}`;
    if (norm.toLowerCase() !== dir.toLowerCase()) out.push(norm);
  }
  return out;
}

/** Una consulta a Nominatim. Devuelve {lat,lng} o null. */
async function nominatim(q: string): Promise<{ lat: number; lng: number } | null> {
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ar' +
    `&viewbox=${VIEWBOX}&bounded=1&q=${encodeURIComponent(`${q}, La Plata, Buenos Aires, Argentina`)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const body = (await res.json()) as Array<{ lat: string; lon: string }>;
  if (!Array.isArray(body) || body.length === 0) return null;
  const lat = Number(body[0]!.lat);
  const lng = Number(body[0]!.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/** Merge del snapshot + update + (opcional) audit→outbox para replicar. */
async function actualizarSnapshot(
  id: string,
  extra: Record<string, unknown>,
  conAudit: boolean,
): Promise<void> {
  const row = await prisma.deliveryInfo.findUnique({ where: { id } });
  if (!row) return;
  const snapshot = {
    ...((row.direccionSnapshot as Record<string, unknown>) ?? {}),
    ...extra,
  };
  await prisma.$transaction(async (tx) => {
    await tx.deliveryInfo.update({
      where: { id },
      data: { direccionSnapshot: snapshot as never },
    });
    if (conAudit) {
      await recordAudit({
        tabla: 'delivery_info',
        registroId: id,
        accion: 'UPDATE',
        usuarioId: null,
        valorNuevo: extra,
        contexto: { job: 'geocoder', motor: 'nominatim' },
        tx,
      });
    }
  });
}

let sweeping = false;

/** Un barrido: toma hasta BATCH_POR_SWEEP pendientes y los geocodifica. */
export async function runGeocoderSweep(): Promise<{ ok: number; fail: number }> {
  if (sweeping) return { ok: 0, fail: 0 };
  sweeping = true;
  let ok = 0;
  let fail = 0;
  try {
    const candidatos = await prisma.$queryRaw<Candidato[]>(Prisma.sql`
      SELECT
        d.id::text AS id,
        NULLIF(TRIM(d.direccion_snapshot->>'direccion'), '') AS direccion,
        COALESCE((d.direccion_snapshot->>'geo_intentos')::int, 0) AS intentos
      FROM delivery_info d
      JOIN ventas v ON v.id = d.venta_id
      WHERE NOT (d.direccion_snapshot ? 'lat')
        AND NOT (d.direccion_snapshot ? 'geo_fallido')
        AND v.fecha_apertura >= (CURRENT_DATE - INTERVAL '90 days')
      ORDER BY v.fecha_apertura DESC
      LIMIT ${BATCH_POR_SWEEP}
    `);
    if (candidatos.length === 0) return { ok, fail };
    log(`barrido: ${candidatos.length} direcciones pendientes`);

    for (const c of candidatos) {
      // Sin texto de dirección no hay nada que geocodificar → estado final.
      if (!c.direccion) {
        await actualizarSnapshot(c.id, { geo_fallido: true }, true);
        fail++;
        continue;
      }
      try {
        let hit: { lat: number; lng: number } | null = null;
        for (const q of variantes(c.direccion)) {
          hit = await nominatim(q);
          await sleep(NOMINATIM_DELAY_MS);
          if (hit) break;
        }
        if (hit) {
          await actualizarSnapshot(
            c.id,
            { lat: hit.lat, lng: hit.lng, geo_fuente: 'nominatim', geo_at: new Date().toISOString() },
            true,
          );
          ok++;
        } else {
          const intentos = c.intentos + 1;
          if (intentos >= MAX_INTENTOS) {
            await actualizarSnapshot(c.id, { geo_intentos: intentos, geo_fallido: true }, true);
            fail++;
          } else {
            // Intento intermedio: solo local, sin ensuciar el audit chain.
            await actualizarSnapshot(c.id, { geo_intentos: intentos }, false);
          }
        }
      } catch (e) {
        // Error de red/Nominatim caído: NO consume intentos — se reintenta
        // en el próximo barrido. Cortamos el batch para no insistir.
        log(`error de red (${e instanceof Error ? e.message : String(e)}) — corto el barrido`);
        break;
      }
    }
    if (ok > 0 || fail > 0) log(`✓ barrido: ${ok} geocodificadas, ${fail} marcadas sin resolver`);
    return { ok, fail };
  } catch (e) {
    log(`✗ barrido falló: ${e instanceof Error ? e.message : String(e)}`);
    return { ok, fail };
  } finally {
    sweeping = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startGeocoder(): void {
  // Una sola instancia para todo el sistema: el server LAN. Las cajas y el
  // espejo del dueño reciben los resultados vía replicator / mirror-sync.
  // STA_GEOCODER=1 fuerza el arranque (dev / standalone sin server).
  if (config.STA_ROLE !== 'server' && !config.STA_GEOCODER) {
    return;
  }
  log(`iniciado (cada ${SWEEP_INTERVAL_MS / 60000} min, batch ${BATCH_POR_SWEEP}, Nominatim 1 req/seg)`);
  setTimeout(() => void runGeocoderSweep(), FIRST_SWEEP_DELAY_MS);
  timer = setInterval(() => void runGeocoderSweep(), SWEEP_INTERVAL_MS);
}

export function stopGeocoder(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
