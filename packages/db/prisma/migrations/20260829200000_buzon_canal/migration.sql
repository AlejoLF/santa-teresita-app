-- Buzón de recepciones de canal (RAPPI / Pedidos YA / Mercado Libre).
--
-- Registra TODO lo que golpea /channel/*, aceptado o rechazado, para poder
-- diagnosticar por qué un pedido de plataforma no entró. Ver el comentario del
-- modelo `RecepcionCanal` en schema.prisma.
--
-- Aditiva e idempotente: tabla nueva, no toca nada existente.

CREATE TABLE IF NOT EXISTS "recepciones_canal" (
    "id"               UUID         NOT NULL,
    "recibido_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ruta"             VARCHAR(160) NOT NULL,
    "metodo"           VARCHAR(10)  NOT NULL,
    "ip"               VARCHAR(60),
    "headers"          JSONB        NOT NULL,
    "body"             JSONB,
    "body_texto"       TEXT,
    "bytes"            INTEGER      NOT NULL DEFAULT 0,
    "status"           INTEGER      NOT NULL,
    "resultado"        VARCHAR(40)  NOT NULL,
    "detalle"          TEXT,
    "canal"            VARCHAR(30),
    "id_externo_canal" VARCHAR(120),
    "venta_id"         UUID,

    CONSTRAINT "recepciones_canal_pkey" PRIMARY KEY ("id")
);

-- Por fecha: el panel siempre muestra "lo último que llegó".
CREATE INDEX IF NOT EXISTS "recepciones_canal_recibido_at_idx"
    ON "recepciones_canal"("recibido_at");

-- Por resultado: "mostrame sólo lo que se rechazó" es la consulta que importa
-- cuando algo no entró.
CREATE INDEX IF NOT EXISTS "recepciones_canal_resultado_recibido_at_idx"
    ON "recepciones_canal"("resultado", "recibido_at");
