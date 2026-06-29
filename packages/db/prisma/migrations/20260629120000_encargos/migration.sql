-- Encargos: pedidos para días futuros (pestaña /encargos).
--
-- Reutiliza la tabla `ventas` (toda la maquinaria de cobro/sesión/auditoría/
-- impresión ya existe). Agrega flags de encargo + datos de entrega futura +
-- estado de cobro. Migración ADITIVA y SEGURA: columnas nullable / con default,
-- enums nuevos, FK e índice. Idempotente (IF NOT EXISTS / EXCEPTION duplicate).
--
-- Lógica clave (en el API): un encargo nace PROCESADA + es_encargo=true +
-- estado_cobro_encargo=A_PAGAR (no cuenta en caja hasta finalizar). Al cobrarlo
-- días después, se FINALIZA y se REASIGNA sesion_caja_id a la sesión actual del
-- momento del cobro (no retroactivo). Ver invariante sesionCajaId en CLAUDE.md.

-- Enums nuevos (idempotentes)
DO $$ BEGIN
  CREATE TYPE "FranjaEntregaEncargo" AS ENUM ('MANANA', 'TARDE', 'NOCHE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TipoEntregaEncargo" AS ENUM ('RETIRO', 'ENVIO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "EstadoCobroEncargo" AS ENUM ('A_PAGAR', 'COBRADO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Nuevo tipo de trabajo de impresión: comanda de encargo.
-- (ADD VALUE va dentro de la transacción implícita; el valor no se usa en esta
--  misma migración, así que PG 12+ lo acepta sin problemas.)
ALTER TYPE "TipoTrabajoImpresion" ADD VALUE IF NOT EXISTS 'COMANDA_ENCARGO';

-- Columnas de encargo en `ventas`
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "es_encargo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "fecha_entrega_promesa" DATE;
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "hora_entrega_exacta" VARCHAR(5);
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "franja_entrega" "FranjaEntregaEncargo";
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "tipo_entrega_encargo" "TipoEntregaEncargo";
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "estado_cobro_encargo" "EstadoCobroEncargo" NOT NULL DEFAULT 'A_PAGAR';
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "fecha_cobro_encargo" TIMESTAMP(3);
ALTER TABLE "ventas" ADD COLUMN IF NOT EXISTS "usuario_cobro_encargo_id" UUID;

-- FK al usuario que efectúa el cobro diferido del encargo.
DO $$ BEGIN
  ALTER TABLE "ventas" ADD CONSTRAINT "ventas_usuario_cobro_encargo_id_fkey"
    FOREIGN KEY ("usuario_cobro_encargo_id") REFERENCES "usuarios"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Índice para el calendario de encargos (lista por día de entrega).
CREATE INDEX IF NOT EXISTS "ventas_es_encargo_fecha_entrega_promesa_idx"
  ON "ventas"("es_encargo", "fecha_entrega_promesa");
