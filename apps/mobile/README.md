# Santa Teresita Mobile (PWA)

Panel de consulta **read-only** para Julio (dueño) y la encargada — instalable
en iPhone/Android sin App Store. Conecta directo a Supabase.

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
5. Solo usuarios con rol `ADMIN` pueden entrar — el PIN del cajero no funciona en mobile.

## Tabs disponibles

| Tab | Endpoint API | Qué muestra |
|---|---|---|
| Resumen | `/api/resumen` | KPIs hoy/7d/30d + últimas 10 ventas |
| Ventas | `/api/ventas?periodo=&q=` | Lista filtrable de últimas 100 ventas |
| Analytics | `/api/analytics` | Top productos, ventas por canal, top clientes, tendencia 14d |
| Productos | `/api/productos?q=` | Browse del catálogo, agrupado por categoría |
| Mapa | `/api/mapa` | Deliveries del día con botones "Llamar" + "Ir" (abren apps nativas) |

Todo es **solo lectura**. No hay endpoints de escritura.

## Deploy en Vercel

1. Crear proyecto nuevo en Vercel apuntando a este repo.
2. Settings → General → **Root Directory** = `apps/mobile`.
3. Settings → Environment Variables:

   | Variable | Valor |
   |---|---|
   | `SUPABASE_DB_URL_POOLED` | Mismo string de Supabase Pooler IPv4-compatible que usás en el repo raíz |
   | `MOBILE_AUTH_SECRET` | Generar con `openssl rand -hex 32` |

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

- **Solo lectura.** Ni Julio ni la encargada pueden cargar/anular ventas
  desde mobile. Para eso usan la app desktop (la encargada en su PC del local).
- **Necesita conexión a internet.** No funciona offline. Si la encargada está
  en un lugar sin señal y quiere consultar, no puede.
- **No hay push notifications** todavía. iOS las soporta desde 16.4 pero
  hay que armar el backend de Web Push — TODO post-MVP.
- **El mapa NO renderiza un mapa.** Muestra lista de deliveries con botones
  "Llamar" y "Ir" que abren las apps nativas (Apple Maps / Google Maps /
  WhatsApp Phone). Decisión consciente: en pantalla 6" un mapa es chico y
  el flujo "tocar → app nativa" es más usable.

## Datos en cloud

La cloud DB (Supabase) actualmente tiene **catálogo y configuración** seedeados
pero **0 ventas / movimientos / sesiones**. Esos vienen del **sync agent
local→cloud** que aún no está construido. Hasta entonces:

- Tab Resumen: muestra "0 ventas, $0" (esperado).
- Tab Ventas: lista vacía.
- Tab Analytics: gráficos vacíos.
- Tab Productos: ✅ funciona (catálogo está seedeado).
- Tab Mapa: lista vacía.

Cuando el sync agent esté online, la PWA empieza a tener datos en tiempo real.
