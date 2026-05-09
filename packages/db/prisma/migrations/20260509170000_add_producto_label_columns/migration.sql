ALTER TABLE productos
  ADD COLUMN IF NOT EXISTS forma_venta_label VARCHAR(40),
  ADD COLUMN IF NOT EXISTS unidad_precio_label VARCHAR(40);
