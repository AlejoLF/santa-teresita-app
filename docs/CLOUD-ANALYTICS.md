# Cloud Analytics — `analytics_ventas` para Julio

VIEW desnormalizada de ventas + tutorial para que el dueño consulte el negocio
desde Claude/ChatGPT vía Postgres MCP.

## Por qué esto existe

El schema operativo está normalizado en ~10 tablas (`ventas`, `items_venta`,
`pagos`, `clientes`, `delivery_info`, `usuarios`, etc.). Para que un LLM
genere SQL bien hay que pasarle el schema completo, lo que es:

1. **Caro en tokens** (prompt grande).
2. **Propenso a JOINs mal armados** — el LLM se confunde con foreign keys.

Solución: una **VIEW** llamada `analytics_ventas` que tiene UNA fila por venta
con todo lo que Julio podría querer, ya pre-joineado.

## Schema de `analytics_ventas`

| Columna | Tipo | Descripción |
|---|---|---|
| **Identidad** | | |
| `venta_id` | UUID | FK al detalle si Julio quiere ir más profundo |
| `numero` | INT | Numerador global secuencial |
| `numero_orden` | INT | Numerador del turno (#1, #2, ... reseteado por sesión) |
| `estado` | ENUM | `PROCESADA` / `FINALIZADA` / `ANULADA` — **filtrar por `FINALIZADA` para análisis real** |
| `canal` | ENUM | `MOSTRADOR` / `WHATSAPP` / `WEB` / `RAPPI` / `PEDIDOS_YA` / `MERCADO_LIBRE` / `DELIVERATE` / `TELEFONO` |
| `modalidad` | ENUM | `TAKE_AWAY` / `DELIVERY_PROPIO` / `DELIVERY_PLATAFORMA` / `DELIVERY_DELIVERATE` |
| **Tiempos** | | |
| `fecha` | DATE | Fecha de apertura (YYYY-MM-DD) |
| `hora` | TIME | Hora de apertura (HH:MM:SS) |
| `timestamp_apertura` | TIMESTAMPTZ | Apertura completa con TZ |
| `timestamp_cierre` | TIMESTAMPTZ | Cuando se finalizó (NULL si abierto) |
| `timestamp_anulacion` | TIMESTAMPTZ | Cuando se anuló (NULL si no) |
| `dia_semana` | INT | 0=domingo, 1=lunes, ..., 6=sábado |
| `hora_del_dia` | INT | 0-23, útil para "rush hour" |
| **Cliente** | | |
| `cliente_nombre` | TEXT | Nombre + apellido, o `'NN'` si no se cargó |
| `cliente_telefono` | TEXT | Para buscar pedidos de un teléfono |
| `cliente_tipo` | ENUM | `CASUAL` / `REGISTRADO` / `CORPORATIVO` / `PLATAFORMA` |
| `cliente_recurrente` | BOOL | `true` si es REGISTRADO o CORPORATIVO |
| **Vendedor** | | |
| `vendedor_nombre` | TEXT | Quien abrió la venta |
| `cerrado_por` | TEXT | Quien finalizó (puede ser distinto del vendedor) |
| `anulado_por` | TEXT | Si se anuló |
| `motivo_anulacion` | TEXT | Texto libre |
| **Financiero** | | |
| `subtotal` | DECIMAL | Precio antes de descuento/recargo |
| `descuento` | DECIMAL | Plata descontada (incluye 10% efectivo si aplicó) |
| `recargo_canal` | DECIMAL | Recargo de RAPPI/PYA/MELI |
| `total` | DECIMAL | **El número que cobramos al cliente** |
| `total_pagado` | DECIMAL | Lo que efectivamente pagaron (debería = total) |
| `descuento_efectivo` | BOOL | `true` si pagó con efectivo y aplicó el 10% off |
| **Pagos** | | |
| `pagos` | JSONB | Array `[{metodo, cuenta, monto, ...}]` — soporta multi-pago |
| `metodos_pago` | TEXT | Resumen string `"EFECTIVO + DEBITO"` |
| **Productos** | | |
| `productos` | JSONB | Array `[{producto, cantidad, modificadores, observacion, ...}]` |
| `productos_resumen` | TEXT | `"Ravioles x2 \| Pizza grande \| Salsa fileto"` |
| `cantidad_items` | INT | Cuántas líneas de producto tiene |
| **Delivery** | | |
| `es_delivery` | BOOL | `true` si modalidad es DELIVERY_* |
| `direccion_entrega` | TEXT | Dirección snapshot |
| `empresa_delivery` | TEXT | RAPPI / PYA / DELIVERATE / NULL si propio |
| `hora_prometida` | TIMESTAMPTZ | Cuando se prometió entregar |
| `hora_salida` | TIMESTAMPTZ | Cuando salió Damián con el pedido |
| `hora_entrega` | TIMESTAMPTZ | Cuando se confirmó entregado |
| `estado_delivery` | ENUM | `PENDIENTE` / `EN_RUTA` / `ENTREGADO` / `NO_ENTREGADO` / `DEVUELTO` |
| `demora_delivery_min` | INT | Minutos desde apertura hasta entrega |
| **Otros** | | |
| `observaciones` | TEXT | Texto libre del cajero |
| `id_orden_externa` | TEXT | ID del pedido en RAPPI/PYA/MELI (reconcilación) |
| `tiene_cocina` | BOOL | `true` si algo del pedido pasa por cocina |
| `pc_origen` | TEXT | Qué PC del local cargó la venta |

## Setup del MCP en Claude / ChatGPT

### Credenciales

```
user:     julio_analytics
password: <generada al correr `pnpm cloud:create-analytics-view`>
host:     aws-1-sa-east-1.pooler.supabase.com
port:     6543
database: postgres
schema:   public
```

**Acceso:** SELECT-only sobre `analytics_ventas`. NO puede leer otras tablas
(no ve PINs, audit logs, datos de empleados, etc.).

### Para Claude Code

```bash
claude mcp add postgres-julio --env DATABASE_URL='postgresql://julio_analytics:[PASSWORD]@aws-1-sa-east-1.pooler.supabase.com:6543/postgres' -- cmd /c npx -y @modelcontextprotocol/server-postgres@latest
```

### Para Claude Desktop

Editá `%APPDATA%\Claude\claude_desktop_config.json` y agregá:

```json
{
  "mcpServers": {
    "santa-teresita-analytics": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres@latest"],
      "env": {
        "DATABASE_URL": "postgresql://julio_analytics:[PASSWORD]@aws-1-sa-east-1.pooler.supabase.com:6543/postgres"
      }
    }
  }
}
```

Reiniciá Claude Desktop.

### Para ChatGPT

ChatGPT no soporta MCP de Postgres oficialmente todavía. Workarounds:
1. Usá el conector "Custom GPT" con OpenAPI hacia un endpoint que vos hostees.
2. O simplemente usá Claude — soporta MCP nativo.

## Ejemplos de queries que Julio puede hacer

Una vez configurado el MCP, le podés escribir en lenguaje natural y el LLM
traduce a SQL. Ejemplos reales:

| Pregunta de Julio | SQL que el LLM genera |
|---|---|
| "¿Cuánto facturé el mes pasado?" | `SELECT SUM(total) FROM analytics_ventas WHERE estado = 'FINALIZADA' AND fecha >= date_trunc('month', current_date - interval '1 month') AND fecha < date_trunc('month', current_date)` |
| "Top 10 productos más vendidos en mayo" | `SELECT producto, SUM(cantidad) FROM analytics_ventas, jsonb_to_recordset(productos) AS x(producto text, cantidad numeric) WHERE estado='FINALIZADA' AND date_trunc('month', fecha) = '2026-05-01' GROUP BY producto ORDER BY 2 DESC LIMIT 10` |
| "¿Cuál fue mi peor día de la semana?" | `SELECT dia_semana, SUM(total) FROM analytics_ventas WHERE estado='FINALIZADA' GROUP BY dia_semana ORDER BY 2 ASC` |
| "Pedidos de delivery con demora > 60min" | `SELECT venta_id, cliente_nombre, demora_delivery_min FROM analytics_ventas WHERE es_delivery AND demora_delivery_min > 60 ORDER BY demora_delivery_min DESC` |
| "Clientes recurrentes que más compraron este año" | `SELECT cliente_nombre, COUNT(*), SUM(total) FROM analytics_ventas WHERE cliente_recurrente AND estado='FINALIZADA' AND date_part('year', fecha)=date_part('year', current_date) GROUP BY cliente_nombre ORDER BY 3 DESC LIMIT 20` |
| "Ventas con observación que mencione 'devolver'" | `SELECT * FROM analytics_ventas WHERE observaciones ILIKE '%devolv%' ORDER BY fecha DESC` |
| "¿Cuánta plata fue por cada canal en marzo?" | `SELECT canal, SUM(total) FROM analytics_ventas WHERE estado='FINALIZADA' AND fecha BETWEEN '2026-03-01' AND '2026-03-31' GROUP BY canal ORDER BY 2 DESC` |
| "Hora pico promedio del local" | `SELECT hora_del_dia, COUNT(*) FROM analytics_ventas WHERE estado='FINALIZADA' GROUP BY hora_del_dia ORDER BY 2 DESC LIMIT 5` |

## Refresh / mantenimiento

La VIEW es **siempre fresca** — cada SELECT recalcula. No requiere refresh.

Si en el futuro las queries se ponen lentas (volumen 10k+ ventas/mes), upgrade
a MATERIALIZED VIEW con refresh periódico:

```sql
-- En vez de CREATE OR REPLACE VIEW, usar:
CREATE MATERIALIZED VIEW analytics_ventas_mv AS SELECT ... ;

-- Refresh cada 5 minutos via cron job de Supabase
SELECT cron.schedule('refresh-analytics-ventas', '*/5 * * * *', $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_ventas_mv;
$$);
```

(Para tu volumen actual, no hace falta — el VIEW puro es perfectamente
performante).

## Cuando lleguen los datos a la cloud

Hoy la cloud tiene 0 ventas (la sync agent va a empujar desde la PC de Nancy
una vez la construyamos). Cuando esté el agente operativo:

1. Cada venta finalizada en local → sync push → `sync_inbox` cloud → worker
   inserta en `ventas` + `items_venta` + `pagos` + `delivery_info`.
2. La VIEW `analytics_ventas` lee esas tablas, ve los datos nuevos
   automáticamente.
3. Julio pregunta a su Claude → MCP query → respuesta.

## Troubleshooting

### "permission denied for view analytics_ventas"

El usuario que está consultando no es `julio_analytics` (probablemente alguien
intentó usar `anon` o `authenticated`). Solo el rol `julio_analytics` y el
`postgres`/`service_role` pueden leer.

### "no rows returned"

La cloud puede estar vacía. Corré `pnpm cloud:status` para ver cuántas filas
hay en `ventas`. Si es 0, esperá a que el sync agent empuje datos.

### Necesito rotar la password de julio_analytics

```sql
-- En el SQL Editor de Supabase:
DROP ROLE julio_analytics;
```

Después corré `pnpm cloud:create-analytics-view` — genera una password nueva
y la imprime en stdout.
