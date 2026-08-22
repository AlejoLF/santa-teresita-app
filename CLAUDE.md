# CLAUDE.md — Santa Teresita Pastas

Guía para Claude Code y desarrolladores trabajando sobre este repo.

## Contexto

App de gestión integral para Santa Teresita Pastas (La Plata, AR) — POS + cashflow +
proveedores + ticketing térmico + sync con Excel + integraciones externas (RAPPI, Pedidos
YA, MELI, MercadoPago, Belvo). Reemplaza Innovo Suite (USD 180/mo) y resuelve sus
problemas estructurales.

**Documentación viva**:
- [docs/SPEC.md](docs/SPEC.md) — especificación funcional completa (13 secciones, ~5.000 líneas).
- [docs/PREGUNTAS.md](docs/PREGUNTAS.md) — pendientes a resolver con el cliente.
- [docs/wireframes/00-INDEX.md](docs/wireframes/00-INDEX.md) — wireframes ASCII.
- [docs/TRABAJO-REMOTO.md](docs/TRABAJO-REMOTO.md) — **cómo operar el proyecto sin la PC** (publicar
  alpha y migrar Supabase desde el celu). Abrir antes de tocar un release.
- [docs/SERVIDOR-LOCAL.md](docs/SERVIDOR-LOCAL.md) — diseño del servidor local LAN (Fase 1A/1B/1.5 implementadas).
- [docs/DEPLOY-SERVIDOR-LOCAL.md](docs/DEPLOY-SERVIDOR-LOCAL.md) — **playbook de deploy** del server, cajas y PWA. Abrir cuando vayas a desplegar.
- [docs/PLAN-PARIDAD-APP-NUBE.md](docs/PLAN-PARIDAD-APP-NUBE.md) — plan de una sola app responsive
  servida desde la nube (Camino A: API en cloud + `apps/web` real). Estado: parcialmente ejecutado.
- [docs/CLOUD-DB.md](docs/CLOUD-DB.md) / [docs/CLOUD-ANALYTICS.md](docs/CLOUD-ANALYTICS.md) — Supabase: schema, sync, vistas de analytics.
- [docs/ACCESO-REMOTO-S1.md](docs/ACCESO-REMOTO-S1.md) — acceso remoto al server S1.
- [docs/N8N-FACTURAS-OCR.md](docs/N8N-FACTURAS-OCR.md) — OCR de facturas vía N8N + bot Telegram.
- [docs/MIGRACION-INNOVO.md](docs/MIGRACION-INNOVO.md) — migración de datos desde Innovo Suite.
- [docs/POSNETS.md](docs/POSNETS.md) — posnets y medios de pago.
- [docs/PRODUCTIZACION-Y-VENTA.md](docs/PRODUCTIZACION-Y-VENTA.md) — análisis estratégico de vender el POS como producto (mercado ES/AR/PT, regulación Veri*Factu/AT, pricing, arquitectura SaaS multi-tenant, capacidad Supabase medida, features IA). Research 2026-06-06.

## Arquitectura: WAT (Workflows / Agents / Tools)

Tres capas separadas — la IA razona, el código ejecuta. Compounding de errores es la
razón: 5 pasos al 90% = 59% end-to-end. Offloadear ejecución a scripts mantiene la
orquestación confiable.

- **[workflows/](workflows/)** — SOPs en markdown. Cada uno define objetivo, inputs, tools, edge cases.
- **Agents** (Claude leyendo workflows) — secuencian tools y manejan errores. No ejecutan lógica directa.
- **[tools/](tools/)** — scripts deterministas (Python para parsers de Excel, scripts de mantenimiento).

## Stack

| Capa | Tech | Notas |
|-|-|-|
| Backend | Node 22 + TS + Fastify 5 + Prisma | tipado end-to-end, zod type provider |
| DB | PostgreSQL 16 (local) + Supabase (nube) | fuente de verdad local, réplica cloud |
| Web | Next.js 15 + React 19 + Tailwind | responsive + PWA instalable |
| Escritorio | Electron (`apps/desktop`) | el `.exe` de las cajas, auto-update |
| Auth | PIN 4 dígitos (bcryptjs) + Bearer token | token en localStorage → funciona cross-origin |
| Agente local | Node daemon + node-thermal-printer | EPSON TM-T20II |
| Cola de impresión | tabla `TrabajoImpresion` + polling del agente (3s) | **no** hay BullMQ (ver nota abajo) |
| Excel | exceljs (en la API) | export/import; **sin** Google Drive API todavía |
| OCR facturas | LLM con visión en N8N | bot Telegram |
| Deploy | Vercel (web) + Railway (API) + GitHub Actions | Docker Compose + Caddy para local/LAN |

> **Ojo con la cola**: `infra/docker/docker-compose.dev.yml` levanta un contenedor
> Redis, pero **ningún paquete lo usa** (no hay `bullmq` ni `ioredis` en el
> workspace). La impresión es una cola en la DB que el agente pollea. Si alguna
> vez migrás a BullMQ, el Redis ya está ahí; hasta entonces, no asumas que hay
> cola real.

## Estructura del repo

```
.
├── apps/
│   ├── api/          ─ Fastify API (16 módulos de rutas: auth, catálogo, ventas,
│   │                   encargos, mayoristas, proveedores, impresión, analytics,
│   │                   channel/ingest de plataformas, sync, audit…)
│   ├── web/          ─ Next.js — la app real (Vendedor + Admin + Encargos), responsive
│   ├── desktop/      ─ Electron: el `.exe` de las cajas (empaqueta API + web + agente)
│   ├── server/       ─ servidor local LAN del mini PC (Postgres + API + replicator)
│   ├── mobile/       ─ PWA read-only para Julio/encargada (consulta Supabase directo)
│   └── local-agent/  ─ daemon de impresión ESC/POS
├── packages/
│   ├── db/           ─ Prisma schema + migraciones SQL + seeds
│   └── shared/       ─ types, zod schemas, money utils, hash chain
├── scripts/
│   └── cloud/        ─ migrate / status / seed / analytics contra Supabase
├── tools/            ─ scripts Python (parsers de Excel) + api-scripts
├── workflows/        ─ SOPs en markdown
├── infra/
│   ├── docker/       ─ compose + init SQL
│   └── caddy/        ─ Caddyfile prod
├── .github/workflows ─ release.yml (build del .exe) + cloud-migrate.yml
├── docs/             ─ SPEC.md, PREGUNTAS.md, wireframes/, playbooks
└── *.xlsx            ─ Excels del cliente (input)
```

`apps/web` es **la** app: el `.exe` la empaqueta y la nube la sirve. `apps/mobile`
es un cliente read-only aparte — no repliques lógica de negocio ahí (ver
PLAN-PARIDAD-APP-NUBE.md §1).

## Cómo arrancar dev

Prerequisitos: Node 22+, pnpm 9+, Docker, Python 3.10+.

```bash
# 1. Variables de entorno
cp .env.example .env

# 2. Instalar deps
pnpm install

# 3. Postgres + Redis + Adminer
pnpm docker:up

# 4. Generar el cliente Prisma
pnpm db:generate

# 5. Sincronizar el schema con la DB local
#    ⚠️ NO uses `pnpm db:migrate`: mapea a `prisma migrate dev`, que detecta
#    "drift" y auto-genera una migración que DROPEA índices (ver Invariantes).
pnpm --filter @sta/db exec prisma db push --skip-generate --accept-data-loss

# 6. Parsear el Excel (opcional, output ya está committeado)
pip install openpyxl
python tools/parse_lista_precios.py \
  --excel "Lista de Precios.xlsx" \
  --output packages/db/prisma/seed-data/lista-precios.json

# 7. Cargar datos iniciales (usuarios, categorías, productos)
pnpm db:seed

# 8. Levantar todo en paralelo
pnpm dev
# API   → http://localhost:3001
# Web   → http://localhost:3000
# Adminer (DB UI) → http://localhost:8080  (server: postgres / user: teresita / db: teresita)
```

Con el repo ya clonado, **`pnpm sync-local`** hace 2→7 de una (pull de `main`,
install, generate, `db push`, seed). Ojo: stashea lo que tengas sin commitear y
te cambia a `main` — no lo corras en medio de una feature branch.

PINs default (cambiar en producción):
- Vendedor: `0001`
- Encargada: `0002`
- Julio: `0003`

## Cómo operar

1. **Antes de codear**: leé el SPEC sección relevante. La fuente de verdad operativa
   es el SPEC + wireframes.
2. **Antes de armar tooling**: chequeá `tools/` y `workflows/`. No reinventes scripts.
3. **Cuando una tarea sea ejecutable**: NO la inlinees en el razonamiento. Encontrá el
   workflow + tool, o creá uno nuevo.
4. **Workflows acumulan aprendizaje** (rate limits, quirks, formato del Excel). No los
   reescribas casualmente — agregá notas.
5. **Failure → system improvement.** Leé el trace completo, arreglá el tool, verificá,
   actualizá el workflow con lo aprendido. Si un retry quema créditos pagos, confirmar
   con el user primero.

## Testing

Pendiente — el alcance del MVP no incluyó suite de tests. **No hay ni un archivo
`.test.ts`/`.spec.ts` en el workspace** y la rama `feat/tests` que citaba este doc ya
no existe en el remoto. `pnpm test` corre `pnpm -r test` sobre paquetes sin tests.
La verificación hoy es manual (ver `workflows/dia-de-prueba.md`).

## Decisiones cerradas (no re-discutir sin evidencia nueva)

Ver SPEC §1.5. Punteo:
- Local-first hybrid (Postgres replicado).
- 2 roles operativos: Vendedor (PIN compartido) + Admin (PIN por persona).
- 3 estados de venta: Procesada / Finalizada / Anulada.
- Modelo de productos con modificadores y combos (no SKUs aplanados).
- Sin ARCA en este sistema.
- Sin stock control en fase 1.
- Bot WhatsApp es fase 2.
- Aesthetic: "Trattoria refinada" — verde Teresita + cremoso + serif Fraunces.

## Invariantes / gotchas (no romper sin entender por qué)

- **Todo registro transaccional atado a un turno DEBE setear `sesionCajaId`
  vía `getOrCreateSesionActual(usuarioId)`.** Aplica a ventas Y movimientos
  (aportes/egresos/transferencias). Síntoma si se rompe: el registro queda
  con `sesion_caja_id = NULL`, NO entra al cierre de caja (que filtra por
  sesión) pero SÍ aparece en `/admin/movimientos` (filtra por fecha) — da
  la falsa sensación de que "se mezcla con sesiones pasadas". Incidente real:
  alpha.18 y anteriores, `POST /admin/movimientos` no seteaba el campo.
  Fix en alpha.19. Si agregás un endpoint nuevo que crea algo que debería
  contar para el cierre del turno, llamá `getOrCreateSesionActual` y manejá
  el `FueraDeHorarioError` (devolver 423).

- **Fechas de sesión: usar siempre TZ Argentina explícita.** El cálculo de
  `fecha` de `SesionCaja` depende de la TZ del proceso. El .exe spawnea el
  API con `TZ='America/Argentina/Buenos_Aires'` — si corrés el API en otro
  contexto (Vercel, CI, dev sin TZ) las sesiones creadas en madrugada AR
  quedan con la fecha del día anterior. El resolver de `horarios.ts` usa
  `getFullYear/Month/Date` (TZ-local) — correcto solo si la TZ está bien.

- **Para llegar al API desde la MISMA máquina, usar `127.0.0.1`, nunca
  `localhost`.** El API hace `listen({ host: '0.0.0.0' })`, que es **solo
  IPv4**; desde Node 17 `localhost` resuelve **primero a IPv6** (`::1`).
  Cualquier cliente Node/axios local (n8n, un script, un healthcheck) se come
  un `connect ECONNREFUSED ::1:3001` con el server andando perfecto. Síntoma
  traicionero: PowerShell/.NET y `curl` **sí** caen a IPv4, así que un chequeo
  hecho desde ahí dice "OK, el API responde" mientras el que importa falla —
  un falso verde. Incidente real: la ingesta de facturas por OCR, 2026-08-14.
  (Si algún día hace falta atender los dos stacks, es `API_HOST=::`, pero eso
  cambia el binding de producción: preferir arreglar la URL del cliente.)

- **Pooler de Supabase: `aws-1-sa-east-1`, NO `aws-0`.** Supabase migró la
  infra de Supavisor. La URL legacy `aws-0-*` devuelve "tenant not found".
  El default está en `scripts/cloud/_url.mjs`. Si `cloud:migrate`/`status`
  fallan con ese error, la conexión directa (`SUPABASE_DB_URL_DIRECT`,
  puerto 5432) funciona como fallback para aplicar migraciones.

- **`prisma generate` falla con EPERM si el .exe está abierto.** El proceso
  `Santa Teresita.exe` mantiene `query_engine-windows.dll.node` lockeado.
  Cerrar la app antes de regenerar. Verificar con:
  `Get-Process | ? { $_.Modules.FileName -like '*query_engine-windows*' }`.

- **Si tocás `schema.prisma`, escribí la migración — `db push` NO alcanza.**
  Conviven dos formas de armar una base: desde el schema (`db push` → Supabase
  y las locales) y aplicando migraciones en orden (**S1**, vía
  `update-server.ps1` / `setup-mini-pc.ps1`). Una columna empujada con `db push`
  sin migración existe en las primeras y **no** en S1. Peor: si una migración
  posterior la USA, revienta ahí y —como el updater corta ante el primer
  error— **todas** las migraciones que siguen quedan sin aplicar. Incidente
  real: `tipos_producto.es_subcategoria` (más `opciones_modificador.codigo` y
  `sesiones_caja.ultimo_numero_orden`) nunca tuvieron migración;
  `20260702120000_porciones_reorg` la usa, y S1 pasó **seis semanas** sin poder
  aplicar una sola migración, fallando y rolleando sola a las 4 AM sin que
  nadie se enterara. Se detecta con **`node tools/check-migration-drift.mjs`**
  — corrélo antes de publicar un release del server. Si la columna la usa una
  migración que ya existe, el nombre de la nueva tiene que ordenar **antes**
  que aquella (se aplican alfabéticamente), aunque quede con fecha "vieja".

- **NO correr `prisma migrate dev` contra ninguna DB de este repo — y `pnpm
  db:migrate` MAPEA A ESO.** (Verificado: `packages/db/package.json` →
  `"migrate": "prisma migrate dev"`. El atajo es una trampa; para sincronizar
  una DB local usá `prisma db push`, como hace `scripts/sync-local.mjs`.) Las migraciones se aplican vía raw SQL
  (`scripts/cloud/migrate.mjs` para cloud; aplicar el `migration.sql` a mano
  para local). `migrate dev` compara la schema contra su shadow DB, detecta
  "drift" (porque el historial se aplicó por SQL, no por Prisma Migrate) y
  AUTO-GENERA una migración correctiva que **dropea índices de performance**
  y reordena columnas. Si aparece una migración no creada a mano (ej.
  `*_alpha20` con DROP INDEX), borrar el dir + el registro en
  `_prisma_migrations` + recrear los índices. Para sincronizar una DB local
  nueva: aplicar los `migration.sql` en orden con un script, no `migrate dev`.

- **Cliente API: nunca mandar `Content-Type: application/json` sin body.**
  Fastify rechaza body vacío con ese header (FST_ERR_CTP_EMPTY_JSON_BODY,
  400) — rompía todos los DELETE sin body (quitar item, eliminar producto).
  `lib/api.ts` setea el header solo si hay body; `server.ts` además parsea
  body vacío como `undefined` (red de seguridad para cualquier cliente).

- **Repartidor en tickets: se infiere del canal** (`repartidorPorCanal()` en
  `services/impresion.ts`). RAPPI/PYA/MELI/DELIVERATE no requieren asignación
  manual. Prioridad: empleado interno asignado > empresa explícita > inferido
  del canal. Los 3 tickets (comanda cocina, ticket cliente, ticket delivery)
  deben mostrarlo — si tocás uno, revisá los otros dos.

## Estado (2026-08-05 · v2.0.0-alpha.58)

El sistema está **en producción en el local**, distribuido como `.exe` Electron que
se auto-actualiza. Desde el bootstrap se sumó, entre otras cosas:

✅ Admin completo: dashboard, ventas, movimientos, cierres, cuentas, precios, listas,
   productos, insumos/proveedores (con pago multi-cuenta), facturas, clientes,
   empleados, horarios, mayoristas, delivery, analytics, configuración
✅ **Encargos** (pestaña propia): calendario, carga, cobro diferido, comanda, retiro
✅ **Promos** con temporalidad + modificadores con ícono/conteo/unidad
✅ Impresión: routing de comanderas configurable, tickets de encargo por comandera,
   ficha del producto impresa, re-impresión eligiendo comandera
✅ Ingesta de órdenes de plataforma (puente RAPPI/PYA/MELI — `channel.ts`; `ingest.ts`
   es otra cosa: facturas por OCR). **Ojo**: es un puente platform-neutral con token
   propio (`CHANNEL_INGEST_TOKEN`) — no hay credenciales de RAPPI/PYA/MELI cableadas
✅ Responsive real en celular (tarjetas en vez de tablas) + PWA instalable
✅ Todo en TZ Argentina explícita
✅ Buscadores con filtro temporal y paginación en las 4 áreas pesadas
✅ Cloud: Supabase + replicación, vistas de analytics, API deployable (Dockerfile)
✅ CI/CD: build del `.exe` y migraciones de Supabase disparables desde el celular

## El ciclo de release (desde la nube)

Detalle en [docs/TRABAJO-REMOTO.md](docs/TRABAJO-REMOTO.md). Resumen:

- **ANTES de publicar: escribí las novedades.** Agregá una entrada nueva arriba de
  todo en `apps/web/src/lib/novedades.ts` con la versión que va a salir. Es lo que
  ve la encargada y las empleadas al abrir la app actualizada (cartel una vez por
  versión). Si no la agregás, el release sale mudo y nadie se entera de qué cambió.
  Escribilo para ellas, no para programadores.
- **Publicar un alpha** → Actions → *Release Desktop* → Run workflow (`bump=prerelease`).
  El workflow bumpea, commitea a `main`, taggea y buildea. No toques versiones a mano:
  el drift versión/tag es lo que hizo fallar alpha.54.
- **Migrar Supabase** → Actions → *Cloud Migrate* → Run workflow. Idempotente.
- **Actualizar el servidor S1** → Actions → *Release Server (S1)* → Run workflow
  (`bump=patch`). S1 lo aplica solo a las 4 AM; `inmediato=true` lo baja en ~5 min.
  **Ciclo separado del `.exe`**: publicar un alpha NO actualiza S1. Si tocás la
  API y la usás desde S1, corré los dos. El job va en `windows-latest` a la
  fuerza — el build empaqueta binarios nativos (engine de Prisma,
  `better-sqlite3`) de la plataforma donde corre.
- **Orden cuando el release trae cambio de schema**: primero Cloud Migrate, después
  Release Desktop (así las cajas encuentran las columnas nuevas al actualizarse).
- Web y API deployan solos en cada push a `main` (Vercel + Railway).

> **Primer disparo real: 2026-08-05 (alpha.58).** Los dos workflows corrieron por
> `workflow_dispatch` y funcionaron. Cloud Migrate reportó "1 aplicadas, 23 ya
> estaban"; Release Desktop bumpeó a alpha.58, commiteó a `main` y taggeó sin
> drift versión/tag.
>
> **Truco de orden que conviene repetir**: si el release trae cambio de schema,
> corré Cloud Migrate **desde la rama de la feature** (el selector de rama del
> "Run workflow"), ANTES de mergear. Si mergeás primero, Vercel y Railway
> deployan solos en el acto y el API queda pidiendo columnas que todavía no
> existen → 500 en la pantalla afectada hasta que corras la migración. Como las
> migraciones son aditivas e idempotentes, aplicarlas antes que el código es
> seguro: el código viejo ignora las columnas nuevas.

## Pendientes priorizados

| # | Item | Bloqueante para |
|-|-|-|
| 1 | Resolver pendientes del cliente (PREGUNTAS.md) | Producción |
| 2 | Sync Excel ↔ programa (falta Google Drive API; hoy solo exceljs) | Aprobación de cambios masivos |
| 3 | Webhooks reales de RAPPI/PYA/MELI (la ingesta existe, falta el push de las plataformas) | Integración delivery automática |
| 4 | Hash-chain audit triggers en Postgres (no solo app-level) | Forensic strength |
| 5 | Cola real para impresión (hoy DB + polling cada 3s) | Throughput alto |
| 6 | Tests E2E con Playwright | Calidad |
| 7 | Completar Camino A de PLAN-PARIDAD (una sola app en la nube) | Que el admin opere 100% desde el celu |
| 8 | **Banco de horas de empleados** (especificado en SPEC §14, sin implementar) | Que la encargada sepa cuánto se debe |

### 🔒 Pendientes de seguridad — HACER CUANDO ESTÉ EL SERVER LISTO

Del acid-test de seguridad (alpha.39 cerró la mayoría). Estos dos quedaron para
cuando se despliegue el mini PC porque están acoplados al recovery:

- **A1 — audit append-only en Postgres.** Trigger que rechace UPDATE/DELETE sobre
  `audit_log` (y tablas chaineadas). OJO: hacerlo mal rompe el catch-up (que
  re-chainea filas) — diseñar JUNTO con C6. Además el salt de la cadena idealmente
  NO debe vivir en las cajas (hoy `getOrCreateSecret` lo genera por máquina,
  contradice el invariante "salt idéntico en todos lados").
- **C6 — validar el catch-up.** `services/catch-up.ts` absorbe filas de la nube
  (`origen='cloud'`) y las upsertea como fuente de verdad SIN revalidar precios/
  totales → recalcular server-side al importar y cuarentenar anomalías. (El vector
  principal —inyectar ventas vía la PWA— ya se cerró en alpha.39 con precios
  server-side; urgencia bajó, queda el caso de escritura directa a Supabase.)

Acción del dueño (no código): **C4** sacar el password de Postgres de las cajas
(que hablen solo a la API), **C5** firmar el instalador (cert Authenticode), y
operativo: **cambiar los PINs default `0001/0002/0003`** + segmentar el WiFi.

## Datos del cliente

- Local: Av. 44 e. 12 y Plaza Paso, La Plata, Bs. As.
- Volumen: 200–2.500 ventas/día
- Personal: encargada + dueño Julio + cajeros + cocineros + 1 motoquero (Damián)
- Apps usadas: RAPPI, Pedidos YA, Mercado Libre, DELIVERATE
- Cuentas: Caja física, Santander, Galicia, Cuenta DNI (BAPRO), MercadoPago

---

*Última actualización: 2026-08-05 (alpha.58). Se sumó a mayoristas la impresión
de remitos individuales, el detalle/edición de cada remito y el estado PAGADO con
imputación de cobros (ojo con el cálculo del saldo: PAGADO NO sale del total
remitado). Del lado de canal, `GET /channel/products` y `POST
/channel/orders/cancel`. Y quedó registrado el primer release disparado
íntegramente por `workflow_dispatch`.*

*Anterior: 2026-07-26 (alpha.56). Puesta al día tras la migración a
cloud-coding: Stack y estructura corregidos contra el código real (no hay BullMQ ni
better-auth; se sumaron desktop/server/mobile), setup de dev sin el `db:migrate`
trampa, estado y pendientes reflejando lo que ya se envió entre alpha.19 y alpha.56,
y el nuevo ciclo de release por GitHub Actions.*
