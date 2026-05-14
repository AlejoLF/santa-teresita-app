import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { prisma } from '@sta/db/client';
import { TipoLoginAudit, RolUsuario, type Usuario } from '@sta/db';
import { hashToken, invalidateAuthCache } from '../plugins/auth.js';
import { config } from '../config.js';
import { recordAudit } from './audit.js';

export class AuthError extends Error {
  constructor(
    public readonly code:
      | 'PIN_INVALIDO'
      | 'USUARIO_BLOQUEADO'
      | 'USUARIO_INACTIVO'
      | 'PIN_DEBIL'
      | 'PIN_INCORRECTO',
    message: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface LoginContext {
  pcOrigen: string;
  ipOrigen?: string;
  userAgent?: string;
}

interface LoginResult {
  token: string;
  usuario: Pick<Usuario, 'id' | 'nombre' | 'rol'>;
  expiraAt: Date;
}

/**
 * Login con PIN (sin "username") — el sistema busca el usuario por PIN.
 *
 * Política de matching: itera sobre los usuarios activos y testea cada PIN con bcrypt.
 * Para 3 usuarios (Vendedor, Encargada, Julio) esto es ~15ms total — aceptable.
 * Si crece el universo de usuarios habría que cambiar a un esquema de "userId + PIN".
 *
 * Bloqueo por intentos fallidos: si el último intento fallido llega al threshold,
 * el usuario queda bloqueado por AUTH_PIN_LOCKOUT_MINUTES.
 */
export async function login(pin: string, ctx: LoginContext): Promise<LoginResult> {
  const usuarios = await prisma.usuario.findMany({ where: { activo: true } });

  // Buscar el usuario cuyo PIN matchea (constant-time-ish: testeamos todos).
  let match: Usuario | null = null;
  for (const u of usuarios) {
    const ok = await bcrypt.compare(pin, u.pinHash);
    if (ok) match = u;
  }

  if (!match) {
    await prisma.loginAudit.create({
      data: {
        tipo: TipoLoginAudit.LOGIN_FALLIDO,
        pcOrigen: ctx.pcOrigen,
        ipOrigen: ctx.ipOrigen ?? null,
        observaciones: 'PIN no coincidió con ningún usuario activo',
      },
    });
    throw new AuthError('PIN_INVALIDO', 'PIN incorrecto');
  }

  if (match.bloqueadoHasta && match.bloqueadoHasta > new Date()) {
    throw new AuthError('USUARIO_BLOQUEADO', 'Usuario bloqueado por intentos fallidos', {
      bloqueadoHasta: match.bloqueadoHasta,
    });
  }

  // Token aleatorio 32 bytes hex
  const tokenRaw = randomBytes(32).toString('hex');
  const tokenHash = hashToken(tokenRaw);
  const ttlHours =
    match.rol === RolUsuario.VENDEDOR
      ? config.AUTH_SESSION_TTL_HOURS_VENDEDOR
      : config.AUTH_SESSION_TTL_HOURS_ADMIN;
  const expiraAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.usuario.update({
      where: { id: match.id },
      data: { intentosFallidos: 0, bloqueadoHasta: null },
    });
    await tx.authSession.create({
      data: {
        usuarioId: match.id,
        pcOrigen: ctx.pcOrigen,
        ipOrigen: ctx.ipOrigen ?? null,
        userAgent: ctx.userAgent ?? null,
        tokenHash,
        expiraAt,
      },
    });
    await tx.loginAudit.create({
      data: {
        tipo: TipoLoginAudit.LOGIN_EXITOSO,
        usuarioId: match.id,
        pcOrigen: ctx.pcOrigen,
        ipOrigen: ctx.ipOrigen ?? null,
      },
    });
  });

  return {
    token: tokenRaw,
    usuario: { id: match.id, nombre: match.nombre, rol: match.rol },
    expiraAt,
  };
}

export async function logout(sessionId: string, usuarioId: string): Promise<void> {
  // Buscar el tokenHash antes del update para poder borrar del cache.
  const session = await prisma.authSession.findUnique({
    where: { id: sessionId },
    select: { tokenHash: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.authSession.update({
      where: { id: sessionId },
      data: { revocadaAt: new Date(), motivoRevocacion: 'logout_manual' },
    });
    await tx.loginAudit.create({
      data: {
        tipo: TipoLoginAudit.LOGOUT_MANUAL,
        usuarioId,
      },
    });
  });
  if (session) invalidateAuthCache(session.tokenHash);
}

/**
 * Verifica un PIN admin para una acción in-line (Sección 6.4).
 * No crea sesión nueva — solo registra la aprobación.
 */
export async function aprobarConPinAdmin(args: {
  pin: string;
  accion: string;
  contexto?: Record<string, unknown>;
  usuarioSolicitanteId: string;
  pcOrigen: string;
  ipOrigen?: string;
}): Promise<{ usuarioAprobador: Pick<Usuario, 'id' | 'nombre' | 'rol'> }> {
  const admins = await prisma.usuario.findMany({
    where: { activo: true, rol: RolUsuario.ADMIN },
  });
  let match: Usuario | null = null;
  for (const u of admins) {
    if (await bcrypt.compare(args.pin, u.pinHash)) match = u;
  }
  if (!match) {
    await prisma.loginAudit.create({
      data: {
        tipo: TipoLoginAudit.LOGIN_FALLIDO,
        pcOrigen: args.pcOrigen,
        ipOrigen: args.ipOrigen ?? null,
        accionAprobada: args.accion,
        accionContexto: (args.contexto as never) ?? undefined,
        usuarioSolicitanteId: args.usuarioSolicitanteId,
        observaciones: 'Aprobación admin in-line: PIN incorrecto',
      },
    });
    throw new AuthError('PIN_INCORRECTO', 'PIN admin incorrecto');
  }
  await prisma.loginAudit.create({
    data: {
      tipo: TipoLoginAudit.APROBACION_ADMIN_INLINE,
      usuarioId: match.id,
      pcOrigen: args.pcOrigen,
      ipOrigen: args.ipOrigen ?? null,
      accionAprobada: args.accion,
      accionContexto: (args.contexto as never) ?? undefined,
      usuarioSolicitanteId: args.usuarioSolicitanteId,
    },
  });
  await recordAudit({
    tabla: 'login_audit',
    registroId: match.id,
    accion: 'APROBACION_ADMIN_INLINE',
    usuarioId: match.id,
    pcOrigen: args.pcOrigen,
    ipOrigen: args.ipOrigen,
    contexto: { accion: args.accion, ...args.contexto },
  });
  return { usuarioAprobador: { id: match.id, nombre: match.nombre, rol: match.rol } };
}
