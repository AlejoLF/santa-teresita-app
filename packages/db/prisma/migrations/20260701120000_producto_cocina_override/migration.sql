-- Fix 3a: flag "Enviar a cocina" por PRODUCTO (no solo por TipoProducto).
-- Override nullable: null = hereda de tipo_producto.cocina_interviene (sin cambio
-- de comportamiento para productos existentes); true/false = fuerza este producto.
-- Aditiva + idempotente.
ALTER TABLE "productos"
  ADD COLUMN IF NOT EXISTS "cocina_interviene_override" BOOLEAN;
