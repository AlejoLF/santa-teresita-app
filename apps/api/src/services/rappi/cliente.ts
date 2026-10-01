import { prisma } from '@sta/db/client';
import { ambienteRappi, credencialesRappi, dominiosRappi } from './config.js';

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
  /** Algo que conviene saber de cómo se hizo la llamada (p. ej. con qué token). */
  nota?: string;
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

/**
 * Dónde pedir cada token. El de integraciones va al dominio "nuevo" y listo.
 * El de utils (horarios) es otro login con las mismas credenciales, y en DEV
 * no está claro en qué host vive: la tabla del portal dice
 * `microservices.dev.rappi.com`, los ejemplos `api.dev.rappi.com`. Se prueban
 * los dos (el configurado primero) y gana el que entregue token. Con un
 * override de URL (tests, proxy) no se inventan hosts.
 */
function hostsLogin(tipo: TipoToken): string[] {
  const { nuevo, legacy } = dominiosRappi();
  const hosts = [nuevo];
  if (tipo === 'utils') {
    if (ambienteRappi() === 'dev' && nuevo === 'https://api.dev.rappi.com') hosts.push('https://microservices.dev.rappi.com');
    hosts.push(legacy);
  }
  return [...new Set(hosts)];
}

async function loginEn(tipo: TipoToken, host: string): Promise<string> {
  const cred = credencialesRappi();
  if (!cred) throw new RappiApagadoError();
  const ruta = `/restaurants/auth/v1/token/login/${tipo}`;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${host}${ruta}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: cred.clientId, client_secret: cred.clientSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    await registrar({
      metodo: 'POST', ruta, contexto: `login ${tipo} en ${host}`, status: null, ok: false,
      ms: Date.now() - t0, error: describir(e),
    });
    throw new RappiError(`No se pudo hablar con RAPPI (${host}) para el login: ${describir(e)}`, null, null);
  }
  const ms = Date.now() - t0;
  const texto = await res.text();
  const body = parsear(texto);
  // El cuerpo del login NO se registra: lleva las credenciales de ida y el
  // token de vuelta. Sólo el resultado.
  await registrar({
    metodo: 'POST', ruta, contexto: `login ${tipo} en ${host}`, status: res.status, ok: res.ok, ms,
    error: res.ok ? null : `RAPPI respondió ${res.status} al login de ${tipo}`,
  });
  const token = (body as { access_token?: unknown } | null)?.access_token;
  if (!res.ok || typeof token !== 'string' || !token) {
    throw new RappiError(`${host}: ${res.status}`, res.status, body ?? texto);
  }
  const expiresIn = Number((body as { expires_in?: unknown }).expires_in);
  const vida = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 7 * 24 * 3_600_000;
  tokens.set(tipo, { token, expiraAt: Date.now() + vida });
  return token;
}

async function login(tipo: TipoToken): Promise<string> {
  const intentos: string[] = [];
  let ultimo: RappiError | null = null;
  for (const host of hostsLogin(tipo)) {
    try {
      return await loginEn(tipo, host);
    } catch (e) {
      if (!(e instanceof RappiError)) throw e;
      ultimo = e;
      intentos.push(e.message);
    }
  }
  const status = ultimo?.status ?? null;
  // Los dos logins van con las MISMAS credenciales. Si el de integraciones
  // anda y el de utils (horarios) da 401 en todos los hosts, no es la
  // credencial: a la integración le falta el permiso de utils (el portal lo
  // llama scope `create:store_schedules`), y eso lo habilita RAPPI. Verificado
  // el 01/10: con credenciales inventadas los dos logins contestan el mismo
  // 401 `error.auth.unauthorized`, así que el 401 es "no autorizado", no
  // "endpoint equivocado".
  throw new RappiError(
    tipo === 'utils'
      ? `RAPPI rechazó las credenciales para el token de utils (${intentos.join(', ')}), el que exigen los horarios. Si "Probar credenciales" anda, las credenciales están bien: a esta integración le falta el permiso de utils (scope create:store_schedules). Hay que pedírselo a RAPPI (al TAM, o por el Integrations Manager).`
      : `RAPPI rechazó las credenciales (${status ?? 'sin respuesta'}). Revisá RAPPI_CLIENT_ID / RAPPI_CLIENT_SECRET y que el ambiente (RAPPI_AMBIENTE) sea el de esas credenciales.`,
    status,
    ultimo?.cuerpo ?? null,
  );
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
export async function probarCredenciales(): Promise<{ ok: boolean; detalle: string; utils: { ok: boolean; detalle: string } }> {
  invalidarTokens();
  let integraciones: { ok: boolean; detalle: string };
  try {
    await login('integrations');
    integraciones = { ok: true, detalle: 'RAPPI aceptó las credenciales y entregó un token.' };
  } catch (e) {
    integraciones = { ok: false, detalle: e instanceof Error ? e.message : String(e) };
  }
  // El token de utils es el que piden los horarios. Se prueba aparte para que
  // "las credenciales andan pero los horarios no" se vea acá, de una.
  let utils: { ok: boolean; detalle: string };
  try {
    await login('utils');
    utils = { ok: true, detalle: 'RAPPI también entregó el token de utils (horarios).' };
  } catch (e) {
    utils = { ok: false, detalle: e instanceof Error ? e.message : String(e) };
  }
  return {
    ok: integraciones.ok,
    detalle: integraciones.ok ? `${integraciones.detalle} ${utils.detalle}` : integraciones.detalle,
    utils,
  };
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
  let nota: string | undefined;
  // Con qué token se pega. Si el de utils no se consigue (401/403 en todos
  // los hosts), se intenta igual con el de integraciones: el portal dice
  // "Token" a secas para esos endpoints, y si RAPPI lo acepta, listo; si
  // contesta "Access is denied", el registro muestra las dos cosas y el
  // diagnóstico es inequívoco (falta el permiso de utils).
  const tokenPara = async (): Promise<{ token: string; tipo: TipoToken }> => {
    try {
      return { token: await obtenerToken(tipo), tipo };
    } catch (e) {
      if (tipo !== 'utils' || !(e instanceof RappiError) || (e.status !== 401 && e.status !== 403)) throw e;
      nota = `el login de utils dio ${e.status}; se usó el token de integraciones`;
      return { token: await obtenerToken('integrations'), tipo: 'integrations' };
    }
  };
  try {
    const t = await tokenPara();
    ({ res, ms } = await hacer(t.token));
    // Un 401 con token cacheado casi siempre es un token vencido antes de
    // tiempo (rotaron credenciales, o RAPPI lo invalidó): se renueva y se
    // reintenta UNA vez.
    if (res.status === 401 && tokens.has(t.tipo)) {
      tokens.delete(t.tipo);
      ({ res, ms } = await hacer((await tokenPara()).token));
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
    metodo: args.metodo, ruta: rutaCompleta, contexto: nota ? `${args.contexto} (${nota})` : args.contexto, ventaId: args.ventaId,
    status: res.status, ok: res.ok, ms, requestBody: args.body,
    responseBody: body, responseTexto: body === null ? texto : null,
    error: res.ok ? null : `RAPPI respondió ${res.status}`,
  });
  return { status: res.status, ok: res.ok, body, texto: body === null && texto ? texto : null, ms, ...(nota && { nota }) };
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
