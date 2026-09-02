# Integración con RAPPI (y las demás plataformas)

> Estado al 29/08/2026: **la ingesta funciona; falta el traductor del formato de
> RAPPI.** Este documento dice qué hay, qué falta, y exactamente qué hace falta
> para terminarlo.

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
