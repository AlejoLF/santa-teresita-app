-- Mapeo fila-del-Excel → proveedor del sistema, para el writeback de
-- "Proveedores 2026.xlsx" (hoja `Deudas`).
--
-- Las filas de esa hoja no son proveedores uno a uno: "Grafipack en Negro" y
-- "Grafipack en Blanco" son el mismo proveedor partido por tipo de
-- comprobante, y "Verduras"/"Huevos"/"Limpieza" son rubros que juntan varios.
-- Por eso el mapeo se guarda explícito en vez de adivinarse por nombre.
--
-- Aditiva e idempotente: se puede aplicar antes que el código que la usa.

CREATE TABLE IF NOT EXISTS "mapeo_excel_proveedores" (
  "id"                UUID         NOT NULL DEFAULT gen_random_uuid(),
  "etiqueta_excel"    VARCHAR(120) NOT NULL,
  "proveedor_id"      UUID         NOT NULL,
  "tipos_comprobante" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "activo"            BOOLEAN      NOT NULL DEFAULT true,
  CONSTRAINT "mapeo_excel_proveedores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mapeo_excel_proveedores_etiqueta_excel_proveedor_id_key"
  ON "mapeo_excel_proveedores"("etiqueta_excel", "proveedor_id");
CREATE INDEX IF NOT EXISTS "mapeo_excel_proveedores_proveedor_id_idx"
  ON "mapeo_excel_proveedores"("proveedor_id");

DO $$
BEGIN
  ALTER TABLE "mapeo_excel_proveedores"
    ADD CONSTRAINT "mapeo_excel_proveedores_proveedor_id_fkey"
    FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
