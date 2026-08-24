-- El banco de horas pasa a ser una CUENTA CORRIENTE.
--
-- Hasta ahora liquidar era todo-o-nada: se pagaban todas las horas pendientes
-- y se descontaban TODOS los adelantos, de una. Eso no es como funciona el
-- local. Un préstamo de $100.000 no se cubre el día siguiente trabajando
-- gratis: se devuelve de a poco, en los días que la encargada decide, mientras
-- la persona sigue cobrando normal.
--
-- Con estas dos columnas una fila deja de ser "pagada o no pagada" y pasa a
-- ser "pagada hasta acá".
ALTER TABLE "movimientos_banco_horas"
    ADD COLUMN IF NOT EXISTS "horas_aplicadas" DECIMAL(12, 6) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "monto_aplicado" DECIMAL(18, 2) NOT NULL DEFAULT 0;

-- Las filas que YA estaban liquidadas quedan consumidas por completo. Sin esto
-- volverían a aparecer como pendientes —con `horas_aplicadas = 0`— y se
-- pagarían dos veces las mismas horas.
UPDATE "movimientos_banco_horas"
   SET "horas_aplicadas" = COALESCE("horas", 0),
       "monto_aplicado"  = COALESCE("monto_pesos", 0)
 WHERE "liquidacion_id" IS NOT NULL
   AND ("horas_aplicadas" = 0 AND "monto_aplicado" = 0);

-- Lo pendiente se busca por lo que falta aplicar, no por `liquidacion_id`.
CREATE INDEX IF NOT EXISTS "movimientos_banco_horas_pendientes_idx"
    ON "movimientos_banco_horas" ("empleado_id", "fecha")
 WHERE "liquidacion_id" IS NULL;
