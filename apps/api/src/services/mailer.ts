/**
 * Servicio de email — nodemailer.
 *
 * Configuración (en orden de prioridad):
 *   1. Tabla `configuracion_sistema` con claves smtp_host, smtp_port,
 *      smtp_user, smtp_pass, smtp_from, smtp_secure. La encargada edita
 *      desde /admin/configuracion/usuarios sin tocar .env.
 *   2. Variables de entorno SMTP_HOST, SMTP_PORT, etc. (fallback dev).
 *   3. Si no hay host configurado por ningún medio → Ethereal preview-only.
 *
 * Para Gmail (recomendado):
 *   1. Activar verificación en 2 pasos en la cuenta google.
 *   2. Crear app password en https://myaccount.google.com/apppasswords.
 *   3. Cargar desde la UI admin: host=smtp.gmail.com, port=587, user=...,
 *      pass=<app password>.
 */

import nodemailer, { type Transporter } from 'nodemailer';

interface MailerConfig {
  from: string;
  recipientsDefault: string[];
  isEthereal: boolean;
}

// Sólo cacheamos el transporter Ethereal (que requiere crear cuenta remota y
// no cambia con env). Para SMTP real no cacheamos: así si la encargada
// actualiza el SMTP por la UI, basta esperar el próximo send.
let cachedEtherealTransporter: Transporter | null = null;
let cachedEtherealConfig: MailerConfig | null = null;

interface SmtpDbConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

/**
 * Timeouts explícitos. SIN esto nodemailer usa sus defaults —connectionTimeout
 * 2 min, socketTimeout 10 min— y un puerto SMTP bloqueado (router del local,
 * ISP) deja el request colgado minutos: la encargada ve el spinner eterno y el
 * navegador corta con "timeout" sin decir nunca qué falló. Incidente real:
 * el reenvío del cierre desde /admin/cierres no salía y no había diagnóstico.
 *
 * Preferimos fallar en ~8s con un mensaje accionable antes que "cargando".
 * socketTimeout es más holgado porque el adjunto (Excel del cierre) se sube
 * por ahí y el uplink del local puede ser lento.
 */
const SMTP_TIMEOUTS = {
  connectionTimeout: 8_000,
  greetingTimeout: 8_000,
  socketTimeout: 30_000,
} as const;

/**
 * Traduce el error crudo de nodemailer/Node a algo que se pueda leer desde la
 * UI y accionar sin mirar logs. El código viene en `err.code`.
 */
export function describirErrorSmtp(e: unknown): string {
  const err = e as { code?: string; responseCode?: number; message?: string };
  const code = err?.code ?? '';
  const detalle = err?.message ? ` (${err.message})` : '';
  switch (code) {
    case 'ETIMEDOUT':
    case 'ESOCKET':
      return `No se pudo conectar al servidor de correo: se agotó el tiempo de espera. Casi siempre es el puerto SMTP bloqueado en la red del local (probá el otro puerto: 587 o 465) o el host mal cargado.${detalle}`;
    case 'ECONNREFUSED':
      return `El servidor de correo rechazó la conexión. Revisá host y puerto en Configuración.${detalle}`;
    case 'ENOTFOUND':
    case 'EDNS':
      return `No se encontró el servidor de correo (host inexistente). Revisá que diga exactamente smtp.gmail.com.${detalle}`;
    case 'EAUTH':
      return `El servidor rechazó usuario o contraseña. Con Gmail hay que usar una "app password" de 16 caracteres, no la clave normal de la cuenta.${detalle}`;
    case 'EENVELOPE':
      return `Alguna dirección de destino es inválida.${detalle}`;
    default:
      return err?.message ?? 'Error desconocido enviando el email';
  }
}

/**
 * Lee la config SMTP de `configuracion_sistema` y completa con .env como
 * fallback campo a campo. Devuelve null si NI la DB NI el env tienen host
 * — en ese caso se cae a Ethereal preview.
 */
async function loadSmtpConfig(): Promise<SmtpDbConfig | null> {
  const { prisma } = await import('@sta/db/client');
  const claves = [
    'smtp_host',
    'smtp_port',
    'smtp_user',
    'smtp_pass',
    'smtp_from',
    'smtp_secure',
  ];
  const rows = await prisma.configuracionSistema
    .findMany({ where: { clave: { in: claves } } })
    .catch(() => [] as Array<{ clave: string; valor: string }>);
  const get = (k: string) => rows.find((r) => r.clave === k)?.valor?.trim() ?? '';

  const host = get('smtp_host') || process.env.SMTP_HOST || '';
  if (!host) return null;

  const portRaw = get('smtp_port') || process.env.SMTP_PORT || '587';
  const user = get('smtp_user') || process.env.SMTP_USER || '';
  const pass = (get('smtp_pass') || process.env.SMTP_PASS || '').replace(/\s+/g, '');
  const fromConf = get('smtp_from') || process.env.SMTP_FROM || '';
  // Si el from viene con <> vacío, usamos smtp_user adentro de los <>.
  const from = fromConf.replace('<>', `<${user}>`) || `"Santa Teresita Pastas" <${user || 'no-reply@santateresita.local'}>`;
  const port = Number(portRaw) || 587;
  // `secure` se DERIVA del puerto, no del flag guardado. Es el footgun más
  // común: marcar "TLS implícito" con puerto 587 (o no marcarlo con 465) deja
  // la conexión rota y el mail no sale sin error claro. La regla es fija:
  //   465 → TLS implícito (secure=true)
  //   587 / 25 / otros → STARTTLS (secure=false)
  // Así la casilla de la UI no puede romper el envío.
  const secure = port === 465;

  return { host, port, user, pass, from, secure };
}

async function buildTransporter(): Promise<{
  transporter: Transporter;
  config: MailerConfig;
}> {
  // Destinatarios: primero buscamos en ConfiguracionSistema (panel UI),
  // sino fallback al ENV. La encargada configura desde /admin/configuracion/
  // usuarios — no hace falta editar .env y rebuildear.
  const { prisma } = await import('@sta/db/client');
  const dbConfig = await prisma.configuracionSistema
    .findUnique({ where: { clave: 'cierre_email_recipients' } })
    .catch(() => null);
  const fromDb = dbConfig?.valor
    ? dbConfig.valor.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const recipientsDefault =
    fromDb.length > 0
      ? fromDb
      : (process.env.ADMIN_EMAIL_RECIPIENTS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  const smtp = await loadSmtpConfig();
  if (smtp) {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      ...SMTP_TIMEOUTS,
    });
    console.log(
      `[mailer] SMTP real: ${smtp.host}:${smtp.port} via ${smtp.user || '(sin auth)'}`,
    );
    return {
      transporter,
      config: { from: smtp.from, recipientsDefault, isEthereal: false },
    };
  }

  // Fallback: Ethereal — generamos cuenta temporal una vez y la reusamos.
  // Esto SIRVE para validar contenido del email en dev sin SMTP real, pero
  // NUNCA llega a Gmail. Si la encargada ve "Ethereal" en /admin/configuracion,
  // significa que falta cargar SMTP.
  if (cachedEtherealTransporter && cachedEtherealConfig) {
    return { transporter: cachedEtherealTransporter, config: cachedEtherealConfig };
  }
  console.warn(
    '[mailer] SMTP no configurado (ni en DB ni en env) → Ethereal preview (NO llega a Gmail)',
  );
  const test = await nodemailer.createTestAccount();
  const transporter = nodemailer.createTransport({
    host: test.smtp.host,
    port: test.smtp.port,
    secure: test.smtp.secure,
    auth: { user: test.user, pass: test.pass },
    ...SMTP_TIMEOUTS,
  });
  cachedEtherealTransporter = transporter;
  cachedEtherealConfig = {
    from: '"Santa Teresita Pastas (test)" <test@ethereal.email>',
    recipientsDefault: recipientsDefault.length > 0 ? recipientsDefault : [test.user],
    isEthereal: true,
  };
  return { transporter, config: cachedEtherealConfig };
}

/**
 * Devuelve el estado de configuración actual (sin password). Útil para que
 * la UI muestre "SMTP configurado correctamente" o un warning de Ethereal.
 */
export async function getMailerStatus(): Promise<{
  modo: 'smtp' | 'ethereal';
  host: string | null;
  user: string | null;
  destinatarios: string[];
  passConfigurado: boolean;
}> {
  const { prisma } = await import('@sta/db/client');
  const dbConfig = await prisma.configuracionSistema
    .findUnique({ where: { clave: 'cierre_email_recipients' } })
    .catch(() => null);
  const dest = dbConfig?.valor
    ? dbConfig.valor.split(',').map((s) => s.trim()).filter(Boolean)
    : (process.env.ADMIN_EMAIL_RECIPIENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const smtp = await loadSmtpConfig();
  return {
    modo: smtp ? 'smtp' : 'ethereal',
    host: smtp?.host ?? null,
    user: smtp?.user ?? null,
    destinatarios: dest,
    passConfigurado: !!smtp?.pass,
  };
}

export interface SendMailOpts {
  to?: string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}

export interface SendMailResult {
  ok: boolean;
  messageId: string;
  /** URL de preview cuando se usa Ethereal (no aplica a SMTP real). */
  previewUrl: string | null;
  recipients: string[];
  isEthereal: boolean;
}

export async function sendMail(opts: SendMailOpts): Promise<SendMailResult> {
  const { transporter, config } = await buildTransporter();
  const recipients = opts.to ?? config.recipientsDefault;
  if (recipients.length === 0) {
    throw new Error(
      'No hay destinatarios. Setea ADMIN_EMAIL_RECIPIENTS o pasá to[] explícito.',
    );
  }
  // Re-lanzamos con un mensaje accionable: la ruta que llama devuelve
  // `e.message` al cliente, así que acá es donde se decide qué lee la
  // encargada cuando el envío falla.
  let info;
  try {
    info = await transporter.sendMail({
      from: config.from,
      to: recipients.join(', '),
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      attachments: opts.attachments,
    });
  } catch (e) {
    // Mensaje legible, PERO conservando code/command/response: /admin/email/test
    // los devuelve al cliente para diagnóstico y no queremos degradarlo.
    const err = new Error(describirErrorSmtp(e), { cause: e }) as Error &
      Record<string, unknown>;
    const orig = e as Record<string, unknown>;
    for (const k of ['code', 'command', 'response', 'responseCode'] as const) {
      if (orig?.[k] !== undefined) err[k] = orig[k];
    }
    throw err;
  }
  const previewUrl = config.isEthereal
    ? (nodemailer.getTestMessageUrl(info) as string | false) || null
    : null;
  return {
    ok: true,
    messageId: info.messageId,
    previewUrl: previewUrl ?? null,
    recipients,
    isEthereal: config.isEthereal,
  };
}

/**
 * Test rápido — útil para validar que el SMTP está bien configurado.
 */
export async function sendTestEmail(to?: string): Promise<SendMailResult> {
  return sendMail({
    to: to ? [to] : undefined,
    subject: 'Test — Santa Teresita Pastas',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; padding: 16px;">
        <h2 style="color: #1B3A2B;">🍝 Santa Teresita Pastas</h2>
        <p>Si recibís este email, el SMTP está configurado correctamente.</p>
        <p style="color: #777; font-size: 12px;">
          Enviado desde el servidor en ${new Date().toLocaleString('es-AR')}.
        </p>
      </div>`,
  });
}
