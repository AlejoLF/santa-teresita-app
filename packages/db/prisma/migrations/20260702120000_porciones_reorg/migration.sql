-- Fix 3c: reorganización de "porciones calientes".
--
-- ANTES: cada porción era un TipoProducto propio ("Canelones porción especial",
-- es_subcategoria=false) con UN producto colgado y el grupo de sabores aplicado
-- al TIPO. Eso ensuciaba el selector de sub-categorías del admin (25+ entradas)
-- y hacía imposible cargar porciones nuevas como productos normales.
--
-- AHORA: dos sub-categorías reales por categoría — "Porción simple" y "Porción
-- especial" (es_subcategoria=true, cocina_interviene=true) — con las porciones
-- como PRODUCTOS adentro. Los grupos de modificadores que estaban aplicados al
-- tipo viejo se re-apuntan al PRODUCTO (mismo efecto en el cajero). Los tipos
-- viejos quedan INACTIVOS (no se borran: histórico + FKs).
--
-- La detección simple/especial + salsa del cajero usa el NOMBRE del tipo
-- (endsWith "porción simple/especial") → los nombres destino la conservan.
-- Bonus: absorbe los "Varenikes porcion ..." (sin acento, es_subcategoria=true,
-- cocina_interviene=false) — bug de datos: no imprimían comanda ni ofrecían
-- salsa. Al pasar a los tipos destino quedan con cocina + salsa correctos.
--
-- Idempotente: al re-correr, los tipos viejos ya están inactivos y sin
-- productos ni modificadores → el filtro de fuentes no devuelve nada.
-- Por nombres (sin UUIDs) → la misma migración sirve para local y Supabase.

DO $$
DECLARE
  kind TEXT;
  target_nombre TEXT;
  cat RECORD;
  target_id UUID;
  src RECORD;
  apl RECORD;
  prod RECORD;
  orden_min INT;
BEGIN
  FOREACH kind IN ARRAY ARRAY['simple', 'especial'] LOOP
    target_nombre := CASE kind WHEN 'simple' THEN 'Porción simple' ELSE 'Porción especial' END;

    -- Categorías que tienen tipos "X porción <kind>" pendientes de migrar.
    -- ('porci_n' con _ matchea "porción" y "porcion".)
    FOR cat IN
      SELECT DISTINCT t.categoria_id
      FROM tipos_producto t
      WHERE lower(t.nombre) LIKE ('%porci_n ' || kind)
        AND lower(t.nombre) <> lower(target_nombre)
        AND (
          t.activo = true
          OR EXISTS (SELECT 1 FROM productos p WHERE p.tipo_producto_id = t.id)
          OR EXISTS (SELECT 1 FROM modificadores_aplicables ma WHERE ma.tipo_producto_id = t.id)
        )
    LOOP
      -- 1) Asegurar la sub-categoría destino en esta categoría.
      SELECT id INTO target_id
        FROM tipos_producto
       WHERE categoria_id = cat.categoria_id
         AND lower(nombre) = lower(target_nombre);
      IF target_id IS NULL THEN
        SELECT COALESCE(MIN(orden), 0) INTO orden_min
          FROM tipos_producto
         WHERE categoria_id = cat.categoria_id
           AND lower(nombre) LIKE ('%porci_n ' || kind);
        INSERT INTO tipos_producto (id, categoria_id, nombre, cocina_interviene, es_subcategoria, orden, activo)
        VALUES (gen_random_uuid(), cat.categoria_id, target_nombre, true, true, orden_min, true)
        RETURNING id INTO target_id;
      ELSE
        UPDATE tipos_producto
           SET es_subcategoria = true, cocina_interviene = true, activo = true
         WHERE id = target_id;
      END IF;

      -- 2) Migrar cada tipo viejo de esta categoría/kind.
      FOR src IN
        SELECT t.id, t.nombre
          FROM tipos_producto t
         WHERE t.categoria_id = cat.categoria_id
           AND lower(t.nombre) LIKE ('%porci_n ' || kind)
           AND t.id <> target_id
      LOOP
        -- 2a) Re-apuntar los grupos de modificadores del TIPO viejo a cada
        --     PRODUCTO del tipo (mismo efecto en el cajero, sin depender del tipo).
        FOR apl IN
          SELECT id, grupo_modificador_id, obligatorio_override
            FROM modificadores_aplicables
           WHERE tipo_producto_id = src.id
        LOOP
          FOR prod IN SELECT id FROM productos WHERE tipo_producto_id = src.id LOOP
            IF NOT EXISTS (
              SELECT 1 FROM modificadores_aplicables
               WHERE grupo_modificador_id = apl.grupo_modificador_id
                 AND producto_id = prod.id
            ) THEN
              INSERT INTO modificadores_aplicables (id, grupo_modificador_id, producto_id, obligatorio_override)
              VALUES (gen_random_uuid(), apl.grupo_modificador_id, prod.id, apl.obligatorio_override);
            END IF;
          END LOOP;
          DELETE FROM modificadores_aplicables WHERE id = apl.id;
        END LOOP;

        -- 2b) Mover los productos al tipo destino.
        UPDATE productos SET tipo_producto_id = target_id WHERE tipo_producto_id = src.id;

        -- 2c) Desactivar el tipo viejo (no borrar: histórico).
        UPDATE tipos_producto SET activo = false WHERE id = src.id;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
