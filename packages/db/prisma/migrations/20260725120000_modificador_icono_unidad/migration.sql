-- Grupos de modificadores: ícono configurable + flag de unidad numérica.
--
--   icono            -> emoji que representa al grupo. En la tarjeta de
--                       producto del cajero se muestra este ícono + el conteo
--                       de opciones en vez de listar todos los sabores (que
--                       genera un recuadro gigante e ilegible).
--   requiere_cantidad -> si es false, las opciones del grupo son SOLO
--                       seleccionables (sin input de peso/cantidad al lado).
--                       Default true = comportamiento histórico (los sabores
--                       clásicos llevan cantidad). Selección única vs múltiple
--                       ya la define `tipo_seleccion`.
--
-- Aditiva e idempotente: se puede correr varias veces sin efecto.
ALTER TABLE "grupos_modificador"
  ADD COLUMN IF NOT EXISTS "icono" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "requiere_cantidad" BOOLEAN NOT NULL DEFAULT true;
