-- Traducción del menú de una plataforma (RAPPI) al catálogo del POS.
--
-- El menú vive en la web de RAPPI; cada producto/topping de RAPPI se traduce a
-- un Producto / OpcionModificador nuestro para contarlo. Lo que llega sin
-- traducción entra con el producto comodín y queda acá como PENDIENTE. Ver el
-- comentario del modelo `TraduccionCanal` en schema.prisma.
--
-- Aditiva e idempotente: tabla nueva, no toca nada existente.

CREATE TABLE IF NOT EXISTS "traducciones_canal" (
    "id"                  UUID          NOT NULL,
    "plataforma"          VARCHAR(30)   NOT NULL,
    "tipo"                VARCHAR(20)   NOT NULL,
    "id_externo"          VARCHAR(120)  NOT NULL,
    "nombre_externo"      VARCHAR(200)  NOT NULL,
    "sku_externo"         VARCHAR(120),
    "categoria_externa"   VARCHAR(200),
    "precio_externo"      DECIMAL(18,2),
    "estado"              VARCHAR(20)   NOT NULL DEFAULT 'PENDIENTE',
    "origen_traduccion"   VARCHAR(20),
    "producto_id"         UUID,
    "opcion_id"           UUID,
    "cantidad_por_unidad" DECIMAL(12,3),
    "origen"              VARCHAR(20)   NOT NULL DEFAULT 'PEDIDO',
    "veces_visto"         INTEGER       NOT NULL DEFAULT 0,
    "visto_at"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_at"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_at"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_por"     VARCHAR(120),

    CONSTRAINT "traducciones_canal_pkey" PRIMARY KEY ("id")
);

-- Un producto de la plataforma se traduce una sola vez.
CREATE UNIQUE INDEX IF NOT EXISTS "traducciones_canal_plataforma_tipo_id_externo_key"
    ON "traducciones_canal"("plataforma", "tipo", "id_externo");

-- "Mostrame los pendientes" es la consulta de la pantalla.
CREATE INDEX IF NOT EXISTS "traducciones_canal_plataforma_estado_idx"
    ON "traducciones_canal"("plataforma", "estado");

DO $$ BEGIN
  ALTER TABLE "traducciones_canal"
    ADD CONSTRAINT "traducciones_canal_producto_id_fkey"
    FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "traducciones_canal"
    ADD CONSTRAINT "traducciones_canal_opcion_id_fkey"
    FOREIGN KEY ("opcion_id") REFERENCES "opciones_modificador"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
