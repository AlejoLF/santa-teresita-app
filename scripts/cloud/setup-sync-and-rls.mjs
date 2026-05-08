/**
 * Crea la infraestructura para que el sync agent local→cloud funcione, y
 * habilita RLS en todas las tablas como defense-in-depth.
 *
 * Lo que setea:
 *
 * 1. Tabla `sync_inbox` (cloud-side):
 *    - Registra cada evento que el agente local pushea desde `outbox_events`
 *      con el mismo `id` (idempotencia: si el push se reintenta, no duplica).
 *    - Estado workflow: pending → applied / failed.
 *    - Índices para consulta por status y por topic.
 *
 * 2. Función `apply_sync_event(uuid, varchar, jsonb)` :
 *    - El agente la llama vía RPC en cada push.
 *    - INSERT con `ON CONFLICT (id) DO NOTHING`, así reintentos son seguros.
 *
 * 3. RLS enabled en todas las tablas de `public`:
 *    - Sin políticas creadas → anon/authenticated NO pueden leer ni escribir.
 *    - service_role bypassa RLS automáticamente (es superuser-like).
 *    - Si alguna vez exponemos el REST API con anon key, los datos quedan
 *      protegidos por default.
 *
 * Idempotente: re-ejecutable sin efectos.
 */

import { Client } from 'pg';
import { pooledUrl, maskUrl } from './_url.mjs';

const SQL = `
-- ─── 1) sync_inbox ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sync_inbox (
  id            UUID PRIMARY KEY,
  topic         VARCHAR(80) NOT NULL,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at    TIMESTAMPTZ,
  status        VARCHAR(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','applied','failed')),
  error_msg     TEXT,
  retry_count   INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sync_inbox_status_idx
  ON public.sync_inbox (status, received_at);

CREATE INDEX IF NOT EXISTS sync_inbox_topic_idx
  ON public.sync_inbox (topic, received_at DESC);

-- ─── 2) RPC para que el agente publique de forma idempotente ─────────
CREATE OR REPLACE FUNCTION public.apply_sync_event(
  p_id UUID,
  p_topic VARCHAR(80),
  p_payload JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  insertado BOOLEAN;
BEGIN
  INSERT INTO public.sync_inbox (id, topic, payload, status)
  VALUES (p_id, p_topic, p_payload, 'pending')
  ON CONFLICT (id) DO NOTHING
  RETURNING TRUE INTO insertado;

  -- Si retorna NULL es porque ON CONFLICT no insertó (ya existía) → no es error.
  RETURN COALESCE(insertado, FALSE);
END;
$$;
COMMENT ON FUNCTION public.apply_sync_event IS
  'Idempotent insert para el sync agent. Returns true si insertó, false si ya existía.';
`;

async function main() {
  const url = pooledUrl();
  console.log(`▸ Pooler: ${maskUrl(url)}`);
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // 1+2: sync_inbox + función RPC
  console.log('▸ Aplicando sync_inbox + apply_sync_event RPC...');
  await client.query(SQL);
  console.log('  ✓ sync_inbox + RPC listos');

  // 3: enable RLS en todas las tablas de `public`. Hacemos un loop dinámico
  //    porque son ~45 tablas y enumerarlas es propenso a olvidarse de alguna
  //    cuando aparezca una nueva migración.
  console.log('▸ Habilitando RLS en todas las tablas de public...');
  const tablas = await client.query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT LIKE 'pg_%'
       AND tablename NOT LIKE '_prisma_%'
     ORDER BY tablename`,
  );
  let enabled = 0;
  for (const row of tablas.rows) {
    const t = row.tablename;
    // ALTER TABLE no soporta IF NOT EXISTS para RLS, pero es idempotente
    // (re-correrlo en una tabla con RLS ya habilitado no falla).
    await client.query(`ALTER TABLE public."${t}" ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE public."${t}" FORCE ROW LEVEL SECURITY`);
    enabled++;
  }
  console.log(`  ✓ RLS habilitado en ${enabled} tablas`);

  // Sanity: contar tablas sin políticas (debería ser todas — no creamos ninguna
  // política deliberadamente; service_role bypassa RLS de todos modos).
  const sinPoliticas = await client.query(
    `SELECT count(*)::int as n
     FROM pg_tables t
     LEFT JOIN pg_policies p ON p.schemaname = t.schemaname AND p.tablename = t.tablename
     WHERE t.schemaname = 'public' AND p.policyname IS NULL`,
  );
  console.log(`  i ${sinPoliticas.rows[0].n} tablas sin políticas (anon/authenticated bloqueados, service_role bypassa)`);

  await client.end();
  console.log('\n✓ Sync infrastructure + RLS listo');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
