# Santa Teresita Mobile (PWA)

App web instalable (iPhone / Android / iPad / notebook) que pega **directo a
Supabase**, sin App Store y sin instalar el `.exe`. Dos usos según el rol del PIN:

- **Encargada / vendedor (rol VENDEDOR):** carga pedidos directo a la cloud DB
  (`/cargar-pedido`) — catálogo + carrito + cobro. Útil desde una tablet en el
  salón, o como respaldo si la caja desktop está caída.
- **Julio / gerencia (rol ADMIN):** dashboard de **estadísticas en vivo**
  (auto-refresh por polling) + puede también cargar pedidos.

Mismo PIN que en el desktop (validado contra `usuarios.pin_hash`).

## Stack

- Next.js 15 + React 19 + Tailwind 3
- pg (cliente Postgres directo, no Supabase JS — para queries crudas)
- jose (JWT) + bcryptjs (verificación de PIN)
- PWA installable (manifest + apple-touch-icon + standalone display)

## Flujo de auth

1. Usuario abre la URL en Safari/Chrome.
2. Login con su PIN (mismo que tiene en el desktop, validado contra `usuarios.pin_hash`).
3. Backend firma JWT con `MOBILE_AUTH_SECRET` y lo guarda en cookie httpOnly.
4. API routes verifican el JWT en cada request.
5. Entran roles `ADMIN` y `VENDEDOR`. El rol viaja en el JWT: `VENDEDOR` cae en
   `/cargar-pedido`; `ADMIN` ve el dashboard (y puede ir a cargar pedido con el
   botón "+ Pedido").

## Cargar pedido (escritura)

`POST /api/ventas` crea la venta **FINALIZADA** en una sola transacción contra
Supabase: sesión de caja (reusa la ABIERTA del turno o crea una), items, pago,
delivery info y una fila de audit en el hash-chain de la cloud (`origen='cloud'`).

Seguridad: **los precios se recalculan server-side** (lista por canal +
override), NUNCA se confía en el `precioUnitario` del cliente. El monto del pago
nunca puede ser menor al total server-side. (Endurecido en el acid-test, alpha.39.)

## Tabs del dashboard (lectura, en vivo)

Cada tab refresca solo por polling (pausa cuando la pantalla está oculta, vuelve
a tirar al recuperar foco). Indicador "EN VIVO · hace Xs" arriba a la derecha.

| Tab | Endpoint API | Refresh | Qué muestra |
|---|---|---|---|
| Resumen | `/api/resumen` | 20s | KPIs hoy/7d/30d + últimas 10 ventas |
| Ventas | `/api/ventas?periodo=&q=` | 20s | Lista filtrable de últimas 100 ventas |
| Analytics | `/api/analytics` | 60s | Top productos, ventas por canal, top clientes, tendencia 14d |
| Productos | `/api/productos?q=` | — | Browse del catálogo, agrupado por categoría |
| Mapa | `/api/mapa` | 15s | Deliveries del día con botones "Llamar" + "Ir" (abren apps nativas) |

## Deploy en Vercel

1. Crear proyecto nuevo en Vercel apuntando a este repo.
2. Settings → General → **Root Directory** = `apps/mobile`.
3. Settings → Environment Variables:

   | Variable | Valor |
   |---|---|
   | `SUPABASE_DB_URL_POOLED` | Mismo string de Supabase Pooler IPv4-compatible que usás en el repo raíz |
   | `MOBILE_AUTH_SECRET` | Generar con `openssl rand -hex 32` |
   | `AUDIT_HASH_SALT` | **Mismo valor** que en las cajas / el server. Sin esto, las ventas cargadas desde la PWA quedan con audit sin firmar (`NO_SALT_CLOUD`) hasta el catch-up del server local. |

   > **Íconos PWA:** se generan con `node apps/mobile/scripts/gen-icons.mjs`
   > (encoder PNG en Node puro, sin deps). Ya están committeados en `public/`;
   > re-correr solo si cambiás la marca.

4. Deploy.

5. (Opcional) Configurar custom domain — ej. `mobile.santateresita.com.ar`.
   Vercel maneja HTTPS auto via Let's Encrypt.

## Cómo instalan Julio y la encargada en iPhone

Mandales este enlace + las siguientes instrucciones:

> 1. Abrí Safari (NO Chrome — el "Add to Home Screen" en Chrome iOS no
>    funciona como app nativa, solo como bookmark).
> 2. Andá a `https://<tu-dominio-vercel>`.
> 3. Login con tu PIN de 4 dígitos.
> 4. Tocá el botón de Compartir (el cuadradito con la flecha hacia arriba).
> 5. Bajá hasta encontrar "**Agregar a Pantalla de inicio**".
> 6. Tocá "Agregar".
> 7. La app aparece como icono en tu pantalla de inicio. Cuando la abrís, se
>    ve como app nativa (sin barra de Safari).

En Android es el mismo flujo desde Chrome → "Agregar a pantalla de inicio".

## Limitaciones (por ahora)

- **Carga de pedidos simplificada.** Single-pago (no multi-cuenta), sin combos
  y 1 modificador por ítem. **No anula** ventas ni imprime comanda (no hay
  impresora en mobile). Para multi-pago / anulación / impresión → app desktop.
- **Necesita conexión a internet.** No funciona offline (no hay service worker
  todavía). Si no hay señal, no carga ni consulta.
- **No hay push notifications** todavía. iOS las soporta desde 16.4 pero
  hay que armar el backend de Web Push — TODO post-MVP.
- **El mapa NO renderiza un mapa.** Muestra lista de deliveries con botones
  "Llamar" y "Ir" que abren las apps nativas (Apple Maps / Google Maps /
  WhatsApp Phone). Decisión consciente: en pantalla 6" un mapa es chico y
  el flujo "tocar → app nativa" es más usable.

## Datos en cloud

El `.exe` v2.x corre **cloud-first**: las cajas escriben directo a Supabase. O
sea la cloud DB **ya es la base de producción en vivo** — cada venta de la
encargada está ahí en el momento. La PWA lee de la misma DB, así que los KPIs y
las listas reflejan lo que pasa en el local, con el delay del polling (15–60s
según tab). No depende de ningún "sync agent" aparte.

(Cuando se despliegue el mini-PC con Postgres local como fuente de verdad, el
replicador transaccional sigue empujando a Supabase y la PWA no cambia.)
