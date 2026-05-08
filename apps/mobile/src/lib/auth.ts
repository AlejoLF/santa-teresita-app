/**
 * Auth con PIN + JWT en cookie.
 *
 * Flujo:
 *   1. Usuario ingresa PIN (4 dígitos) en /login.
 *   2. POST /api/auth/login → busca usuario activo cuyo `pin_hash` matchee
 *      con bcrypt.compare(pin, hash). Solo permite roles ADMIN (Julio +
 *      encargada). El cajero no puede entrar al mobile.
 *   3. Si OK, firma un JWT con `jose` (HS256) y lo guarda en cookie httpOnly.
 *   4. Las API routes protegidas verifican el JWT en cada request.
 *
 * Por qué JWT en vez de session DB:
 *   - Vercel serverless es stateless. JWT firmado nos permite verificar sin
 *     volver a la DB en cada request.
 *   - No persistimos nada server-side; logout = borrar cookie.
 *
 * Secreto:
 *   - `MOBILE_AUTH_SECRET` env var (32+ bytes random). Cualquier rotación
 *     invalida sesiones existentes — los usuarios re-loggean.
 */

import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
// query se importa dinámicamente dentro de verificarPin para mantener el bundle de auth chico

const COOKIE_NAME = 'sta_mobile_session';
const TOKEN_TTL_HOURS = 24 * 7; // 7 días

interface SessionPayload {
  userId: string;
  nombre: string;
  rol: string;
  /** issued at timestamp en segundos UNIX */
  iat?: number;
}

function getSecret(): Uint8Array {
  const s = process.env.MOBILE_AUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'MOBILE_AUTH_SECRET no configurada o es muy corta (mínimo 32 chars). Generala con `openssl rand -hex 32` y configurala en Vercel.',
    );
  }
  return new TextEncoder().encode(s);
}

/**
 * Verifica el PIN contra `usuarios.pin_hash` y devuelve los datos del user
 * si matchea. NULL si no hay match.
 *
 * Acepta ADMIN y VENDEDOR. El rol se devuelve en el JWT y los componentes
 * lo usan para decidir qué mostrar (admin dashboard vs cargar-pedido).
 */
export async function verificarPin(pin: string): Promise<{
  id: string;
  nombre: string;
  rol: string;
} | null> {
  if (!/^\d{4,8}$/.test(pin)) return null;

  const { query } = await import('./db');
  const rows = await query<{ id: string; nombre: string; rol: string; pin_hash: string }>(
    `SELECT id::text, nombre, rol::text, pin_hash
     FROM usuarios
     WHERE rol IN ('ADMIN', 'VENDEDOR') AND activo = true`,
  );
  for (const u of rows) {
    const ok = await bcrypt.compare(pin, u.pin_hash);
    if (ok) return { id: u.id, nombre: u.nombre, rol: u.rol };
  }
  return null;
}

export async function crearSesion(user: { id: string; nombre: string; rol: string }) {
  const token = await new SignJWT({ userId: user.id, nombre: user.nombre, rol: user.rol })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_HOURS}h`)
    .sign(getSecret());

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: TOKEN_TTL_HOURS * 3600,
  });
}

/** Verifica la cookie en una request del cliente. Devuelve null si no hay sesión válida. */
export async function leerSesion(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify<SessionPayload>(token, getSecret());
    return payload;
  } catch {
    return null;
  }
}

export async function cerrarSesion() {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

/**
 * Helper para route handlers — devuelve la sesión o tira 401 si no hay.
 * Uso típico en API:
 *   const session = await requireSession();
 *   // ... query DB
 */
export async function requireSession(): Promise<SessionPayload> {
  const session = await leerSesion();
  if (!session) {
    throw new Response('Unauthorized', { status: 401 });
  }
  return session;
}
