-- Cuentas que NO afectan al cierre de caja físico.
-- Caso de uso: "Efectivo acumulado" — efectivo de cajas anteriores que el
-- dueño guarda aparte y desde donde a veces se hacen pagos. Esos egresos
-- aparecen en /admin/movimientos pero NO restan al esperado del turno
-- actual (sino estaríamos pidiéndole a la cajera que cuente ese efectivo
-- como si estuviera en su caja, lo cual es falso).

ALTER TABLE cuentas
  ADD COLUMN IF NOT EXISTS excluida_de_cierre_caja BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_cuentas_excluida_cierre
  ON cuentas (tipo, excluida_de_cierre_caja);
