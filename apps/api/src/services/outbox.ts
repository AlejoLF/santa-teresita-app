/**
 * Outbox local — resiliencia offline.
 *
 * Cuando el frontend hace una escritura (POST/PUT/PATCH/DELETE) y la cloud
 * no responde (red caída, Supabase momentáneamente inaccesible, etc.), el
 * frontend redirige el request a `POST /api/v1/sync/queue`. Eso lo persiste
 * en una SQLite local (en userData/outbox.sqlite) que sobrevive al reinicio
 * de la app.
 *
 * Un flusher en background reintenta cada 5s contra la API de la propia PC
 * (que a su vez habla con la cloud). Cuando logra publicarlo, lo borra del
 * outbox.
 *
 * Por qué SQLite y no in-memory:
 *   - Si la PC se reinicia con writes pendientes, no se pierden.
 *   - Si el proceso API crashea, los datos siguen ahí.
 *   - Mejor que JSON en disco: transacciones, índices, queries SQL.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  // Path configurable vía OUTBOX_DB_PATH (lo setea main.js apuntando a
  // userData/data/outbox.sqlite). Si no está, fallback al cwd para dev.
  const dbPath = process.env.OUTBOX_DB_PATH ?? './outbox.sqlite';
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  // WAL mejora concurrencia entre flusher (read+delete) y enqueue (write).
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_writes (
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      body_json TEXT,
      headers_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      next_retry_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS pending_writes_retry_idx
      ON pending_writes (next_retry_at)
      WHERE attempts < 20;
  `);
  return db;
}

export interface PendingWrite {
  id: string;
  method: string;
  url: string;
  body_json: string | null;
  headers_json: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  next_retry_at: number;
}

export function enqueue(input: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO pending_writes (id, method, url, body_json, headers_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.method,
      input.url,
      input.body !== undefined ? JSON.stringify(input.body) : null,
      input.headers ? JSON.stringify(input.headers) : null,
    );
  return id;
}

/** Cantidad de eventos pendientes (no abandonados). */
export function pendingCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM pending_writes WHERE attempts < 20`)
    .get() as { n: number };
  return row.n;
}

/** Eventos abandonados (>= 20 intentos fallidos). Sirve para alerta visible. */
export function abandonedCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM pending_writes WHERE attempts >= 20`)
    .get() as { n: number };
  return row.n;
}

/** Próximo evento a procesar (oldest first, attempts<20, retry-time vencido). */
export function nextPending(): PendingWrite | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM pending_writes
       WHERE attempts < 20 AND next_retry_at <= unixepoch()
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get();
  return (row as PendingWrite) ?? null;
}

export function deletePending(id: string): void {
  getDb().prepare(`DELETE FROM pending_writes WHERE id = ?`).run(id);
}

export function markFailed(id: string, error: string): void {
  // Backoff exponencial: 5s, 10s, 20s, 40s, ..., max 30min.
  // intent 1 → 5s, intent 2 → 10s, ..., intent 10+ → 30min cap.
  getDb()
    .prepare(
      `UPDATE pending_writes
       SET attempts = attempts + 1,
           last_error = ?,
           next_retry_at = unixepoch() + MIN(1800, 5 * (1 << MIN(attempts, 9)))
       WHERE id = ?`,
    )
    .run(error.slice(0, 500), id);
}

/** Lista los eventos abandonados para UI/admin. */
export function listAbandoned(limit = 50): PendingWrite[] {
  return getDb()
    .prepare(
      `SELECT * FROM pending_writes
       WHERE attempts >= 20
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as PendingWrite[];
}

export function deleteAbandoned(id: string): void {
  // Solo permitir borrar abandonados — los activos los procesa el flusher.
  getDb()
    .prepare(`DELETE FROM pending_writes WHERE id = ? AND attempts >= 20`)
    .run(id);
}

export function closeOutbox(): void {
  if (db) {
    db.close();
    db = null;
  }
}
