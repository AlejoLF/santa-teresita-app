-- Remitos: estado PAGADO + trazabilidad de qué cobro los saldó.
--
-- Hasta acá un remito sólo podía estar PENDIENTE o ANULADO, así que al
-- registrar un cobro no había forma de decir QUÉ remitos cubría. Quedaban
-- todos pendientes para siempre y el operador tenía que llevar la cuenta por
-- fuera del sistema.
--
--   pagado_at                 -> cuándo se marcó cobrado.
--   pagado_con_movimiento_id  -> el movimiento del cobro que lo saldó.
--                                Nullable: se puede marcar a mano (cobro
--                                viejo, ajuste) sin movimiento asociado.
--                                ON DELETE SET NULL — borrar el movimiento no
--                                puede borrar el remito.
--
-- OJO CON EL SALDO: un remito PAGADO SIGUE contando en "total remitado". El
-- saldo es remitado - cobrado, y el cobro ya está del otro lado; si los
-- PAGADO salieran del total, el pago se restaría dos veces y el saldo daría
-- negativo. PAGADO es una MARCA, no una baja.
--
-- Aditiva e idempotente: se puede correr varias veces sin efecto.

-- BEFORE 'ANULADO' para que el orden del enum en la DB coincida con el del
-- schema de Prisma. No cambia el comportamiento, pero evita que una base
-- creada con `db push` y otra migrada por SQL queden distintas.
ALTER TYPE "EstadoRemito" ADD VALUE IF NOT EXISTS 'PAGADO' BEFORE 'ANULADO';

ALTER TABLE "remitos"
  ADD COLUMN IF NOT EXISTS "pagado_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pagado_con_movimiento_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'remitos_pagado_con_movimiento_id_fkey'
  ) THEN
    ALTER TABLE "remitos"
      ADD CONSTRAINT "remitos_pagado_con_movimiento_id_fkey"
      FOREIGN KEY ("pagado_con_movimiento_id") REFERENCES "movimientos"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "remitos_pagado_con_movimiento_id_idx"
  ON "remitos"("pagado_con_movimiento_id");
