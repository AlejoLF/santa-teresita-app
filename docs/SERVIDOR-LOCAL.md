# Servidor local LAN + operación en corte de luz — diseño

Estado: **DISEÑO APROBADO (2026-05-19, v2)** · Implementación: pendiente.

Implementa la decisión cerrada del SPEC §1.5: *"Local-first hybrid (Postgres
replicado local↔VPS)"*. Hoy todo pega a Supabase São Paulo; la latencia desde
La Plata hace lento el laburo del cajero. Este doc define cómo mover la fuente
de verdad al local, mantener backup + acceso remoto, y **seguir vendiendo
durante un corte de luz** (escenario primario en Argentina).

> **v2 (2026-05-19):** se incorpora el escenario real de corte de luz. Un corte
> apaga el server **y** las cajas juntos; lo único que sobrevive son
> celulares/tablet con batería + datos móviles corriendo la PWA. Eso obliga a
> tener una copia del API siempre encendida en la nube (Vercel). Reescrito
> entero respecto de v1.

---

## 1. Decisiones cerradas

| Decisión | Valor | Por qué |
|-|-|-|
| Hardware server | Mini PC / NUC dedicado, headless, siempre encendido | No compite con el cajero; si apagan una caja no se cae el sistema |
| Fuente de verdad | Postgres en el mini PC (LAN) | Velocidad — escrituras sin RTT a São Paulo |
| Replicación normal | local → Supabase, app-level CDC vía `outbox_events` | Replicación lógica PG inviable (Supabase tendría que entrar a la LAN por NAT) |
| API en la nube | **Vercel serverless** (junto a la web que ya está ahí), apunta a Supabase | $0 extra, sin server nuevo que mantener. Es el "cerebro" siempre-encendido que usa la PWA en el corte |
| Failover A — LAN caída, **con luz** | `.exe` lee de Supabase (vía API local) + ventas al `outbox.sqlite` de cada caja; flush al volver | Mini PC se colgó pero las PCs están vivas. Cero conflictos (Supabase no recibe writes autoritativos) |
| Failover B — **corte de luz** | Celular/tablet con PWA → API Vercel → Supabase (writes autoritativos) | Server y cajas apagados. Único modo de seguir vendiendo. Es el failover PRIMARIO |
| Recuperación post-corte | Mini PC bootea → catch-up direccional Supabase→local de la ventana del corte → reanuda forward | Sin merge concurrente: el local estuvo congelado durante el corte (apagado) |
| Server headless | Postgres + API/replicator como **Windows Services** (NO el `.exe`). Arranque automático sin login/UAC/humano | Mini PC sin monitor. Ver §8 |

---

## 2. Topología (3 niveles)

```
NIVEL CLOUD (siempre encendido, alcanzable por internet)
┌──────────────────────────────────────────────────────────────┐
│  Vercel:  Web (UI)  +  API Fastify serverless ──► Supabase    │
│  Supabase: Postgres (mirror/backup + datos del corte)         │
└──────────────────────────────────────────────────────────────┘
        ▲ internet (datos móviles en el corte; o Julio remoto)
        │                                   ▲ replicación
        │                                   │ local→Supabase (forward, normal)
        │                                   │ Supabase→local (catch-up, recovery)
   ┌────┴─────────┐              ┌──────────┴───────────────────┐
   │ Celular/Tablet│              │ Mini PC (server LAN, headless)│
   │ PWA (batería) │              │  Postgres 16 ← FUENTE VERDAD  │
   │ SOLO en corte │              │  API Fastify (→ PG local)     │
   └───────────────┘              │  Replicator (Windows Service) │
                                  └───────────────────────────────┘
                                          ▲ LAN cableada (sub-ms)
                                     ┌────┴──────┬───────────┐
                                    Caja1      Caja2   ...  (.exe)
                                    outbox.sqlite c/u
```

- **Cajas (`.exe`)**: modo normal → su API local apunta al Postgres del mini PC
  por LAN (rápido). Mantienen su `outbox.sqlite` (ya existe) como buffer.
- **Mini PC**: Postgres (fuente de verdad) + API + replicator. Headless.
- **Cloud (Vercel + Supabase)**: la web ya vive en Vercel; se suma el **API
  Fastify como serverless en Vercel** apuntando a Supabase. Es el cerebro
  siempre-encendido para la PWA del corte y para Julio remoto.
- **Celular/Tablet (PWA)**: `apps/mobile` (ya scaffoldeada). Solo se usa en el
  corte de luz; corre con batería + datos móviles contra el API de Vercel.

### Por qué el `.exe` mantiene su API bundleada

La API Fastify tiene lógica crítica (hash-chain audit, sesiones, FIFO de pagos,
`numeroOrdenTurno`) que NO se puede saltear hablándole directo a Postgres.
Reusar el `.exe` self-contained (solo cambiando a qué DB apunta) minimiza
cambios. El mismo código de la API se deploya además en Vercel (serverless)
para el nivel cloud — un solo codebase, dos despliegues.

---

## 3. Replicación normal: local → Supabase (CDC app-level)

No se usa replicación lógica de Postgres (el subscriber Supabase debería entrar
a la LAN por NAT — inviable). Se usa **transactional outbox** con la tabla
`outbox_events` que **ya existe en el schema, sin usar**:

```prisma
model OutboxEvent {                       // tabla outbox_events
  id String @id @default(uuid()) @db.Uuid
  topic String @db.VarChar(80)            // ej "ventas.TRANSITION"
  payload Json @db.JsonB                  // { tabla, registroId, accion, secuencia, snapshot }
  agregadoAt DateTime @default(now())
  publicadoAt DateTime?                   // null = pendiente
  intentos Int @default(0)
  ultimoError String?
  @@index([publicadoAt, agregadoAt])
}
```

- **Producción**: se engancha en `services/audit.ts` (donde ya se escribe
  `audit_log` con su `secuencia` BigInt monotónica) → insert de `outbox_events`
  en la **misma transacción**. Un solo punto, no se toca cada endpoint.
- **Replicator** (`services/replicator.ts`, nuevo, solo `STA_ROLE=server`):
  loop que drena `outbox_events` ordenado por `secuencia`, hace **upsert
  idempotente por PK** en Supabase (LWW: nunca pisa con dato más viejo),
  marca `publicado_at`. Backoff en error. At-least-once + idempotente =
  exactly-once efectivo. Conexión Supabase: pooler `aws-1-sa-east-1`.

---

## 4. Failover A — LAN caída CON luz (mini PC colgado, PCs vivas)

| Estado | Lecturas | Escrituras |
|-|-|-|
| `LAN_OK` | API caja → Postgres mini PC | → Postgres mini PC (autoritativo) |
| `LAN_DOWN` (hay luz) | API caja → Supabase mirror (read-only) | → `outbox.sqlite` de la caja (encolado) |

Al volver `LAN_OK`: el `outbox-flusher` (ya existe, 5 s) drena el `outbox.sqlite`
contra la API del mini PC → Postgres local → replicator → Supabase. FIFO +
`secuencia`, idempotente, **cero humano**. Supabase nunca recibe escrituras
autoritativas en este modo → cero reconciliación.

Cubre: mini PC se cuelga/reinicia pero hay electricidad y las cajas siguen
prendidas. Cortes de minutos.

---

## 5. Failover B — CORTE DE LUZ (escenario primario)

Un corte apaga el mini PC **y** las cajas **y** el router LAN juntos. Lo único
vivo: **celular/tablet con batería + datos móviles**.

### 5.1 Durante el corte

- El personal usa la **PWA** (`apps/mobile`) en celular/tablet, por datos
  móviles, contra el **API de Vercel** → escribe a **Supabase**.
- La PWA **sí carga pedidos** (writes autoritativos). Pasa por el mismo código
  de negocio (audit, sesiones, etc.) porque le habla al API real (en Vercel),
  no a Supabase crudo.
- El Postgres local está **congelado** (apagado, cero writes).

### 5.2 Recuperación cuando vuelve la luz

1. Mini PC bootea (Windows Services, §8). Postgres + API + replicator arriba.
2. El replicator detecta que Supabase tiene filas con `secuencia`/`editado_at`
   posteriores al último estado conocido del local → hace **catch-up
   direccional Supabase→local** de esa ventana (upsert por PK).
3. **No hay conflicto de merge**: el local no escribió NADA durante el corte
   (estaba apagado). Es un catch-up de un solo sentido, ordenado.
4. Terminado el catch-up, reanuda la replicación forward normal local→Supabase.
5. Las cajas (`.exe`) vuelven a `LAN_OK` y operan contra el local ya al día.

### 5.3 El punto fino: numeración entre "isla local" e "isla Supabase"

`audit_log.secuencia` es un autoincrement **independiente en cada DB**. Durante
el corte, Supabase avanzó su `secuencia`; el local quedó atrás. Lo mismo con
`numeroOrdenTurno` (por sesión). Estrategia:

- **Tag de origen**: cada fila replicada lleva `origen` (`local` | `cloud`) +
  `secuencia_origen`. El catch-up importa las filas del corte preservando su
  identidad (UUID PK) sin reusar el `secuencia` local — se le asigna `secuencia`
  local nueva al importar, manteniendo `secuencia_origen` para auditoría.
- **Sesiones de caja del corte**: la PWA abre sesión vía API Vercel con un
  marcador `pcOrigen='PWA-CORTE'`. Al catch-up, esas sesiones se importan tal
  cual; no colisionan con las locales porque el local no abrió sesiones en ese
  rango temporal (estaba apagado).
- **`numeroOrdenTurno`**: es único por `(sesionCajaId)`. Como las sesiones del
  corte son distintas a las locales, no hay colisión de números.

Detalle fino se cierra al implementar Fase 1.5 (esquema de `origen` +
`secuencia_origen` requiere migración chica).

---

## 6. API en Vercel (serverless)

El mismo codebase `apps/api` (Fastify) se deploya como funciones serverless en
Vercel, junto a la web. `DATABASE_URL` → Supabase pooler (`aws-1-sa-east-1`,
`pgbouncer=true&connection_limit=1`).

Consideraciones:
- **Cold start**: primer request tras inactividad ~1-2 s. Aceptable para uso de
  contingencia (corte de luz), no es la ruta normal.
- **`recordAudit` (hash-chain)**: hoy hace 3 queries en tx Serializable. Sobre
  pooler + serverless eso es lento. La optimización pendiente (precomputar
  `secuencia` con `nextval()` → 1 INSERT) se hace acá también — relevante para
  que la PWA no se sienta lentísima en el corte.
- **Estado**: serverless es stateless → OK, toda la lógica de sesión vive en
  Postgres (Supabase), no en memoria del proceso.
- La PWA apunta a `https://<vercel-app>/api/v1` siempre (en el corte es la única
  ruta; con luz la PWA igual puede usarse pero la ruta normal del local es el
  `.exe`).

---

## 7. Plan de implementación

### Fase 1 — Server local + replicación forward  *(esta entrega, parte A)*

1. `STA_ROLE` (`server`|`caja`) + resolución de URL LAN/cloud (`main.js` +
   `packages/db/client`).
2. Router de Prisma: LAN primary / Supabase read-only, con healthcheck.
3. Hook en `services/audit.ts`: insertar `outbox_events` en la misma tx.
4. `services/replicator.ts` (solo `STA_ROLE=server`): drain idempotente →
   Supabase, backoff, métricas en `/sync/status`.
5. Failover A (LAN down con luz): caja lee Supabase + writes al `outbox.sqlite`.
6. Provisión mini PC (`tools/setup-mini-pc.ps1`): Postgres 16, DB+rol,
   migraciones por SQL (NO `prisma migrate dev` — ver gotcha CLAUDE.md), seed,
   `config.json rol:server`, **Windows Services (NSSM)** con recovery +
   dependencia de Postgres, firewall LAN, acceso remoto admin (RDP/SSH).
7. Validar arranque headless (simular reboot, verificar recuperación sola).

### Fase 1.5 — Corte de luz: API Vercel + PWA + catch-up  *(esta entrega, parte B)*

8. Deploy del API Fastify como serverless en Vercel apuntando a Supabase.
9. Optimizar `recordAudit` a 1 INSERT (`nextval()` precomputado) — necesario
   para latencia aceptable de la PWA sobre pooler.
10. PWA (`apps/mobile`): apuntar al API de Vercel; flujo mínimo de carga de
    pedido + cobro (lo que se necesita para operar en el corte).
11. Migración chica: `origen` + `secuencia_origen` en tablas transaccionales
    (o en `audit_log`) para el catch-up.
12. Catch-up Supabase→local en el replicator: al bootear, detectar ventana del
    corte e importar idempotente antes de reanudar forward.
13. Simular corte completo (apagar mini PC + cajas, operar por PWA, reencender,
    verificar que el local absorbe todo sin intervención ni duplicados).

### Fase 2 — Reconciliación bidireccional concurrente  *(diferida, quizá innecesaria)*

Solo haría falta si alguna vez el local y Supabase reciben writes autoritativos
**al mismo tiempo** (ej. mini PC colgado SIN corte de luz, pero deciden operar
por PWA igual). Con el diseño actual no pasa: Failover A no escribe a Supabase,
Failover B tiene el local apagado. Se documenta como contingencia, no se
construye salvo evidencia de necesidad.

---

## 8. Operación — mini PC headless, arranque 100% automático

El mini PC no tiene monitor. Tras un corte, cuando vuelve la luz y Windows
bootea, **todo levanta solo, sin login/UAC/humano**.

- El server **NO corre el `.exe` Electron** (eso es solo para las cajas con
  pantalla). Corre infra headless:

| Componente | Cómo | Auto-start |
|-|-|-|
| Postgres 16 | Windows Service (lo crea el instalador) | Sí, antes del login |
| API + replicator (`STA_ROLE=server`) | Windows Service (NSSM), Node puro sobre `resources/api/server.mjs`, sin Electron | Sí, Automatic, `DependOnService=postgresql` |

- Servicios arrancan antes del login → sin auto-login, sin UAC, sin ventana.
  Crash → Service Manager reinicia (recovery configurado por el script).
- **Secuencia post-corte**: vuelve luz → Windows bootea → Postgres service →
  API/replicator service → replicator hace catch-up Supabase→local (§5.2) →
  cajas detectan `LAN_OK` (≤10 s) y flushean su `outbox.sqlite`. Cero humano.
- **UPS recomendado**: un parpadeo no reinicia nada; en corte real da tiempo a
  shutdown limpio de Postgres (evita corrupción del WAL). Sin UPS funciona
  (WAL + crash recovery) pero el UPS elimina el peor escenario.
- Acceso admin sin monitor: RDP / OpenSSH habilitados por el script de
  provisión, para mantenimiento puntual.

---

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
|-|-|
| Corte largo: ventas solo en Supabase, local atrasado | Catch-up automático al volver (§5.2). Es directional, sin merge → robusto |
| Numeración secuencia/orden entre islas | Tag `origen` + `secuencia_origen`, sesiones del corte separadas (§5.3) |
| Cold start de Vercel en el corte | ~1-2 s solo el primer request; uso de contingencia, aceptable |
| `recordAudit` lento sobre pooler en la PWA | Optimización a 1 INSERT (paso 9) |
| Reloj del mini PC desfasado | `TZ='America/Argentina/Buenos_Aires'` + NTP (fechas de sesión dependen de la TZ — gotcha CLAUDE.md) |
| Drift schema local vs Supabase | Mismas migraciones por SQL en ambos. **Nunca `prisma migrate dev`** (gotcha CLAUDE.md) |
| Postgres LAN expuesto | `pg_hba.conf` solo subred; 5432 cerrado al exterior; password fuerte |
| Caja con `outbox.sqlite` lleno (Failover A largo) | Visible en `/sync/status` |

---

*v2 — 2026-05-19. Aprobado: server local (Fase 1) + corte de luz vía PWA/Vercel
(Fase 1.5) juntas. API cloud en Vercel ($0 extra). Implementación pendiente de
arrancar — este doc es la fuente de verdad del diseño.*
