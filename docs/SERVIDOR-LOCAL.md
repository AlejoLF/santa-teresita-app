# Servidor local LAN — diseño

Estado: **DISEÑO APROBADO (2026-05-19)** · Implementación: pendiente, por fases.

Implementa la decisión cerrada del SPEC §1.5 / CLAUDE.md: *"Local-first hybrid
(Postgres replicado local↔VPS)"*. Hoy el sistema es cloud-first (todo pega a
Supabase São Paulo); la latencia desde La Plata hace lento el laburo del cajero.
Este doc define cómo mover la fuente de verdad al local sin perder el backup ni
el acceso remoto del dueño.

---

## 1. Objetivos y decisiones cerradas

| Decisión | Valor | Por qué |
|-|-|-|
| Hardware server | Mini PC / NUC dedicado, siempre encendido | No compite con el laburo del cajero; si apagan una caja no se cae el sistema |
| Fuente de verdad | Postgres en el mini PC (LAN) | Velocidad — escrituras sin RTT a São Paulo |
| Supabase | Mirror / backup + acceso remoto de Julio | Resguardo y dashboards remotos, NO ruta crítica de venta |
| Replicación | local → Supabase, app-level CDC vía `outbox_events` | Replicación lógica PG es inviable (Supabase tendría que entrar a la LAN por NAT) |
| Failover (Fase 1) | mini PC caído → cajas leen de Supabase + ventas al `outbox.sqlite` de cada caja; flush al volver | Cero conflictos: Supabase nunca recibe escrituras autoritativas. Reusa el outbox que ya existe |
| Failover (Fase 2) | escritura autoritativa a Supabase + reconciliación bidireccional | Solo si los cortes resultan largos/frecuentes. Diseñado acá, NO se implementa en Fase 1 |
| Server headless | Postgres + API/replicator como **Windows Services** (NO el `.exe` Electron). Arranque automático post-corte de luz, sin login/UAC/humano | Mini PC sin monitor, dedicado. Ver §9 |
| Restore post-corte | Automático: `outbox-flusher` de cada caja drena al volver el LAN. Cero intervención | Ver §4.2.1 |

---

## 2. Topología

```
┌─ Mini PC (server LAN, IP fija, siempre encendido) ───────────────┐
│  Postgres 16            ← FUENTE DE VERDAD                        │
│  API Fastify  (DATABASE_URL → 127.0.0.1:5432 local)              │
│  Replicator worker      ── drena outbox_events → upsert ──►  Supabase
│  (opcional) sirve el web bundleado en :3000                      │
└──────────────────────────────────────────────────────────────────┘
        ▲ LAN cableada (sub-ms, sin latencia a SP)
   ┌────┴───────┬────────────┬───────────┐
  Caja 1       Caja 2       Caja 3      ... (.exe Electron)
  outbox.sqlite c/u (resiliencia ante corte de LAN / mini PC)
                                          │
                                          └─► Supabase (solo en failover, READ-ONLY)
```

- **Mini PC** = el "server". Corre Postgres + la API + el replicator. IP fija en
  la LAN (ej. `192.168.1.10`).
- **Cajas** = el `.exe` actual. En modo normal su API/web apunta al mini PC por
  LAN. Cada caja mantiene su `outbox.sqlite` (ya existe) como buffer.
- **Supabase** = mirror downstream puro en Fase 1. Julio lo lee remoto.

### Decisión: ¿caja con API propia o thin client?

Se mantiene el **modelo actual** (cada `.exe` bundlea API + web). Cambia solo a
qué `DATABASE_URL` apunta esa API:

- **Normal**: `postgresql://teresita@<minipc-ip>:5432/teresita` (LAN).
- **Failover**: la API local de la caja reconecta a Supabase **solo para
  lecturas**; las escrituras caen al `outbox.sqlite` de esa caja.

Razón: no introducir un modelo nuevo de "thin client". La API Fastify tiene
lógica de negocio crítica (hash-chain audit, sesiones, FIFO de pagos) que no se
puede saltear hablándole directo a Postgres/Supabase. Reusar el `.exe`
self-contained minimiza cambios y riesgo.

---

## 3. Replicación local → Supabase (CDC app-level)

No se usa replicación lógica de Postgres: el subscriber (Supabase) debería
conectarse al publisher (mini PC) y eso requiere exponer el mini PC a Internet o
un túnel. Inviable/insegura. En su lugar, **transactional outbox** con la tabla
`outbox_events` que **ya existe en el schema y está sin usar**:

```prisma
model OutboxEvent {                       // tabla outbox_events
  id          String    @id @default(uuid()) @db.Uuid
  topic       String    @db.VarChar(80)   // ej. "venta.upsert", "movimiento.upsert"
  payload     Json      @db.JsonB         // snapshot del registro + metadata
  agregadoAt  DateTime  @default(now())
  publicadoAt DateTime?                   // null = pendiente de replicar
  intentos    Int       @default(0)
  ultimoError String?
  @@index([publicadoAt, agregadoAt])
}
```

### 3.1 Producción del evento

Toda mutación que ya graba audit (vía `recordAudit`) inserta **en la misma
transacción** un `outbox_events`. Se engancha en `services/audit.ts` para no
tocar cada endpoint: donde hoy se escribe `audit_log` con su `secuencia`
monotónica, se agrega el insert del outbox con el mismo orden lógico.

- `topic`: `"<tabla>.<accion>"` (ej. `ventas.TRANSITION`).
- `payload`: `{ tabla, registroId, accion, secuencia, snapshot }` donde
  `snapshot` es el row completo post-cambio (para upsert idempotente) o
  `{ deleted: true }` en DELETE.
- El `audit_log.secuencia` (BigInt monotónico ya existente) es el **orden total**
  de replicación. El replicator respeta ese orden.

### 3.2 El replicator (worker en el mini PC)

Servicio nuevo `apps/api/src/services/replicator.ts`, arranca solo si
`STA_ROLE=server` (ver §5). Loop:

1. `SELECT * FROM outbox_events WHERE publicado_at IS NULL ORDER BY agregado_at LIMIT N`.
2. Para cada evento, **upsert idempotente** en Supabase por PK:
   `INSERT ... ON CONFLICT (id) DO UPDATE SET ... WHERE excluded.editado_at >= tabla.editado_at`
   (last-write-wins por timestamp/secuencia; nunca pisa con un dato más viejo).
3. `UPDATE outbox_events SET publicado_at = now()` al confirmar.
4. Error de red/Supabase → `intentos++`, `ultimo_error`, backoff exponencial,
   reintenta (no marca publicado). Idempotencia hace seguro el reintento.

Conexión a Supabase: pooler `aws-1-sa-east-1` (ver CLAUDE.md — `aws-0` es legacy
y da "tenant not found"). El mini PC tiene salida a Internet → NAT-friendly.

Garantías: **at-least-once + idempotente = efectivamente exactly-once** sobre el
estado final. Orden preservado por `secuencia`. Si el mini PC se cae, los
eventos quedan en `outbox_events` y se drenan al volver — no se pierde nada.

---

## 4. Failover — Fase 1 (aprobada)

Objetivo: si el mini PC no responde, las cajas **siguen vendiendo** sin generar
conflictos de datos.

### 4.1 Healthcheck

La API de cada caja (su `.exe`) hace un healthcheck liviano al Postgres del mini
PC (ping `SELECT 1` con timeout corto, ej. cada 10 s o on-demand antes de cada
write crítico). Estados: `LAN_OK` / `LAN_DOWN`.

### 4.2 Comportamiento por estado

| Estado | Lecturas (catálogo, sesión, historial) | Escrituras (venta, cobro, movimiento) |
|-|-|-|
| `LAN_OK` | API local de la caja → Postgres mini PC | → Postgres mini PC (directo, autoritativo) |
| `LAN_DOWN` | API local → **Supabase mirror (read-only)** para que la UI siga viva | → **`outbox.sqlite` de la caja** (encolado). NO se escribe a Supabase |

### 4.2.1 Restauración al volver el LAN — 100% automática, sin humano

Secuencia exacta cuando el mini PC vuelve (recovery):

1. El `outbox-flusher` de cada caja (ya existe, loop cada 5 s) detecta que la
   API del mini PC responde de nuevo.
2. Drena su `outbox.sqlite` en orden FIFO: reproduce cada write encolado
   (`POST /ventas`, `/finalizar`, `/movimientos`, …) contra la API del mini PC
   → Postgres local. El orden se preserva (FIFO + `audit_log.secuencia`).
3. Es **idempotente**: si un reintento manda dos veces el mismo evento, el
   upsert por PK no duplica. Un corte de red a mitad de drenado se recupera
   solo en el siguiente tick.
4. El `replicator` del mini PC toma esos writes recién aplicados desde
   `outbox_events` y los propaga a Supabase.

Cero clicks, cero intervención. El `outbox.sqlite` es un archivo en disco de
cada caja: si una caja se apaga durante el corte, al rebootear el flusher
retoma desde donde quedó — no se pierde nada salvo muerte del disco físico.

**Visibilidad durante el corte (límite explícito)**: mientras el mini PC está
caído, Supabase NO recibe los pedidos del corte (es mirror read-only en Fase 1).
Julio, mirando Supabase remoto, NO ve esos pedidos hasta que el mini PC vuelve y
el flusher+replicator se ponen al día. Además, durante el corte cada caja solo
tiene su propia cola (no hay vista consolidada). Aceptable para cortes de
minutos/horas; Fase 2 cubre cortes largos.

**Supabase nunca recibe escrituras autoritativas en Fase 1** → cero
reconciliación, cero conflictos.

### 4.3 Por qué esto cumple "failover automático a Supabase"

El usuario sigue operando durante el corte: la UI lee del mirror Supabase
(catálogo/sesión visibles) y las ventas se acumulan en el outbox local de cada
caja (igual que hoy ante caída de cloud). La diferencia con "escribir a Supabase"
es deliberada: evita el problema bidireccional. Cubre cortes de minutos/horas
(99% de los casos de un mini PC dedicado).

### 4.4 Límite conocido de Fase 1

Si el mini PC está caído **mucho tiempo**, las ventas quedan repartidas en los
`outbox.sqlite` de cada caja y nadie ve datos consolidados hasta que vuelva. Para
eso está la Fase 2 (no se implementa ahora).

---

## 5. Cambios de config

### 5.1 Rol del proceso

Nueva env `STA_ROLE`:
- `server` (mini PC): la API usa Postgres local + arranca el replicator.
- `caja` (default): la API usa LAN primary + Supabase fallback, NO replicator.

### 5.2 Resolución de DATABASE_URL (extender `main.js`)

Hoy `leerCloudDbUrl()` precedencia: `env SUPABASE_DB_URL` → `%APPDATA%/config.json`
→ `cloud-config.json` bundleado. Se agrega:

```jsonc
// %APPDATA%/Santa Teresita/config.json — en una CAJA
{
  "rol": "caja",
  "lanDbUrl":   "postgresql://teresita:***@192.168.1.10:5432/teresita",
  "cloudDbUrl": "postgresql://postgres.<ref>:***@aws-1-sa-east-1.pooler.supabase.com:6543/postgres",
  "webRemoteUrl": "http://192.168.1.10:3000"
}
```

```jsonc
// config.json — en el MINI PC
{
  "rol": "server",
  "cloudDbUrl": "postgresql://teresita@127.0.0.1:5432/teresita",
  "replicateToUrl": "postgresql://postgres.<ref>:***@aws-1-sa-east-1.pooler.supabase.com:6543/postgres",
  "webRemoteUrl": ""
}
```

Precedencia nueva para la caja: `lanDbUrl` (si healthcheck OK) → `cloudDbUrl`
(failover read-only). El switch lo maneja la API, no `main.js` (necesita ser
dinámico en runtime, no solo al boot).

### 5.3 Prisma con datasource conmutable

Prisma no soporta cambiar `datasource.url` en runtime sin reinstanciar el client.
Estrategia: dos `PrismaClient` (uno LAN, uno Supabase-RO) y un router que elige
según el estado del healthcheck. Encapsular en `packages/db/src/client.ts`
(hoy exporta un único `prisma`). Detalle de implementación en Fase 1.

---

## 6. Cambios de schema

`outbox_events` ya existe — **no requiere migración**. Posibles ajustes menores
en Fase 1 (a confirmar al implementar):

- Índice parcial `WHERE publicado_at IS NULL` para que el drain sea O(pendientes).
- Campo `secuencia BIGINT` en `outbox_events` espejando `audit_log.secuencia`
  para ordenar el drain sin join (opcional, optimización).

No se toca el resto del schema. La replicación es upsert por PK sobre las tablas
existentes en Supabase (mismo schema en ambos lados — ya garantizado por las
mismas migraciones).

---

## 7. Plan por fases

### Fase 1 — Servidor local + replicación forward + failover-outbox  *(esta entrega)*

1. `STA_ROLE` + resolución de URL LAN/cloud en `main.js` y `packages/db/client`.
2. Router de Prisma (LAN primary / Supabase read-only) + healthcheck.
3. Hook en `services/audit.ts`: insertar `outbox_events` en la misma tx.
4. `services/replicator.ts` (solo `STA_ROLE=server`): drain idempotente →
   Supabase, backoff, métricas en `/sync/status`.
5. Failover read-only: cuando `LAN_DOWN`, la API de la caja lee de Supabase y los
   writes van al `outbox.sqlite` (ya existe el camino vía `/sync/queue`).
6. Script de provisión del mini PC (`tools/setup-mini-pc.ps1`): instalar
   Postgres 16, crear DB + rol, aplicar migraciones (vía SQL, **no
   `prisma migrate dev`** — ver gotcha CLAUDE.md), seed, `config.json` con
   `rol: server`, **registrar API + replicator como Windows Service (NSSM)**
   con recovery + dependencia de Postgres, firewall LAN (5432 solo subred),
   habilitar acceso remoto admin (RDP/SSH). Ver §9.
7. Validar arranque headless: simular reboot del mini PC y verificar que todo
   levanta solo y las cajas recuperan sin intervención.

### Fase 2 — Failover autoritativo + reconciliación bidireccional  *(diferida)*

Solo si los cortes del mini PC resultan largos/frecuentes en la práctica.

- Durante `LAN_DOWN`, las cajas escriben autoritativo a Supabase.
- Al volver el mini PC: reconciliador Supabase→local de la ventana de corte,
  LWW por PK + `secuencia`/`editado_at`, idempotente.
- Resolución de colisiones de `numeroOrdenTurno` / secuencias de caja entre la
  isla local y la isla Supabase (estrategia: rangos de numeración por origen).

---

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|-|-|
| Mini PC se apaga (corte de luz) | UPS recomendado. El outbox de cada caja cubre el hueco; al volver, flush. |
| Reloj del mini PC desfasado | `TZ='America/Argentina/Buenos_Aires'` + NTP. Las fechas de sesión dependen de la TZ del proceso (ver gotcha CLAUDE.md). |
| Drift de schema local vs Supabase | Mismas migraciones aplicadas por SQL en ambos. **Nunca `prisma migrate dev`** (genera migraciones de drift que dropean índices — ver CLAUDE.md). |
| Replicator atrasado (Supabase lento) | Es asíncrono y no bloquea ventas. `outbox_events` crece pero drena solo. Alarma si pendientes > umbral. |
| Caja con `outbox.sqlite` lleno tras corte largo | Visible en `/sync/status`. Fase 2 si se vuelve recurrente. |
| Seguridad LAN (Postgres expuesto) | `pg_hba.conf` solo subred LAN; puerto 5432 cerrado al exterior; password fuerte. |

---

## 9. Operación — mini PC HEADLESS, arranque 100% automático

El mini PC no tiene monitor (o no se usa). Requisito duro: tras un corte de luz,
cuando vuelve la energía y Windows bootea, **todo el stack del server tiene que
levantar solo, sin que nadie le dé OK, sin login, sin UAC, sin ventana**.

### 9.1 El server NO corre el `.exe` de Electron

El `.exe` de Electron (splash, ventana, posible prompt UAC) es **solo para las
cajas** (tienen pantalla). El mini PC corre infra headless pura:

| Componente | Cómo corre en el mini PC | Auto-start |
|-|-|-|
| Postgres 16 | **Windows Service** (lo crea el instalador de Postgres) | Sí, nativo. Arranca antes de cualquier login |
| API + replicator (`STA_ROLE=server`) | **Windows Service** vía NSSM (o `node-windows`), Node puro corriendo `resources/api/server.mjs` — sin Electron | Sí, `Startup type: Automatic` |
| Web (opcional, si las cajas usan el web del server) | Mismo service o uno aparte (`next start`) | Sí |

Servicios de Windows arrancan **antes del login de usuario** → no hace falta
auto-login, no aparece UAC (los services no lo disparan), no hay ventana que
cerrar. Si el proceso crashea, el Service Manager lo reinicia
(`Recovery: Restart the Service`, configurado por el script de provisión).

### 9.2 Secuencia post-corte de luz (sin humano)

1. Vuelve la luz → el mini PC bootea Windows.
2. Service `postgresql-x64-16` arranca (Automatic) → DB lista.
3. Service `sta-api` arranca (Automatic, `DependOnService=postgresql-x64-16`)
   → API en `:3001` + replicator drenando `outbox_events` a Supabase.
4. Las cajas (su `.exe`) detectan `LAN_OK` en el próximo healthcheck (≤10 s) y
   sus `outbox-flusher` vacían lo encolado durante el corte (§4.2.1).

Cero intervención. Tiempo típico de recuperación: lo que tarda Windows en
bootear + ~10 s del healthcheck.

### 9.3 UPS — recomendado, no opcional para producción seria

Un UPS chico en el mini PC:
- Un parpadeo de luz NO reinicia nada (se evita la clase entera de problemas).
- En un corte real, da tiempo a que Postgres haga shutdown limpio (vía script
  del UPS o `shutdown /s` a batería baja) → **evita corrupción del WAL** de
  Postgres, que sería el peor escenario (DB inconsistente).
- Sin UPS igual funciona (Postgres tiene WAL + crash recovery), pero el UPS
  elimina el riesgo de un boot con DB dañada que sí requeriría humano.

### 9.4 Provisión y mantenimiento

- Script de provisión (`tools/setup-mini-pc.ps1`, a crear en Fase 1):
  instala Postgres 16, crea DB + rol, aplica migraciones por SQL (NO
  `prisma migrate dev`), seed, escribe `config.json` con `rol: server`,
  registra los Windows Services con NSSM + recovery + dependencias, abre el
  puerto 5432 solo en la subred LAN en el firewall.
- IP fija en el mini PC (reserva DHCP por MAC o IP estática). DNS LAN opcional
  (`server.local`).
- Backup: el replicator a Supabase ES el backup off-site. Adicional: tarea
  programada `pg_dump` diario a disco externo / carpeta sincronizada.
- Monitoreo: `/sync/status` reporta lag del replicator (pendientes, último
  error, antigüedad del más viejo) — visible desde cualquier caja o remoto.
- Acceso administrativo al server sin monitor: RDP / AnyDesk / SSH (OpenSSH
  para Windows) habilitado en el script, para mantenimiento puntual sin tener
  que enchufar un monitor.

---

*Creado 2026-05-19. Diseño aprobado: Fase 1 (outbox + mirror read-only),
documento primero. Implementación de Fase 1 pendiente de arrancar.*
