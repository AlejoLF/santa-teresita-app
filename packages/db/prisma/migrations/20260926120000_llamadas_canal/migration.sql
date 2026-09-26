-- Registro de llamadas SALIENTES a la API de una plataforma (RAPPI).
--
-- Es el espejo del buzón `recepciones_canal`: aquél guarda lo que nos mandan,
-- éste lo que mandamos nosotros. Sin esto, "RAPPI no tomó el pedido" no se
-- puede distinguir de "nunca lo llamamos" ni de "lo llamamos y rechazó". Ver el
-- comentario del modelo `LlamadaCanal` en schema.prisma.
--
-- Aditiva e idempotente: tabla nueva, no toca nada existente.

CREATE TABLE IF NOT EXISTS "llamadas_canal" (
    "id"             UUID         NOT NULL,
    "hecho_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plataforma"     VARCHAR(30)  NOT NULL,
    "metodo"         VARCHAR(10)  NOT NULL,
    "ruta"           VARCHAR(300) NOT NULL,
    "contexto"       VARCHAR(160),
    "status"         INTEGER,
    "ok"             BOOLEAN      NOT NULL,
    "ms"             INTEGER      NOT NULL,
    "request_body"   JSONB,
    "response_body"  JSONB,
    "response_texto" TEXT,
    "error"          TEXT,
    "venta_id"       UUID,

    CONSTRAINT "llamadas_canal_pkey" PRIMARY KEY ("id")
);

-- Por fecha: el panel muestra "lo último que hicimos".
CREATE INDEX IF NOT EXISTS "llamadas_canal_hecho_at_idx"
    ON "llamadas_canal"("hecho_at");

-- "Mostrame sólo las que fallaron" es la consulta que importa cuando algo no anda.
CREATE INDEX IF NOT EXISTS "llamadas_canal_plataforma_ok_hecho_at_idx"
    ON "llamadas_canal"("plataforma", "ok", "hecho_at");
