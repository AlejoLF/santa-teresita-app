-- Columnas que estaban en schema.prisma pero que NINGUNA migración creaba.
--
-- ── Qué pasó ──────────────────────────────────────────────────────────────
-- Se agregaron al schema con `prisma db push` durante el desarrollo y nunca se
-- les escribió la migración. Las bases armadas DESDE EL SCHEMA (Supabase, y
-- cualquier `db push` local) las tienen; la armada APLICANDO LAS MIGRACIONES
-- EN ORDEN — el mini PC S1 — no, porque para ella nunca existieron.
--
-- ── Por qué importaba ─────────────────────────────────────────────────────
-- `20260702120000_porciones_reorg` ESCRIBE en `tipos_producto.es_subcategoria`.
-- En S1 esa columna no existía, así que la migración fallaba, y como el updater
-- corta ante el primer error, TODAS las migraciones posteriores quedaban sin
-- aplicar. Resultado: S1 quedó congelada en el esquema del 1 de julio y su
-- auto-update nocturno venía fallando y rolleando solo desde entonces, sin que
-- nadie se enterara. Detectado el 2026-08-15 al intentar publicar el 1.1.8.
--
-- ── Por qué la fecha del nombre es anterior a porciones_reorg ─────────────
-- A propósito. Las migraciones se aplican ordenadas por nombre, así que esta
-- TIENE que correr antes que `20260702120000_porciones_reorg` para que la
-- columna exista cuando aquella la use. Con un nombre de hoy iría después y el
-- problema seguiría igual. En las bases que ya están al día no cambia nada:
-- todo acá es `IF NOT EXISTS`, así que es un no-op.
--
-- Aditiva e idempotente: se puede correr las veces que haga falta.

-- Sub-categoría real dentro de una categoría (ver porciones_reorg).
ALTER TABLE "tipos_producto"
  ADD COLUMN IF NOT EXISTS "es_subcategoria" BOOLEAN NOT NULL DEFAULT false;

-- Código corto para buscar el sabor por teclado desde la caja. Nullable, y
-- único GLOBALMENTE (no por grupo): el cajero tipea solo dígitos.
ALTER TABLE "opciones_modificador"
  ADD COLUMN IF NOT EXISTS "codigo" VARCHAR(8);

CREATE UNIQUE INDEX IF NOT EXISTS "opciones_modificador_codigo_key"
  ON "opciones_modificador"("codigo");

-- Contador del número de orden por turno. Arranca en 0.
ALTER TABLE "sesiones_caja"
  ADD COLUMN IF NOT EXISTS "ultimo_numero_orden" INTEGER NOT NULL DEFAULT 0;
