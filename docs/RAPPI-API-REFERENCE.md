# API de RAPPI — referencia transcrita

> **Qué es esto.** La documentación de RAPPI vive en `dev-portal.rappi.com`, detrás de
> un menú navegable y repartida en quince páginas. Esto es lo que se necesita para
> integrar, transcrito acá para no depender de poder entrar cada vez.
>
> **Transcrito el 26/09/2026.** Es una copia, no la fuente: si algo no cierra contra
> el comportamiento real, gana el portal. Los payloads de ejemplo son los del portal,
> no inventados.
>
> El plan de trabajo y el estado de cada capacidad están en
> [RAPPI-INTEGRACION.md](RAPPI-INTEGRACION.md).

## Dominios

Hay **dos familias de dominios** y se usan según el prefijo del endpoint. Confundirlas
es el primer error posible.

Para `/api/v2/restaurants-integrations-public-api/...` (los "legacy"):

| País | Dominio |
|-|-|
| **Desarrollo** | `https://microservices.dev.rappi.com` |
| **Argentina** | `https://services.rappi.com.ar` |
| Uruguay | `https://services.rappi.com.uy` |
| Chile | `https://services.rappi.cl` |
| Brasil | `https://services.rappi.com.br` |
| Colombia | `https://services.rappi.com` |
| México | `https://services.mxgrability.rappi.com` |
| Perú | `https://services.rappi.pe` |
| Ecuador | `https://services.rappi.com.ec` |
| Costa Rica | `https://services.rappi.co.cr` |

Para `/restaurants/{orders|menu|auth}/v1/...` (los "nuevos"):

| País | Dominio |
|-|-|
| **Desarrollo** | `https://api.dev.rappi.com` |
| **Argentina** | `https://api.rappi.com.ar` |
| Uruguay | `https://api.rappi.com.uy` |
| Chile | `https://api.rappi.cl` |
| Brasil | `https://api.rappi.com.br` |
| Colombia | `https://api.rappi.com.co` |
| México | `https://api.rappi.com.mx` |
| Perú | `https://api.rappi.pe` |
| Ecuador | `https://api.rappi.com.ec` |
| Costa Rica | `https://api.rappi.co.cr` |

## Autenticación

```
POST https://{NEW_DOMAIN}/restaurants/auth/v1/token/login/integrations
Content-Type: application/json
Accept: application/json

{ "client_id": "...", "client_secret": "..." }
```

Respuesta:

```json
{ "access_token": "...", "token_type": "Bearer", "expires_in": 604798 }
```

**El token dura UNA SEMANA.** Hay que cachearlo y renovarlo; pedir uno por request es
desperdiciar una llamada contra su rate limit en cada operación.

### El header NO es `Authorization`

En las llamadas siguientes el token va así:

```
x-authorization: Bearer: <access_token>
```

Dos cosas fuera de lo común, las dos a respetar al pie de la letra:

1. El header se llama **`x-authorization`**, no `Authorization`.
2. Después de `Bearer` va **dos puntos**: `Bearer: <token>`, no `Bearer <token>`.

Hay un token aparte para los endpoints de *utils*:
`POST /restaurants/auth/v1/token/login/utils`.

## Tiendas

Base: `{COUNTRY_DOMAIN}/api/v2/restaurants-integrations-public-api`

| | |
|-|-|
| **Listar** | `GET /stores-pa` |
| **Activar / desactivar** | `PUT /stores-pa/{storeId}/status?integrated=true\|false` |
| **Código de check-in** | `GET /stores-pa/{storeId}/check-in-code` |

`GET /stores-pa` →

```json
[{ "integrationId": "111", "rappiId": "890982", "name": "Store 1" }]
```

`PUT /stores-pa/{storeId}/status` → `{ "message": "The store {storeid} was changed to integrated {true} successfully." }`

### Horarios

Otro prefijo, y token de *utils*:

```
POST {COUNTRY_DOMAIN}/api/rest-ops-utils/store/schedule/{storeId}

{ "schedule_details": [
    { "days": "mon,tue,wed,thu,fri,sat,sun", "starts_time": "08:00:00", "ends_time": "20:00:00" }
] }
```

## Disponibilidad

Base: `{COUNTRY_DOMAIN}/api/v2/restaurants-integrations-public-api`

**Prender/apagar tiendas** — `PUT /availability/stores/enable` (y
`/enable/massive` para varias):

```json
{ "stores": [ { "store_id": "12312", "is_enabled": true } ] }
```

Respuesta:

```json
{ "results": [ {
  "store_id": 90774, "is_enabled": true, "operation_result": true,
  "operation_result_type": "SUCCESS", "operation_result_message": "success",
  "suspended_reason": null, "suspended_at": null, "suspended_time": 0
} ] }
```

**Prender/apagar productos** — `PUT /availability/stores/items` (con NUESTROS
sku) o `/availability/stores/items/rappi` (con los ids de ellos):

```json
[ { "store_integration_id": "999", "items": { "turn_on": ["1111"], "turn_off": ["5555"] } } ]
```

**Consultar** — `POST /availability/items/status` con
`{ "store_id": "...", "item_ids": ["..."] }` → `[{ item_id, item_type, stock_out_state }]`.

## Órdenes

Base: `{COUNTRY_DOMAIN}/api/v2/restaurants-integrations-public-api`

| | |
|-|-|
| **Tomar** | `PUT /orders/{orderId}/take/{cookingTime}` — `cookingTime` puede ir vacío para dejar el default |
| **Rechazar** | `PUT /orders/{orderId}/reject` — sólo órdenes en estado `SENT` |
| **Lista para retiro** | `POST /orders/{orderId}/ready-for-pickup` |
| **Listar nuevas** | `GET /orders` (opcional `?storeId=`) |
| **Listar en SENT** | `GET /orders/status/sent` |
| **Eventos de una orden** | `GET /orders/{orderId}/events` |

Body de `reject`:

```json
{
  "reason": "texto",
  "cancel_type": "ITEM_OUT_OF_STOCK",
  "items_ids": [],
  "items_skus": []
}
```

`cancel_type` es uno de: `ITEM_WRONG_PRICE`, `ITEM_NOT_FOUND`, `ITEM_OUT_OF_STOCK`,
`ORDER_MISSING_INFORMATION`, `ORDER_MISSING_ADDRESS_INFORMATION`,
`ORDER_TOTAL_INCORRECT`. Los que son "por ítem" exigen decir cuáles.

> `ready-for-pickup` deja de ejecutarse después de tres requests.

## Webhooks

### Eventos

| Evento | Qué es |
|-|-|
| `NEW_ORDER` | pedido nuevo |
| `NEW_ORDER_SCHEDULED` | pedido agendado, aviso anticipado |
| `NEW_ORDER_SCHEDULED_CANCELLED` | se canceló antes de soltarse a la tienda |
| `ORDER_EVENT_CANCEL` | cancelación |
| `ORDER_OTHER_EVENT` | otros eventos de la orden |
| `MENU_APPROVED` / `MENU_REJECTED` | resultado de publicar el menú |
| `PING` | health check que usa RAPPI para detectar caídas |
| `STORE_CONNECTIVITY` | la tienda pasó a estar disponible o no |
| `ORDER_RT_TRACKING` | seguimiento del repartidor |
| `STORE_PROVISIONING_STATUS` | terminó un aprovisionamiento |

### La firma — HMAC

```
Rappi-Signature: t=123456,sign=<hash>
```

- Algoritmo: **HMAC-SHA256**.
- Lo que se firma: **`timestamp + "." + cuerpo`** (el `t` del header, un punto, y el
  body crudo tal cual llegó).
- La clave es el `secret` del webhook.
- Si no coincide: responder **no-2xx** y descartar.

> Se firma el **cuerpo crudo**, así que hay que tenerlo antes de parsearlo. Un
> `JSON.parse` + `JSON.stringify` reordena claves y cambia espacios: el hash da
> distinto y la firma válida se rechaza.

### Suscribirse

A nivel integración (es lo que pide *Auto-onboarding*):

```
POST {COUNTRY_DOMAIN}/api/v2/restaurants-integrations-public-api/clients/{clientId}/webhooks

{ "event": "STORE_PROVISIONING_STATUS", "url": "https://.../rappi/events", "secret": "..." }
```

Si se omite el `secret`, **no manda firma**.

Por tienda hay además: `POST /webhook`, `GET /webhook/{EVENT}`,
`PUT /webhook/{EVENT}/change-url`, `PUT /webhook/{EVENT}/add-stores`,
`DELETE /webhook/{EVENT}/remove-stores`, `PUT /webhook/{EVENT}/reset-secret`,
`PUT /webhook/{EVENT}/change-status`.

> Los webhooks por tienda **no cuentan** para la capacidad de Auto-onboarding: ésa
> exige el de nivel integración.

### Qué responder

- `NEW_ORDER`: HTTP 200 en **menos de 5 segundos**.
- `PING`: HTTP 200 en **menos de 3 segundos**, con
  `{ "status": "OK", "description": "Store on" }`.
- `ORDER_EVENT_CANCEL`: HTTP 200, y liberar la orden. Payload:
  `{ "event": "canceled_with_charge", "order_id": "106", "store_id": "900109448" }`

## El payload de NEW_ORDER

Lo que hacía falta para escribir el adaptador:

```json
{
  "order_detail": {
    "order_id": "1308613474",
    "cooking_time": 15,
    "min_cooking_time": 0,
    "max_cooking_time": 0,
    "created_at": "2026-09-18 10:19:09",
    "place_at": null,
    "delivery_method": "delivery",
    "delivery_operation_type": "turbo",
    "payment_method": "cc",
    "billing_information": null,
    "delivery_information": null,
    "discounts": [],
    "vendors": [],
    "totals": {
      "total_products": 10000,
      "total_discounts": 0,
      "total_products_with_discount": 10000.00,
      "total_products_without_discount": 10000.00,
      "total_other_discounts": 0.00,
      "total_order": 10000.00,
      "total_to_pay": 0.00,
      "discount_by_support": 0,
      "total_discount_by_partner": 0,
      "charges": { "shipping": 3000.00, "service_fee": 5900.00 },
      "other_totals": { "total_rappi_credits": 0.00, "total_rappi_pay": 0.00, "tip": 0.00 }
    },
    "items": [
      {
        "id": "729963",
        "sku": "0009",
        "name": "Prueba 1",
        "type": "product",
        "price": 10000.00,
        "quantity": 1,
        "comments": "",
        "unit_price_with_discount": 10000.00,
        "unit_price_without_discount": 10000.00,
        "percentage_discount": 0.00,
        "toppingId": null,
        "toppingCategoryId": null,
        "categoryDescription": null,
        "subitems": []
      }
    ],
    "delivery_discount": null
  },
  "customer": null,
  "store": { "internal_id": "900105814", "external_id": "900105814", "name": "Tienda Sin Mapeo" }
}
```

Lo que importa para mapear a nuestro contrato neutral:

| Nuestro | De ellos |
|-|-|
| `idExternoCanal` | `order_detail.order_id` |
| `items[].codigo` | `order_detail.items[].sku` ← **es nuestro `Producto.codigo`** |
| `items[].cantidad` | `order_detail.items[].quantity` |
| `items[].observacion` | `order_detail.items[].comments` |
| modificadores | `order_detail.items[].subitems` (type `topping`) |
| la tienda | `store.external_id` |

> `total_to_pay: 0.00` con `total_order: 10000.00` es lo normal en un pedido pagado
> en la app: el cliente ya pagó, al local no le entra plata en mano.

## El simulador — se puede probar sin esperar a RAPPI

En el Integrations Manager, con el ambiente en **DEV**:

**Orders → Simulator** → elegir la integración y la tienda → armar un carrito →
elegir modelo de negocio, medio de pago y tipo de operación → **Create order**.

Devuelve el id generado y la orden aparece en la pestaña **Live** para manejarle los
estados. En producción no deja crear órdenes de prueba.

Es la forma de cerrar el ciclo entero sin depender de que alguien pida de verdad.

## Límites

- Hay que mantener **98% de éxito** en las llamadas.
- **45 segundos** mínimo entre requests (dato de segunda mano, de una búsqueda web,
  no del portal — confirmar antes de armar cualquier bucle de sincronización).
- RAPPI **cancela sola** la orden que no se toma dentro de los **6 minutos**
  (OCC timeout).
