# Deploy de N8N en S1 — lectura automática de facturas

Deja corriendo en S1 (mini PC) el N8N con el workflow que lee facturas por foto
(Telegram → LlamaExtract → `POST /ingest/facturas`). La factura nace en
**PENDIENTE_VALIDACION**: un humano la revisa y acepta en `/admin/facturas`.
**No mueve plata.**

Archivos: [`infra/n8n/docker-compose.yml`](../../infra/n8n/docker-compose.yml) ·
[`workflow-facturas.json`](workflow-facturas.json) (importable) ·
contrato/diseño en [`BUILD-facturas-llamaextract.md`](BUILD-facturas-llamaextract.md).

---

## 0. Lo que necesitás tener a mano
- **Bot de Telegram**: creá uno con **@BotFather** (`/newbot`) → guardá el **token**.
- **LlamaCloud**: cuenta en https://cloud.llamaindex.ai → **API Key** (`llx-...`) +
  el **Project ID** (uuid, está en la URL del proyecto).
- **INGEST_API_TOKEN**: un token de máquina de 32+ chars (lo generamos abajo).

---

## 1. Habilitar el endpoint de ingesta en el sta-server (S1)
El endpoint `POST /ingest/facturas` responde **503** si no está el token. En S1:

1. Generá un token (PowerShell):
   ```powershell
   -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})
   ```
2. Agregalo al `.env` del server (donde está `DATABASE_URL`, `AUTH_SECRET`, etc.):
   ```
   INGEST_API_TOKEN=<el token generado>
   ```
3. Reiniciá el `sta-server` (servicio/.exe del server) para que lo tome.
4. Probá que dejó de dar 503 (debería dar 401 sin token, lo cual confirma que está vivo):
   ```powershell
   curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://localhost:3001/api/v1/ingest/facturas
   ```

## 2. Levantar N8N con Docker
Requiere **Docker** en S1 (`docker --version`). Si no está, ver §2-bis (sin Docker).
1. Copiá la carpeta `infra/n8n/` a S1 (o cloná el repo).
2. `cd infra/n8n` → `copy .env.example .env` (lo completamos en §3).
3. Levantalo:
   ```powershell
   docker compose up -d
   docker compose logs -f   # ver que arranque; Ctrl+C para salir
   ```
4. Abrí **http://localhost:5678** → creá la cuenta dueño de n8n (email + password).

### 2-bis. Sin Docker (alternativa con Node)
Si no querés/poder Docker, n8n corre con Node (S1 ya tiene Node):
```powershell
npm install -g n8n
# Persistente como servicio: usar nssm (https://nssm.cc) apuntando a n8n, o una
# Tarea Programada "al iniciar sesión" que corra:  n8n start
$env:GENERIC_TIMEZONE='America/Argentina/Buenos_Aires'; $env:N8N_SECURE_COOKIE='false'; n8n start
```
(En este modo, en el workflow usá `STA_API_URL = http://localhost:3001` — sin Docker no hace falta `host.docker.internal`.)

## 3. Exponer N8N para el webhook de Telegram (Tailscale Funnel)
Telegram necesita una URL pública HTTPS para llamar al webhook del Trigger. Como
S1 ya tiene **Tailscale**, lo exponemos sin abrir puertos en el router:
```powershell
tailscale funnel --bg 5678
tailscale funnel status   # te muestra la URL https://s1.<tailnet>.ts.net
```
- Poné esa URL en `infra/n8n/.env`:
  ```
  N8N_HOST=s1.<tailnet>.ts.net
  N8N_WEBHOOK_URL=https://s1.<tailnet>.ts.net/
  ```
- Reiniciá n8n para que tome la URL: `docker compose up -d`.

> Funnel expone **solo** el puerto de n8n (5678). El editor sigue protegido por la
> cuenta de n8n; el webhook de Telegram no necesita auth (el workflow filtra por
> remitente autorizado).

## 4. Configurar credenciales en N8N
En n8n → **Credentials → New**:
- **Telegram API** → pegá el token de @BotFather.
- **Header Auth** llamada `LlamaCloud` → Header `Authorization`, Value `Bearer llx-...`.
- **Header Auth** llamada `STA Ingesta` → Header `Authorization`, Value `Bearer <INGEST_API_TOKEN>`.

Y en **Settings → Variables** (o como `$env`):
| Variable | Valor |
|-|-|
| `LLAMA_PROJECT_ID` | el uuid del proyecto LlamaCloud |
| `STA_API_URL` | Docker: `http://host.docker.internal:3001` · sin Docker: `http://localhost:3001` |

## 5. Importar el workflow
- n8n → **Workflows → Import from File** → elegí `docs/n8n/workflow-facturas.json`.
- Abrí cada nodo marcado y **asigná la credencial** correspondiente (Telegram /
  LlamaCloud / STA Ingesta) — la importación no trae las credenciales.
- En el nodo Code "Elegir archivo", opcional: poné los **chat IDs autorizados**
  (encargada, Julio) en `PERMITIDOS` para que solo ellos puedan cargar.
- **Activá** el workflow (toggle arriba a la derecha) → registra el webhook de Telegram.

## 6. Probar
- Mandale al bot una **foto o PDF** de una factura.
- A los segundos debería responder «✅ Factura de … cargada».
- Verificá en **`/admin/facturas`** que aparece en **PENDIENTE_VALIDACION**.
- Reenviá la misma foto → debe decir «ℹ️ ya estaba cargada» (idempotencia).

---

## Notas
- **Idempotencia**: el endpoint deduplica por hash del archivo y por
  proveedor+puntoVenta+número+tipo → reintentar es seguro.
- **Costo**: LlamaExtract cobra por extracción (tier `agentic`). Volumen de
  facturas del local = bajo. Empezá con pocas para calibrar.
- **Privacidad**: el workflow filtra por remitente autorizado (paso 5). El bot no
  responde a desconocidos si cargás `PERMITIDOS`.
