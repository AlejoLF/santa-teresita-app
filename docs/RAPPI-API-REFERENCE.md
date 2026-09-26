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
| **Desarrollo** | `https://api.dev.rappi.com` (ver nota) |
| **Argentina** | `https://services.rappi.com.ar` |
| Uruguay | `https://services.rappi.com.uy` |
| Chile | `https://services.rappi.cl` |
| Brasil | `https://services.rappi.com.br` |
| Colombia | `https://services.rappi.com` |
| México | `https://services.mxgrability.rappi.com` |
| Perú | `https://services.rappi.pe` |
| Ecuador | `https://services.rappi.com.ec` |
| Costa Rica | `https://services.rappi.co.cr` |

> **Nota sobre DEV.** La tabla "Country Domains" del portal dice
> `https://microservices.dev.rappi.com` para desarrollo, pero **todos** los
> ejemplos de la referencia de la API (`GET https://api.dev.rappi.com/api/v2/
> restaurants-integrations-public-api/stores-pa`, etc.) y la guía de
> self-onboarding ("For development, use `https://api.dev.rappi.com`") usan
> `api.dev.rappi.com` también para los endpoints legacy. En la primera prueba
> real (26/09), `microservices.dev` respondió `404 Not found appClient…` con un
> login válido. El código usa `api.dev`; `RAPPI_BASE_LEGACY_URL` lo cambia.

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

Errores documentados de `/stores-pa`:

| Status | Cuerpo | Qué significa |
|-|-|-|
| 401 | `{ "message": "Invalid token" }` | token vencido o del otro ambiente |
| 404 | `{ "message": "Not found appClient of client id {clientId}" }` | el `clientId` de la integración **no tiene un App Client asociado** en ese ambiente. No es un problema de credenciales (el login anduvo): es que RAPPI todavía no asoció la integración a una tienda. Lo resuelve RAPPI (el TAM), o el self-onboarding con el token del comercio. |
| 400 | `{ "message": "The stores {storeId} don't belong to the appClient of client id {clientId}" }` | la tienda existe pero no es de esta integración |



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

### Aprovisionar tiendas (Auto-onboarding)

```
POST {COUNTRY_DOMAIN}/api/v2/restaurants-integrations-public-api/stores/provisioning

{ "stores": [ {
  "store_id": "900105814",            // obligatorio
  "name": "Santa Teresita",           // obligatorio
  "status": "ACTIVE",                 // opcional: ACTIVE | INACTIVE
  "ping_active": true,                // opcional, default true
  "get_menu_active": true,            // opcional, default true
  "cancellation_events": true,        // opcional, default true
  "other_events": true,               // opcional, default true
  "store_integration_id": "999"       // opcional: NUESTRO id para esa tienda
} ] }
```

Responde **202** con `{ batch_id, accepted: [{store_id, integration_id}],
rejected: [{store_id, reason}] }` — `reason` es uno de `not_owned`,
`invalid_integration_id`, `missing_name`, `invalid_status`. El resultado final
llega después por el webhook `STORE_PROVISIONING_STATUS`.

`POST /stores/deprovisioning` con `{ "stores": [{ "store_id": "…" }] }` hace lo
inverso (razones: `not_owned`, `not_integrated`, `has_integrated_children`).

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

## Payloads de los demás eventos

No hay header que diga qué evento es: **se identifica por la URL** en la que RAPPI
lo entrega (se configura una URL por evento). Los cuerpos:

```jsonc
// PING — responder 2xx con {"status":"OK","description":"Store on"}.
// `status` es obligatorio: null o distinto de "OK" = tienda no disponible.
{ "store_id": 999 }

// ORDER_EVENT_CANCEL
{ "event": "canceled_with_charge", "order_id": "106", "store_id": "900109448" }

// MENU_APPROVED
{ "store_id": "900109448", "message": "Menu Approved" }

// MENU_REJECTED
{ "store_id": "900109448" }

// STORE_CONNECTIVITY
{ "external_store_id": "999", "enabled": false, "message": "The Store is not enabled to operate" }

// STORE_PROVISIONING_STATUS
{ "batchId": "…", "integrationId": "…", "operation": "PROVISION",
  "results": [ { "storeId": "10", "status": "ACTIVE", "httpCode": 201 },
               { "storeId": "11", "status": "FAILED", "errorMessage": "Store already exists", "httpCode": 409 } ],
  "timestamp": "2026-04-21T10:00:00Z" }
```

`NEW_ORDER_SCHEDULED` tiene la misma forma que `NEW_ORDER` más `"action": "scheduled"`,
`place_at` con la hora agendada, y los montos en cero.

## Menú

`POST {COUNTRY_DOMAIN}/api/v2/restaurants-integrations-public-api/menu` — crea o
reemplaza el menú de UNA tienda. RAPPI lo valida en forma síncrona:

| Código | |
|-|-|
| 200 | aceptado, queda pendiente de validación (después llega `MENU_APPROVED` / `MENU_REJECTED`) |
| 400 | estructura inválida — el detalle dice qué |
| 404 | la tienda no existe |
| 424 | ítems duplicados |

```jsonc
{
  "storeId": "900105814",
  "items": [
    {
      "name": "Sorrentinos de jamón y queso",   // obligatorio
      "description": "…",                        // obligatorio
      "sku": "3000",                             // obligatorio — nuestro Producto.codigo
      "type": "PRODUCT",                         // obligatorio
      "price": 8500,                             // obligatorio, ENTERO
      "imageUrl": "https://…",                   // opcional
      "sortingPosition": 1,                      // opcional
      "combo": false,                            // opcional
      "category": {                              // obligatorio
        "id": "pastas-rellenas", "name": "Pastas rellenas",
        "minQty": 0, "maxQty": 0, "sortingPosition": 1
      },
      "children": [                              // los modificadores
        {
          "name": "Salsa bolognesa", "description": "…", "sku": "MOD-SALSA-BOL",
          "type": "TOPPING", "price": 0, "maxLimit": 1,
          "category": { "id": "salsa", "name": "Salsa", "minQty": 1, "maxQty": 1, "sortingPosition": 1 },
          "children": []
        }
      ]
    }
  ]
}
```

`GET /menu/approved/{storeId}` devuelve sólo el código de estado (no hay cuerpo
documentado). `GET /menu` lista los menús creados.

> Hay una API de menú NUEVA (`/restaurants/menu/v1/stores/{storeId}/store-menu`),
> con otra estructura (menus / categories / items separados). El checklist de
> certificación acepta cualquiera de las dos para "Enviar menú"; se usa la legacy
> porque es la que tiene el cuerpo documentado entero.

## Órdenes — la API nueva

Existe también `/restaurants/orders/v1/stores/{storeId}/orders/{orderId}/{take|ready-for-pickup}`
y `…/cancel_type/{cancelType}/reject` (body `{description, additional_info}`, responde
202). **El checklist nombra las rutas legacy** (`PUT /orders/{orderId}/take`), así que
es lo que se implementa.

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
