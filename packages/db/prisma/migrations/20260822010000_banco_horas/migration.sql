-- Banco de horas de empleados (SPEC §14).
--
-- Aditiva: no toca ni borra nada existente, así que es segura de aplicar antes
-- que el código (como pide el playbook de release cuando hay cambio de schema).

CREATE TYPE "TipoMovimientoBancoHoras" AS ENUM ('HORAS_TRABAJADAS', 'ADELANTO', 'LIQUIDACION', 'AJUSTE');

CREATE TABLE "categorias_laborales" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "valor_hora" DECIMAL(18,2) NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "categorias_laborales_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "categorias_laborales_nombre_key" ON "categorias_laborales"("nombre");
CREATE INDEX "categorias_laborales_activo_idx" ON "categorias_laborales"("activo");

CREATE TABLE "valores_hora_categoria" (
    "id" UUID NOT NULL,
    "categoria_id" UUID NOT NULL,
    "valor_hora" DECIMAL(18,2) NOT NULL,
    "vigencia_desde" TIMESTAMP(3) NOT NULL,
    "usuario_id" UUID NOT NULL,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "valores_hora_categoria_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "valores_hora_categoria_categoria_id_vigencia_desde_idx" ON "valores_hora_categoria"("categoria_id", "vigencia_desde");

CREATE TABLE "tipos_hora" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(60) NOT NULL,
    "multiplicador" DECIMAL(6,3),
    "valor_hora_fijo" DECIMAL(18,2),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tipos_hora_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tipos_hora_nombre_key" ON "tipos_hora"("nombre");
CREATE INDEX "tipos_hora_activo_idx" ON "tipos_hora"("activo");

-- XOR en la base y no sólo en la app: un tipo de hora con las dos formas de
-- precio, o con ninguna, no se puede cobrar. Que lo impida el motor significa
-- que ningún camino —ni un script, ni un import— puede dejarlo inconsistente.
ALTER TABLE "tipos_hora" ADD CONSTRAINT "tipos_hora_precio_xor"
    CHECK (("multiplicador" IS NOT NULL) <> ("valor_hora_fijo" IS NOT NULL));

CREATE TABLE "liquidaciones_empleado" (
    "id" UUID NOT NULL,
    "empleado_id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "horas_liquidadas" DECIMAL(8,2) NOT NULL,
    "valor_hora_aplicado" DECIMAL(18,2) NOT NULL,
    "monto_horas" DECIMAL(18,2) NOT NULL,
    "adelantos_aplicados" DECIMAL(18,2) NOT NULL,
    "monto_pagado" DECIMAL(18,2) NOT NULL,
    "movimiento_id" UUID,
    "observacion" TEXT,
    "usuario_id" UUID NOT NULL,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "liquidaciones_empleado_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "liquidaciones_empleado_empleado_id_fecha_idx" ON "liquidaciones_empleado"("empleado_id", "fecha");

CREATE TABLE "movimientos_banco_horas" (
    "id" UUID NOT NULL,
    "empleado_id" UUID NOT NULL,
    "tipo" "TipoMovimientoBancoHoras" NOT NULL,
    "horas" DECIMAL(8,2),
    "monto_pesos" DECIMAL(18,2),
    "tipo_hora_id" UUID,
    "fecha" DATE NOT NULL,
    "observacion" TEXT,
    "movimiento_id" UUID,
    "liquidacion_id" UUID,
    "usuario_id" UUID NOT NULL,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "movimientos_banco_horas_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "movimientos_banco_horas_empleado_id_fecha_idx" ON "movimientos_banco_horas"("empleado_id", "fecha");
-- El índice que sostiene la consulta caliente: "lo pendiente de esta persona"
-- es liquidacion_id IS NULL, y es lo que se calcula en cada pantalla.
CREATE INDEX "movimientos_banco_horas_empleado_id_liquidacion_id_idx" ON "movimientos_banco_horas"("empleado_id", "liquidacion_id");
CREATE INDEX "movimientos_banco_horas_liquidacion_id_idx" ON "movimientos_banco_horas"("liquidacion_id");

ALTER TABLE "empleados" ADD COLUMN "categoria_laboral_id" UUID;
ALTER TABLE "empleados" ADD COLUMN "valor_hora_propio" DECIMAL(18,2);
CREATE INDEX "empleados_categoria_laboral_id_idx" ON "empleados"("categoria_laboral_id");

ALTER TABLE "valores_hora_categoria" ADD CONSTRAINT "valores_hora_categoria_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categorias_laborales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "valores_hora_categoria" ADD CONSTRAINT "valores_hora_categoria_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "empleados" ADD CONSTRAINT "empleados_categoria_laboral_id_fkey" FOREIGN KEY ("categoria_laboral_id") REFERENCES "categorias_laborales"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "liquidaciones_empleado" ADD CONSTRAINT "liquidaciones_empleado_empleado_id_fkey" FOREIGN KEY ("empleado_id") REFERENCES "empleados"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "liquidaciones_empleado" ADD CONSTRAINT "liquidaciones_empleado_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "movimientos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "liquidaciones_empleado" ADD CONSTRAINT "liquidaciones_empleado_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "movimientos_banco_horas" ADD CONSTRAINT "movimientos_banco_horas_empleado_id_fkey" FOREIGN KEY ("empleado_id") REFERENCES "empleados"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "movimientos_banco_horas" ADD CONSTRAINT "movimientos_banco_horas_tipo_hora_id_fkey" FOREIGN KEY ("tipo_hora_id") REFERENCES "tipos_hora"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "movimientos_banco_horas" ADD CONSTRAINT "movimientos_banco_horas_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "movimientos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "movimientos_banco_horas" ADD CONSTRAINT "movimientos_banco_horas_liquidacion_id_fkey" FOREIGN KEY ("liquidacion_id") REFERENCES "liquidaciones_empleado"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Arranca con una sola: una hora es una hora. La encargada crea las demás desde
-- la pantalla de configuración si algún día las necesita.
INSERT INTO "tipos_hora" ("id", "nombre", "multiplicador", "orden")
VALUES (gen_random_uuid(), 'Normales', 1.000, 0);
