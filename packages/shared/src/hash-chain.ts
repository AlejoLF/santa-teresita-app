/**
 * Hash chain para audit log (SPEC §11).
 * Cada entry de audit_log tiene `hash_anterior` y `hash_actual`. El hash actual se calcula
 * concatenando: hash_anterior + secuencia + tabla + registro_id + accion + valor_nuevo + timestamp + salt.
 *
 * La idea es que cualquier modificación retroactiva del log invalida el chain — al recomputar,
 * los hashes posteriores no coinciden y se detecta la manipulación.
 */

import { createHash } from 'node:crypto';

export interface HashChainEntry {
  secuencia: number | bigint;
  tabla: string;
  registroId: string;
  accion: string;
  valorAnterior: unknown;
  valorNuevo: unknown;
  usuarioId: string | null;
  timestamp: Date | string;
}

const stableStringify = (input: unknown): string => {
  if (input === null || input === undefined) return 'null';
  if (typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) {
    return `[${input.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(input as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((input as Record<string, unknown>)[k])}`)
    .join(',')}}`;
};

export function computeHashChain(
  prevHash: string | null,
  entry: HashChainEntry,
  salt: string,
): string {
  const tsIso = entry.timestamp instanceof Date ? entry.timestamp.toISOString() : entry.timestamp;
  const payload = [
    prevHash ?? 'GENESIS',
    String(entry.secuencia),
    entry.tabla,
    entry.registroId,
    entry.accion,
    stableStringify(entry.valorAnterior),
    stableStringify(entry.valorNuevo),
    entry.usuarioId ?? 'system',
    tsIso,
    salt,
  ].join('|');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function verifyHashChain(
  entries: Array<HashChainEntry & { hashAnterior: string | null; hashActual: string }>,
  salt: string,
): { valid: boolean; brokenAt?: number } {
  let prevHash: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.hashAnterior !== prevHash) return { valid: false, brokenAt: i };
    const expected = computeHashChain(prevHash, e, salt);
    if (expected !== e.hashActual) return { valid: false, brokenAt: i };
    prevHash = e.hashActual;
  }
  return { valid: true };
}
