-- Excepción del día: la persona trabajó en OTRA categoría que la suya.
--
-- Hasta ahora la fila no sabía en qué categoría se trabajó: el valor salía de
-- la tarifa del empleado al momento de leer. Eso no representa el caso real de
-- alguien de Mostrador que un sábado cubre Cocina y ese día cobra distinto.
--
-- NULL = "la de siempre" y la fila sigue valuándose con la tarifa del empleado.
-- Se completa SÓLO cuando la encargada elige otra explícitamente: si se
-- estampara en cada carga, un empleado con `valor_hora_propio` pasaría a
-- cobrar por categoría sin que nadie lo hubiera pedido.
ALTER TABLE "movimientos_banco_horas"
    ADD COLUMN IF NOT EXISTS "categoria_laboral_id" UUID;

DO $$
BEGIN
    ALTER TABLE "movimientos_banco_horas"
        ADD CONSTRAINT "movimientos_banco_horas_categoria_laboral_id_fkey"
        FOREIGN KEY ("categoria_laboral_id") REFERENCES "categorias_laborales"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Se filtra por empleado+pendientes en cada lectura del saldo; el índice de
-- categoría sirve al "¿cuánto sube la deuda si aumento esta categoría?".
CREATE INDEX IF NOT EXISTS "movimientos_banco_horas_categoria_laboral_id_idx"
    ON "movimientos_banco_horas" ("categoria_laboral_id");
