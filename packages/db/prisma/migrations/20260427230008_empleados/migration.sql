-- CreateEnum
CREATE TYPE "PuestoEmpleado" AS ENUM ('CAJERO', 'COCINERO', 'ENCARGADO', 'MOTOQUERO', 'ADMINISTRATIVO', 'OTRO');

-- CreateTable
CREATE TABLE "empleados" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "apellido" VARCHAR(120),
    "dni" VARCHAR(20),
    "cuil" VARCHAR(20),
    "puesto" "PuestoEmpleado" NOT NULL,
    "sueldo_base" DECIMAL(18,2),
    "forma_pago" VARCHAR(40),
    "telefono" VARCHAR(40),
    "email" VARCHAR(120),
    "fecha_ingreso" DATE,
    "fecha_egreso" DATE,
    "observaciones" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "empleados_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "empleados_activo_idx" ON "empleados"("activo");
