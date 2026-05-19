import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
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
  /**
   * Cliente transaccional del caller. Cuando se pasa, recordAudit se suma a la
   * transacción existente en vez de abrir la suya propia. Esencial cuando esta
   * función se llama desde un outer `prisma.$transaction(...)` para que el
   * audit y la mutación principal sean atómicos.
   */
  tx?: Prisma.TransactionClient;
}

type DbClient = Prisma.TransactionClient | typeof prisma;

async function writeAuditEntry(client: DbClient, entry: AuditEntryInput): Promise<void> {
  const last = await client.auditLog.findFirst({
    orderBy: { secuencia: 'desc' },
    select: { hashActual: true, secuencia: true },
  });
  const created = await client.auditLog.create({
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
  await client.auditLog.update({
    where: { id: created.id },
    data: { hashActual: hash },
  });

  // ── Transactional outbox (replicación local → Supabase) ──
  // Solo si STA_OUTBOX_REPLICATION está prendido (server LAN + cajas en
  // modo LAN). En la MISMA tx que el audit → garantía atómica: si la
  // mutación commitea, el evento de replicación existe; si rollbackea, no.
  // El payload es mínimo (qué fila cambió + secuencia para orden total);
  // el replicator resuelve el row completo al drenar (idempotente).
  if (config.STA_OUTBOX_REPLICATION) {
    await client.outboxEvent.create({
      data: {
        topic: `${entry.tabla}.${entry.accion}`,
        payload: {
          tabla: entry.tabla,
          registroId: entry.registroId,
          accion: entry.accion,
          secuencia: created.secuencia.toString(),
        } as never,
      },
    });
  }
}

/**
 * Registra una entrada en audit_log calculando el hash-chain SHA-256.
 *
 * Si el caller pasa `entry.tx` (un cliente transaccional), recordAudit se
 * suma a esa transacción y NO abre una nueva — esto permite que la
 * mutación principal y el audit log sean un solo commit atómico.
 *
 * Si NO viene `tx`, abre una transacción Serializable propia (modo legacy
 * para call sites que no se pueden envolver en una transacción mayor).
 */
export async function recordAudit(entry: AuditEntryInput): Promise<void> {
  if (entry.tx) {
    await writeAuditEntry(entry.tx, entry);
    return;
  }
  await prisma.$transaction(
    async (tx) => {
      await writeAuditEntry(tx, entry);
    },
    { isolationLevel: 'Serializable' },
  );
}
