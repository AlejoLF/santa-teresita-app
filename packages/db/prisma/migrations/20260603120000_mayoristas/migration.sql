-- Mayoristas: clientes con cuenta corriente + remitos.
-- Ventas a empresas a precio especial (vía lista de precios dedicada) que se
-- entregan con remitos y se cobran por cuenta corriente a fin de mes.

-- Enum estado de remito (idempotente).
DO $$ BEGIN
  CREATE TYPE "EstadoRemito" AS ENUM ('PENDIENTE', 'ANULADO');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS clientes_mayoristas (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre           VARCHAR(160) NOT NULL,
  cuit             VARCHAR(20),
  contacto         VARCHAR(120),
  telefono         VARCHAR(40),
  email            VARCHAR(120),
  direccion        TEXT,
  lista_precios_id UUID NOT NULL,
  activo           BOOLEAN NOT NULL DEFAULT true,
  observaciones    TEXT,
  creado_at        TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT clientes_mayoristas_lista_fkey FOREIGN KEY (lista_precios_id)
    REFERENCES listas_precios (id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clientes_mayoristas_activo
  ON clientes_mayoristas (activo);

CREATE TABLE IF NOT EXISTS remitos (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero               SERIAL,
  cliente_mayorista_id UUID NOT NULL,
  fecha                TIMESTAMP(3) NOT NULL DEFAULT now(),
  total                DECIMAL(18, 2) NOT NULL,
  estado               "EstadoRemito" NOT NULL DEFAULT 'PENDIENTE',
  observaciones        TEXT,
  usuario_id           UUID,
  motivo_anulacion     TEXT,
  anulado_at           TIMESTAMP(3),
  creado_at            TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT remitos_numero_key UNIQUE (numero),
  CONSTRAINT remitos_cliente_fkey FOREIGN KEY (cliente_mayorista_id)
    REFERENCES clientes_mayoristas (id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_remitos_cliente_estado
  ON remitos (cliente_mayorista_id, estado);
CREATE INDEX IF NOT EXISTS idx_remitos_fecha ON remitos (fecha);

CREATE TABLE IF NOT EXISTS remito_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remito_id       UUID NOT NULL,
  producto_id     UUID,
  nombre_snapshot VARCHAR(200) NOT NULL,
  cantidad        DECIMAL(12, 3) NOT NULL,
  precio_unitario DECIMAL(18, 2) NOT NULL,
  subtotal        DECIMAL(18, 2) NOT NULL,
  orden           INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT remito_items_remito_fkey FOREIGN KEY (remito_id)
    REFERENCES remitos (id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_remito_items_remito ON remito_items (remito_id);
