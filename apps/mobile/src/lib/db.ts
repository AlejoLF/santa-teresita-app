/**
 * Cliente Postgres server-side para queries a Supabase.
 *
 * Solo se usa desde API routes (`'use server'` en Next 15) — NUNCA expongas
 * estos imports al cliente. Las credenciales viven en variables de entorno
 * de Vercel (no en el bundle del browser).
 *
 * El cliente usa el connection string POOLED de Supabase (`SUPABASE_DB_URL_POOLED`)
 * porque desde Vercel/serverless las conexiones son IPv4 y deben ir vía Supavisor.
 *
 * Los queries van con role `postgres` (service_role efectivo) — bypassa RLS
 * y puede leer cualquier tabla. Como esta API es solo lectura para usuarios
 * autenticados con PIN, no exponemos endpoints que escriban.
 */

import { Pool, type QueryResultRow } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.SUPABASE_DB_URL_POOLED;
  if (!url) {
    throw new Error(
      'SUPABASE_DB_URL_POOLED no está configurada. Agregá la env var en Vercel apuntando al pooler URL de Supabase.',
    );
  }
  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    // Vercel serverless functions tienen poco lifecycle — pool chico + timeout
    // bajo para no acumular conexiones colgadas.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

/**
 * Ejecuta una query parametrizada y devuelve los rows tipados.
 * Para queries con muchas inserciones de datos del usuario, usar params $1, $2…
 * NUNCA concatenar strings con input del cliente — riesgo SQL injection.
 */
export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await getPool().connect();
  try {
    const result = await client.query<T>(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

/** Convenience: una query que devuelve UN row o null. */
export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}
