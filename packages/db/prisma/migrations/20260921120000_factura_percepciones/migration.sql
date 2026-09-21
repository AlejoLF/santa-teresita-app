-- Percepciones con nombre en las facturas recibidas.
--
-- Conceptos que el comprobante suma DESPUÉS del IVA (percepciones de IIBB, de
-- ganancias, sellados, fletes). No son ítems —no tienen cantidad ni precio— y
-- no entran en el cálculo del IVA.
--
-- `facturas_recibidas.otros_impuestos` ya existía pero es UN número sin nombre;
-- se mantiene con la SUMA de estas filas para que el Excel de facturas y la
-- ingesta por OCR sigan leyendo lo mismo.
--
-- Aditivo e idempotente: se aplica igual sobre bases armadas desde el schema
-- (Supabase, las locales) y sobre S1, que va por migraciones en orden.

CREATE TABLE IF NOT EXISTS "factura_percepciones" (
  "id"         UUID           NOT NULL,
  "factura_id" UUID           NOT NULL,
  "concepto"   VARCHAR(120)   NOT NULL,
  "monto"      DECIMAL(18, 2) NOT NULL,
  "orden"      INTEGER        NOT NULL DEFAULT 0,

  CONSTRAINT "factura_percepciones_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'factura_percepciones_factura_id_fkey'
  ) THEN
    ALTER TABLE "factura_percepciones"
      ADD CONSTRAINT "factura_percepciones_factura_id_fkey"
      FOREIGN KEY ("factura_id") REFERENCES "facturas_recibidas"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "factura_percepciones_factura_id_idx"
  ON "factura_percepciones"("factura_id");
