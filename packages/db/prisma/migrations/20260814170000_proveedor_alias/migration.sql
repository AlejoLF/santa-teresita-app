-- Nombres alternativos de un proveedor, como aparecen en las facturas.
--
-- Sin esto, cada factura por OCR cuyo nombre impreso no coincidia exactamente
-- con el del sistema creaba un proveedor NUEVO y duplicado, partiendo la
-- cuenta corriente. Ver apps/api/src/services/proveedor-match.ts.
--
-- Aditiva e idempotente: se puede aplicar antes que el codigo.
CREATE TABLE IF NOT EXISTS "proveedor_alias" (
  "id"                 UUID PRIMARY KEY,
  "proveedor_id"       UUID NOT NULL,
  "nombre_original"    VARCHAR(160) NOT NULL,
  "nombre_normalizado" VARCHAR(160) NOT NULL,
  "origen"             VARCHAR(20)  NOT NULL DEFAULT 'ocr',
  "creado_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT "proveedor_alias_proveedor_id_fkey"
    FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE CASCADE
);

-- Un mismo nombre no puede apuntar a dos proveedores distintos.
CREATE UNIQUE INDEX IF NOT EXISTS "proveedor_alias_nombre_normalizado_key"
  ON "proveedor_alias" ("nombre_normalizado");

CREATE INDEX IF NOT EXISTS "proveedor_alias_proveedor_id_idx"
  ON "proveedor_alias" ("proveedor_id");
