-- Encargos: comandera elegida al cargar el pedido.
-- Los encargos se toman también desde PCs que no son la del mostrador, así que
-- la caja elige el destino en la PRIMERA impresión (no solo al re-imprimir).
-- La usa la comanda del cobro diferido y el default de la re-impresión.
-- Aditiva e idempotente: se puede correr varias veces sin efecto.
ALTER TABLE "ventas"
  ADD COLUMN IF NOT EXISTS "destino_impresion_encargo" VARCHAR(20);
