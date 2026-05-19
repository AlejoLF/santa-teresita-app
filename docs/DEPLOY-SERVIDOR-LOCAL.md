# Deploy del servidor local — playbook

Guía paso a paso para desplegar el servidor local LAN + cajas con failover +
PWA del corte. Pensada para abrir cuando vayas a hacerlo y seguirla en orden.

Diseño y rationale: [`SERVIDOR-LOCAL.md`](SERVIDOR-LOCAL.md). Esta guía es
**solo operación**.

## Resumen de qué se despliega

3 piezas, en este orden:

1. **Mini PC (server LAN)** — Postgres + API + replicator. Es la fuente de
   verdad. Headless.
2. **Cajas (`.exe`)** — Solo cambia un archivo de config en cada una para que
   apunten al server LAN + tengan failover a Supabase.
3. **PWA `apps/mobile` en Vercel** — La app que se usa **solo durante un
   corte de luz** (celular/tablet con batería + datos móviles).

Al final hay una **verificación end-to-end** que confirma que todo funciona,
incluida la simulación del corte completo.

---

## 0. Antes de empezar (5 min)

Verificá:

- [ ] Migración aplicada en Supabase (ya está hecho — `cerrada_anticipadamente`,
      `perf_indexes`, `audit_origen`). Confirmá con: `pnpm cloud:status` desde
      tu PC de dev.
- [ ] El pooler de Supabase es `aws-1-sa-east-1` (NO aws-0 — ver gotcha CLAUDE.md).
- [ ] Tenés el `AUTH_SECRET` y el `AUDIT_HASH_SALT` del sistema actual (los del
      `.exe`/Vercel hoy). Los necesitás idénticos en server y en Vercel.
- [ ] Decidiste la IP fija del mini PC en la LAN (típicamente `192.168.1.10`).
      Reservala en el router por MAC del mini PC.

---

## 1. Mini PC (server LAN)  ── ~30 min

### 1.1 Prereqs del mini PC (instalar una sola vez)

En el mini PC, como administrador:

```powershell
# Postgres 16 — descargá el instalador oficial de https://www.postgresql.org
# Anotá la password del superusuario `postgres`.
# Asegurate que el service `postgresql-x64-16` quede Automatic.

# Node 20 LTS
winget install OpenJS.NodeJS.LTS

# NSSM (para Windows Services)
winget install NSSM.NSSM
```

Verificá:

```powershell
node -v        # v20.x o más
psql --version # 16.x
nssm --help    # debería responder
Get-Service postgresql-x64-16    # Status=Running, StartType=Automatic
```

### 1.2 Buildear el paquete `apps/server` (en tu PC de dev)

```powershell
cd "ruta\a\SANTA TERESITA APP"
pnpm install
pnpm --filter @sta/server build
```

Produce `apps/server/dist/` autocontenido (~50-100 MB) con la API bundleada,
node_modules, Prisma client+engine, las migraciones SQL, el seed, el
`setup-mini-pc.ps1` y este README.

### 1.3 Copiar `dist/` al mini PC

Por USB, red, o `git clone` + build ahí mismo. La carpeta `dist/` es 100%
autocontenida — no depende del `.exe` ni del repo.

Sugerido: `C:\sta-server\` en el mini PC.

### 1.4 Configurar `.env` en el mini PC

```powershell
cd C:\sta-server
copy .env.example .env
notepad .env
```

Completar (los **críticos**):

| Var | Valor |
|-|-|
| `DATABASE_URL` | `postgresql://teresita:PASS_FUERTE@127.0.0.1:5432/teresita?schema=public` |
| `REPLICATE_TO_URL` | URL del pooler **aws-1** de Supabase (con `?pgbouncer=true&connection_limit=1`). Si lo dejás vacío, el replicator no arranca (no hay backup a la nube). |
| `AUTH_SECRET` | **EL MISMO** valor que usan hoy las cajas / Vercel. Si lo cambiás se invalidan todas las sesiones. |
| `AUDIT_HASH_SALT` | **EL MISMO** que el resto del sistema. Si difiere se rompe el hash-chain del audit. |
| `API_CORS_ORIGINS` | `https://sta-desktop.vercel.app` (+ otros orígenes si los hay) |
| `TZ` | `America/Argentina/Buenos_Aires` (no cambiar) |

> ⚠ **Importante**: `AUTH_SECRET` y `AUDIT_HASH_SALT` deben ser **idénticos** en
> 3 lados: el server local, el `.exe` de cada caja, y la PWA en Vercel.

### 1.5 Provisionar (instala Postgres DB + servicios + firewall)

Desde **PowerShell como administrador**:

```powershell
cd C:\sta-server
powershell -ExecutionPolicy Bypass -File .\setup-mini-pc.ps1
```

El script es idempotente (se puede re-correr). Hace:

1. Verifica prereqs (Node, psql, postgres service, NSSM).
2. Crea rol + DB `teresita` si no existen.
3. Aplica migraciones SQL pendientes (tracking en `_prisma_migrations` — **no**
   usa `prisma migrate dev`, ver gotcha CLAUDE.md).
4. Seed solo si la DB está vacía (primer arranque). Crea usuarios default
   con PINs `0001`/`0002`/`0003`.
5. Registra el Windows Service `sta-server` (Node, auto-start, recovery,
   depende de Postgres). El service **arranca sin login/UAC** — headless.
6. Abre el firewall para 5432 y 3001 **solo en la subred LAN**.

### 1.6 Configurar NTP en el mini PC (importante)

Las fechas de sesión dependen de la TZ del proceso (ver gotcha CLAUDE.md).
Verificá:

```powershell
w32tm /query /status
w32tm /resync
```

### 1.7 Verificar el server arrancó OK

```powershell
Get-Service postgresql-x64-16, sta-server
# Ambos Status=Running, StartType=Automatic

curl http://localhost:3001/health
# {"ok":true, ... "dbState":"PRIMARY", ...}

curl http://localhost:3001/api/v1/sync/status
# {"pending":0, "abandoned":0, "rol":"server", "replicacion": {...}}
```

`replicacion.pendientes` debería ser bajo (drena solo). Si crece sin bajar,
revisar `C:\sta-server\logs\sta-server.err.log` (típicamente: Supabase URL mal
o sin conexión a internet).

### 1.8 Anotar la IP del mini PC

```powershell
ipconfig | findstr "IPv4"
```

Esa IP la necesitás para configurar las cajas. Asegurate que esté fija
(reserva DHCP por MAC, o IP estática).

### 1.9 Acceso remoto admin (opcional pero recomendado)

Habilitá RDP o OpenSSH para mantener el server sin conectarle monitor:

```powershell
# OpenSSH
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic
Start-Service sshd
New-NetFirewallRule -DisplayName "SSH (LAN)" -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^127\.' } | Select-Object -First 1 -ExpandProperty IPAddress) -Action Allow
```

### 1.10 UPS (recomendado)

Un UPS chico en el mini PC. Razón: evita reinicios por parpadeos y, en un
corte real, da tiempo a que Postgres haga shutdown limpio (sin esto, riesgo
de corrupción del WAL). Sin UPS igual funciona, pero el UPS elimina la peor
clase de problema.

---

## 2. Cajas (`.exe`)  ── ~5 min por caja

En cada PC de caja, una vez que el server está vivo:

### 2.1 Cerrar el `.exe` y editar el config

```powershell
# Cerrar Santa Teresita.exe completamente (verificar en Administrador de tareas)
notepad "$env:APPDATA\Santa Teresita\config.json"
```

Contenido:

```json
{
  "rol": "caja",
  "lanDbUrl": "postgresql://teresita:LA_MISMA_PASS@192.168.1.10:5432/teresita?schema=public",
  "cloudDbUrl": "postgresql://postgres.<REF>:PASS@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1",
  "webRemoteUrl": "https://sta-desktop.vercel.app"
}
```

- `lanDbUrl` = IP del mini PC + password del rol `teresita` (la del `.env`
  del server).
- `cloudDbUrl` = pooler **aws-1** de Supabase.
- `webRemoteUrl` = Vercel (o `""` si querés usar el web bundleado del `.exe`).

### 2.2 Reabrir el `.exe`

Al boot leerá el config y arrancará en modo "caja con failover":

- Modo normal → escribe al Postgres del mini PC (LAN, rápido).
- Si el mini PC se cuelga (pero hay luz) → la UI lee de Supabase mirror y
  los writes van al `outbox.sqlite` local. Al volver el LAN, se sincronizan
  solos.

### 2.3 Verificar en cada caja

```powershell
curl http://127.0.0.1:3001/health
# {"ok":true, ... "dbState":"PRIMARY"}     ← LAN está OK

curl http://127.0.0.1:3001/api/v1/sync/status
# {"pending":0, ..., "rol":"caja", "replicacion":null}
```

Si `dbState=DEGRADED`, el `.exe` no ve al server LAN — revisar IP, firewall
del mini PC, o que el service `sta-server` esté Running.

### 2.4 Repetir para todas las cajas

Mismo procedimiento. Cada caja queda independiente con su propio
`outbox.sqlite` (resiliencia individual).

---

## 3. PWA del corte de luz (Vercel)  ── ~15 min

La PWA `apps/mobile` se usa **solo durante un corte de luz**. Es la única
vía para seguir vendiendo cuando el mini PC y las cajas están apagadas.

### 3.1 Deploy a Vercel

Si es la primera vez:

```bash
cd "ruta/a/SANTA TERESITA APP"
npx vercel --cwd apps/mobile
```

Seguir el wizard. Settings sugeridos:
- Framework: Next.js (auto-detecta).
- Root Directory: `apps/mobile`.
- Build command: `pnpm install --frozen-lockfile && pnpm --filter @sta/mobile build` (o el default).

### 3.2 Env vars en Vercel (críticas)

En el dashboard de Vercel → Settings → Environment Variables del proyecto
`sta-mobile` (o como lo llames):

| Var | Valor |
|-|-|
| `SUPABASE_DB_URL_POOLED` | Pooler **aws-1** de Supabase (`postgresql://postgres.<REF>:PASS@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1`) |
| `AUTH_SECRET` | **EL MISMO** que el server y las cajas. |
| `AUDIT_HASH_SALT` | **EL MISMO** que el resto del sistema. |

> ⚠ Si `AUDIT_HASH_SALT` falta en Vercel, la PWA igual registra las ventas
> del corte (con un hash sentinel `NO_SALT_CLOUD`). El catch-up del server
> las re-chainea con el salt local al absorberlas — no se pierde nada,
> pero la copia de Supabase no es verificable standalone hasta que se setee.

### 3.3 Anotar la URL pública

Algo como `https://sta-mobile-xxx.vercel.app`. Esa es la que abren en el
celular/tablet durante un corte.

### 3.4 Instalar la PWA en celular/tablet

Abrir la URL en Chrome (Android) o Safari (iOS), login con PIN, y "Agregar a
pantalla de inicio" desde el menú del browser. Queda como app nativa.

### 3.5 (Opcional) Custom domain

Si querés una URL más prolija (ej. `app.santateresita.com.ar`) configurás un
domain custom en Vercel. No es necesario para funcionar.

---

## 4. Verificación end-to-end  ── ~20 min

### 4.1 Test del flujo normal (LAN_OK)

En una caja: cargar un pedido, cobrar.

```powershell
# En el mini PC, verificar que la venta llegó:
psql -h 127.0.0.1 -U teresita -d teresita -c "SELECT numero, total, estado, fecha_finalizacion FROM ventas ORDER BY fecha_finalizacion DESC LIMIT 3"

# Verificar que el replicator la mandó a Supabase (puede tardar unos segundos):
curl http://localhost:3001/api/v1/sync/status
# replicacion.pendientes debería volver a 0 después del drain
```

### 4.2 Test del failover A — mini PC colgado, hay luz

Simulación:

```powershell
# En el mini PC, parar el service del API (NO Postgres):
Stop-Service sta-server
```

En la caja: cargar otro pedido y cobrar.

- En la UI debería aparecer "guardado localmente, se sincroniza solo".
- El pedido queda en `outbox.sqlite` de la caja.

Reanudar:

```powershell
# En el mini PC:
Start-Service sta-server
```

En ~5 segundos el `outbox-flusher` de la caja drena el pedido contra el
server. Verificá en `psql` que aparece.

### 4.3 Test del corte de luz (failover B)

Simulación más drástica (idealmente en un horario tranquilo):

1. Apagar el mini PC.
2. Apagar las cajas (o desconectarlas de la LAN).
3. En el celular/tablet con datos móviles (NO WiFi del local), abrir la URL
   de Vercel, loguear con PIN.
4. Cargar un pedido y cobrar **desde la PWA**.
5. La venta queda en Supabase con `audit_log.origen='cloud'`.

Volver la luz:

```powershell
# Encender el mini PC. Esperar ~30 s.
# Verificar:
Get-Service postgresql-x64-16, sta-server     # Ambos Running
curl http://localhost:3001/health              # dbState=PRIMARY

# Logs del catch-up:
Get-Content C:\sta-server\logs\sta-server.out.log -Tail 20 | Select-String "catch-up"
# Debería ver: "[catch-up] absorbiendo N ventas creadas durante el corte..."
# Y luego: "[catch-up] ✓ catch-up: N ventas del corte absorbidas y re-chaineadas"
```

Verificar que la venta de la PWA está ahora en el local:

```sql
SELECT v.numero, v.total, a.origen, a.secuencia_origen
FROM ventas v
JOIN audit_log a ON a.registro_id = v.id::text AND a.tabla = 'ventas'
WHERE a.origen = 'cloud'
ORDER BY v.fecha_finalizacion DESC;
```

Si aparece la venta del paso 4 acá → ✅ el catch-up funciona.

Encender las cajas, abrir el `.exe`, login. Deberían ver la venta del corte
en el historial.

---

## 5. Troubleshooting

### "El `.exe` no se conecta al server LAN"

```powershell
# En la caja:
Test-NetConnection 192.168.1.10 -Port 5432    # ¿llega al Postgres?
Test-NetConnection 192.168.1.10 -Port 3001    # ¿llega al API?
```

Si TCP no conecta:
- Firewall del mini PC bloquea (el setup script abrió SOLO la subred LAN —
  confirmá que la caja está en la misma subred).
- IP del mini PC cambió (no era fija). Re-fijar.
- Service `sta-server` no Running.

### "Hash-chain mismatch al verificar"

Causa más probable: `AUDIT_HASH_SALT` no es igual en server, cajas y Vercel.
Comparar los 3 lados y unificar.

### "El catch-up no encuentra las ventas del corte"

```sql
-- En Supabase, ver si las ventas de la PWA tienen audit cloud:
SELECT COUNT(*) FROM audit_log WHERE origen = 'cloud';

-- En el local, ver si ya las absorbió:
SELECT COUNT(*) FROM audit_log WHERE origen = 'cloud';
```

Si Supabase tiene >0 y local tiene 0, el catch-up no se disparó:
- Verificar `STA_ROLE=server` en `.env`.
- Verificar `REPLICATE_TO_URL` está seteado y accesible desde el mini PC.
- Mirar `C:\sta-server\logs\sta-server.err.log` (mensajes de `[catch-up]`).

### "Postgres no arranca tras un corte de luz brusco"

Posible corrupción del WAL. Recuperación:

```powershell
# Detener el service
Stop-Service postgresql-x64-16
# Ver el log
notepad "C:\Program Files\PostgreSQL\16\data\log\postgresql-*.log"
# Postgres tiene crash recovery automático en el siguiente start;
# normalmente con re-arrancar el service alcanza:
Start-Service postgresql-x64-16
```

Si no levanta, restaurar del backup más reciente (`pg_dump` diario que
configuraste en §6 — si no lo hiciste, lo importante para reconstruir está
en Supabase: el replicator mantuvo el mirror al día).

### "Service `sta-server` no arranca"

```powershell
Get-Content C:\sta-server\logs\sta-server.err.log -Tail 50
```

Causas frecuentes:
- `DATABASE_URL` con password incorrecta → Postgres rechaza.
- `AUTH_SECRET`/`AUDIT_HASH_SALT` con < min chars → validación zod falla.
- Puerto 3001 ocupado por otro proceso.

---

## 6. Backups

El backup off-site ya existe: el **replicator mantiene Supabase al día** con
todo lo del local. Si el mini PC se incendia, Supabase tiene todo hasta el
último write replicado.

Adicional recomendado (defensa en profundidad): `pg_dump` diario a un disco
externo. Tarea programada de Windows:

```powershell
# Crear tarea programada que corre cada día a las 4 AM
$action = New-ScheduledTaskAction -Execute 'pg_dump' -Argument '-h 127.0.0.1 -U teresita -d teresita -F c -f E:\backups\teresita-$(Get-Date -Format yyyy-MM-dd).dump'
$trigger = New-ScheduledTaskTrigger -Daily -At 4am
Register-ScheduledTask -TaskName "STA pg_dump diario" -Action $action -Trigger $trigger -RunLevel Highest
```

---

## 7. Apéndice: estructura de archivos

```
C:\sta-server\                          ← el server LAN
  api\server.mjs + node_modules\        API + Prisma + engine + better-sqlite3
  migrations\*.sql                      todas las migraciones (orden cronológico)
  seed\seed.mjs + seed-data\            seed (solo se corre si DB vacía)
  .env                                  config local (passwords, AUTH_SECRET, etc.)
  .env.example                          template
  setup-mini-pc.ps1                     provisión (idempotente)
  logs\sta-server.{out,err}.log         logs del service (rotan a 10 MB)
  README.md                             apuntador a este doc

%APPDATA%\Santa Teresita\config.json    ← en cada caja
  { rol, lanDbUrl, cloudDbUrl, webRemoteUrl }

Vercel (apps/mobile)                    ← la PWA del corte
  Env: SUPABASE_DB_URL_POOLED, AUTH_SECRET, AUDIT_HASH_SALT
```

## 8. Referencias

- Diseño y rationale: [`SERVIDOR-LOCAL.md`](SERVIDOR-LOCAL.md)
- Gotchas (invariantes que NO romper): [`../CLAUDE.md`](../CLAUDE.md) sección
  "Invariantes / gotchas"
- Paquete del server: [`../apps/server/README.md`](../apps/server/README.md)
- DB cloud (Supabase): [`CLOUD-DB.md`](CLOUD-DB.md)
