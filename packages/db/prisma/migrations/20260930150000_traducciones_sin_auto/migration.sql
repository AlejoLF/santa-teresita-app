-- La primera versión de la traducción del menú de RAPPI traducía sola por
-- nombre exacto (AUTO_NOMBRE) o por sku (AUTO_SKU), y eligió mal (30/09).
-- Ya no existe la traducción automática: lo que quedó decidido así vuelve a
-- PENDIENTE para que lo decida la encargada. Idempotente.

UPDATE "traducciones_canal"
   SET "estado" = 'PENDIENTE',
       "producto_id" = NULL,
       "opcion_id" = NULL,
       "origen_traduccion" = NULL
 WHERE "origen_traduccion" LIKE 'AUTO%';
