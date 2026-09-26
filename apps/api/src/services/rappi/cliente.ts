import { prisma } from '@sta/db/client';
import { credencialesRappi, dominiosRappi } from './config.js';

/**
 * El cliente HTTP contra la API de RAPPI. Todo lo saliente pasa por acá.
 *
 * Tres cosas que hace por todos:
 *
 *  1. **El token.** Se pide con `client_id`/`client_secret`, dura UNA SEMANA y
 *     se cachea en memoria; se renueva solo cuando le queda menos de una hora
 *     y ante el primer 401. Pedir uno por request sería gastar una llamada
 *     contra su rate limit en cada operación.
 *
 *  2. **El header.** No es `Authorization`: es `x-authorization`, y lleva dos
 *     puntos después de Bearer (`Bearer: <token>`). Con el header normal todo
 *     da 401 y uno se vuelve loco buscando el error en las credenciales.
 *     docs/RAPPI-API-REFERENCE.md → Autenticación.
 *
 *  3. **El registro.** Cada llamada queda en `llamadas_canal` con qué se mandó
 *     y qué volvió. Es el espejo del buzón: sin esto, "RAPPI no tomó el
 *     pedido" no se puede distinguir de "nunca lo llamamos". El login NO
 *     registra el cuerpo — ahí van las credenciales.
 */

export type ArbolRappi = 'legacy' | 'nuevo';
export type TipoToken = 'integrations' | 'utils';

export interface RespuestaRappi<T = unknown> {
  status: number;
  ok: boolean;
  /** El cuerpo parseado, o null si no era JSON / venía vacío. */
  body: T | null;
  /** El cuerpo crudo cuando no era JSON. */
  texto: string | null;
  ms: number;
}

export class RappiApagadoError extends Error {
  constructor() {
    super('RAPPI está apagado: faltan RAPPI_CLIENT_ID / RAPPI_CLIENT_SECRET en el server.');
    this.name = 'RappiApagadoError';
  }
}

export class RappiError extends Error {
  status: number | null;
  cuerpo: unknown;
  constructor(mensaje: string, status: number | null, cuerpo: unknown) {
    super(mensaje);
    this.name = 'RappiError';
    this.status = status;
    this.cuerpo = cuerpo;
  }
}

const TIMEOUT_MS = 15_000;
/** Más que esto no se guarda de un cuerpo. Un menú entero pesa bastante más: se recorta. */
const MAX_BYTES_REGISTRO = 32 * 1024;
const MAX_FILAS_REGISTRO = 500;

// ─── Token ───────────────────────────────────────────────────────────────

const tokens = new Map<TipoToken, { token: string; expiraAt: number }>();
const RENOVAR_ANTES_MS = 60 * 60_000;

async function login(tipo: TipoToken): Promise<string> {
  const cred = credencialesRappi();
  if (!cred) throw new RappiApagadoError();
  const { nuevo } = dominiosRappi();
  const ruta = `/restaurants/auth/v1/token/login/${tipo}`;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${nuevo}${ruta}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: cred.clientId, client_secret: cred.clientSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    await registrar({
      metodo: 'POST', ruta, contexto: `login ${tipo}`, status: null, ok: false,
      ms: Date.now() - t0, error: describir(e),
    });
    throw new RappiError(`No se pudo hablar con RAPPI para el login: ${describir(e)}`, null, null);
  }
  const ms = Date.now() - t0;
  const texto = await res.text();
  const body = parsear(texto);
  // El cuerpo del login NO se registra: lleva las credenciales de ida y el
  // token de vuelta. Sólo el resultado.
  await registrar({
    metodo: 'POST', ruta, contexto: `login ${tipo}`, status: res.status, ok: res.ok, ms,
    error: res.ok ? null : `RAPPI respondió ${res.status} al login`,
  });
  const token = (body as { access_token?: unknown } | null)?.access_token;
  if (!res.ok || typeof token !== 'string' || !token) {
    throw new RappiError(
      `RAPPI rechazó las credenciales (${res.status}). Revisá RAPPI_CLIENT_ID / RAPPI_CLIENT_SECRET y que el ambiente (${'RAPPI_AMBIENTE'}) sea el de esas credenciales.`,
      res.status,
      body ?? texto,
    );
  }
  const expiresIn = Number((body as { expires_in?: unknown }).expires_in);
  const vida = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 7 * 24 * 3_600_000;
  tokens.set(tipo, { token, expiraAt: Date.now() + vida });
  return token;
}

export async function obtenerToken(tipo: TipoToken = 'integrations'): Promise<string> {
  const c = tokens.get(tipo);
  if (c && c.expiraAt - Date.now() > RENOVAR_ANTES_MS) return c.token;
  return login(tipo);
}

export function invalidarTokens(): void {
  tokens.clear();
}

/** Para el botón "Probar credenciales": fuerza un login y dice cómo fue. */
export async function probarCredenciales(): Promise<{ ok: boolean; detalle: string }> {
  invalidarTokens();
  try {
    await login('integrations');
    return { ok: true, detalle: 'RAPPI aceptó las credenciales y entregó un token.' };
  } catch (e) {
    return { ok: false, detalle: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Llamadas ────────────────────────────────────────────────────────────

export interface LlamadaArgs {
  arbol: ArbolRappi;
  metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sin dominio: `/api/v2/restaurants-integrations-public-api/stores-pa`. */
  ruta: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Para qué se hizo, en criollo. Va al registro. */
  contexto: string;
  ventaId?: string;
  token?: TipoToken;
}

/**
 * Hace la llamada, la registra, y devuelve la respuesta SIN tirar por un
 * status de error: cada capacidad decide qué significa un 404 o un 409 para
 * ella. Sólo tira si RAPPI está apagado o si no se pudo ni hablar.
 */
export async function llamarRappi<T = unknown>(args: LlamadaArgs): Promise<RespuestaRappi<T>> {
  if (!credencialesRappi()) throw new RappiApagadoError();
  const tipo = args.token ?? 'integrations';
  const base = dominiosRappi()[args.arbol];
  const qs = args.query
    ? Object.entries(args.query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const rutaCompleta = qs ? `${args.ruta}?${qs}` : args.ruta;

  const hacer = async (token: string): Promise<{ res: Response; ms: number }> => {
    const t0 = Date.now();
    const res = await fetch(`${base}${rutaCompleta}`, {
      method: args.metodo,
      headers: {
        Accept: 'application/json',
        ...(args.body !== undefined && { 'Content-Type': 'application/json' }),
        // Sí: `x-authorization`, y con dos puntos. Ver el comentario de arriba.
        'x-authorization': `Bearer: ${token}`,
      },
      ...(args.body !== undefined && { body: JSON.stringify(args.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { res, ms: Date.now() - t0 };
  };

  let res: Response;
  let ms: number;
  try {
    ({ res, ms } = await hacer(await obtenerToken(tipo)));
    // Un 401 con token cacheado casi siempre es un token vencido antes de
    // tiempo (rotaron credenciales, o RAPPI lo invalidó): se renueva y se
    // reintenta UNA vez.
    if (res.status === 401 && tokens.has(tipo)) {
      tokens.delete(tipo);
      ({ res, ms } = await hacer(await obtenerToken(tipo)));
    }
  } catch (e) {
    if (e instanceof RappiError || e instanceof RappiApagadoError) throw e;
    await registrar({
      metodo: args.metodo, ruta: rutaCompleta, contexto: args.contexto, ventaId: args.ventaId,
      status: null, ok: false, ms: 0, requestBody: args.body, error: describir(e),
    });
    throw new RappiError(`No se pudo hablar con RAPPI: ${describir(e)}`, null, null);
  }

  const texto = await res.text();
  const body = parsear(texto) as T | null;
  await registrar({
    metodo: args.metodo, ruta: rutaCompleta, contexto: args.contexto, ventaId: args.ventaId,
    status: res.status, ok: res.ok, ms, requestBody: args.body,
    responseBody: body, responseTexto: body === null ? texto : null,
    error: res.ok ? null : `RAPPI respondió ${res.status}`,
  });
  return { status: res.status, ok: res.ok, body, texto: body === null && texto ? texto : null, ms };
}

// ─── Registro ────────────────────────────────────────────────────────────

interface Registro {
  metodo: string;
  ruta: string;
  contexto: string;
  status: number | null;
  ok: boolean;
  ms: number;
  requestBody?: unknown;
  responseBody?: unknown;
  responseTexto?: string | null;
  error?: string | null;
  ventaId?: string;
}

function recortar(v: unknown): { json: unknown; texto: string | null } {
  if (v === undefined || v === null) return { json: null, texto: null };
  const s = JSON.stringify(v);
  if (Buffer.byteLength(s) <= MAX_BYTES_REGISTRO) return { json: v, texto: null };
  return { json: null, texto: `${s.slice(0, MAX_BYTES_REGISTRO)}… (recortado, ${Buffer.byteLength(s)} bytes)` };
}

/** NUNCA tira: un problema para registrar no puede ser el motivo de que falle la llamada. */
async function registrar(r: Registro): Promise<void> {
  try {
    const req = recortar(r.requestBody);
    const resp = recortar(r.responseBody);
    await prisma.llamadaCanal.create({
      data: {
        plataforma: 'RAPPI',
        metodo: r.metodo,
        ruta: r.ruta.slice(0, 300),
        contexto: r.contexto.slice(0, 160),
        status: r.status,
        ok: r.ok,
        ms: r.ms,
        requestBody: req.json === null ? undefined : (req.json as never),
        responseBody: resp.json === null ? undefined : (resp.json as never),
        responseTexto: resp.texto ?? r.responseTexto?.slice(0, MAX_BYTES_REGISTRO) ?? (req.texto ? `(request recortado) ${req.texto}` : null),
        error: r.error ?? null,
        ventaId: r.ventaId ?? null,
      },
    });
    if (Math.random() < 1 / 25) {
      await prisma.$executeRaw`
        DELETE FROM "llamadas_canal"
         WHERE "id" IN (SELECT "id" FROM "llamadas_canal" ORDER BY "hecho_at" DESC OFFSET ${MAX_FILAS_REGISTRO})
      `;
    }
  } catch (e) {
    console.error('[rappi] no se pudo registrar la llamada:', e);
  }
}

function parsear(texto: string): unknown {
  const t = texto.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function describir(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return `sin respuesta en ${TIMEOUT_MS / 1000} s`;
    return e.message;
  }
  return String(e);
}
