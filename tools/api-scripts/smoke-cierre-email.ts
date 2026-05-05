/**
 * Smoke test: agarra el último cierre cerrado y manda el email.
 * Si no hay SMTP configurado, usa Ethereal y muestra la URL de preview.
 */

import { prisma } from '@sta/db/client';
import { cargarCierre, generarExcelCierre, generarHtmlCierre } from '../services/cierre-export.js';
import { sendMail } from '../services/mailer.js';

async function main() {
  const args = process.argv.slice(2);
  const toArg = args.find((a) => a.startsWith('--to='))?.split('=')[1];

  const sesion = await prisma.sesionCaja.findFirst({
    where: { estado: { in: ['CERRADA', 'APROBADA'] } },
    orderBy: { fecha: 'desc' },
  });
  if (!sesion) {
    console.error('No hay sesiones cerradas. Corré primero generar-dia-prueba.ts');
    process.exit(1);
  }

  console.log(
    `▸ Generando email para sesión ${sesion.fecha.toISOString().slice(0, 10)} ${sesion.turno}`,
  );

  const data = await cargarCierre(sesion.id);
  console.log(
    `  ✓ ${data.resumen.ventasFinalizadas} ventas, total ${data.resumen.totalCobrado.toFixed(2)}, ${data.movimientos.length} movs`,
  );

  const xlsx = await generarExcelCierre(data);
  console.log(`  ✓ Excel generado (${(xlsx.length / 1024).toFixed(1)} KB)`);

  const { subject, html, text } = generarHtmlCierre(data);
  const fechaSlug = data.sesion.fecha.toISOString().slice(0, 10);
  const turnoSlug = data.sesion.turno.toLowerCase();

  const result = await sendMail({
    to: toArg ? [toArg] : undefined,
    subject,
    html,
    text,
    attachments: [
      {
        filename: `cierre-${fechaSlug}-${turnoSlug}.xlsx`,
        content: xlsx,
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ],
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✓ Email enviado');
  console.log('  Destinatarios:', result.recipients.join(', '));
  console.log('  messageId:', result.messageId);
  if (result.isEthereal) {
    console.log('\n  📬 Modo Ethereal (no llega a Gmail real).');
    console.log('  Preview URL:', result.previewUrl);
    console.log(
      '\n  Para enviar a un Gmail real, configurá SMTP_* en .env y volvé a correr.',
    );
  }
  process.exit(0);
}

void main().catch((e) => {
  console.error('❌ Error:', e);
  process.exit(1);
});
