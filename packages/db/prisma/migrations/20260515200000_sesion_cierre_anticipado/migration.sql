-- alpha.19: cierre anticipado de sesiones de caja.
--
-- Cuando la encargada cierra el turno antes de la hora pautada (ej: cierra
-- MANANA a las 13:00 cuando estaba pautada hasta 14:30), marcamos la sesión
-- con `cerrada_anticipadamente = true`. El resolverSlotActivo del API
-- considera esto y NO reabre un slot del mismo turno por el resto del día
-- — la próxima venta queda fuera de horario hasta que abra el siguiente
-- turno. Default false porque el wipe legacy no afecta cierres en horario.

ALTER TABLE sesiones_caja
  ADD COLUMN IF NOT EXISTS cerrada_anticipadamente BOOLEAN NOT NULL DEFAULT FALSE;
