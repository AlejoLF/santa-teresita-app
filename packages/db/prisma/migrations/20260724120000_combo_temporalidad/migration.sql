-- Temporalidad de combos/promos: en qué días y turnos aparece la promo en la
-- pantalla de PEDIDOS. Así la encargada no activa/desactiva a mano — se
-- muestran solas el día/turno que configuró.
--
--   dias_semana: int[] con 0=domingo .. 6=sábado (JS getDay en TZ AR).
--                vacío = todos los días.
--   turnos:      TurnoCaja[] (MANANA/TARDE). vacío = todos los turnos.
--
-- Aditiva e idempotente (IF NOT EXISTS + default '{}'). Los combos existentes
-- quedan sin restricción (siempre visibles), que es el comportamiento previo.

ALTER TABLE "combos"
  ADD COLUMN IF NOT EXISTS "dias_semana" INTEGER[] NOT NULL DEFAULT '{}';

ALTER TABLE "combos"
  ADD COLUMN IF NOT EXISTS "turnos" "TurnoCaja"[] NOT NULL DEFAULT '{}';
