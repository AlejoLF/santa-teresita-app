# Lectura automática de facturas (n8n + LlamaCloud + Telegram)

Sistema de ingreso de facturas de proveedores por OCR. La encargada manda una foto
o PDF a un bot de Telegram → n8n lee con **LlamaCloud** (LlamaParse/LlamaExtract, cloud)
→ postea al programa → la factura queda **PENDIENTE_VALIDACION** → un humano la revisa,
corrige y acepta.

**Invariante central**: el ingreso OCR **NO mueve plata de ninguna cuenta**. Solo crea
la factura como borrador para revisión. El pago (asignar cuenta / cuenta corriente)
es el flujo existente, separado, que recién corre **después** de validar.

```
┌─ Telegram (encargada manda foto/PDF) ─┐
│                                        ▼
│   n8n (corre en S1)        LlamaCloud (cloud: LlamaParse / LlamaExtract)
│   Trigger → getFile ──upload──►  parse/extract  ──JSON estructurado──┐
│                                                                       ▼
│                              hash + map al contrato                   │
│                                        │                              │
│                                        ▼  POST Bearer                 │
│                  http://localhost:3001/api/v1/ingest/facturas         │
│                                        │                              │
└──────── reply ◄── 201 {id, reviewPath} ┘                             │
                                         ▼                              │
                    factura PENDIENTE_VALIDACION (origen TELEGRAM_OCR)  │
                                         ▼                              │
              replicador S1 → Supabase (la ve la encargada, la PWA, el espejo)
                                         ▼
            Admin → Facturas → bandeja "sin validar" → revisar/corregir → Aceptar
                                         ▼
                              PENDIENTE_PAGO → (flujo de pago existente)
```

## Dónde corre cada cosa

| Pieza | Dónde | Por qué |
|-|-|-|
| **n8n** | en S1 (local) | postea a `localhost:3001` → la factura nace en la **fuente de verdad** (S1) y el replicador la sube a Supabase sola. Sin túnel, sin split-brain. |
| **OCR** | **LlamaCloud (cloud)** | LlamaParse/LlamaExtract leen PDF e imagen (incluso escaneadas) y devuelven datos estructurados. Es un servicio pago por página. |
| **App** | S1 (Postgres + API) | recibe el JSON ya estructurado y aplica idempotencia/validación/audit. |

> ⚠️ **Implicancias de usar LlamaCloud (cloud)**:
> - **Internet**: S1 necesita salida a internet (ya la tiene) para llamar a LlamaCloud.
> - **Costo**: LlamaParse cobra por página procesada (hay un tier gratis mensual). Para
>   facturas (pocas/día) entra holgado, pero medilo.
> - **Privacidad**: las imágenes de las facturas **salen del local** hacia LlamaCloud.
>   Son facturas de proveedores (no datos de clientes), pero tenelo presente.
> - A favor: nada de modelo local, nada de GPU/RAM, sin rasterizar PDFs a mano, y la
>   precisión en tablas/items es muy superior a un OCR casero.

---

## 1. El contrato — `POST /api/v1/ingest/facturas`

**Auth**: header `Authorization: Bearer <INGEST_API_TOKEN>`. Es un token de máquina
(NO el PIN de un usuario, NO el AUTH_SECRET). Solo esta ruta lo acepta. Si el server
no tiene `INGEST_API_TOKEN` seteado → responde **503** (ingesta deshabilitada).

**Body** (todos los montos aceptan número o string):

```jsonc
{
  "adjunto": {
    "hash": "<sha256 del archivo>",   // idempotencia fuerte — MANDALO
    "url":  "https://.../archivo.jpg"  // opcional, para guardar el original
  },
  "proveedor": {
    "nombre": "Distribuidora La Plata SA",  // requerido
    "cuit":   "30-12345678-9",              // opcional (mejora el match)
    "razonSocial": "..."                     // opcional
  },
  "comprobante": {
    "tipo": "FACTURA_A",          // A|B|C|X|NOTA_CREDITO|NOTA_DEBITO|TICKET|REMITO|OTRO
    "puntoVenta": "0001",         // opcional
    "numero": "00012345",         // requerido
    "fechaEmision": "2026-06-08", // YYYY-MM-DD (requerido)
    "fechaVencimiento": "2026-07-08", // opcional
    "cuitEmisor": "...", "razonSocialEmisor": "..."  // opcionales
  },
  "montos": {
    "neto": 10000, "iva21": 2100, "iva10_5": 0, "iva27": 0,
    "ivaTotal": 2100,            // si no discriminás IVA, mandá ivaTotal
    "otrosImpuestos": 0,
    "total": 12100               // requerido
  },
  "items": [
    { "descripcion": "Harina 000 x 25kg", "cantidad": 4, "unidad": "bolsa",
      "precioUnitario": 2000, "alicuotaIva": 21, "subtotal": 8000 }
  ],
  "ocr": {
    "confianza": 0.92,           // 0..1 — qué tan seguro está el extractor
    "payload": { }               // JSON crudo de LlamaCloud (se guarda para forense)
  },
  "observaciones": "texto libre"  // opcional
}
```

**Respuestas**:

| Código | Caso | Body |
|-|-|-|
| `201` | Creada | `{ ok:true, id, estado:"PENDIENTE_VALIDACION", reviewPath:"/admin/facturas/<id>" }` |
| `200` | Duplicada (mismo `adjunto.hash`) | `{ duplicate:true, motivo:"adjuntoHash", id, estado }` |
| `200` | Duplicada (mismo proveedor+pv+número+tipo) | `{ duplicate:true, motivo:"comprobante", id, estado }` |
| `401` | Token inválido/ausente | `{ error }` |
| `400` | Body inválido (falta total, etc.) | validación zod |
| `503` | Ingesta deshabilitada (falta token) | `{ error }` |

**Idempotencia** (n8n puede reintentar sin miedo):
1. `adjunto.hash` (sha256 del archivo) → la **misma foto** reenviada no duplica.
2. `@@unique(proveedor, puntoVenta, numero, tipoComprobante)` → la **misma factura**
   fotografiada distinto no duplica.

En ambos casos devuelve `200 duplicate` (no error) → n8n responde "ya estaba cargada".
**El API es la autoridad de idempotencia** — n8n no necesita su propio registro de hashes.

---

## 1.bis Instalación — un solo comando

Todo lo de las secciones 2 y 4 está automatizado en `tools/n8n/setup-n8n.ps1`.
Desde S1, en PowerShell **como Administrador**:

```powershell
cd C:\sta\santa-teresita-app\tools\n8n
.\setup-n8n.ps1 `
  -TelegramBotToken   '<token de @BotFather>' `
  -TelegramAllowedIds '<id o @usuario de la encargada>,<id o @usuario de Julio>' `
  -LlamaCloudApiKey   'llx-...' `
  -IngestToken        '<el INGEST_API_TOKEN del server>'
```

Instala n8n, instala el **nodo oficial de LlamaCloud**, genera la clave de
cifrado, escribe el entorno con permisos restringidos, registra el servicio NSSM
(arranque automático + reinicio ante caída), importa credenciales y workflow, lo
activa y verifica que todo responda — incluido un chequeo de que la API key de
LlamaCloud y el token del bot son válidos. Es **idempotente**: se puede volver a
correr.

> ⚠️ **La clave de cifrado**. Se guarda en `C:\sta\n8n\encryption-key.txt`.
> Perderla inutiliza las credenciales guardadas en n8n. Hacé una copia fuera de
> S1. El script la reusa si ya existe, nunca la pisa.

> ⚠️ **`-TelegramAllowedIds` no es opcional en la práctica.** Un bot de Telegram
> es público: cualquiera que sepa su nombre puede escribirle. Sin lista blanca el
> workflow **no le contesta a nadie** (falla cerrado, a propósito).
>
> Se acepta **el ID numérico o el `@usuario`**, mezclados y separados por coma:
> `'8123456789,@julio'`. El `@usuario` es el que tenés a mano; el numérico lo da
> @userinfobot y es el que conviene, porque un `@usuario` se puede soltar y otro
> tomarlo después. Si alguien queda afuera de la lista, su mensaje se descarta en
> silencio **pero el log de la ejecución imprime el `from.id` y el `@usuario` que
> llegaron** — de ahí se copia el valor que falta.

### Probar en tu PC — `setup-n8n-dev.ps1`

Para armar o retocar el workflow con el editor visual sin tocar S1:

```powershell
cd C:\sta\santa-teresita-app\tools\n8n
.\setup-n8n-dev.ps1 -TelegramBotToken '<bot DE PRUEBA>' `
                    -LlamaCloudApiKey 'llx-...' -ImportarWorkflow
```

Instala n8n en primer plano (Ctrl+C lo corta), con datos en `C:\sta\n8n-dev`
— carpeta aparte, para no pisar la de S1 — y el editor en
`http://localhost:5678`. Cuando termines:

```powershell
n8n export:workflow --id=<id> --output=workflow-facturas-ocr.json
```

**Para volver a arrancarlo** (después de cerrar la terminal) usá
`.\n8n-dev.ps1`, no `n8n start` pelado: el setup carga el entorno en *esa*
sesión de PowerShell y se va con ella. Sin las variables, los Code nodes
vuelven a fallar con `access to env vars denied`. `n8n-dev.ps1` relee el
archivo de entorno, avisa si el bot quedó con un webhook puesto, y arranca.

### El nodo "Telegram Trigger" NO se puede probar en tu PC

Si lo ponés en el canvas y ejecutás, da:

```
Bad Request: bad webhook: An HTTPS URL must be provided for webhook
```

No es un error de configuración: ese nodo **registra un webhook**, o sea que
Telegram tiene que poder *entrar* a tu n8n desde internet por HTTPS. En
`localhost:5678` no hay ninguna URL pública que darle.

**El `--tunnel` de n8n ya no existe**: fue eliminado en n8n 2.0 (regla de
breaking changes `tunnel-option-v2` — "the --tunnel flag will be ignored"). Si
lo pasás, n8n lo ignora en silencio y el problema queda igual.

Opciones reales:

1. **Usar el workflow de polling** (el de este repo). No necesita webhook, es
   lo que va a correr en producción, y en el editor se prueba con *Execute
   workflow* igual que cualquier otro. Es lo recomendado.
2. Si querés sí o sí el trigger por webhook: levantar un túnel propio
   (Cloudflare Tunnel, ngrok) y arrancar n8n con `WEBHOOK_URL=https://<tu-url>`.
   Es una pieza más para mantener y no aporta nada a lo que se va a desplegar.

> 🚨 **Un webhook apaga el polling del bot.** Telegram no permite las dos cosas
> a la vez: con un webhook registrado, `getUpdates` devuelve **409** y el
> workflow de S1 deja de recibir facturas hasta que lo borres. Si llegaste a
> registrar uno (aunque haya sido probando), revisá y limpiá:
>
> ```powershell
> $t = '<token del bot>'
> Invoke-RestMethod "https://api.telegram.org/bot$t/getWebhookInfo"   # ver si hay
> Invoke-RestMethod "https://api.telegram.org/bot$t/deleteWebhook"    # sacarlo
> ```
>
> `n8n-dev.ps1` hace ese chequeo solo al arrancar y te avisa.

> 🚨 **Dos n8n contra el mismo bot se pisan.** Telegram admite **un solo**
> `getUpdates` en vuelo por token. Si el de S1 y el de tu PC poletean el mismo
> bot: a uno lo corta con **409** (error instantáneo) y al otro lo deja colgado
> hasta que el gateway lo mata con **504 a los 120s**. Como el trigger dispara
> cada minuto, para entonces ya hay dos ejecuciones encimadas y **no se
> recupera solo** — se ve como `Error in 2m 0.6s` repetido, una y otra vez.
>
> Usá un bot de prueba aparte de @BotFather, o pará el de S1 (`nssm stop n8n`)
> mientras probás. El script te avisa si detecta el servicio corriendo.
>
> El workflow ahora corta la consulta a los 20s, así que una ejecución nunca
> llega viva al disparo siguiente y el encavalgamiento no se sostiene solo;
> pero si hay **dos pollers de verdad**, el choque sigue hasta que apagues uno.

### El trigger es POLLING, no webhook

El §2 de abajo describe el nodo **Telegram Trigger**, que registra un webhook:
Telegram tiene que poder **entrar** a n8n desde internet. S1 está detrás del
router del local, sin IP pública — eso obligaría a un túnel, que es una pieza más
que se cae.

El workflow implementado usa **long-polling**: S1 **sale** a internet (que ya
puede) y consulta `getUpdates` cada minuto. El offset se guarda en la static data
del workflow, así que sobrevive reinicios y cortes de luz sin reprocesar
mensajes. El costo es hasta 60s de latencia, irrelevante para facturas.

### El OCR usa el nodo oficial de LlamaCloud, no un HTTP Request a mano

`@llamaindex/n8n-nodes-llamacloud` ("LlamaParse Platform") es un community node
**verificado**, publicado por LlamaIndex. El instalador lo pone en
`C:\sta\n8n\.n8n\nodes` (que es de donde n8n carga los community nodes) y crea
la credencial del tipo `llamaParseApi` con la API key.

Se usa la acción **Extract structured data** en modo **Schema**: el schema de la
factura va *inline* en el workflow, así que **no hay que crear nada en el panel
de LlamaCloud** — ni extraction agent ni saved configuration. Esto resuelve el
lío de la v2 (LlamaExtract reemplazó los "extraction agents" por "saved
configurations"): en modo Schema no aplica ninguna de las dos.

Qué hace el nodo por dentro, verificado leyendo el paquete (v6.7.2):

1. Sube el binario a LlamaCloud y obtiene un `file_id`.
2. `POST /api/v2/extract` con `{ file_input, configuration: { data_schema } }`.
3. Poletea `GET /api/v2/extract/<job>` hasta `COMPLETED`.
4. Devuelve **`{ result: "<JSON stringificado>" }`** — un string, no un objeto.

Ese último detalle importa: el nodo *Armar factura* hace `JSON.parse` y recupera
el `chatId`/`hash` del nodo anterior por `pairedItem`, porque el nodo de
LlamaCloud **no arrastra los campos de entrada**.

El schema pedido está en el parámetro `dataSchema` del nodo, en el JSON del
workflow: `proveedor{nombre,cuit}`, `comprobante{tipo,puntoVenta,numero,
fechaEmision,fechaVencimiento}`, `montos{neto,iva21,iva10_5,ivaTotal,total}` e
`items[]`. Si querés cambiar qué se extrae, se toca ahí y punto — el mapeo al
contrato del §1 tolera campos faltantes.

**Lo que queda sin verificar**: nadie corrió todavía una factura real de punta a
punta. Los contratos están confirmados (API de Telegram, el nodo de LlamaCloud
leído del paquete, `POST /ingest/facturas` de este repo), pero la precisión del
OCR sobre facturas argentinas hay que medirla con 5-10 reales.

---

## 2. El flujo de n8n — nodo por nodo

### Trigger
- **Telegram Trigger** — `Updates: message`. Captura fotos y documentos.
- Filtrá: `message.photo` (foto) o `message.document` con mimeType `image/*` o
  `application/pdf`. Cualquier otra cosa → responder "mandá foto o PDF de la factura".

### Obtener el archivo
- **Telegram → Get File** con el `file_id`:
  - Foto: usar el último elemento de `message.photo` (mayor resolución).
  - Documento: `message.document.file_id`.
- Devuelve el binario en `binary.data`. **No hace falta convertir PDF a imagen** —
  LlamaCloud come PDF e imagen directo.

### Hash de idempotencia
- **Code node** (o Crypto node): sha256 del binario → `adjunto.hash`.
  ```js
  const crypto = require('crypto');
  const buf = Buffer.from(items[0].binary.data.data, 'base64');
  return [{ json: { hash: crypto.createHash('sha256').update(buf).digest('hex') } }];
  ```
  Requiere `NODE_FUNCTION_ALLOW_BUILTIN=crypto` — ver abajo. El campo es
  opcional: si no va, el programa deriva un hash del contenido OCR
  (`ingest.ts`), que igual frena el duplicado pero recién después de pagar
  una pasada de OCR.

### El sandbox del Code node bloquea dos cosas por defecto

Los Code nodes de n8n 2.x corren en el **task runner**, no en el proceso
principal, y arrancan cerrados. Dos restricciones nos pegaron, las dos con el
mismo síntoma engañoso — la ejecución muere sin que el error mencione al
sandbox:

| Variable | Sin ella | Por qué la necesitamos |
|-|-|-|
| `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` | `access to env vars denied`, a los 11ms | Los 4 Code nodes leen `$env` (token del bot, whitelist, URL de ingesta) |
| `NODE_FUNCTION_ALLOW_BUILTIN=crypto` | `Module 'crypto' is disallowed` | El sha256 del archivo en "Bajar archivo" |

Las dos las escribe `setup-n8n.ps1` en `n8n.env`, y NSSM las toma al re-correr
el script (re-setea `AppEnvironmentExtra` siempre).

**No son equivalentes en riesgo.** La primera abre TODO el entorno del proceso
—incluida `N8N_ENCRYPTION_KEY`— a cualquier Code node de cualquier workflow, y
n8n no permite filtrar por variable; se acepta porque el panel escucha solo en
127.0.0.1 y hay que tener S1 para escribir un Code node. La segunda habilita
una librería de hashing y no expone nada.

Lo que el sandbox **sí** deja pasar sin configurar: `Buffer`, `TextEncoder`,
`FormData`, `$getWorkflowStaticData`, y de los helpers `httpRequest`,
`prepareBinaryData`, `getBinaryDataBuffer`, `binaryToString`. Los `Buffer`
sobreviven el ida y vuelta por RPC (n8n los re-arma con `toBuffer`), así que
bajar un binario en un Code node y pasarlo como binary funciona. No hay
`crypto` global ni WebCrypto: sin el `require`, no hay forma de hashear.

### OCR — nodo **LlamaParse Platform**
- Acción: **Extract structured data**. Configuration mode: **Schema** (inline).
- Input type: **Binary File**, campo `data` (el que deja *Bajar archivo*).
- Credencial: `LlamaParse API` (API key `llx-...` + base `https://api.cloud.llamaindex.ai`).
- **No hace falta convertir PDF a imagen** — LlamaCloud come PDF e imagen directo.
- Retry On Fail: 3 intentos, 5s. `onError: continueRegularOutput` para que un
  fallo del OCR no mate la ejecución y la encargada reciba el aviso.

Alternativa si algún día conviene: acción **Parse a document** (devuelve markdown)
y pasarle el markdown a un LLM. Más piezas, más costo, misma salida — no vale la
pena mientras Extract funcione.

### Qué se exige para cargar una factura

Solo dos cosas: **de quién es** (proveedor) y **cuánto es** (total). Nada más
bloquea.

Buena parte de lo que entra al local no es comprobante fiscal en regla —
remitos, tickets, papeles sin numerar—. Exigir el número de comprobante
rebotaba justamente esas, que son la mitad del trabajo que se quería ahorrar.

Todo lo demás (número, fecha, tipo, CUIT, detalle de productos) entra como
**faltante**: la factura se carga igual **sin validar**, la observación dice
exactamente qué falta, la confianza baja según cuánto falte, y el bot se lo
avisa a quien la mandó. La encargada completa lo que haga falta al revisarla.

> El programa exige un número de comprobante (`numero` es NOT NULL y forma
> parte de `@@unique(proveedor, puntoVenta, numero, tipo)`). Cuando la factura
> no lo trae, n8n arma uno derivado del contenido: `S/N-<fecha>-<total>`. Se
> ve claro que es provisorio, y como sale del contenido, la misma factura
> fotografiada dos veces genera el mismo número y el duplicado se sigue
> frenando. Un `S/N` fijo no serviría: dos facturas distintas del mismo
> proveedor chocarían y la segunda se perdería como "duplicada".

**El descuadre de items** se mide contra el neto **o** contra el total. Los
renglones suelen venir netos y el total con IVA: compararlos solo contra el
total marcaba descuadre en casi toda factura A bien discriminada, y un aviso
que salta siempre no lo lee nadie.

### Parse + validación
- **Code node**: asegurate de tener el JSON del contrato. Sanity checks:
  - `total > 0`, `numero` no vacío, `proveedor.nombre` no vacío.
  - Avisá si `abs(total - sum(items.subtotal)) > total*0.05` (descuadre) bajando la
    `confianza` o agregando `observaciones: "revisar: items no suman el total"`.
  - Agregá `adjunto.hash`, `ocr.payload` (la salida cruda de LlamaCloud), `ocr.confianza`.

### POST al programa
- **HTTP Request**:
  - Method `POST`, URL `http://localhost:3001/api/v1/ingest/facturas`.
  - Header `Authorization: Bearer {{$env.INGEST_API_TOKEN}}` (credencial de n8n).
  - Body = JSON del paso anterior.
  - **Settings → Retry On Fail**: 3 intentos, espera 5s (cubre el caso de que el API
    arranque después que n8n tras un corte de luz).

### Responder en Telegram
- **Telegram → Send Message** según la respuesta:
  - `201` → `✅ Factura de {proveedor} por ${total} cargada. Revisala y aceptala en el sistema.`
  - `200 duplicate` → `ℹ️ Esa factura ya estaba cargada.`
  - error/4xx → `⚠️ No pude leer la factura. Mandá una foto más nítida y derecha, o cargala a mano.`

### Manejo de errores
- En los nodos de LlamaCloud y el HTTP del POST: activar **Continue On Fail** y rutear
  con un **IF** a la rama de error → Send Message de aviso + (opcional) log.
- Crear un **Error Workflow** global de n8n para que cualquier excepción no manejada
  también avise por Telegram en vez de morir en silencio.
- Errores `5xx`/red en el POST → los cubre el Retry On Fail; si agota → avisar
  "reintentá en un rato" (el archivo sigue en el chat, se puede reenviar).
- LlamaCloud caído / sin crédito → avisar y dejar que la encargada cargue a mano.

---

## 3. Validación humana (lado programa)

La factura entra en **PENDIENTE_VALIDACION**. El dashboard admin muestra
*"N facturas cargadas por OCR sin validar 🧾"* (link a la bandeja). Endpoints:

| Acción | Endpoint | Efecto |
|-|-|-|
| Bandeja | `GET /api/v1/admin/facturas?estado=PENDIENTE_VALIDACION` | lista FIFO sin validar |
| Detalle | `GET /api/v1/admin/facturas/:id` | factura + items + payload OCR |
| Corregir | `PATCH /api/v1/admin/facturas/:id` | edita campos/items (solo sin-validar) |
| **Aceptar** | `POST /api/v1/admin/facturas/:id/validar` | → PENDIENTE_PAGO (marca quién/cuándo) |
| Rechazar | `POST /api/v1/admin/facturas/:id/anular` | → ANULADA (OCR basura/duplicado) |

UI: **Admin → Facturas de compra** → filtro "Sin validar" → abrir → form editable con
los datos discriminados → **Aceptar** o **Rechazar**. `validar` y `anular` **no tocan
ninguna cuenta**. Recién en PENDIENTE_PAGO entra el flujo de pago multi-cuenta existente.
Todo queda auditado (hash-chain).

---

## 4. Setup en S1 — n8n como servicio de Windows (sobrevive corte de luz)

> Clave: **servicio NSSM**, no app de bandeja ni Docker Desktop. Un servicio arranca en
> el boot, headless, sin que nadie inicie sesión — igual que el `sta-server`. (Ya no hay
> modelo local que instalar: el OCR es LlamaCloud, en la nube.)

### 4.1 n8n
```powershell
# 1. Node 22 ya está en S1 (lo usa el server). Instalar n8n global:
npm install -g n8n
# 2. Clave de cifrado (¡guardala! cifra las credenciales de n8n):
setx N8N_ENCRYPTION_KEY "<32+ chars aleatorios>" /M
# 3. Registrar como servicio NSSM:
nssm install n8n "C:\Program Files\nodejs\node.exe" "C:\Users\<u>\AppData\Roaming\npm\node_modules\n8n\bin\n8n"
nssm set n8n AppEnvironmentExtra ^
  "N8N_PORT=5678" "N8N_HOST=127.0.0.1" "N8N_PROTOCOL=http" ^
  "INGEST_API_TOKEN=<el mismo token que en el .env del server>" ^
  "LLAMA_CLOUD_API_KEY=llx-..." ^
  "GENERIC_TIMEZONE=America/Argentina/Buenos_Aires"
nssm set n8n Start SERVICE_AUTO_START
nssm start n8n
```
Editor de n8n en `http://localhost:5678` (desde S1) para armar el workflow.

### 4.2 Credenciales en n8n
- **Telegram API**: el token de @BotFather (§5).
- **LlamaParse API** (tipo `llamaParseApi`, lo aporta el community node): la API key
  `llx-...` de `https://cloud.llamaindex.ai` + base `https://api.cloud.llamaindex.ai`.

### 4.3 El token de ingesta (en el server)

**No existe todavía: hay que generarlo.** No viene de ningún lado — es un token
de máquina que inventás vos. Mínimo 24 chars (lo valida zod en `config.ts`), y
**distinto del `AUTH_SECRET`**: su único permiso es crear facturas sin validar,
que no mueven plata hasta que un humano las acepte.

```powershell
# 1. Generarlo
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[Convert]::ToBase64String($b)

# 2. Pegarlo en C:\sta-server\.env
#    INGEST_API_TOKEN=<lo de arriba>

# 3. NSSM congela el env al registrar el servicio: reiniciar NO alcanza.
cd C:\sta-server
.\update-server.ps1 -SyncEnv

# 4. Verificar (con body VALIDO y un token a proposito invalido)
$body = '{"proveedor":{"nombre":"PRUEBA"},"comprobante":{"numero":"1","fechaEmision":"2026-08-12"},"montos":{"total":1}}'
try {
  Invoke-RestMethod -Uri 'http://localhost:3001/api/v1/ingest/facturas' -Method POST `
    -ContentType 'application/json' -Body $body `
    -Headers @{ Authorization = 'Bearer token-a-proposito-invalido' }
} catch { "HTTP " + [int]$_.Exception.Response.StatusCode }
```

`401` = el token está configurado, todo bien. `503` = falta `INGEST_API_TOKEN`
en el `.env` → volvé al paso 3.

> **El body tiene que ser válido, y esto no es un detalle.** La ruta declara
> `schema: { body: BodySchema }`, y Fastify valida el body **antes** de entrar
> al handler — que es donde viven los chequeos de 503 y 401. Un `POST` vacío
> devuelve **400** y nunca llega a mirar el token: no distingue "token puesto"
> de "token faltante". Lo único que prueba es que la ruta existe.
>
> El token inválido es a propósito: si mandaras el correcto, crearías una
> factura de prueba de verdad en la bandeja.

> ⚠️ El paso 3 es el que se olvida. `update-server.ps1:93-95` lo explica: NSSM
> guarda un snapshot del `.env` en `AppEnvironmentExtra` cuando se registra el
> servicio, y dotenv **no pisa** lo que NSSM ya inyectó en `process.env`. Editar
> el `.env` y reiniciar deja el valor viejo (o ninguno) sin avisar.

### 4.4 Orden de arranque tras corte de luz
Servicios `SERVICE_AUTO_START`: PostgreSQL → sta-server → n8n. Si n8n arranca antes que
el API, el primer POST reintenta (Retry On Fail) → se autocorrige. LlamaCloud es externo
(solo necesita que vuelva internet).

---

## 5. El bot de Telegram
1. Crear el bot con **@BotFather** → guardar el token.
2. En n8n: credencial "Telegram API" con ese token.
3. Restringir quién puede usarlo: en el flujo, un IF que chequee `message.from.id` contra
   una lista blanca (la encargada + Julio). Cualquier otro → ignorar.

---

## 6. Checklist de puesta en marcha
- [ ] `INGEST_API_TOKEN` en el `.env` del server (S1) + reiniciar `sta-server`.
- [ ] Deploy del server con el endpoint de ingesta (release del server).
- [ ] Cuenta de LlamaCloud + API key `llx-...`. (El schema va inline en el workflow:
      **no** hay que crear extraction agent ni saved configuration en el panel.)
- [ ] n8n instalado + community node `@llamaindex/n8n-nodes-llamacloud` + servicio NSSM
      corriendo + credenciales `LlamaParse API` e `Ingesta STA` + INGEST_API_TOKEN.
- [ ] Bot de @BotFather + whitelist de usuarios.
- [ ] Workflow armado y probado con 5-10 facturas reales (medir costo LlamaCloud y precisión).
- [ ] UI de validación visible para la encargada (Admin → Facturas de compra → Sin validar).

---

*Creado 2026-06-10. Actualizado 2026-08-11: el workflow y el instalador están
escritos (`tools/n8n/`). El tramo de OCR pasó de un HTTP Request armado a mano
(endpoint sin confirmar) al **nodo oficial `@llamaindex/n8n-nodes-llamacloud`**
en modo schema inline — los nombres de nodo, parámetros y credencial se
verificaron leyendo el paquete v6.7.2, y el instalador lo instala solo. El
endpoint de ingesta, el flujo de validación y la UI de bandeja ya estaban
implementados y verificados. Falta: correr el instalador en S1 y medir precisión
y costo con 5-10 facturas reales.*
