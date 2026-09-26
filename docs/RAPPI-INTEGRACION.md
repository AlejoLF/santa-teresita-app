# Integración con RAPPI (y las demás plataformas)

> Estado al 26/09/2026: **las 15 capacidades del checklist están implementadas;
> falta certificarlas contra el RAPPI real.** Este documento dice qué hay, cómo
> ponerlo en marcha, y qué queda por decidir.
>
> La API de RAPPI está transcrita en **[RAPPI-API-REFERENCE.md](RAPPI-API-REFERENCE.md)**.

## Cómo está armado

Dos direcciones, dos módulos:

| Dirección | Dónde | Qué |
|-|-|-|
| **RAPPI → nosotros** | `routes/channel.ts` + `services/rappi/adaptador.ts`, `firma.ts` | Los webhooks: pedidos nuevos, cancelaciones, PING, menú, tienda. Una URL por evento, firma HMAC, y todo queda en el buzón (`recepciones_canal`). |
| **Nosotros → RAPPI** | `services/rappi/cliente.ts`, `tiendas.ts`, `ordenes.ts`, `menu.ts`, `webhooks.ts` + `routes/rappi.ts` | Llamadas a su API: tiendas, menú, tomar/rechazar/lista, suscripción de webhooks, aprovisionamiento. Cada llamada queda en `llamadas_canal`. |

Todo lo saliente se dispara desde **Admin → Configuración → Integraciones**, con
sesión de admin. Cada botón es un ítem del checklist.

### Configuración

Secretos y ambiente, en el entorno del server (Railway) — **nunca en la base**:

| Variable | Qué es |
|-|-|
| `RAPPI_CLIENT_ID` / `RAPPI_CLIENT_SECRET` | Las credenciales que da RAPPI, **por ambiente**. Sin ellas, lo saliente está apagado (los pedidos entran igual). |
| `RAPPI_WEBHOOK_SECRET` | Con el que RAPPI firma los webhooks. Es el mismo que se manda al suscribirlos. Sin él, la firma no se exige y la pantalla lo avisa. |
| `RAPPI_AMBIENTE` | `dev` (sandbox + simulador) o `prod`. Elige el dominio. |
| `CHANNEL_INGEST_TOKEN` | El de siempre: va en la URL de los webhooks. |

Un valor mal cargado en cualquiera de las `RAPPI_*` **no tira el API**: se lee lo
que se pueda (se sacan espacios y comillas, `DEV` vale como `dev`) y lo que no se
entiende se **muestra en el panel con nombre y motivo**. Es a propósito: son
variables de una integración opcional, y si el API se negara a arrancar por
ellas, Railway dejaría corriendo el deploy anterior y la pantalla diría "faltan"
sin ninguna pista. Ver *Si la pantalla dice que faltan las variables*.

Lo operativo, en `configuracion_sistema` (clave `rappi_config`), editable desde la
pantalla: la tienda elegida, el `clientId` de la integración, si se toman las
órdenes solas, el tiempo de cocina que se declara, y el estado del último menú.

## El checklist, capacidad por capacidad

| Grupo | Capacidad | Cómo se cumple | Estado |
|-|-|-|-|
| Tiendas | **Enable/disable** ⭐ | botón *Activar/Desactivar integración* → `PUT /stores-pa/{id}/status` | listo |
| Tiendas | Listar | botón *Listar tiendas* → `GET /stores-pa` (si hay una sola, se elige sola) | listo |
| Tiendas | Horarios | botón *Enviar horarios* → manda los turnos de `sesiones_horarios`, token de *utils* | listo (dominio a confirmar: ver nota) |
| Menú | Enviar menú | botón *Enviar menú* → `POST /menu` armado desde el catálogo | listo |
| Menú | Estado del menú | botón *Consultar aprobación* → `GET /menu/approved/{id}`, y el webhook `MENU_APPROVED` | listo |
| Menú | Disponibilidad | `PUT /admin/rappi/menu/disponibilidad` → `PUT /availability/stores/items` | listo (sin botón todavía: se llama por API) |
| Webhooks | Recibir órdenes | `…/rappi/<token>/new-order` → adaptador → venta + comanda, 200 en < 5 s | listo |
| Webhooks | **Cancelación** ⭐ | `…/cancel` → anula la venta, reversa pagos, comanda de cancelación | listo |
| Webhooks | PING | `…/ping` → `{status:"OK"}`; el panel muestra el último | listo |
| Webhooks | Validar firma HMAC | `Rappi-Signature` sobre el cuerpo crudo; sin firma o mal firmado → 401 registrado | listo |
| Onboarding | Auto-onboarding | *Suscribir por API* (`POST /clients/{id}/webhooks`) + *Aprovisionar* (`POST /stores/provisioning`) | listo |
| Órdenes | **Tomar** ⭐ | botón *Tomar* o el switch de tomar automático → `PUT /orders/{id}/take[/min]` | listo |
| Órdenes | Rechazar | botón *Rechazar* con motivo → `PUT /orders/{id}/reject` | listo |
| Órdenes | Lista para retiro | botón *Lista* → `POST /orders/{id}/ready-for-pickup` | listo |
| Órdenes | Tomar en < 6 min | métrica de RAPPI sobre lo anterior; con el switch prendido no se vence nunca | depende de la decisión de abajo |

⭐ = REQUERIDO

> **Nota sobre los horarios**: el endpoint es `/api/rest-ops-utils/store/schedule/{id}`
> y el portal no dice contra qué dominio. Se asume el legacy (`services.*`), por el
> prefijo `/api/`. Si contesta 404, el registro lo muestra y es cambiar una línea en
> `services/rappi/tiendas.ts`.

## Cómo se pone en marcha

En este orden. Cada paso se ve en la pantalla de Integraciones.

1. **Credenciales.** Cargar `RAPPI_CLIENT_ID`, `RAPPI_CLIENT_SECRET`, `RAPPI_WEBHOOK_SECRET`
   y `RAPPI_AMBIENTE=dev` en Railway. Botón *Probar credenciales*.
2. **Tienda.** *Listar tiendas*. Si hay una, queda elegida. Si el checklist dice
   "el cliente no tiene tiendas asociadas", *Aprovisionar*. Después *Activar
   integración* y *Abrir tienda*.
3. **Webhooks.** O se pegan las URLs por evento en el portal (módulo Webhooks,
   con el mismo `secret` que `RAPPI_WEBHOOK_SECRET`), o se carga el `clientId` de
   la integración y se usa *Suscribir por API* en cada evento. **Desde la versión
   en la nube**: desde el `.exe` las URLs son de esa computadora.
4. **Menú.** *Vista previa* (dice qué queda afuera y por qué), *Enviar menú*, y
   esperar el `MENU_APPROVED` (o *Consultar aprobación*).
5. **Probar con el simulador** del portal (ambiente DEV: *Orders → Simulator*).
   El pedido tiene que aparecer como venta y salir la comanda. *Tomar* desde el
   panel, o dejar el switch prendido.
6. **Certificar**: en el Integrations Manager, *Testear* cada capacidad. Todas
   miran que hayamos hecho al menos una llamada exitosa en los últimos 30 días.
7. **Producción**: nuevas credenciales, `RAPPI_AMBIENTE=prod`, y repetir 2–4.

### Si la pantalla dice que faltan las variables

Y en Railway se ven cargadas. Pasó el 26/09. En orden:

1. **Mirá la línea gris de arriba del panel**: "El server que responde es la
   versión X y arrancó el DD/MM HH:MM". Si esa hora es **anterior** a cuando
   tocaste las variables, el proceso que responde no las tiene: el deploy con
   las variables nuevas no llegó a reemplazarlo. Railway → *Deployments*: si el
   último está en rojo, abrí el log y buscá el motivo. Si está en verde, apretá
   *Actualizar* en el panel — a veces sólo es que el deploy tardó.
2. **Que estén en el servicio de la API**, no en otro servicio del proyecto ni
   sólo como *Shared Variables* del proyecto (ésas hay que agregarlas al
   servicio para que las vea). Y en el *environment* que está deployado.
3. **El nombre exacto**: `RAPPI_CLIENT_ID`, `RAPPI_CLIENT_SECRET`,
   `RAPPI_WEBHOOK_SECRET`, `RAPPI_AMBIENTE`. Mayúsculas, guión bajo, sin
   espacios. Un espacio o unas comillas alrededor del valor no rompen nada:
   se limpian y el panel lo avisa.
4. **El panel lista cada variable con su problema** ("está seteada pero VACÍA",
   "está entre comillas", `vale "produccion" y sólo puede ser dev o prod`). Si
   dice "no está seteada", el proceso que responde directamente no la tiene:
   volvé al punto 1.

## Qué falta decidir

**Tomar las órdenes automáticamente o no.** RAPPI cancela sola lo que no se toma
en 6 minutos. El switch existe y arranca APAGADO:

- **Prendido**: la orden se toma apenas entra. Nunca se vence, pero la cocina queda
  comprometida sin que nadie la mire.
- **Apagado**: hay que tocar *Tomar* en el panel para cada pedido. Hay control, pero
  una demora en el mostrador cancela pedidos sola.

Quedó para más adelante. Cuando se decida, es un tilde en la pantalla.

## Cosas a saber

- **Los precios son los nuestros.** El pedido se valúa con la lista de precios
  RAPPI del sistema, no con lo que dice el cuerpo de RAPPI (decisión de alpha.39:
  precios server-side). El cuerpo entero queda en `payloadExterno` para comparar.
  Si el menú publicado está al día, coinciden; si no, la diferencia se ve ahí.
- **Productos por peso.** RAPPI vende unidades. Un producto por kilo se publica
  como "una unidad = `cantidadDefault`" (p. ej. 500 g) y cuando vuelve se
  convierte al revés. Sin cantidad por defecto no se publica; la vista previa
  lo lista.
- **Combos no se publican todavía.** Un pedido con sku de combo no tendría cómo
  entrar (el mapeo es sólo por `Producto.codigo`).
- **Pedidos agendados** (`NEW_ORDER_SCHEDULED`) se anotan y no se crean: el pedido
  real llega como `NEW_ORDER` cuando RAPPI lo suelta.
- **El buzón acepta cualquier content-type** (desde el 25/09). Antes, un
  integrador que posteara form-encoded —o sin content-type— se comía un 415 de
  Fastify ANTES de llegar al handler y no quedaba ni un renglón: la pantalla
  habría dicho "no llegó nada" con total seguridad, y habría estado mintiendo.
- **PING no se guarda en el buzón** (sería ruido cada pocos minutos); el panel
  muestra cuándo fue el último.
- **Fuera de horario** el pedido sigue rebotando con 423, como cualquier canal.
  RAPPI lo va a cancelar por OCC a los 6 minutos.

## Verificación

`t-rappi.mjs` (suite manual) contra un RAPPI falso local que implementa lo que
la documentación dice y anota cada llamada: 14 secciones, ~100 comprobaciones.
Cubre el token (una sola vez, header `x-authorization: Bearer: …`), las tres de
tiendas, el menú armado desde el catálogo con precios de la lista RAPPI, la
firma sobre el cuerpo crudo (válida, ausente, equivocada, y con espacios
raros), `NEW_ORDER` → venta con el topping resuelto al id real y el cliente
creado, el duplicado, tomar automático (y que NO se tome con el switch apagado),
productos por peso en las dos direcciones, agendado, cancelación, menú
aprobado/rechazado, conectividad, aprovisionamiento, la URL única, tomar/
rechazar/lista desde el panel, suscripción por API, que el registro no filtre
secretos, y que un vendedor no vea el panel.

## Lo que pasó en la prueba del 29/08

Se cargó el integrador de RAPPI apuntando al endpoint de Railway, se generó un
pedido de prueba y se lo aceptó desde el mismo integrador. **No apareció nada en
el programa ni salió el ticket.**

El motivo casi seguro es uno de estos dos, y hasta ahora no había manera de
distinguirlos:

1. **RAPPI no manda el header `Authorization`** que espera `/channel/orders`, así
   que el pedido rebotaba con 401 antes de mirar el cuerpo.
2. **El cuerpo no tiene nuestro formato.** `/channel/orders` espera un contrato
   *neutral* (ver abajo) que cada integrador tiene que hablar. RAPPI manda el
   suyo, así que el pedido rebotaba con 400.

En los dos casos, del lado del local **no quedaba ni un renglón**: ni la venta,
ni el ticket, ni un registro de que alguien había golpeado la puerta. Por eso la
frase "no apareció el pedido" era indistinguible de "RAPPI nunca lo mandó", que
es un problema completamente distinto.

**Eso ya está resuelto**: ahora todo lo que llega queda registrado, entre o no.

## Cómo terminar la integración — el paso que falta

Es un solo viaje de ida y vuelta:

### 1. Cargar la dirección nueva en RAPPI

Andá a **Admin → Configuración → Integraciones**. Ahí está la URL exacta, con un
botón para copiarla. Tiene esta forma:

```
https://<la-api>/api/v1/channel/webhook/rappi/<token>
```

La clave va **en la dirección** justamente porque los integradores casi nunca
dejan configurar un header. Tratala como una contraseña.

> Si abrís esa pantalla desde la app instalada, la dirección va a ser la de esa
> computadora y RAPPI no la puede alcanzar. La pantalla te avisa. Abrila desde el
> navegador para sacar la buena.

### 2. Repetir la prueba

Generá y aceptá otro pedido de prueba, igual que la vez pasada.

### 3. Mirar qué llegó

Volvé a **Integraciones**. Ahí abajo, en *"Lo que llegó"*, va a estar el pedido.
Tocalo y se abre **el cuerpo exacto que mandó RAPPI**.

- **Si la lista quedó vacía**: el pedido nunca salió de RAPPI. El problema está
  del lado de allá — la dirección mal cargada, o el pedido de prueba que no
  dispara el aviso. Eso ya es información: descarta todo el lado nuestro.
  (Desde el 25/09 esto es confiable de verdad: el buzón registra el cuerpo
  venga en el formato que venga, incluso sin content-type y aunque el token
  esté equivocado.)
- **Si aparece con "Llegó bien, falta traducir su formato"**: perfecto, es lo
  esperado. Ese cuerpo es lo único que falta para escribir el traductor.

### 4. Pasarme ese cuerpo

Con el JSON que quedó guardado escribo el adaptador, y **esa misma dirección
empieza a andar** sin tocar nada en RAPPI.

No lo puedo escribir antes: el formato de RAPPI no lo tengo, y escribirlo de
memoria tiene dos finales posibles — que rebote igual, o algo peor, que entre
mal y cargue pedidos con datos equivocados.

## El contrato neutral

Lo que el sistema entiende hoy. Cualquier integrador que pueda mandar **esto** ya
funciona sin adaptador:

```jsonc
POST /api/v1/channel/orders
Authorization: Bearer <CHANNEL_INGEST_TOKEN>

{
  "canal": "RAPPI",                    // RAPPI | PEDIDOS_YA | MERCADO_LIBRE
  "idExternoCanal": "RP-99887",        // el id del pedido EN la plataforma
  "modalidad": "DELIVERY_PLATAFORMA",  // o TAKE_AWAY. Opcional
  "items": [
    {
      "codigo": "3000",                // ← el SKU. Es `Producto.codigo` del catálogo
      "cantidad": 2,
      "observacion": "sin sal",        // opcional
      "modificadores": []              // opcional
    }
  ],
  "cliente":  { "nombre": "Ana", "telefono": "221-555-0000" },   // opcional
  "entrega":  { "direccion": "Av. 44 1234", "indicaciones": "" }, // opcional
  "observaciones": "",                                            // opcional
  "payloadExterno": { }                // el JSON crudo de la plataforma, se guarda
}
```

Respuestas:

| Código | Qué significa |
|-|-|
| `201` | Entró. La venta se creó, se auto-finalizó y **la comanda ya salió a la cocina**. |
| `200` | Ese `idExternoCanal` ya estaba cargado. No se duplicó nada. |
| `400` | El cuerpo no tiene este formato. La respuesta dice qué campo falta. |
| `401` | Token equivocado. |
| `422` | Algún `codigo` no existe en el catálogo. Devuelve cuáles. |
| `423` | Llegó fuera del horario configurado: no hay turno abierto donde imputarla. |
| `501` | Llegó por el webhook, con el token correcto, pero en un formato que todavía no traducimos. |
| `503` | `CHANNEL_INGEST_TOKEN` no está seteado: la ingesta está apagada. |

En los siete casos el cuerpo queda guardado en el buzón: el registro se hace
ANTES de validar el token y ANTES de mirar la forma del body.

### El SKU es `Producto.codigo`

Es el punto de contacto entre el menú publicado en la plataforma y el catálogo de
acá. Un producto **sin código** no se puede publicar ni se puede matchear: si un
pedido lo incluye, rebota con 422.

`GET /channel/products` devuelve el catálogo publicable y, aparte, los que no
tienen código — sirve de chequeo antes de conectar en vivo.

## Las cinco razones por las que un pedido no entra

Están todas en la pantalla de Integraciones, cada una con su cartel:

| | Se ve como |
|-|-|
| `CHANNEL_INGEST_TOKEN` sin setear en el server | "La ingesta está apagada" |
| La plataforma manda otro token | "Token equivocado" |
| El cuerpo no es el contrato neutral | "Formato que no entendemos" / "falta traducir su formato" |
| Un SKU que no existe en el catálogo | "Producto sin código" |
| Llegó fuera del horario de atención | "Fuera de horario" |

## Probar sin ensuciar el local

`POST /channel/orders/dry-run` — mismo cuerpo y mismo token, pero **no escribe
nada**: ni venta, ni sesión de caja, ni papel en la cocina. Devuelve el
diagnóstico de lo que hubiera pasado. Es el pre-flight para validar el mapeo del
menú sin imprimir tickets de prueba en plena atención.

## Cancelaciones

`POST /channel/orders/cancel` con `{ canal, idExternoCanal }` anula la venta,
revierte los pagos e imprime la comanda de cancelación en la cocina.

## Notas de seguridad

- El token de canal es **distinto** del de facturas y del de usuarios: si se
  filtra uno, no compromete a los otros. Sólo habilita crear ventas de canal.
- Se rota cambiando `CHANNEL_INGEST_TOKEN` en Railway y volviendo a copiar la URL
  desde la pantalla de Integraciones a la plataforma.
- El buzón **no guarda tokens**. De los headers de autorización se guarda la
  forma (largo y puntas), nunca el valor — alcanza para diagnosticar y no deja un
  secreto guardado en una tabla que además se replica a la nube.
- El buzón conserva las últimas 300 recepciones y se poda solo.
