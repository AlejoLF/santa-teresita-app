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
  /** true si el PIN es uno de los default sembrados / triviales — el front debe
   *  forzar un cambio. Seguridad A7: PINs default 0001/0002/0003 sin rotacion. */
  debeCambiarPin: boolean;
}

/** PINs default del seed + triviales obvios. Si un usuario sigue con uno, hay que
 *  forzar el cambio (no se puede saber por el hash, pero sí en el login plano). */
const PINS_DEBILES = new Set([
  '0001', '0002', '0003', '0000', '1111', '2222', '3333', '4444', '5555',
  '6666', '7777', '8888', '9999', '1234', '4321', '1212',
]);

/**
 * Anti-fuerza-bruta para login y aprobación con PIN. Como el login es
 * por-PIN-sin-usuario, el bloqueo es por ORIGEN: cuenta los LOGIN_FALLIDO
 * recientes de esa IP (el socket real, confiable con trustProxy=false) y, si
 * superan el umbral, bloquea por AUTH_PIN_LOCKOUT_MINUTES.
 *
 * Seguridad: antes el lockout estaba declarado en el schema/config pero el
 * código NUNCA incrementaba intentosFallidos → un PIN de 4 dígitos (10k combos)
 * se barría sin freno. Esto lo cierra.
 */
async function assertNoBruteForce(
  ipOrigen?: string | null,
  pcOrigen?: string | null,
): Promise<void> {
  const desde = new Date(Date.now() - config.AUTH_PIN_LOCKOUT_MINUTES * 60_000);
  // Clave de conteo: preferimos la IP del socket; si no hay, el pcOrigen.
  const filtroOrigen = ipOrigen ? { ipOrigen } : pcOrigen ? { pcOrigen } : null;
  if (!filtroOrigen) return;
  const fallidos = await prisma.loginAudit.count({
    where: { tipo: TipoLoginAudit.LOGIN_FALLIDO, timestamp: { gte: desde }, ...filtroOrigen },
  });
  if (fallidos >= config.AUTH_PIN_LOCKOUT_THRESHOLD) {
    throw new AuthError(
      'USUARIO_BLOQUEADO',
      `Demasiados intentos fallidos. Esperá ${config.AUTH_PIN_LOCKOUT_MINUTES} minutos.`,
      { bloqueadoHasta: new Date(Date.now() + config.AUTH_PIN_LOCKOUT_MINUTES * 60_000) },
    );
  }
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
  // Freno de fuerza bruta por origen ANTES de testear PINs.
  await assertNoBruteForce(ctx.ipOrigen, ctx.pcOrigen);

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
    debeCambiarPin: PINS_DEBILES.has(pin),
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
  // Mismo freno de fuerza bruta que el login (un cajero con el PIN compartido
  // no puede barrer el PIN admin para auto-aprobarse anulaciones).
  await assertNoBruteForce(args.ipOrigen, args.pcOrigen);

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
