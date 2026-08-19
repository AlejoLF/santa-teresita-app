-- Vincular los insumos con la hoja `Compras` del Excel + avisos de aumento.
--
-- 1) `insumos.nombre_excel_compras`: el nombre EXACTO de la columna A de esa
--    hoja. Es lo que permite volver a encontrar la fila del producto para
--    escribirle la cantidad comprada. Se guarda el nombre y no el numero de
--    fila porque la encargada inserta filas seguido y el numero queda viejo.
--
-- 2) `alertas_precio_insumo`: "este producto aumento un X%". El precio NO se
--    actualiza solo — un aumento puede ser real, pero tambien un error de OCR,
--    otra presentacion o un recargo puntual. Queda PENDIENTE hasta que alguien
--    lo aprueba.
--
-- Aditiva e idempotente: se puede aplicar antes que el codigo que la usa.

ALTER TABLE "insumos"
  ADD COLUMN IF NOT EXISTS "nombre_excel_compras" VARCHAR(160);

CREATE INDEX IF NOT EXISTS "insumos_proveedor_principal_id_nombre_excel_compras_idx"
  ON "insumos"("proveedor_principal_id", "nombre_excel_compras");

DO $$
BEGIN
  CREATE TYPE "EstadoAlertaPrecio" AS ENUM ('PENDIENTE', 'APROBADA', 'RECHAZADA');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "alertas_precio_insumo" (
  "id"                UUID                 NOT NULL DEFAULT gen_random_uuid(),
  "insumo_id"         UUID                 NOT NULL,
  "proveedor_id"      UUID                 NOT NULL,
  "factura_item_id"   UUID,
  "precio_anterior"   DECIMAL(18, 4)       NOT NULL,
  "precio_nuevo"      DECIMAL(18, 4)       NOT NULL,
  "variacion_pct"     DECIMAL(9, 4)        NOT NULL,
  "estado"            "EstadoAlertaPrecio" NOT NULL DEFAULT 'PENDIENTE',
  "detectada_at"      TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resuelta_at"       TIMESTAMP(3),
  "usuario_id"        UUID,
  "aplicada_en_excel" BOOLEAN              NOT NULL DEFAULT false,
  "observaciones"     TEXT,
  CONSTRAINT "alertas_precio_insumo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "alertas_precio_insumo_estado_detectada_at_idx"
  ON "alertas_precio_insumo"("estado", "detectada_at");
CREATE INDEX IF NOT EXISTS "alertas_precio_insumo_insumo_id_idx"
  ON "alertas_precio_insumo"("insumo_id");

DO $$
BEGIN
  ALTER TABLE "alertas_precio_insumo"
    ADD CONSTRAINT "alertas_precio_insumo_insumo_id_fkey"
    FOREIGN KEY ("insumo_id") REFERENCES "insumos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "alertas_precio_insumo"
    ADD CONSTRAINT "alertas_precio_insumo_proveedor_id_fkey"
    FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "alertas_precio_insumo"
    ADD CONSTRAINT "alertas_precio_insumo_usuario_id_fkey"
    FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
