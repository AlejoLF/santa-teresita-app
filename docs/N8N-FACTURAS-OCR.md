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
  -TelegramAllowedIds '<id de la encargada>,<id de Julio>' `
  -LlamaCloudApiKey   'llx-...' `
  -IngestToken        '<el INGEST_API_TOKEN del server>' `
  -LlamaExtractUrl    '<endpoint de extracción de LlamaCloud>'
```

Instala n8n, genera la clave de cifrado, escribe el entorno con permisos
restringidos, registra el servicio NSSM (arranque automático + reinicio ante
caída), importa credenciales y workflow, lo activa y verifica que todo responda.
Es **idempotente**: se puede volver a correr.

> ⚠️ **La clave de cifrado**. Se guarda en `C:\sta\n8n\encryption-key.txt`.
> Perderla inutiliza las credenciales guardadas en n8n. Hacé una copia fuera de
> S1. El script la reusa si ya existe, nunca la pisa.

> ⚠️ **`-TelegramAllowedIds` no es opcional en la práctica.** Un bot de Telegram
> es público: cualquiera que sepa su nombre puede escribirle. Sin lista blanca el
> workflow **no le contesta a nadie** (falla cerrado, a propósito). Para conseguir
> un ID: que la persona le escriba al bot y mirá el log, o usá @userinfobot.

### El trigger es POLLING, no webhook

El §2 de abajo describe el nodo **Telegram Trigger**, que registra un webhook:
Telegram tiene que poder **entrar** a n8n desde internet. S1 está detrás del
router del local, sin IP pública — eso obligaría a un túnel, que es una pieza más
que se cae.

El workflow implementado usa **long-polling**: S1 **sale** a internet (que ya
puede) y consulta `getUpdates` cada minuto. El offset se guarda en la static data
del workflow, así que sobrevive reinicios y cortes de luz sin reprocesar
mensajes. El costo es hasta 60s de latencia, irrelevante para facturas.

### ⚠️ Lo único sin verificar: el endpoint de LlamaCloud

Todo el resto del workflow está armado contra contratos verificados (la API de
Telegram y `POST /ingest/facturas` de este repo). El endpoint de extracción de
LlamaCloud **no se pudo confirmar**: su documentación está bloqueada desde el
entorno donde se armó esto, y hay una señal fuerte de que cambió — **LlamaExtract
v2 reemplazó los "extraction agents" por "saved configurations"**, así que la
descripción del §2 de abajo quedó vieja.

Qué hacer:

1. Entrá a `https://cloud.llamaindex.ai` y fijate el endpoint de extracción
   vigente para tu cuenta.
2. Pasalo en `-LlamaExtractUrl`. Está parametrizado justamente por esto: **no
   hay que tocar el workflow**, es una variable de entorno.
3. Si la respuesta viene con otra forma, se ajusta **una sola función** —
   `leer()` dentro del nodo *Armar factura*. Ya tolera varias formas comunes
   (`data`, `result`, `extraction` en la raíz; `montos.total`, `total`,
   `importe_total` para el importe).

El resto del pipeline no depende de esa forma.

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

### OCR — LlamaCloud (recomendado: **LlamaExtract**)
LlamaCloud tiene dos servicios; para facturas conviene **LlamaExtract** (extrae directo
a un schema). API key en `https://cloud.llamaindex.ai` (formato `llx-...`). Base:
`https://api.cloud.llamaindex.ai`. Auth: `Authorization: Bearer llx-...`.

**Opción A — LlamaExtract (estructurado directo, ideal facturas):**
1. Una vez, definí un *extraction agent* con el schema de la factura (en la UI de
   LlamaCloud o por API): proveedor{nombre,cuit}, comprobante{tipo,puntoVenta,numero,
   fechaEmision}, montos{neto,iva21,total}, items[{descripcion,cantidad,unidad,
   precioUnitario,subtotal}].
2. En n8n, **HTTP Request** subiendo el archivo al agente → devuelve el JSON del schema.
3. Ese JSON ya es casi el contrato del §1 → mapealo en un Code node.

**Opción B — LlamaParse + un LLM (si preferís markdown):**
1. **HTTP Request** (multipart) `POST https://api.cloud.llamaindex.ai/api/v1/parsing/upload`
   con el binario y el header de auth → devuelve `{ id }` (job).
2. **Poll**: `GET /api/v1/parsing/job/{id}` hasta `status=SUCCESS` (Wait + IF loop, o el
   nodo con retry). Luego `GET /api/v1/parsing/job/{id}/result/markdown` → markdown.
3. Pasá el markdown a un LLM (OpenAI/Anthropic/lo que uses) con un prompt que devuelva
   SOLO el JSON del contrato. (LlamaParse lee bien las tablas → el LLM extrae fácil.)

> Verificá los paths exactos en la doc vigente de LlamaCloud — la API evoluciona.
> El patrón (upload → job → result, o extract-con-schema) es estable.

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
- **LlamaCloud**: la API key `llx-...` (en un header `Authorization: Bearer` de los
  HTTP Request, o como credencial genérica). Sacala de `https://cloud.llamaindex.ai`.

### 4.3 El token de ingesta (en el server)
Agregar al `.env` del `sta-server` en S1 y reiniciar el servicio:
```
INGEST_API_TOKEN=<generá uno: 32+ chars aleatorios, distinto del AUTH_SECRET>
```
Verificar: `curl -s -o NUL -w "%{http_code}" http://localhost:3001/api/v1/ingest/facturas`
→ debe dar `401` (vivo, pero sin token en el request). Con el body+token correcto → `201`.

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
- [ ] Cuenta de LlamaCloud + API key `llx-...` + (si LlamaExtract) el extraction agent con schema.
- [ ] n8n instalado + servicio NSSM corriendo + credenciales Telegram y LlamaCloud + INGEST_API_TOKEN.
- [ ] Bot de @BotFather + whitelist de usuarios.
- [ ] Workflow armado y probado con 5-10 facturas reales (medir costo LlamaCloud y precisión).
- [ ] UI de validación visible para la encargada (Admin → Facturas de compra → Sin validar).

---

*Creado 2026-06-10. Actualizado 2026-08-11: el workflow y el instalador están
escritos (`tools/n8n/`). El endpoint de ingesta, el flujo de validación y la UI de
bandeja ya estaban implementados y verificados. Falta: confirmar el endpoint de
LlamaCloud contra la cuenta y correr el instalador en S1.*
