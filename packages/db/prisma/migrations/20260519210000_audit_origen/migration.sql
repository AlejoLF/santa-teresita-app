-- Fase 1.5: identidad de isla para el catch-up Supabase→local tras un corte
-- de luz. Ver docs/SERVIDOR-LOCAL.md §5.2 / §5.3.
--
-- Durante un corte, la PWA móvil escribe ventas autoritativas a Supabase
-- (vía apps/mobile, único nodo vivo). El Postgres local está apagado. Al
-- volver la luz, el server tiene que absorber esas filas SIN romper el
-- hash-chain del audit (que es por-DB e independiente en cada isla).
--
--   origen           'local' (default, escrito por el server LAN) |
--                     'cloud' (escrito por la PWA durante el corte).
--   secuencia_origen  el `secuencia` que tuvo la fila en su DB de origen.
--                     Al importar al local se le asigna un `secuencia`
--                     local NUEVO (re-chain), pero preservamos el original
--                     para forensia / trazabilidad cruzada.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS origen VARCHAR(8) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS secuencia_origen BIGINT;

-- El catch-up busca "filas de la nube todavía no absorbidas localmente".
-- Índice parcial chico: solo filas origen='cloud'.
CREATE INDEX IF NOT EXISTS idx_audit_log_origen_cloud
  ON audit_log (origen, timestamp)
  WHERE origen = 'cloud';
