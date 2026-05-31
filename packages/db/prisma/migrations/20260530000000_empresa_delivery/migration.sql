-- Empresas / repartidores de delivery configurables (sección Delivery del admin).
-- Comisión informativa por ahora (no descuenta automático en contabilidad).

CREATE TABLE IF NOT EXISTS empresas_delivery (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        VARCHAR(80) NOT NULL UNIQUE,
  comision_pct  DECIMAL(7, 4) NOT NULL DEFAULT 0,
  es_interno    BOOLEAN NOT NULL DEFAULT false,
  orden         INTEGER NOT NULL DEFAULT 0,
  activo        BOOLEAN NOT NULL DEFAULT true,
  creado_at     TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_empresas_delivery_activo_orden
  ON empresas_delivery (activo, orden);
