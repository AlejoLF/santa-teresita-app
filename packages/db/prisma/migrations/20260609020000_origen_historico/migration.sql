-- Migración Innovo: columna `origen` + sesion_caja_id opcional con CHECK.
-- Permite cargar el histórico de Innovo en las tablas vivas (origen='innovo')
-- sin sesión de caja, manteniendo el invariante para las ventas vivas.
-- Ver docs/MIGRACION-INNOVO.md.

ALTER TABLE "ventas"   ADD COLUMN IF NOT EXISTS "origen" VARCHAR(20);
ALTER TABLE "clientes" ADD COLUMN IF NOT EXISTS "origen" VARCHAR(20);

ALTER TABLE "ventas" ALTER COLUMN "sesion_caja_id" DROP NOT NULL;

ALTER TABLE "ventas" DROP CONSTRAINT IF EXISTS "ventas_sesion_o_origen_chk";
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_sesion_o_origen_chk"
  CHECK ("sesion_caja_id" IS NOT NULL OR "origen" = 'innovo');

-- Índice para filtrar/excluir rápido las filas migradas en reportes.
CREATE INDEX IF NOT EXISTS "ventas_origen_idx" ON "ventas" ("origen");
