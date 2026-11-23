-- Cola del email del cierre de caja (23/11/2026).
--
-- "Enviar por email" y el envío automático al cerrar dejan una fila acá; el que
-- manda es S1, con reintentos. Antes el envío corría dentro del request: si la
-- cajera cerraba el programa enseguida se perdía, y desde el celular (API en
-- Railway, que bloquea SMTP en el plan Hobby) no salía nunca.
--
-- Sin FK a sesiones_caja a propósito: en Supabase la fila la crea el API de la
-- nube y la sesión llega por replicación; una FK podría trabar el pedido.
-- Aditiva e idempotente.
CREATE TABLE IF NOT EXISTS "envios_email_cierre" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "sesion_caja_id"     UUID         NOT NULL,
  "destinatarios"      TEXT[]       DEFAULT ARRAY[]::TEXT[],
  "estado"             VARCHAR(20)  NOT NULL DEFAULT 'PENDIENTE',
  "intentos"           INTEGER      NOT NULL DEFAULT 0,
  "ultimo_error"       TEXT,
  "proximo_intento_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "origen"             VARCHAR(20)  NOT NULL,
  "automatico"         BOOLEAN      NOT NULL DEFAULT false,
  "solicitado_por_id"  UUID,
  "creado_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "enviado_at"         TIMESTAMP(3),
  "enviado_a"          TEXT,
  CONSTRAINT "envios_email_cierre_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "envios_email_cierre_estado_proximo_intento_at_idx"
  ON "envios_email_cierre" ("estado", "proximo_intento_at");
CREATE INDEX IF NOT EXISTS "envios_email_cierre_sesion_caja_id_idx"
  ON "envios_email_cierre" ("sesion_caja_id");
