-- CreateTable
CREATE TABLE "configuracion_sistema" (
    "id" UUID NOT NULL,
    "clave" VARCHAR(80) NOT NULL,
    "valor" TEXT NOT NULL,
    "tipo" VARCHAR(20) NOT NULL DEFAULT 'string',
    "descripcion" TEXT,
    "categoria" VARCHAR(40),
    "editable" BOOLEAN NOT NULL DEFAULT true,
    "actualizado_at" TIMESTAMP(3) NOT NULL,
    "actualizado_por" VARCHAR(120),

    CONSTRAINT "configuracion_sistema_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "configuracion_sistema_clave_key" ON "configuracion_sistema"("clave");

-- CreateIndex
CREATE INDEX "configuracion_sistema_categoria_idx" ON "configuracion_sistema"("categoria");
