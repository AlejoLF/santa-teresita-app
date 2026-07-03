-- Adiciones de encargo: "modificación adicional al pedido X" — items agregados
-- a un encargo ya cargado/cobrado se registran como una venta hija (secuencia
-- de pago propia) apuntando al encargo raíz. Aditiva + idempotente.
ALTER TABLE "ventas"
  ADD COLUMN IF NOT EXISTS "encargo_padre_id" UUID;

DO $$ BEGIN
  ALTER TABLE "ventas"
    ADD CONSTRAINT "ventas_encargo_padre_id_fkey"
    FOREIGN KEY ("encargo_padre_id") REFERENCES "ventas"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ventas_encargo_padre_id_idx" ON "ventas"("encargo_padre_id");
