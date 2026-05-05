/**
 * Servicio de email — nodemailer.
 *
 * Configuración:
 *   - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS → usa ese SMTP real
 *   - sin SMTP_HOST → cae a Ethereal (https://ethereal.email): inbox de
 *     prueba que devuelve una URL para previsualizar el mail. NO llega a
 *     gmail; sirve para validar que el contenido se generó OK sin tocar
 *     credenciales.
 *
 * Para Gmail (recomendado):
 *   1. Activar verificación en 2 pasos en la cuenta google
 *   2. Crear app password en https://myaccount.google.com/apppasswords
 *   3. Setear en .env:
 *        SMTP_HOST=smtp.gmail.com
 *        SMTP_PORT=587
 *        SMTP_USER=tu@gmail.com
 *        SMTP_PASS=<app password>
 *        SMTP_FROM="Santa Teresita <tu@gmail.com>"
 *        ADMIN_EMAIL_RECIPIENTS=alejolafalce@gmail.com,otra@dom.com
 */

import nodemailer, { type Transporter } from 'nodemailer';

interface MailerConfig {
  from: string;
  recipientsDefault: string[];
  isEthereal: boolean;
}

// Sólo cacheamos el transporter Ethereal (que requiere crear cuenta remota y
// no cambia con env). Para SMTP real no cacheamos: así si el usuario cambia
// SMTP_* en .env, basta reiniciar la API y la próxima llamada usa la nueva config.
let cachedEtherealTransporter: Transporter | null = null;
let cachedEtherealConfig: MailerConfig | null = null;

async function buildTransporter(): Promise<{
  transporter: Transporter;
  config: MailerConfig;
}> {
  const host = process.env.SMTP_HOST;
  const recipientsDefault =
    (process.env.ADMIN_EMAIL_RECIPIENTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  if (host) {
    // Limpiamos el password de espacios (Gmail App Password se muestra con
    // espacios visualmente: "abcd efgh ijkl mnop", pero se debe enviar sin).
    const pass = (process.env.SMTP_PASS ?? '').replace(/\s+/g, '');
    const transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass }
        : undefined,
    });
    const from =
      process.env.SMTP_FROM ??
      `"Santa Teresita Pastas" <${process.env.SMTP_USER ?? 'no-reply@santateresita.local'}>`;
    console.log(
      `[mailer] usando SMTP real: ${host} via ${process.env.SMTP_USER ?? '(sin auth)'}`,
    );
    return {
      transporter,
      config: { from, recipientsDefault, isEthereal: false },
    };
  }

  // Fallback: Ethereal — generamos cuenta temporal una vez y la reusamos
  if (cachedEtherealTransporter && cachedEtherealConfig) {
    return { transporter: cachedEtherealTransporter, config: cachedEtherealConfig };
  }
  console.warn(
    '[mailer] SMTP_HOST no está seteado en .env → usando Ethereal (preview only, NO llega a Gmail real)',
  );
  const test = await nodemailer.createTestAccount();
  const transporter = nodemailer.createTransport({
    host: test.smtp.host,
    port: test.smtp.port,
    secure: test.smtp.secure,
    auth: { user: test.user, pass: test.pass },
  });
  cachedEtherealTransporter = transporter;
  cachedEtherealConfig = {
    from: '"Santa Teresita Pastas (test)" <test@ethereal.email>',
    recipientsDefault: recipientsDefault.length > 0 ? recipientsDefault : [test.user],
    isEthereal: true,
  };
  return { transporter, config: cachedEtherealConfig };
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
  const info = await transporter.sendMail({
    from: config.from,
    to: recipients.join(', '),
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    attachments: opts.attachments,
  });
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
