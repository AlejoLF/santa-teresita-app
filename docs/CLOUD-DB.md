# Cloud DB — Supabase Pro

Base de datos en la nube que actúa como **replica de la PC de Nancy** y como
**plataforma común** para integraciones que viven fuera del local (bot de
WhatsApp en N8N, dashboards de Julio desde el celular, etc.).

## Datos del proyecto

| Item | Valor |
|---|---|
| Provider | Supabase Pro |
| Plan | Pro $25/mo + Compute SMALL $15/mo = **$40/mo** |
| Region | South America (São Paulo) — `sa-east-1` |
| Postgres | 17.6 (aarch64 ARM) |
| Project ref | `<PROJECT_REF>` |
| Dashboard | https://supabase.com/dashboard/project/<PROJECT_REF> |
| RLS | Habilitado en todas las 44 tablas (sin políticas — service_role bypassa) |

## Arquitectura

```
┌────────────────────────┐         ┌──────────────────┐
│  PC encargada (local)  │         │  Supabase Pro    │
│  embedded-postgres 18  │═══════► │  Postgres 17.6   │
│  → outbox_events       │  push   │  → sync_inbox    │
│  → ventas, cashflow,   │  (one-  │  → ventas, cash, │
│     productos, etc.    │   way)  │     productos,   │
│                        │         │     etc.         │
└────────────────────────┘         └──────────────────┘
                                            ▲
                                            │ read/write
                                            │
                                   ┌──────────────────┐
                                   │  N8N + bot WSP   │
                                   │  (VPS pequeño)   │
                                   └──────────────────┘
                                            ▲
                                   ┌────────┴─────────┐
                                   │  Admin remoto    │
                                   │  (celular Julio) │
                                   └──────────────────┘
```

**Source of truth: la PC de la encargada.** La cloud es replica.

## Conexión

### Por qué usamos el Shared Pooler y no el Direct

La conexión Direct de Supabase (puerto 5432, host `db.PROJECT.supabase.co`) es
**IPv6-only**. Las redes residenciales en Argentina (Fibertel, Movistar,
Personal) son IPv4-only — el direct queda inalcanzable sin el add-on de IPv4
($4/mo extra) que decidimos NO contratar.

El **Shared Pooler** (Supavisor) tiene host distinto
(`aws-X-REGION.pooler.supabase.com`) y es **IPv4-compatible gratis**. Lo
activás en Settings → Database con el toggle "Use IPv4 connection (Shared
Pooler)".

### Variables de entorno

En el `.env` de la raíz del repo (gitignored):

```bash
SUPABASE_PROJECT_REF=<PROJECT_REF>
SUPABASE_DB_URL_POOLED=postgresql://postgres.<PROJECT_REF>:[PASSWORD]@aws-1-sa-east-1.pooler.supabase.com:6543/postgres
SUPABASE_SERVICE_ROLE=sb_secret_...
```

`SUPABASE_DB_URL_DIRECT` lo dejamos vacío — no funciona desde redes IPv4.

### Para conectarse desde Prisma (sync agent)

```
DATABASE_URL=$SUPABASE_DB_URL_POOLED?pgbouncer=true&connection_limit=1
```

- `pgbouncer=true` → desactiva prepared statements (incompatibles con el
  pooler en transaction mode).
- `connection_limit=1` → recomendado por Prisma para evitar conflictos entre
  conexiones reusadas.

## Comandos

Todos viven en `package.json` de la raíz y leen `.env` automáticamente.

```bash
# Ping de conectividad — prueba ambas conexiones (direct + pooled).
pnpm cloud:test

# Reporta conteo de filas por tabla — sanity check post-bootstrap.
pnpm cloud:status

# Aplica las migraciones de Prisma a la cloud (solo bootstrap).
pnpm cloud:migrate

# Drop schema + recrear desde scratch (¡borra todo!). Pide --yes.
pnpm cloud:reset-schema --yes

# Habilita RLS + crea sync_inbox + RPC apply_sync_event.
pnpm cloud:setup-sync

# Corre el seed local apuntando al cloud, con retry automático.
pnpm cloud:seed
```

## Estado actual (post-bootstrap 2026-05-08)

| Categoría | Estado | Conteo |
|---|---|---|
| Schema | ✅ Aplicado | 44 tablas + sync_inbox |
| RLS | ✅ Habilitado | 44/44 tablas |
| Migraciones registradas | ✅ | 4 |
| Usuarios (PINs) | ✅ | 3 (Vendedor 0001, Encargada 0002, Julio 0003) |
| Categorías de movimiento | ✅ | 19 |
| Cuentas + Cuentas a cobrar | ✅ | 5 + 8 |
| Listas de precios | ✅ | 5 (Local, Pedidos YA, RAPPI, MELI, DELIVERATE) |
| Categorías de catálogo | ✅ | 9 |
| Tipos de producto | ✅ | 56 |
| Productos | ✅ | 54 |
| Grupos de modificadores | ✅ | 17 |
| Opciones de modificador (sabores) | ✅ | 86 |
| Modificadores aplicables (links) | ✅ | 33 |
| Combos | ⚠ Pendiente — sync agent | 0 |
| Estantería + Bebidas | ⚠ Pendiente — sync agent | 0 |
| Operacional (ventas, pagos, etc.) | ⚠ Vacío — se llena por sync | 0 |

La cloud está **lista para uso** — el bot puede leer el catálogo, hay usuarios para autenticar, cuentas y listas configuradas. Lo pendiente (combos, estantería, códigos cortos finales) lo va a completar el sync agent cuando lo construyamos en la fase 2.

## Sync local → cloud

### Modelo Outbox + Inbox

**Local** (PC encargada): cada operación de write (venta, movimiento, edición
de catálogo) inserta una fila en `outbox_events`:

```sql
INSERT INTO outbox_events (id, topic, payload)
VALUES (gen_random_uuid(), 'venta.creada', '{"id": "...", "total": "..."}');
```

**Cloud**: tabla `sync_inbox` con la misma estructura + estado:

```sql
CREATE TABLE sync_inbox (
  id          UUID PRIMARY KEY,
  topic       VARCHAR(80) NOT NULL,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ DEFAULT now(),
  applied_at  TIMESTAMPTZ,
  status      VARCHAR(16) DEFAULT 'pending',
  error_msg   TEXT,
  retry_count INT DEFAULT 0
);
```

**RPC idempotente** para que el agente publique sin duplicar:

```sql
SELECT apply_sync_event('uuid-here', 'venta.creada', '{...}'::jsonb);
-- Returns true si insertó, false si ya existía.
```

### Sync agent (TODO)

Daemon en la PC de Nancy que cada 30 segundos:

1. SELECT 100 eventos de `outbox_events` con `publicado_at IS NULL`.
2. Para cada uno, llama `apply_sync_event(id, topic, payload)` en la cloud.
3. Si OK, UPDATE `outbox_events SET publicado_at = now()`.
4. Si fail, incrementa `intentos` y guarda `ultimo_error`.

Worker en la cloud (más adelante, en N8N):

1. SELECT eventos de `sync_inbox` con `status = 'pending'`.
2. Aplica el payload a las tablas reales (`ventas`, `movimientos`, etc.).
3. UPDATE `status = 'applied'`.

## Disaster recovery

### Backups automáticos

Supabase Pro hace **backups diarios con retención de 7 días + Point-in-Time
Recovery (PITR) hasta 7 días atrás**. Para usarlos:

1. Dashboard → Database → Backups.
2. Click "Restore" en el snapshot más cercano a la hora deseada.
3. Confirmá — el restore crea un **nuevo proyecto** (no sobrescribe el actual).

**Acción**: Probar el flow de restore una vez para no aprenderlo en una
emergencia. Está documentado en [Supabase Docs - PITR](https://supabase.com/docs/guides/platform/backups#point-in-time-recovery).

### Si la cloud DB se rompe pero la encargada sigue operando

La PC de Nancy es la fuente de verdad — sigue tomando ventas como siempre.
Cuando la cloud vuelva, el sync agent retoma desde `outbox_events.publicado_at
IS NULL` y empuja todo el pendiente.

### Si la PC de Nancy se rompe

1. Recuperar la cloud al estado más reciente (PITR).
2. Reinstalar el `.exe` en una PC nueva.
3. Hacer un dump de la cloud y restore al `pgdata` local antes de operar.
4. Re-arrancar el sync agent en modo "skip outbox" (ya está todo en cloud).

(Falta automatizar este flow — TODO post-MVP).

## Seguridad

### RLS habilitado en todas las tablas

Defense-in-depth. Si alguna vez exponemos el REST API con la `anon` key
(actualmente NO lo hacemos), los datos quedan protegidos por default.

El `service_role` key bypassa RLS — el sync agent y los admin scripts lo
usan. El JWT vive en `.env`, **nunca commiteado**.

### Rotación de secrets

- **Database password**: Settings → Database → "Reset database password".
  Después actualizá `.env` y reiniciá los procesos que conecten (sync agent).
- **Service role key**: Settings → API → roll. Igual.
- **Supabase PAT (para MCP)**: https://supabase.com/dashboard/account/tokens.

Hacelo cada 6 meses como hábito, o inmediatamente si sospechás leak.

## Troubleshooting

### "Tenant or user not found" al conectar al pooler

Username del pooler tiene formato `postgres.PROJECT_REF` (con punto, no `_`).
Y el host tiene número de pool (`aws-0` o `aws-1`) — sacalo del dashboard, no
adivines.

### "password authentication failed for user 'postgres'"

La password en el URL no coincide con la del proyecto. Reset desde el
dashboard y actualizá `.env`. Ojo si la password tiene caracteres especiales
(`@`, `/`, `:`): hacé URL-encode o regenerá una alfanumérica simple.

### Prisma se cuelga al hacer `db push` o `migrate dev`

Esos comandos usan **advisory locks** que requieren session-mode. El pooler
es transaction-mode → no soporta advisory locks → cuelga indefinido.

**Workaround**: usá `pnpm cloud:reset-schema` (drop + recreate desde el
schema.prisma vía pg client directo, sin advisory locks).

### "Can't reach database server" en el medio del seed

Supavisor termina conexiones idle o después de cierto número de queries.
Soluciones:
1. Usar `pnpm cloud:seed` (tiene retry automático).
2. Para sync agent productivo, agregar retry exponencial en cada operación.
