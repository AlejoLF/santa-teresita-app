# Plan: paridad total mobile/web — una sola app, en la nube

> **Objetivo:** que la encargada / empleados / gerente puedan usar **la misma app
> completa** (no un clon recortado) desde celular, tablet o notebook —
> instalable como app de inicio — pudiendo **ver todo en profundidad** y
> **operar** como en el escritorio. Solo quedan en escritorio los "detalles
> finos" de hardware (config de impresora, parámetros de instalación).
>
> **Decisión de fondo:** NO seguir reclonando pantallas en la PWA con SQL
> directo (duplica lógica y re-arriesga lo que el acid-test blindó). En su lugar:
> **hostear la API Fastify en la nube y servir la web real (`apps/web`),
> responsive e instalable, apuntada a esa API.** Una sola base de código, misma
> lógica, misma seguridad.
>
> Fecha: 2026-06-06. Estado: **plan, no implementado.** Verificado contra el código.

---

## 1. Las dos formas de lograrlo (y por qué elegimos ésta)

| | **Camino A — API en la nube + web real responsive** ✅ | **Camino B — crecer la PWA tab por tab (SQL directo)** |
|-|-|-|
| Cómo | Deploy de `apps/api` a la nube; `apps/web` (las ~35 pantallas que YA existen) servida responsive apuntando a esa API | Reimplementar cada pantalla del admin como endpoints nuevos con `pg` crudo en `apps/mobile` |
| Lógica de negocio | **Reusa** la de la API (precios, cierres, hash-chain, validaciones) | **Duplica** cada regla → divergencia + re-arriesgar (de ahí salió el bug de precios) |
| Acciones (escribir) | Gratis (es la misma app) | Cada acción = re-codear + re-asegurar |
| Mantenimiento | **Una** app | **Dos** apps que se desincronizan |
| Trabajo total | Menos (integración + responsive) | Más (reclonar 14+ secciones) |

**Elegido: Camino A.** La PWA `apps/mobile` no se tira — se reposiciona (ver §8).

---

## 2. La gran noticia: la arquitectura ya está casi lista

Verificado contra el código actual:

| Pieza | Estado | Evidencia |
|-|-|-|
| **API cloud-ready** | ~95% | Todo por env vars; `STA_ROLE=cloud` ya existe (`config.ts:22`); sin secretos por máquina; `origen='cloud'` ya contemplado (`audit.ts:47`) |
| **Auth cross-origin** | ✅ por diseño | La web usa **Bearer token** de localStorage (`api.ts:172`), no cookie SameSite → funciona contra otro dominio. CORS ya soporta allowlist + `credentials:true` (`server.ts:101-115`) |
| **Web apunta a API remota** | ✅ por diseño | `NEXT_PUBLIC_API_URL` → `${url}/api/v1` (`api.ts:26`). Solo es cambiar la env var |
| **Shell responsive** | ✅ ya hecho | `admin/layout.tsx`: sidebar `lg+`, hamburguesa + bottom-tabs + sheet en mobile (`layout.tsx:182-316`) |
| **Impresión remota** | ✅ ya funciona | Cola `TrabajoImpresion` en DB; el agente local pollea `GET /impresion/pendientes` cada 3s (`agent.ts:64`). Un pedido creado remoto encola y la comandera local lo imprime — sin restricción de LAN |
| **Sesión de caja remota** | ✅ funciona | Se resuelve por **hora del server + horarios** (`sesion-caja.ts:35`), no por ubicación física. Fuera de horario → 423 |

Lo que **falta** es integración + endurecer 2 cosas. No es reescribir.

---

## 3. Arquitectura objetivo

```
            ┌─────────────────────── NUBE ───────────────────────┐
            │                                                     │
  Celular/  │   apps/web (Vercel)            apps/api (container) │
  tablet/   │   Next.js responsive  ──Bearer──►  Fastify          │
  notebook ─┼──►  + PWA instalable      /api/v1   STA_ROLE=cloud  │
  (gerente/ │   (la misma del .exe)              │                │
  encargada)│                                    ▼                │
            │                              Supabase (Postgres)    │
            └──────────────────────────────────│──────────────────┘
                                                │ (misma DB)
   LOCAL (La Plata)                             │
   ┌────────────────────────────────────────────┼───────────────┐
   │  Cajas: .exe (API local + web)  ───────────►│  cloud-first  │
   │  Agente impresión ──pollea cola TrabajoImpresion──► comandera│
   │  (futuro: mini-PC Postgres local + replicador → Supabase)    │
   └──────────────────────────────────────────────────────────────┘
```

- **Remotos** hablan con la **API cloud**; **cajas** con su **API local** (resiliencia offline intacta). Ambas contra la misma Supabase (hoy cloud-first; mañana, con el mini-PC, la cloud es la "isla cloud" que el catch-up reconcilia).
- La web instalable **reusa el `InstallPrompt` que ya construimos** en `apps/mobile`.

---

## 4. Componentes del plan

### 4.1 Hostear `apps/api` en la nube  — esfuerzo: **M**
- **Dónde:** un host de contenedor persistente (Render / Railway / Fly / VPS con `infra/docker`). **No** Vercel serverless: la API es un Fastify monolítico con tareas de fondo (healthcheck, cache de sesión, replicador) → necesita proceso vivo, no funciones.
- **Env vars** (de §1 del reporte): `DATABASE_URL` (pooler Supabase, `aws-1-sa-east-1`), `AUTH_SECRET`, `AUDIT_HASH_SALT` (el MISMO de todo el sistema), `NODE_ENV=production`, `API_CORS_ORIGINS=https://<web>.vercel.app`, `STA_ROLE=cloud`.
- **NO setear** (features locales): `EXCEL_LOCAL_DIR`, `PYTHON_CMD`, `STA_MIRROR_SOURCE_URL`, sync de Excel/writeback. Idealmente, guardarlas detrás de `STA_ROLE !== 'cloud'` para que no arranquen.
- **`trustProxy`**: hoy `false` (server.ts:55, correcto para LAN). **En la nube detrás de proxy hay que ponerlo en `true`** (o el CIDR del proxy). ⚠️ **Crítico**: el lockout de PIN y el rate-limit usan `req.ip` (`auth.ts:121`). Con `trustProxy:false` detrás de un proxy, todos los clientes comparten la IP del proxy → un usuario con PINs fallidos **bloquea a todos** (DoS). Arreglo obligatorio antes de exponer.

### 4.2 Servir `apps/web` responsive + instalable  — esfuerzo: **L**
- Proyecto Vercel nuevo (Root `apps/web`) con `NEXT_PUBLIC_API_URL=https://<api-cloud>`. La auth cross-origin ya funciona (Bearer).
- **PWA instalable:** sumar `manifest.json` + íconos (reusar `gen-icons.mjs`) + `appleWebApp` + el `InstallPrompt`. (Service worker / offline es opcional, fase 2.)
- **Responsive por tandas** (auditoría real, 33 pantallas):
  - **Fácil** (~5): dashboard, ventas (desgloses), analytics, sesión-actual, cierre-detalle → ya tienen breakpoints, ajuste menor.
  - **Medio** (~12): movimientos, cierres-lista, cuentas, configuración, empleados, listas → grids fijos a responsive + scroll horizontal en tablas.
  - **Duro** (~16): productos, mayoristas, clientes, insumos+pagos, precios, facturas → **tablas de 6-8 columnas** que en celular necesitan **vista "card"** alternativa. Patrón repetible (se hace una vez, se aplica).
- **Patrón clave:** las tablas anchas son el 80% del trabajo "duro". Solución estándar: componente `<TablaResponsive>` que en `<md` renderiza cards. Se diseña una vez.

### 4.3 Endurecer el hash-chain de audit (multi-escritor)  — esfuerzo: **M**, hacer JUNTO con A1
- **El riesgo:** dos+ instancias appendeando a `audit_log` a la vez hacen `findFirst(secuencia desc)` + insert + hash → carrera → **chain break** (`audit.ts:28`).
- **Nota honesta:** **este riesgo YA existe hoy** con varias cajas cloud-first escribiendo a la misma Supabase. El Camino A suma **un** escritor más de la misma clase, no inventa el problema. Pero al escalar escritores conviene cerrarlo.
- **Fix:** serializar el append con **advisory lock de Postgres** (`pg_advisory_xact_lock`) o `SELECT … FOR UPDATE` sobre el tail, dentro de la tx. Prisma no expone `FOR UPDATE` → SQL crudo.
- **Diseñar junto con los pendientes de CLAUDE.md:** **A1** (trigger append-only en `audit_log` — no debe romper el re-chain del catch-up) y **C6** (revalidar precios/totales al importar filas `origen='cloud'`). El catch-up (`catch-up.ts:170-211`) ya re-chainea cloud→local preservando `secuenciaOrigen`; el cloud API encaja como "isla cloud" igual que la PWA.
- **Salt:** versionar `AUDIT_HASH_SALT` en `configuracion_sistema` + validar en boot que coincide (hoy diverger = chain break silencioso).

### 4.4 Impresión desde acciones remotas  — esfuerzo: **S** (ya funciona)
- Una venta creada/finalizada vía API cloud **encola** en `TrabajoImpresion` (Supabase); el agente local pollea y la imprime. Sin cambios de fondo.
- Único detalle: que el agente apunte a una API que vea esa cola (hoy cloud-first: la API local lee Supabase → la ve). Con el mini-PC futuro, la cola viaja por replicación/catch-up.

### 4.5 Sesión de caja para remotos  — esfuerzo: **S**
- Funciona por hora-de-server + horarios. Un admin remoto a las 3am da 423 (esperado). **Ojo TZ**: la API cloud DEBE correr con `TZ=America/Argentina/Buenos_Aires` (mismo invariante que el `.exe`), si no las sesiones de madrugada se fechan mal (gotcha ya documentado en CLAUDE.md).

### 4.6 Seguridad de exponer la API a internet  — esfuerzo: **M**
- La API pasa de "LAN del local" a "internet pública". Sumar/confirmar: HTTPS (lo da el host), `trustProxy` + lockout correcto (§4.1), rate-limit global, CORS estricto (ya), rotación de `AUTH_SECRET`/salt, y revisar que los endpoints `/sync/*` (gate loopback que pusimos en alpha.39) **no** queden accesibles desde la API cloud pública.
- Token en localStorage (XSS) es riesgo preexistente del modelo Bearer; la mitigación es el sanitizado de salidas que ya hicimos + CSP (sumar `Content-Security-Policy` en la web).

---

## 5. Qué queda SOLO en escritorio (los "detalles finos")
- Config de **impresora térmica** y el **agente** de impresión (hardware local).
- Parámetros de **instalación/red** del `.exe` y el server local.
- El **modo offline/local-first** (el `.exe` sigue siendo el respaldo ante cortes; eso es una feature, no una carencia).

Todo lo demás (ver Y operar) vive en la app de la nube.

---

## 6. Qué pasa con la PWA `apps/mobile` que ya construimos
No se tira. Se reposiciona a lo que hace bien:
- **Failover de apagón:** sigue siendo la "isla cloud" que escribe directo a Supabase cuando el local está caído (su propósito original).
- **Cargador de pedidos ultra-rápido** optimizado para celular (opcional).
- El **dashboard en vivo + el `InstallPrompt`** que hicimos hoy se **migran/reusan** en la web responsive.

A medida que la web responsive cubre todo, la PWA queda como respaldo, no como "la app del gerente".

---

## 7. Roadmap por fases

| Fase | Qué | Esfuerzo | Desbloquea |
|-|-|-|-|
| **0** | Endurecer audit multi-escritor (advisory lock) + `trustProxy`/lockout cloud + versionar salt | M | Seguridad para exponer |
| **1** | Deploy `apps/api` a la nube (container) + smoke test cross-origin | M | API pública |
| **2** | `apps/web` en Vercel apuntando a la API cloud + PWA instalable (manifest + InstallPrompt) | M | "La misma app" instalable, pantallas fáciles ya usables |
| **3** | Responsive tandas: fáciles → medias (grids + scroll) | M | Gerente opera el 60% desde el celu |
| **4** | `<TablaResponsive>` (card view) + pantallas duras | L | Paridad de tablas/listados |
| **5** | A1 (trigger append-only) + C6 (revalidar catch-up), CSP, pulido | M | Forense fuerte + cierre de seguridad |

> Las fases 0-2 ya dan "es la misma app, instalable, y veo casi todo". Las 3-4 son el grueso del responsive. La 5 cierra seguridad/forense.

---

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|-|-|
| Chain break de audit con N escritores | Advisory lock en el append (§4.3); ya latente hoy, se cierra de una |
| Lockout global por `trustProxy` mal | Setear `trustProxy` correcto + key por forwarded IP (§4.1) — **bloqueante** |
| Fechas de sesión corridas | `TZ=America/Argentina/Buenos_Aires` en el host cloud |
| Tablas ilegibles en celular | Componente `<TablaResponsive>` card-view, una vez |
| API pública = más superficie | HTTPS, CORS estricto, rate-limit, salt/secret rotables, `/sync` no expuesto |
| Costo nube (un container 24/7) | ~USD 7-25/mes (Render/Railway/Fly) además de Supabase |

---

## 9. Decisiones abiertas (para vos)
1. **Hosting de la API:** ¿Render / Railway / Fly / VPS propio? (Tenés N8N self-hosted 24/7 — quizás ahí mismo en Docker.)
2. **Dominio:** ¿`app.santateresita...` para la web y `api.santateresita...` para la API?
3. **¿Una sola app o también queremos mantener el cargador de pedidos PWA** aparte para los cajeros? (Recomiendo: web responsive para todo; PWA solo failover.)
4. **¿Single-tenant (solo Santa Teresita) o ya dejamos las costuras para multi-tenant?** (Esto conecta con `PRODUCTIZACION-Y-VENTA.md` — si vas a vender el POS, esta misma API-en-la-nube es el cimiento del SaaS.)

---

## 10. Relación con otros docs
- **`PRODUCTIZACION-Y-VENTA.md` §4:** este plan ES el "host the API in the cloud" que ahí se identifica como el refactor para el SaaS barato. Hacerlo para Santa Teresita = construir el cimiento del producto vendible.
- **`SERVIDOR-LOCAL.md` §5.3 / §6:** el modelo de islas (local vs cloud) + catch-up que este plan reutiliza para el escritor cloud.
- **CLAUDE.md, pendientes de seguridad A1/C6:** se diseñan dentro de la Fase 0/5 de este plan (el audit multi-escritor es el mismo problema).
