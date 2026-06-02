-- Listas blandas configurables por la encargada (conceptos de pago, motivos
-- de anulación, etiquetas de cliente, listas propias). Patrón genérico:
-- dominio + etiqueta + atributos jsonb.

CREATE TABLE IF NOT EXISTS opciones_configurables (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dominio    VARCHAR(80) NOT NULL,
  etiqueta   VARCHAR(120) NOT NULL,
  valor      VARCHAR(120),
  atributos  JSONB,
  orden      INTEGER NOT NULL DEFAULT 0,
  activo     BOOLEAN NOT NULL DEFAULT true,
  es_sistema BOOLEAN NOT NULL DEFAULT false,
  creado_at  TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT opciones_configurables_dominio_etiqueta_key UNIQUE (dominio, etiqueta)
);

CREATE INDEX IF NOT EXISTS idx_opciones_configurables_dominio_activo_orden
  ON opciones_configurables (dominio, activo, orden);
