import { NextRequest, NextResponse } from 'next/server';
import { verificarPin, crearSesion } from '@/lib/auth';

/**
 * POST /api/auth/login
 *
 * Body: { pin: string }
 * Response: 200 { ok: true, nombre: string } | 401 { error: string }
 *
 * Rate limiting: por ahora ninguno explícito. Si en producción notamos
 * abuso, agregamos un Redis o una cola en memoria con back-off por IP.
 */
export async function POST(req: NextRequest) {
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
    // Mensaje genérico — no revelar si el PIN existe o no.
    return NextResponse.json({ error: 'PIN incorrecto' }, { status: 401 });
  }

  await crearSesion(user);
  return NextResponse.json({ ok: true, nombre: user.nombre, rol: user.rol });
}
