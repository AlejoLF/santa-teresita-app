-- Habilitar Supabase Realtime sobre la tabla `ventas`.
--
-- Por qué:
--   Cuando un usuario está editando una venta y otro la modifica/finaliza,
--   queremos que el cliente del primero reciba un push y muestre un aviso.
--   La política es LWW (last-write-wins) en el servidor, y el aviso al
--   cliente es para evitar que se pierda contexto.
--
-- Cómo:
--   1) `ALTER TABLE ventas REPLICA IDENTITY FULL` — para que el WAL incluya
--      todas las columnas en los UPDATE/DELETE events (sin esto solo
--      llegan PK + columnas modificadas, lo cual rompe `payload.old` para
--      diff).
--   2) Agregar la tabla a la publicación `supabase_realtime` que Supabase
--      crea por defecto. Usamos un DO block para tolerar que ya esté.

ALTER TABLE ventas REPLICA IDENTITY FULL;

DO $$
BEGIN
  -- La publicación supabase_realtime existe en proyectos Supabase. Si no
  -- existe (entorno self-hosted sin Supabase), saltamos.
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    -- Solo agregamos si no está ya
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'ventas'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE ventas';
    END IF;
  END IF;
END $$;
