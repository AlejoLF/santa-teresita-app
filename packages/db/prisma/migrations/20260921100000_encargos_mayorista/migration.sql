-- Encargos para mayoristas: lista de precios elegible, destinatario mayorista
-- y cobro a cuenta corriente vía remito.
--
-- Todo aditivo y con IF NOT EXISTS: la migración se aplica sobre bases armadas
-- desde el schema (Supabase, las locales) y sobre S1, que va por migraciones en
-- orden. Ver el invariante de CLAUDE.md sobre `db push` vs migraciones.

-- ── Venta ───────────────────────────────────────────────────────────────
-- El mayorista destinatario del encargo. Va aparte de `cliente_id` porque los
-- mayoristas viven en su propia tabla, con su lista y su cuenta corriente.
ALTER TABLE "ventas"
  ADD COLUMN IF NOT EXISTS "cliente_mayorista_id" UUID;

-- true = no se cobra al entregar; suma a la cuenta corriente del mayorista.
ALTER TABLE "ventas"
  ADD COLUMN IF NOT EXISTS "encargo_a_cuenta_corriente" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ventas_cliente_mayorista_id_fkey'
  ) THEN
    ALTER TABLE "ventas"
      ADD CONSTRAINT "ventas_cliente_mayorista_id_fkey"
      FOREIGN KEY ("cliente_mayorista_id") REFERENCES "clientes_mayoristas"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ventas_cliente_mayorista_id_idx"
  ON "ventas"("cliente_mayorista_id");

-- ── Remito ──────────────────────────────────────────────────────────────
-- De qué encargo salió este remito. El índice ÚNICO es la garantía de que
-- marcar la entrega dos veces no duplique la deuda del mayorista: el segundo
-- INSERT rebota contra la base, no contra un chequeo que puede correr tarde.
ALTER TABLE "remitos"
  ADD COLUMN IF NOT EXISTS "encargo_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'remitos_encargo_id_fkey'
  ) THEN
    ALTER TABLE "remitos"
      ADD CONSTRAINT "remitos_encargo_id_fkey"
      FOREIGN KEY ("encargo_id") REFERENCES "ventas"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "remitos_encargo_id_key"
  ON "remitos"("encargo_id");
