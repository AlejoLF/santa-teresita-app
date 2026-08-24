-- El empleado devuelve plata del préstamo, en efectivo.
--
-- Hasta ahora el préstamo sólo se bajaba trabajando: las horas se aplicaban
-- contra la deuda. Pero a veces devuelven plata, y sin esto no había forma de
-- registrarlo — la deuda quedaba viva aunque ya la hubieran pagado.
--
-- Es un INGRESO a la caja, no un egreso: la plata entra.
ALTER TYPE "TipoMovimientoBancoHoras" ADD VALUE IF NOT EXISTS 'DEVOLUCION';

-- La categoría contable del ingreso. Va acá Y en `seed.ts`: S1 se arma
-- aplicando migraciones, pero Supabase y las locales con `db push` + seed, y
-- ésas nunca correrían este INSERT. Sin la categoría, registrar una devolución
-- falla SÓLO en la nube — el peor tipo de diferencia entre entornos.
INSERT INTO "categorias_movimiento" ("id", "nombre", "tipo", "es_sistema", "es_operativa", "orden", "activa")
SELECT gen_random_uuid(), 'Devolución de préstamo', 'INGRESO', true, true, 6, true
 WHERE NOT EXISTS (
   SELECT 1 FROM "categorias_movimiento" WHERE "nombre" = 'Devolución de préstamo'
 );
