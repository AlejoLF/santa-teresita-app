import { prisma, createPrismaClientForUrl, type PrismaClient } from '@sta/db/client';
import { config } from '../config.js';
import { cargarCierre, generarExcelCierre, generarHtmlCierre } from './cierre-export.js';
import { sendMail, describirErrorSmtp } from './mailer.js';

/**
 * Cola del email del cierre de caja (23/11).
 *
 * ─── Por qué ──────────────────────────────────────────────────────────────
 * Dos fallas con el mismo origen —el envío corría DENTRO del request—:
 *   1. En la caja, la cajera tocaba "Enviar por email" (o cerraba la caja, que
 *      lo dispara solo) y cerraba el programa al toque: el envío moría con el
 *      proceso y el cierre no llegaba.
 *   2. Desde el celular la app va contra el API de la nube (Railway), y
 *      Railway BLOQUEA el SMTP saliente (puertos 25/465/587) en el plan Hobby:
 *      "Connection timeout" siempre.
 *
 * ─── Cómo ─────────────────────────────────────────────────────────────────
 * Pedir el envío = dejar una fila en `envios_email_cierre` (instantáneo, y
 * queda aunque se cierre todo). El que MANDA es S1 (`STA_ROLE=server`):
 * siempre prendido y con SMTP por la red del local. Cada 15 s procesa:
 *   - la cola de su base (pedidos de las cajas, directo o vía proxy);
 *   - la cola de Supabase (pedidos del celular), con el mismo cliente que usa
 *     el replicator. El cierre lo arma con los datos de SU base, que es la
 *     fuente de verdad; al mandar, marca la sesión en las dos bases para que
 *     el celular vea "enviado".
 * Reintenta con espera creciente; después de MAX_INTENTOS queda en ERROR con
 * el motivo a la vista en /admin/cierres.
 */

const TICK_MS = 15_000;
const MAX_INTENTOS = 20;
/** Minutos de espera antes del intento n (1-based). */
const ESPERA_MIN = [1, 2, 5, 10, 15, 30, 60];

type Origen = 'caja' | 'server' | 'cloud';

export function origenActual(): Origen {
  return config.STA_ROLE === 'server' ? 'server' : config.STA_ROLE === 'cloud' ? 'cloud' : 'caja';
}

/** ¿Este proceso es el que manda los emails? */
export function procesaLaCola(): boolean {
  return config.STA_ROLE === 'server';
}

/**
 * Deja el envío en la cola. Si ya hay uno PENDIENTE para la misma sesión y los
 * mismos destinatarios, devuelve ése (dos toques no mandan dos mails).
 */
export async function encolarEmailCierre(args: {
  sesionId: string;
  destinatarios?: string[];
  usuarioId?: string | null;
  automatico?: boolean;
  client?: PrismaClient;
}) {
  const db = args.client ?? prisma;
  const destinatarios = [...new Set((args.destinatarios ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
  const pendientes = await db.envioEmailCierre.findMany({
    where: { sesionCajaId: args.sesionId, estado: 'PENDIENTE' },
  });
  const igual = pendientes.find((p) => [...p.destinatarios].sort().join(',') === destinatarios.join(','));
  if (igual) return igual;
  return db.envioEmailCierre.create({
    data: {
      sesionCajaId: args.sesionId,
      destinatarios,
      origen: origenActual(),
      automatico: args.automatico ?? false,
      solicitadoPorId: args.usuarioId ?? null,
    },
  });
}

/** El último envío pedido para cada sesión (para mostrar el estado). */
export async function ultimoEnvioPorSesion(sesionIds: string[]) {
  if (sesionIds.length === 0) return new Map<string, EstadoEnvio>();
  const filas = await prisma.envioEmailCierre.findMany({
    where: { sesionCajaId: { in: sesionIds } },
    orderBy: { creadoAt: 'desc' },
  });
  const m = new Map<string, EstadoEnvio>();
  for (const f of filas) if (!m.has(f.sesionCajaId)) m.set(f.sesionCajaId, vistaEnvio(f));
  return m;
}

export interface EstadoEnvio {
  id: string;
  estado: string;
  intentos: number;
  ultimoError: string | null;
  proximoIntentoAt: Date;
  creadoAt: Date;
  enviadoAt: Date | null;
  enviadoA: string | null;
}

function vistaEnvio(f: {
  id: string;
  estado: string;
  intentos: number;
  ultimoError: string | null;
  proximoIntentoAt: Date;
  creadoAt: Date;
  enviadoAt: Date | null;
  enviadoA: string | null;
}): EstadoEnvio {
  return {
    id: f.id,
    estado: f.estado,
    intentos: f.intentos,
    ultimoError: f.ultimoError,
    proximoIntentoAt: f.proximoIntentoAt,
    creadoAt: f.creadoAt,
    enviadoAt: f.enviadoAt,
    enviadoA: f.enviadoA,
  };
}

/** Arma el cierre (Excel + HTML) con la base de este proceso y lo manda. */
export async function mandarCierre(sesionId: string, destinatarios: string[] = []) {
  const data = await cargarCierre(sesionId);
  const xlsx = await generarExcelCierre(data);
  const { subject, html, text } = generarHtmlCierre(data);
  const fechaSlug = data.sesion.fecha.toISOString().slice(0, 10);
  return sendMail({
    ...(destinatarios.length > 0 && { to: destinatarios }),
    subject,
    html,
    text,
    attachments: [
      {
        filename: `cierre-${fechaSlug}-${data.sesion.turno.toLowerCase()}.xlsx`,
        content: xlsx,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ],
  });
}

/** ¿La base todavía no tiene la tabla de la cola? (migración sin aplicar) */
export function faltaTablaCola(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2021';
}

/**
 * Manda UN envío de la cola de `db`. El cierre se arma siempre con la base de
 * este proceso (en S1, la fuente de verdad). Devuelve el estado resultante.
 */
export async function procesarEnvio(
  envioId: string,
  db: PrismaClient = prisma,
  extraSesion?: PrismaClient | null,
): Promise<EstadoEnvio | null> {
  const envio = await db.envioEmailCierre.findUnique({ where: { id: envioId } });
  if (!envio || envio.estado !== 'PENDIENTE') return envio ? vistaEnvio(envio) : null;

  // Reclamar el intento (si otro tick ya lo tomó, no lo mandamos dos veces).
  const intento = envio.intentos + 1;
  const espera = ESPERA_MIN[Math.min(intento - 1, ESPERA_MIN.length - 1)]!;
  const reclamado = await db.envioEmailCierre.updateMany({
    where: { id: envio.id, estado: 'PENDIENTE', intentos: envio.intentos },
    data: { intentos: intento, proximoIntentoAt: new Date(Date.now() + espera * 60_000) },
  });
  if (reclamado.count === 0) return null;

  try {
    const sesion = await prisma.sesionCaja.findUnique({ where: { id: envio.sesionCajaId }, select: { estado: true } });
    if (!sesion) throw new Error('La sesión todavía no está en el servidor del local (se reintenta cuando llegue).');
    if (sesion.estado === 'ABIERTA') throw new Error('La sesión sigue abierta: se manda cuando se cierre.');

    const result = await mandarCierre(envio.sesionCajaId, envio.destinatarios);
    if (result.isEthereal) {
      throw Object.assign(new Error('El correo no está configurado (Configuración → Usuarios → Email).'), {
        sinReintento: true,
      });
    }
    const enviadoA = result.recipients.join(', ');
    const ahora = new Date();
    const fin = await db.envioEmailCierre.update({
      where: { id: envio.id },
      data: { estado: 'ENVIADO', enviadoAt: ahora, enviadoA, ultimoError: null },
    });
    // La sesión "enviada" en las dos bases: el celular lee Supabase.
    for (const c of [prisma, db, extraSesion].filter((x, i, a): x is PrismaClient => !!x && a.indexOf(x) === i)) {
      await c.sesionCaja
        .updateMany({ where: { id: envio.sesionCajaId }, data: { emailEnviadoA: enviadoA, emailEnviadoAt: ahora } })
        .catch((e) => console.warn(`[email-cierre] no se pudo marcar la sesión: ${String(e)}`));
    }
    console.log(`[email-cierre] ${envio.sesionCajaId} → ${enviadoA} (intento ${intento})`);
    return vistaEnvio(fin);
  } catch (e) {
    // sendMail ya tira el mensaje traducido (describirErrorSmtp): no repetirlo.
    const mensaje = e instanceof Error ? e.message : describirErrorSmtp(e);
    const agotado = intento >= MAX_INTENTOS || !!(e as { sinReintento?: boolean })?.sinReintento;
    const fin = await db.envioEmailCierre.update({
      where: { id: envio.id },
      data: { ultimoError: mensaje.slice(0, 1000), ...(agotado && { estado: 'ERROR' }) },
    });
    console.warn(`[email-cierre] ${envio.sesionCajaId} intento ${intento} falló: ${mensaje}`);
    return vistaEnvio(fin);
  }
}

async function procesarCola(db: PrismaClient, extraSesion: PrismaClient | null, etiqueta: string): Promise<void> {
  const listos = await db.envioEmailCierre.findMany({
    where: { estado: 'PENDIENTE', proximoIntentoAt: { lte: new Date() } },
    orderBy: { creadoAt: 'asc' },
    take: 5,
    select: { id: true },
  });
  for (const { id } of listos) {
    try {
      await procesarEnvio(id, db, extraSesion);
    } catch (e) {
      console.warn(`[email-cierre] (${etiqueta}) error procesando ${id}: ${String(e)}`);
    }
  }
}

let corriendo = false;
let nube: PrismaClient | null = null;

/** Arranca el procesador. Sólo en S1; en cajas y en la nube no hace nada. */
export function startColaEmailCierre(): void {
  if (!procesaLaCola()) return;
  if (config.REPLICATE_TO_URL) nube = createPrismaClientForUrl(config.REPLICATE_TO_URL);
  console.log(`[email-cierre] cola activa (local${nube ? ' + nube' : ''}, cada ${TICK_MS / 1000}s)`);
  setInterval(() => {
    if (corriendo) return;
    corriendo = true;
    void (async () => {
      try {
        await procesarCola(prisma, nube, 'local');
        // Si Supabase todavía no tiene la tabla (Cloud Migrate pendiente) o no
        // responde, se ignora: la cola local sigue andando.
        if (nube) await procesarCola(nube, prisma, 'nube').catch(() => {});
      } finally {
        corriendo = false;
      }
    })();
  }, TICK_MS);
}
