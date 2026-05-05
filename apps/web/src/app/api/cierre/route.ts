/**
 * Route handler que envía el cierre de caja por email.
 * Se invoca desde el modo demo cuando la encargada cierra caja:
 * recibe el resumen de la jornada y dispara emails a destinatarios fijos.
 *
 * Variables requeridas en Vercel:
 *   RESEND_API_KEY  → key de resend.com (free tier)
 *   CIERRE_TO       → emails destino, separados por coma
 *                     (default: encargada@example.com,alejolafalce@gmail.com)
 *   CIERRE_FROM     → email remitente (default: onboarding@resend.dev)
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CierrePayload {
  fecha: string;
  turno: string;
  cantidadVentas: number;
  totalDelDia: string;
  desgloseEfectivo: { mostrador: string; damian: string; plataformas: string };
  desgloseTarjeta: { debito: string; credito: string; mpQr: string; transferencia: string };
  porCanal: Array<{ canal: string; monto: string; cantidad: number }>;
  aportes: { total: string; cantidad: number; items: Array<{ categoria: string; monto: string; descripcion: string }> };
  egresos: { total: string; cantidad: number; items: Array<{ categoria: string; monto: string; descripcion: string }> };
  comentario?: string;
  enviadoPor?: string;
}

function fmtMoney(v: string | number): string {
  const n = Number(v);
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(n) ? n : 0);
}

function buildEmailHtml(p: CierrePayload): string {
  const fecha = new Date(p.fecha).toLocaleDateString('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const seccionDesglose = (titulo: string, filas: Array<[string, string]>) => `
    <table style="width:100%; border-collapse:collapse; margin:8px 0;">
      <thead>
        <tr><th colspan="2" style="text-align:left; padding:8px 0; font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#7a7367; border-bottom:1px solid #ddd;">${titulo}</th></tr>
      </thead>
      <tbody>
        ${filas.map(([label, value]) => `
          <tr>
            <td style="padding:6px 0; font-size:14px; color:#3d3a35;">${label}</td>
            <td style="padding:6px 0; font-size:14px; text-align:right; font-family:monospace; color:#16181a;">${value}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  const totalEfectivo =
    Number(p.desgloseEfectivo.mostrador) +
    Number(p.desgloseEfectivo.damian) +
    Number(p.desgloseEfectivo.plataformas);

  const totalTarjeta =
    Number(p.desgloseTarjeta.debito) +
    Number(p.desgloseTarjeta.credito) +
    Number(p.desgloseTarjeta.mpQr) +
    Number(p.desgloseTarjeta.transferencia);

  return `
<!DOCTYPE html>
<html lang="es-AR">
  <head>
    <meta charset="utf-8" />
    <title>Cierre de Caja — ${fecha}</title>
  </head>
  <body style="margin:0; padding:0; background:#FAF8F3; font-family: 'Helvetica Neue', Arial, sans-serif; color:#16181a;">
    <div style="max-width:640px; margin:0 auto; padding:32px 24px;">
      <div style="text-align:center; margin-bottom:24px;">
        <div style="font-size:32px; margin-bottom:4px;">🍝</div>
        <h1 style="margin:0; font-size:22px; color:#1a3a1a; letter-spacing:0.5px;">SANTA TERESITA</h1>
        <p style="margin:4px 0 0; font-size:13px; color:#7a7367; font-style:italic;">Cierre de Caja</p>
      </div>

      <div style="background:white; border:1px solid #DDD7CB; border-radius:8px; padding:24px; margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; border-bottom:1px solid #eee; padding-bottom:12px; margin-bottom:16px;">
          <div>
            <div style="font-size:11px; text-transform:uppercase; color:#7a7367; letter-spacing:1px;">Fecha · Turno</div>
            <div style="font-size:16px; color:#16181a; margin-top:2px;">${fecha} · ${p.turno}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:11px; text-transform:uppercase; color:#7a7367; letter-spacing:1px;">Total del día</div>
            <div style="font-size:22px; color:#1a3a1a; font-weight:600; margin-top:2px;">${fmtMoney(p.totalDelDia)}</div>
            <div style="font-size:12px; color:#7a7367;">${p.cantidadVentas} ventas</div>
          </div>
        </div>

        ${seccionDesglose('💵 Cobrado en efectivo', [
          ['🏪 Mostrador', fmtMoney(p.desgloseEfectivo.mostrador)],
          ['🛵 Damián (delivery propio)', fmtMoney(p.desgloseEfectivo.damian)],
          ['📱 Plataformas (Pedidos YA)', fmtMoney(p.desgloseEfectivo.plataformas)],
          ['<strong>Subtotal efectivo</strong>', `<strong>${fmtMoney(totalEfectivo)}</strong>`],
        ])}

        ${seccionDesglose('💳 Cobrado con tarjeta / digital', [
          ['💳 Débito', fmtMoney(p.desgloseTarjeta.debito)],
          ['💳 Crédito', fmtMoney(p.desgloseTarjeta.credito)],
          ['📱 MP / QR', fmtMoney(p.desgloseTarjeta.mpQr)],
          ['🏦 Transferencia', fmtMoney(p.desgloseTarjeta.transferencia)],
          ['<strong>Subtotal tarjeta</strong>', `<strong>${fmtMoney(totalTarjeta)}</strong>`],
        ])}

        ${seccionDesglose('🧾 Ventas por canal',
          p.porCanal.map(c => [`${c.canal.replace('_', ' ')} (${c.cantidad})`, fmtMoney(c.monto)] as [string, string])
        )}

        ${p.aportes.cantidad > 0 ? seccionDesglose(`➕ Aportes (${p.aportes.cantidad})`,
          [
            ...p.aportes.items.map(a => [`${a.categoria}${a.descripcion ? ' — ' + a.descripcion : ''}`, fmtMoney(a.monto)] as [string, string]),
            ['<strong>Subtotal aportes</strong>', `<strong>${fmtMoney(p.aportes.total)}</strong>`],
          ]
        ) : ''}

        ${p.egresos.cantidad > 0 ? seccionDesglose(`➖ Egresos (${p.egresos.cantidad})`,
          [
            ...p.egresos.items.map(e => [`${e.categoria}${e.descripcion ? ' — ' + e.descripcion : ''}`, fmtMoney(e.monto)] as [string, string]),
            ['<strong>Subtotal egresos</strong>', `<strong>${fmtMoney(p.egresos.total)}</strong>`],
          ]
        ) : ''}

        ${p.comentario ? `
          <div style="background:#F5F1E8; border-left:3px solid #1a3a1a; padding:12px 16px; margin-top:16px; font-size:13px; color:#3d3a35;">
            <div style="font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#7a7367; margin-bottom:4px;">Comentario</div>
            ${p.comentario.replace(/\n/g, '<br/>')}
          </div>
        ` : ''}
      </div>

      <p style="font-size:12px; color:#7a7367; text-align:center; margin:16px 0;">
        Este email fue generado automáticamente desde la versión de demostración de Santa Teresita Pastas.
        ${p.enviadoPor ? `<br/>Enviado por: ${p.enviadoPor}` : ''}
      </p>
    </div>
  </body>
</html>
  `;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as CierrePayload;

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Email no configurado: falta RESEND_API_KEY en el servidor.',
        },
        { status: 503 },
      );
    }

    const to = (process.env.CIERRE_TO ?? 'encargada@example.com,alejolafalce@gmail.com')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const from = process.env.CIERRE_FROM ?? 'Santa Teresita <onboarding@resend.dev>';

    const fechaStr = new Date(payload.fecha).toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    });
    const subject = `Cierre Caja — ${fechaStr} ${payload.turno} — ${fmtMoney(payload.totalDelDia)}`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        html: buildEmailHtml(payload),
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error('[cierre] resend error:', res.status, errBody);
      return NextResponse.json(
        { ok: false, error: `Resend devolvió ${res.status}`, detail: errBody },
        { status: 502 },
      );
    }

    const data = await res.json();
    return NextResponse.json({ ok: true, id: data.id, to, subject });
  } catch (e) {
    console.error('[cierre] error:', e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Error inesperado' },
      { status: 500 },
    );
  }
}
