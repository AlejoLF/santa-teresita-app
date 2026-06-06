import { NextRequest, NextResponse } from 'next/server';
import { verificarPin, crearSesion } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * POST /api/auth/login  — Body: { pin } → 200 { ok, nombre, rol } | 401 | 429
 *
 * Seguridad (C3 del audit): esta ruta es PÚBLICA en internet (Vercel) y un PIN
 * de 4 dígitos (10k combos) se barre en segundos. Lockout por IP usando
 * login_audit. NOTA: la IP de Vercel viene de x-forwarded-for (la setea el
 * proxy de Vercel, confiable). Un atacante que rote IPs lo evade — ideal sumar
 * un rate-limit global (Vercel KV/Upstash) + PINs largos como follow-up.
 */
const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MINUTES = 15;

function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);

  // Lockout por IP: si superó el umbral de fallidos recientes, 429.
  try {
    const recientes = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM login_audit
        WHERE tipo = 'LOGIN_FALLIDO'::"TipoLoginAudit" AND ip_origen = $1
          AND timestamp >= NOW() - ($2 || ' minutes')::interval`,
      [ip, String(LOCKOUT_MINUTES)],
    );
    if (Number(recientes[0]?.n ?? 0) >= LOCKOUT_THRESHOLD) {
      return NextResponse.json(
        { error: `Demasiados intentos. Esperá ${LOCKOUT_MINUTES} minutos.` },
        { status: 429 },
      );
    }
  } catch (e) {
    // No bloqueamos el login si el chequeo falla (disponibilidad), pero logueamos.
    console.error('[login lockout check]', e);
  }

  let pin: string;
  try {
    const body = (await req.json()) as { pin?: unknown };
    if (typeof body.pin !== 'string') {
      return NextResponse.json({ error: 'PIN requerido' }, { status: 400 });
    }
    pin = body.pin;
  } catch {
    return NextResponse.json({ error: 'Body inválido' }, { status: 400 });
  }

  const user = await verificarPin(pin);
  if (!user) {
    // Registrar el fallido para el lockout.
    try {
      await query(
        `INSERT INTO login_audit (id, tipo, ip_origen, observaciones)
         VALUES (gen_random_uuid(), 'LOGIN_FALLIDO'::"TipoLoginAudit", $1, 'PWA: PIN incorrecto')`,
        [ip],
      );
    } catch (e) {
      console.error('[login audit]', e);
    }
    // Mensaje genérico — no revelar si el PIN existe o no.
    return NextResponse.json({ error: 'PIN incorrecto' }, { status: 401 });
  }

  await crearSesion(user);
  return NextResponse.json({ ok: true, nombre: user.nombre, rol: user.rol });
}
