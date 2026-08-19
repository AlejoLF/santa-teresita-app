-- Precio de un SABOR por LISTA + sabores en los ítems de remito.
--
-- 1) `deltas_opcion_por_lista`: el delta de una opción de modificador dejó de
--    ser global. Ausencia de fila = la lista usa el delta de catálogo
--    (`opciones_modificador.delta_precio`), así un cambio de precio en el
--    catálogo sigue propagando a todas las listas que no lo pisaron.
--
-- 2) `remito_items.modificadores_aplicados` / `delta_modificadores`: un remito
--    de mayorista no podía llevar sabores, así que armar uno para un producto
--    con variantes (pizzas, ravioles) daba el precio equivocado.
--
-- Aditiva e idempotente: se puede aplicar antes que el código que la usa.

CREATE TABLE IF NOT EXISTS "deltas_opcion_por_lista" (
  "id"           UUID           NOT NULL DEFAULT gen_random_uuid(),
  "opcion_id"    UUID           NOT NULL,
  "lista_id"     UUID           NOT NULL,
  "delta_precio" DECIMAL(18, 2) NOT NULL,
  CONSTRAINT "deltas_opcion_por_lista_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "deltas_opcion_por_lista_opcion_id_lista_id_key"
  ON "deltas_opcion_por_lista"("opcion_id", "lista_id");
CREATE INDEX IF NOT EXISTS "deltas_opcion_por_lista_lista_id_idx"
  ON "deltas_opcion_por_lista"("lista_id");

DO $$
BEGIN
  ALTER TABLE "deltas_opcion_por_lista"
    ADD CONSTRAINT "deltas_opcion_por_lista_opcion_id_fkey"
    FOREIGN KEY ("opcion_id") REFERENCES "opciones_modificador"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "deltas_opcion_por_lista"
    ADD CONSTRAINT "deltas_opcion_por_lista_lista_id_fkey"
    FOREIGN KEY ("lista_id") REFERENCES "listas_precios"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "remito_items"
  ADD COLUMN IF NOT EXISTS "modificadores_aplicados" JSONB;
ALTER TABLE "remito_items"
  ADD COLUMN IF NOT EXISTS "delta_modificadores" DECIMAL(18, 2) NOT NULL DEFAULT 0;
