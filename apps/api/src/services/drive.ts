/**
 * Google Drive: leer y escribir los Excels de la encargada SIN archivos locales.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────
 *
 * Antes los Excels tenían que estar en un disco: rclone los bajaba a S1 y sólo
 * la API de S1 podía verlos. Eso significaba que la misma pantalla funcionaba o
 * no según a qué servidor le pegara — andaba en el local y fallaba en la nube.
 *
 * Pidiéndoselos a Drive en el momento, funciona igual desde Railway, desde una
 * caja y desde el celular. Y de paso desaparecen rclone, la tarea programada y
 * `EXCEL_LOCAL_DIR`.
 *
 * ── Por qué a mano y no con `googleapis` ──────────────────────────────────
 *
 * El paquete oficial pesa decenas de MB y esta API se empaqueta dentro del .exe
 * que se auto-actualiza en las cajas. Lo único que hace falta es firmar un JWT
 * (RS256, que `node:crypto` ya hace), canjearlo por un access token y llamar
 * tres endpoints REST. Son ~60 líneas contra una dependencia enorme.
 *
 * ── Service account, no la cuenta de una persona ──────────────────────────
 *
 * Una service account tiene su propio mail; la encargada le comparte los
 * archivos como se los compartiría a cualquiera. Ventaja sobre usar la cuenta
 * de alguien: no vence, no depende de que esa persona siga teniendo acceso, y
 * si se rota la credencial no hay que volver a pedirle permiso a nadie.
 */

import { createSign } from 'node:crypto';
import { ReglaNegocioError } from './errores.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

/** MIME de una hoja nativa de Google (no es un .xlsx: hay que exportarla). */
const MIME_GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface CredencialesSA {
  client_email: string;
  private_key: string;
}

function leerCredenciales(): CredencialesSA | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  try {
    // Se acepta el JSON crudo o en base64: pegar un JSON multilínea en una
    // variable de entorno de Railway funciona, pero se rompe fácil al copiar.
    const txt = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(txt) as CredencialesSA;
    if (!j.client_email || !j.private_key) return null;
    // Las claves pegadas a mano suelen quedar con \n literales.
    return { client_email: j.client_email, private_key: j.private_key.replace(/\\n/g, '\n') };
  } catch {
    return null;
  }
}

/**
 * ¿Está Drive completamente configurado?
 *
 * Hacen falta las DOS variables. Con una sola, `configuracionIncompleta()`
 * devuelve el motivo: caer a disco en silencio con media configuración puesta
 * significaría leer un archivo viejo sin que nadie se entere, que es justo lo
 * que este cambio vino a eliminar.
 */
export function driveConfigurado(): boolean {
  return leerCredenciales() !== null && !!process.env.GOOGLE_DRIVE_FOLDER_ID;
}

/** Si está a medio configurar, qué falta. `null` si está entera o vacía. */
export function configuracionIncompleta(): string | null {
  const cred = leerCredenciales();
  const carpeta = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const credCruda = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (credCruda && !cred) {
    return 'GOOGLE_SERVICE_ACCOUNT_JSON está seteada pero no se pudo leer: tiene que ser el JSON de la service account (crudo o en base64) con client_email y private_key.';
  }
  if (cred && !carpeta) {
    return 'Falta GOOGLE_DRIVE_FOLDER_ID: está la credencial de Google pero no la carpeta donde buscar los Excels.';
  }
  if (carpeta && !cred) {
    return 'Falta GOOGLE_SERVICE_ACCOUNT_JSON: está la carpeta de Drive pero no la credencial para entrar.';
  }
  return null;
}

/** Mail de la service account, para poder decirle a quién compartirle. */
export function driveCuenta(): string | null {
  return leerCredenciales()?.client_email ?? null;
}

function b64url(b: Buffer | string): string {
  return Buffer.from(b)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

let tokenCache: { token: string; venceEn: number } | null = null;

/**
 * Access token, cacheado.
 *
 * Google los da por una hora; se renueva a los 55 min. Sin cache, cada lectura
 * del Excel haría dos llamadas en vez de una.
 */
async function accessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.venceEn) return tokenCache.token;

  const cred = leerCredenciales();
  if (!cred) {
    throw new ReglaNegocioError(
      'Falta la credencial de Google Drive (GOOGLE_SERVICE_ACCOUNT_JSON). Sin eso no se pueden leer los Excels.',
      503,
    );
  }

  const ahora = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: cred.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: TOKEN_URL,
      iat: ahora,
      exp: ahora + 3600,
    }),
  );
  const firma = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(cred.private_key);
  const jwt = `${header}.${claims}.${b64url(firma)}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new ReglaNegocioError(
      `Google rechazó la credencial: ${body.error_description ?? body.error ?? res.status}. Revisá GOOGLE_SERVICE_ACCOUNT_JSON.`,
      503,
    );
  }
  tokenCache = { token: body.access_token, venceEn: Date.now() + 55 * 60 * 1000 };
  return body.access_token;
}

async function drive(path: string, init?: RequestInit): Promise<Response> {
  const token = await accessToken();
  return fetch(`${DRIVE_API}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

export interface ArchivoDrive {
  id: string;
  nombre: string;
  mimeType: string;
  /** Es una hoja nativa de Google: hay que exportarla, no bajarla. */
  esHojaGoogle: boolean;
}

/**
 * Busca un archivo por nombre dentro de la carpeta configurada.
 *
 * El nombre en Drive puede venir con o sin `.xlsx` según cómo se haya subido,
 * así que se prueban las dos formas antes de darse por vencido — si no, el
 * mismo archivo "no existe" según cómo lo llamó quien lo subió.
 */
export async function buscarArchivo(nombre: string): Promise<ArchivoDrive | null> {
  const carpeta = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!carpeta) {
    throw new ReglaNegocioError(
      'Falta GOOGLE_DRIVE_FOLDER_ID: la carpeta de Drive donde están los Excels.',
      503,
    );
  }
  const sinExt = nombre.replace(/\.xlsx$/i, '');
  const nombres = [nombre, sinExt];
  const q = [
    `'${carpeta}' in parents`,
    'trashed = false',
    `(${nombres.map((n) => `name = '${n.replace(/'/g, "\\'")}'`).join(' or ')})`,
  ].join(' and ');

  const res = await drive(
    `/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
  );
  if (!res.ok) {
    const t = await res.text();
    throw new ReglaNegocioError(`Drive respondió ${res.status} al buscar "${nombre}": ${t.slice(0, 200)}`, 503);
  }
  const body = (await res.json()) as { files?: Array<{ id: string; name: string; mimeType: string }> };
  const f = body.files?.[0];
  if (!f) return null;
  return {
    id: f.id,
    nombre: f.name,
    mimeType: f.mimeType,
    esHojaGoogle: f.mimeType === MIME_GOOGLE_SHEET,
  };
}

/**
 * Baja el archivo como `.xlsx`.
 *
 * Si es una hoja nativa de Google se exporta al vuelo; si ya es un `.xlsx` se
 * baja tal cual. Para quien llama es lo mismo: recibe bytes que exceljs abre.
 */
export async function descargarXlsx(f: ArchivoDrive): Promise<Buffer> {
  const path = f.esHojaGoogle
    ? `/files/${f.id}/export?mimeType=${encodeURIComponent(MIME_XLSX)}`
    : `/files/${f.id}?alt=media&supportsAllDrives=true`;
  const res = await drive(path);
  if (!res.ok) {
    const t = await res.text();
    throw new ReglaNegocioError(
      `No se pudo bajar "${f.nombre}" de Drive (${res.status}): ${t.slice(0, 200)}`,
      503,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Sube una versión nueva del archivo, PISANDO el contenido.
 *
 * Drive guarda el historial de versiones, así que si algo sale mal se puede
 * volver atrás desde la propia interfaz de Drive — red de seguridad que el
 * archivo en disco no tenía.
 *
 * No sirve para hojas nativas de Google: subir un .xlsx encima convertiría el
 * archivo y rompería las fórmulas. Se rechaza explícito en vez de hacerlo.
 */
export async function subirXlsx(f: ArchivoDrive, contenido: Buffer): Promise<void> {
  if (f.esHojaGoogle) {
    throw new ReglaNegocioError(
      `"${f.nombre}" es una hoja de Google, no un archivo Excel. Escribirle un .xlsx encima la convertiría y se perderían las fórmulas.`,
    );
  }
  const token = await accessToken();
  const res = await fetch(
    `${UPLOAD_API}/files/${f.id}?uploadType=media&supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': MIME_XLSX },
      body: new Uint8Array(contenido),
    },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new ReglaNegocioError(
      `No se pudo guardar "${f.nombre}" en Drive (${res.status}): ${t.slice(0, 200)}`,
      503,
    );
  }
}
