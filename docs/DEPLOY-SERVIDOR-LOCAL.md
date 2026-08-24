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
- [ ] **Si el local tiene 2 internets / 2 routers** (caso Santa Teresita): el
      mini PC va con **una placa de red a cada router** (2 cables). Va a tener
      **una IP por red** (ej. `192.168.1.10` y `192.168.0.10`). Reservá *ambas*
      por MAC, una en cada router. Ver §1.11.

---

## 1. Mini PC (server LAN)  ── ~30 min

### 1.0 Primero: mirar la red real (diagnose-red.ps1)

Antes de instalar nada, corré el diagnóstico — **no cambia nada, sólo lee**:

```powershell
powershell -ExecutionPolicy Bypass -File .\diagnose-red.ps1
# para probar la impresora térmica también:
#   .\diagnose-red.ps1 -PrinterIp 192.168.1.60
```

Genera `red-diagnostico.txt`. Confirmá: cuántas **subredes reales** hay
(sección 3), si cada internet es por **cable o WiFi** (sección 1), y si la
**impresora térmica** cae en una de esas redes (secciones 6/7). Con eso validás
que la estructura es la que pensamos (2 redes) antes de tocar nada.

### 1.1 Prereqs del mini PC (instalar una sola vez)

**Camino fácil (recomendado):** ya está en la carpeta `dist/`. Como
administrador, desde `C:\sta-server\`:

```powershell
powershell -ExecutionPolicy Bypass -File .\bootstrap-mini-pc.ps1
```

Instala **Node 20 LTS + NSSM + PostgreSQL 16** por winget (Postgres en modo
desatendido; te pide inventar la password del superusuario `postgres` —
**anotala**, va al `.env` como `PG_SUPERUSER_PASSWORD`). Si winget no pudiera con
Postgres, el script te avisa para instalarlo a mano y seguir.

**Camino manual** (si preferís control fino):

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
| `DATABASE_URL` | `postgresql://teresita:PASS_FUERTE@127.0.0.1:5432/teresita?schema=public` (password del rol `teresita`) |
| `PG_SUPERUSER_PASSWORD` | Password del superusuario `postgres` (la que pusiste al instalar Postgres / en el bootstrap). El setup la usa para crear el rol/DB y abrir el acceso de red. **No** es la de `teresita`. Si la dejás vacía, el setup te la pregunta. |
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

> 🔒 **Seguridad (muy recomendado): restringí el acceso a las IPs de las cajas.**
> Sin `-CajaIps`, `pg_hba` y el firewall se abren a **toda la subred** — un cliente
> conectado al WiFi del local podría llegar a la base de datos. Pasá las IPs
> exactas de las cajas para limitarlo a ellas (y de paso el acceso queda scopeado
> al rol/DB de la app, no al superusuario):
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\setup-mini-pc.ps1 -CajaIps "192.168.1.21","192.168.1.22","192.168.0.21"
> ```
> Reservá esas IPs fijas en cada router. Aun así, lo ideal es que las cajas estén
> en una **VLAN/SSID separado** del WiFi de clientes.

El script es idempotente (se puede re-correr). Hace:

1. Verifica prereqs (Node, psql, postgres service, NSSM).
2. Crea rol + DB `teresita` si no existen (usa `PG_SUPERUSER_PASSWORD`).
3. **Configura el acceso de red de Postgres**: `listen_addresses='*'` +
   una línea en `pg_hba.conf` por **cada subred LAN detectada** (soporta el
   mini PC con 2 placas / 2 internets), y recarga Postgres. Sin esto las
   cajas no pueden conectarse al 5432.
4. Aplica migraciones SQL pendientes (tracking en `_prisma_migrations` — **no**
   usa `prisma migrate dev`, ver gotcha CLAUDE.md).
5. Seed solo si la DB está vacía (primer arranque). Crea usuarios default
   con PINs `0001`/`0002`/`0003`.
6. Registra el Windows Service `sta-server` (Node, auto-start, recovery,
   depende de Postgres). El service **arranca sin login/UAC** — headless.
7. Abre el firewall para 5432 y 3001 en **todas las subredes LAN** detectadas.

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
(reserva DHCP por MAC, o IP estática). Con 2 internets vas a ver **2 IPs**
(una por red) — el `setup-mini-pc.ps1` también las lista al final. Ver §1.11.

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

### 1.11 Caso 2 internets / 2 redes (infra de Santa Teresita)

El local tiene **2 internets con 2 routers independientes**: algunas PCs
cuelgan de un router y otras del otro. Esto se resuelve haciendo el mini PC
**multi-homed**: una placa de red a cada router.

**Cómo funciona:**

- El mini PC obtiene **una IP en cada red** (ej. `192.168.1.10` en la red A,
  `192.168.0.10` en la red B). Es el mismo server físico, una sola DB.
- La API ya escucha en `0.0.0.0` (todas las placas), y `setup-mini-pc.ps1`
  configura `pg_hba.conf` + el firewall para **ambas subredes**. Resultado:
  una caja de la red A le pega por `192.168.1.10` y una de la red B por
  `192.168.0.10` — al mismo Postgres.
- El server es el **centro de la estrella**: las cajas no necesitan verse entre
  sí (aunque estén en redes distintas), sólo ver al server, que está en las dos.

**Qué tenés que hacer vos:**

1. Conectá las dos placas del mini PC, una a cada router.
2. Reservá la IP del mini PC **en cada router** (DHCP reservation por MAC), para
   que ninguna de las dos cambie.
3. Corré `setup-mini-pc.ps1` normal. Al final imprime **las dos IPs**.
4. En cada caja, poné en `lanDbUrl` la IP del server **de la red a la que esa
   caja está conectada** (ver §2.1).

**Sobre el "salto" de internet:** que el server tenga las dos internets le da
redundancia para el **backup a la nube** (replicator → Supabase), que es
asincrónico y no crítico — si una internet se cae, Windows rutea por la otra y,
si el backup se atrasa unos minutos, se pone al día solo. No es un failover
*seamless* perfecto (eso sería un router dual-WAN), pero para el backup alcanza
de sobra. Lo importante — que las cajas lleguen al server — está cubierto por el
multi-homing de arriba.

**Si el diagnóstico mostró subredes distintas a lo esperado** (o la
auto-detección falló), forzalas a mano — sin reinstalar todo:

```powershell
.\setup-mini-pc.ps1 -NetworkOnly -Subnets "192.168.1.0/24","192.168.0.0/24"
```

`-NetworkOnly` sólo rehace la red (pg_hba + firewall), en segundos, sin tocar la
DB ni el service. Útil para corregir si algo de red quedó mal.

**La impresora térmica en otra subred:** justamente por estar en otra IP, una PC
de la otra red no la alcanzaba. El mini PC, al estar en **las dos redes**, sí la
alcanza. Verificalo con `-PrinterIp` (en `diagnose-red.ps1` o en el setup). Si el
server la ve, centralizar la impresión por el server resuelve ese problema.

---

## 1.5 Excel de la encargada desde Google Drive  ── ~15 min, una sola vez

**Esto ya no se hace en S1.** La API habla con Google Drive directamente (API
oficial, service account), así que los archivos no tienen que estar en ningún
disco: los lee y los escribe la API que esté corriendo, sea la de Railway, la de
S1 o la que empaqueta el `.exe`. Se configura **una vez, en la nube**, y las tres
quedan servidas.

> Lo que había antes —rclone bajando los archivos a `C:\sta\excel` cada 10
> minutos + `EXCEL_LOCAL_DIR`— quedó **obsoleto**. Si S1 todavía tiene la tarea
> `STA-Excel-Sync`, ver "Desmontar rclone" al final. `EXCEL_LOCAL_DIR` sigue
> existiendo, pero sólo como fallback de desarrollo.

### Por qué la API y no una carpeta sincronizada

Tres problemas se cierran de una:

- **El writeback funciona.** rclone bajaba en UNA dirección: lo que S1
  escribiera en el CASHFLOW lo pisaba el ciclo siguiente, sin error. Con la API
  se edita el archivo vivo, y Drive guarda historial de versiones.
- **No depende de una máquina.** La feature andaba sólo en S1 y sólo si el mini
  PC estaba prendido. Ahora la sirve cualquier instancia de la API.
- **No hay sesión de usuario de por medio.** Drive para Escritorio monta la
  unidad por sesión interactiva y un servicio NSSM (LocalSystem) no la ve. La
  service account no tiene sesión: es una credencial.

### Crear la service account

En [Google Cloud Console](https://console.cloud.google.com):

1. Proyecto nuevo (o el que ya usabas para rclone).
2. **APIs y servicios → Biblioteca → Google Drive API → Habilitar.**
3. **Credenciales → Crear credenciales → Cuenta de servicio.** Nombre libre
   (ej. `sta-excel`). Sin roles: los permisos salen de compartir los archivos,
   no de IAM.
4. Entrar a la cuenta creada → **Claves → Agregar clave → Crear nueva → JSON.**
   Se baja un `.json`. **Ese archivo es la credencial: no va al repo.**

No hace falta pantalla de consentimiento, ni publicar la app, ni renovar nada a
los 7 días — todo eso era del flujo OAuth de usuario que usaba rclone.

### Compartir los archivos con ella

El `.json` tiene un campo `client_email`, algo como
`sta-excel@<proyecto>.iam.gserviceaccount.com`. **Ese mail es un usuario más de
Drive.** Hay que compartirle la carpeta donde están los Excels:

- Si la carpeta es tuya: clic derecho → Compartir → pegar el `client_email`.
  **Editor** (necesita escribir el CASHFLOW y las deudas de proveedores), no
  Lector.
- Si los archivos son de la encargada: que ella comparta **la carpeta** con ese
  mail, también como Editor.

El **id de la carpeta** es lo que va después de `/folders/` en su URL:
`https://drive.google.com/drive/folders/`**`1AbC…XyZ`**.

> Una service account no tiene Drive propio y **no puede crear archivos sueltos**
> en una carpeta ajena de Mi unidad sin cuota. Acá sólo lee y sobreescribe
> archivos que ya existen, que sí puede.

### Setear las dos variables

En **Railway** (Variables del servicio de la API) — y en el `.env` de S1 si
querés que también funcione ahí:

| Variable | Valor |
|-|-|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | el contenido del `.json` entero (o el mismo en base64, si el panel se pelea con los saltos de línea) |
| `GOOGLE_DRIVE_FOLDER_ID` | el id de la carpeta |

**Nunca en el repo, nunca en un chat.** Es una credencial: quien la tenga entra
a todo lo que esté compartido con esa cuenta.

En S1, además, acordate de que la variable va en `C:\sta-server\.env` y después
`C:\sta-server\update-server.ps1 -SyncEnv` — `update-server.ps1` re-sincroniza
el bloque de NSSM desde `.env` en cada actualización, así que una variable puesta
con `nssm set` directo desaparece en la tarea de las 4 AM sin dejar rastro.

**Media configuración es un error, no un fallback.** Si está una sola de las dos,
la API responde **503 diciendo cuál falta**. Es a propósito: la alternativa era
leer calladamente un archivo local viejo y que todos los números salieran
desactualizados sin ningún síntoma.

### Verificación

```
GET /admin/excel/origen     (con token de ADMIN)
```

Devuelve el origen que está usando, el `client_email` —para saber a quién
compartirle si algo no aparece—, el id de carpeta y, archivo por archivo, si lo
encuentra. Es la forma rápida de distinguir "falta la credencial" de "el archivo
no está compartido" de "el nombre no coincide".

### Notas

- **`Proveedores 2026` es una hoja nativa de Google, no un `.xlsx`.** Se exporta
  al vuelo al bajarla, así que para leer da igual. Para **escribir** no: una hoja
  nativa no se puede pisar con bytes de xlsx, y el intento devuelve un error
  claro en vez de romper el archivo. Si hiciera falta escribirla, hay que
  convertirla a `.xlsx` en Drive (Archivo → Descargar → subir el resultado).
- **El nombre en Drive tiene que ser exacto.** Se prueba con y sin `.xlsx`, pero
  un "Copia de Proveedores 2026" no lo encuentra.
- **El writeback del CASHFLOW se habilita solo cuando el origen es Drive.** En
  disco sigue apagado por default (`EXCEL_CASHFLOW_ESCRITURA`), porque ahí sí
  puede pisar una copia que nadie sincroniza.
- **El sync/aprobación de precios NO migró.** `excel-sync.ts` shellea parsers
  Python contra un path de disco; sigue necesitando `EXCEL_LOCAL_DIR` + python +
  openpyxl, y por eso hoy sólo corre donde eso exista. Es el pendiente #2 del
  CLAUDE.md.

### Desmontar rclone (si S1 lo tiene)

```powershell
schtasks /delete /tn "STA-Excel-Sync" /f
# y sacar la línea EXCEL_LOCAL_DIR de C:\sta-server\.env, después:
C:\sta-server\update-server.ps1 -SyncEnv
```

Dejar `C:\sta\rclone` y `C:\sta\excel` no molesta, pero conviene borrar
`rclone.conf`: tiene un refresh token de Drive con acceso de lectura a lo que
haya compartido esa cuenta.

## 2. Cajas (`.exe`)  ── ~5 min por caja

En cada PC de caja, una vez que el server está vivo:

### 2.1 Cerrar el `.exe` y editar el config

```powershell
# Cerrar Santa Teresita.exe completamente (verificar en Administrador de tareas)
notepad "$env:APPDATA\Santa Teresita\config.json"
```

Contenido **recomendado** (modo proxy, sin credenciales de base en la caja):

```json
{
  "rol": "caja",
  "lanApiUrl": "http://192.168.1.10:3001",
  "cloudApiUrl": "https://<tu-api>.up.railway.app",
  "webRemoteUrl": "https://sta-desktop.vercel.app"
}
```

- `lanApiUrl` = IP del mini PC + **puerto 3001** (el API, no Postgres). **Si hay
  2 redes (§1.11):** la IP del server **de la red a la que está conectada ESA
  caja**.
- `cloudApiUrl` = opcional. Solo para que las **lecturas** sigan vivas si S1 no
  responde; las escrituras nunca van ahí, se encolan en el outbox local.
- `webRemoteUrl` = Vercel (o `""` para usar el web bundleado del `.exe`).

Con esto la caja levanta `proxy.mjs` en vez de la API completa: **no recibe
`DATABASE_URL` ni ninguna password de Postgres**. Todo pasa por el API de S1,
que es el único que habla con la base. Es el pendiente de seguridad **C4**.

Para la caja el cambio es invisible: la web y el agente de impresión siguen
hablando a `127.0.0.1:3001`, y el outbox sigue en el mismo lugar.

<details>
<summary>Modo viejo (con credenciales de base en la caja)</summary>

```json
{
  "rol": "caja",
  "lanDbUrl": "postgresql://teresita:LA_MISMA_PASS@192.168.1.10:5432/teresita?schema=public",
  "cloudDbUrl": "postgresql://postgres.<REF>:PASS@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1",
  "webRemoteUrl": "https://sta-desktop.vercel.app"
}
```

Sigue funcionando, pero pone la password del Postgres en cada PC del local:
cualquiera con acceso a una caja puede leer y escribir la base entera saltándose
las reglas de negocio. Si `lanApiUrl` está presente, **gana** sobre `lanDbUrl`
— así se puede migrar caja por caja sin borrar la config vieja de golpe.

</details>

- `lanDbUrl` = IP del mini PC + password del rol `teresita` (la del `.env`
  del server). **Si hay 2 redes (§1.11):** usá la IP del server **de la red a la
  que está conectada ESA caja** (las de la red A → `192.168.1.10`; las de la red
  B → `192.168.0.10`).
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

## 7. Actualizaciones del server (remotas, sin AnyDesk)

El mini PC se auto-actualiza desde **GitHub Releases** (`server-v*`). Dos canales,
ambos los registra `update-server.ps1 -Install` (una sola vez en el server):

| Canal | Tarea programada | Cuándo aplica | Para qué |
|-|-|-|-|
| **Nocturno** | `STA Server Update` (4 AM diaria) | cualquier release nuevo | deploy normal, sin interrumpir ventas |
| **Inmediato** | `STA Server Update NOW` (cada 5 min) | solo releases marcados `--now` | hotfix urgente, entra en ~5 min |

### Publicar una actualización (desde tu PC de dev)

```bash
# 1. Bumpeá la versión (el tag server-v<version> debe ser único)
#    apps/server/package.json  →  "version": "1.1.0"

# 2a. Deploy NORMAL → el server lo aplica a las 4 AM
pnpm --filter @sta/server release

# 2b. Deploy INMEDIATO → el server lo aplica en ~5 min (sin AnyDesk)
pnpm --filter @sta/server release -- --now
```

`--now` agrega el token `STA_DEPLOY_NOW` al body del release. La tarea de 5 min
corre en modo `-Now` y **solo** aplica releases con ese marcador; los releases
normales los ignora (los toma la tarea de las 4 AM). Así un push no reinicia el
server en pleno servicio salvo que vos lo decidas.

### Qué hace el updater en cada corrida

1. `pg_dump` de backup (quedan los últimos 10 en `backups\`).
2. Para el servicio, reemplaza `api/ migrations/ seed/` **y los `.ps1`** (se
   auto-actualiza), **conserva `.env` y la DB**.
3. **Re-sincroniza el env de NSSM desde `.env`** (ver nota abajo).
4. Aplica migraciones nuevas, reinicia, verifica `/health` (15 reintentos).
5. Si algo falla → **ROLLBACK** automático al código anterior.

Lock anti-solapamiento (`update.lock`) + `MultipleInstances IgnoreNew` evitan que
la nocturna y la inmediata corran a la vez.

### Forzar / operar a mano (en el server, `C:\sta-server`)

```powershell
.\update-server.ps1            # aplica la última si hay versión nueva
.\update-server.ps1 -Force     # reinstala la última aunque sea la misma (re-deploy/recovery)
.\update-server.ps1 -SyncEnv   # re-sincroniza NSSM env desde .env y reinicia (sin update)
.\update-server.ps1 -Install   # (re)registra las 2 tareas programadas
```

### Nota sobre `.env` y NSSM

NSSM **congela** las variables de entorno al registrar el servicio
(`AppEnvironmentExtra`). El API lee `dist\.env` con `dotenv`, pero `dotenv` **no
pisa** lo que NSSM ya inyectó en `process.env` → editar `.env` y reiniciar **no
alcanza** (incidente real: el replicador quedó en `null`). Por eso el updater
re-pushea `.env` a NSSM en cada corrida, y existe `.\update-server.ps1 -SyncEnv`
para aplicar un cambio de `.env` al instante sin esperar un release.

> **Bootstrap (una sola vez):** el updater instalado hoy (v1.0.0) no tiene el
> canal inmediato ni el re-sync. Para activarlos hay que correr **una vez** en el
> server, vía AnyDesk: copiar el nuevo `update-server.ps1` y ejecutar
> `.\update-server.ps1 -Install`. De ahí en más el updater se auto-actualiza solo
> (copia los `.ps1` nuevos en cada release) → no se vuelve a tocar el server a mano.

---

## 8. Apéndice: estructura de archivos

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

## 9. Referencias

- Diseño y rationale: [`SERVIDOR-LOCAL.md`](SERVIDOR-LOCAL.md)
- Gotchas (invariantes que NO romper): [`../CLAUDE.md`](../CLAUDE.md) sección
  "Invariantes / gotchas"
- Paquete del server: [`../apps/server/README.md`](../apps/server/README.md)
- DB cloud (Supabase): [`CLOUD-DB.md`](CLOUD-DB.md)
