-- Encargos: estado de ENTREGA (retirado), ortogonal al estado de cobro.
-- Un encargo se puede retirar pagado o impago, así que no se modela como un
-- estado más de `estado_cobro_encargo` sino como un timestamp aparte:
--   retirado_at IS NULL  -> pendiente de retiro
--   retirado_at IS NOT NULL -> ya se lo llevaron / salió al reparto
-- Aditiva e idempotente: se puede correr varias veces sin efecto.
ALTER TABLE "ventas"
  ADD COLUMN IF NOT EXISTS "retirado_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "usuario_retiro_encargo_id" UUID;

-- Los filtros de /encargos combinan día de entrega + estado de retiro.
CREATE INDEX IF NOT EXISTS "ventas_es_encargo_retirado_at_idx"
  ON "ventas" ("es_encargo", "retirado_at");
