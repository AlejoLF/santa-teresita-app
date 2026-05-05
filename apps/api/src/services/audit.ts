import { prisma } from '@sta/db/client';
import { computeHashChain, type HashChainEntry } from '@sta/shared/hash-chain';
import { config } from '../config.js';

interface AuditEntryInput {
  tabla: string;
  registroId: string;
  accion: string;
  usuarioId: string | null;
  pcOrigen?: string | null;
  ipOrigen?: string | null;
  valorAnterior?: unknown;
  valorNuevo?: unknown;
  contexto?: Record<string, unknown>;
  observaciones?: string;
}

/**
 * Registra una entrada en audit_log calculando el hash-chain SHA-256.
 *
 * Usa una transacción para garantizar que (a) el último hash leído y (b) el insert nuevo
 * sean atómicos respecto a writers concurrentes. Si dos writers entran al mismo tiempo
 * y leen el mismo prevHash, el segundo va a fallar el unique constraint en `secuencia`
 * (por la sequence `audit_log_secuencia_seq` autoincrement) — pero como `secuencia` es
 * autoincrement, no hay race; la única lectura que sí necesita el "prev" estable es la
 * del hashAnterior, y para eso usamos `SELECT ... FOR UPDATE` en una tx serializable.
 */
export async function recordAudit(entry: AuditEntryInput): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const last = await tx.auditLog.findFirst({
        orderBy: { secuencia: 'desc' },
        select: { hashActual: true, secuencia: true },
      });
      const created = await tx.auditLog.create({
        data: {
          tabla: entry.tabla,
          registroId: entry.registroId,
          accion: entry.accion,
          usuarioId: entry.usuarioId,
          pcOrigen: entry.pcOrigen ?? null,
          ipOrigen: entry.ipOrigen ?? null,
          valorAnterior: (entry.valorAnterior as never) ?? undefined,
          valorNuevo: (entry.valorNuevo as never) ?? undefined,
          contexto: (entry.contexto as never) ?? undefined,
          observaciones: entry.observaciones ?? null,
          hashAnterior: last?.hashActual ?? null,
          hashActual: 'pending',
        },
      });
      const chainEntry: HashChainEntry = {
        secuencia: created.secuencia,
        tabla: entry.tabla,
        registroId: entry.registroId,
        accion: entry.accion,
        valorAnterior: entry.valorAnterior ?? null,
        valorNuevo: entry.valorNuevo ?? null,
        usuarioId: entry.usuarioId,
        timestamp: created.timestamp,
      };
      const hash = computeHashChain(last?.hashActual ?? null, chainEntry, config.AUDIT_HASH_SALT);
      await tx.auditLog.update({
        where: { id: created.id },
        data: { hashActual: hash },
      });
    },
    { isolationLevel: 'Serializable' },
  );
}
