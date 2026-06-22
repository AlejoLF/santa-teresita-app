# Build del workflow n8n — Facturas (Telegram → LlamaExtract → Programa)

Guía node-por-node para armar el flujo en **n8n** (lo desarrollás local en tu PC
y después lo exportás/importás a S1). Lee la factura con **LlamaExtract** y la
postea al endpoint del programa, que la deja en `PENDIENTE_VALIDACION` para que
un humano la revise y acepte. **No mueve plata.**

Arquitectura y contrato completos: [N8N-FACTURAS-OCR.md](../N8N-FACTURAS-OCR.md).
Schema de extracción: [llamaextract-factura-schema.json](llamaextract-factura-schema.json).

```
Telegram Trigger → ¿es factura? → Descargar archivo → SHA256
   → Subir a LlamaCloud → Lanzar extracción → (Esperar → Estado)*  → ¿OK?
   → Mapear al contrato → POST /ingest/facturas → Responder por Telegram
```

---

## 0. Prerrequisitos y variables

En n8n → **Settings → Variables** (o como credenciales/`$env`), definí:

| Variable | Valor | De dónde |
|-|-|-|
| `LLAMA_CLOUD_API_KEY` | `llx-...` | cloud.llamaindex.ai → API Keys |
| `LLAMA_PROJECT_ID` | uuid del proyecto | dashboard de LlamaCloud (está en la URL del proyecto) o `GET https://api.cloud.llamaindex.ai/api/v1/projects` |
| `STA_API_URL` | dev: `http://localhost:3001` · prod: `http://localhost:3001` (n8n corre en S1) | — |
| `INGEST_API_TOKEN` | el mismo token que en el `.env` del server | generado por vos (32+ chars) |

**Credenciales n8n:**
- **Telegram API** (token de @BotFather) — para el Trigger y el Send Message.
- **Header Auth "LlamaCloud"**: header `Authorization` = `Bearer <LLAMA_CLOUD_API_KEY>` — la usan los 3 nodos HTTP de LlamaCloud.
- **Header Auth "STA Ingesta"**: header `Authorization` = `Bearer <INGEST_API_TOKEN>` — la usa el POST al programa.

> Para **dev local** el target es la API corriendo en tu PC (`localhost:3001`) —
> ver §"Dev local" abajo. En **producción** n8n corre en S1 y postea a su propio
> `localhost:3001`, así la factura nace en la fuente de verdad.

---

## 1. Telegram Trigger
- Node: **Telegram Trigger** · Updates: `message` · Credencial: Telegram API.
- La encargada manda foto o PDF de la factura al bot.

## 2. ¿Es factura? (Code → IF)
Node **Code** "Elegir archivo" — detecta foto o PDF, elige el `file_id` y
chequea whitelist de remitentes:
```js
const msg = $json.message ?? {};
// Whitelist de chats autorizados (encargada, Julio). Vacío = permitir a todos (dev).
const PERMITIDOS = []; // ej: [123456789, 987654321]
const fromId = msg.from?.id;
const autorizado = PERMITIDOS.length === 0 || PERMITIDOS.includes(fromId);

let fileId = null, fileName = 'factura';
if (Array.isArray(msg.photo) && msg.photo.length) {
  fileId = msg.photo[msg.photo.length - 1].file_id; // la de mayor resolución
} else if (msg.document && /image\/|pdf/i.test(msg.document.mime_type || '')) {
  fileId = msg.document.file_id;
  fileName = msg.document.file_name || fileName;
}
return [{ json: {
  chatId: msg.chat?.id,
  fileId, fileName,
  esFactura: !!fileId && autorizado,
  motivo: !autorizado ? 'no_autorizado' : !fileId ? 'sin_archivo' : 'ok',
} }];
```
Node **IF** "¿esFactura?": condición `{{$json.esFactura}}` *is true*.
- **false** → Telegram *Send Message* a `{{$json.chatId}}`: «Mandá una **foto o PDF** de la factura 📄».

## 3. Descargar archivo
Node **Telegram** · Resource: **File** · File ID: `{{$json.fileId}}`.
→ deja el binario en la propiedad `data`.

## 4. SHA256 (idempotencia)
Node **Code** "Hash":
```js
const crypto = require('crypto');
const bin = $input.item.binary.data;
const buf = Buffer.from(bin.data, 'base64');
const hash = crypto.createHash('sha256').update(buf).digest('hex');
return [{ json: { ...$json, adjuntoHash: hash }, binary: $input.item.binary }];
```

## 5. Subir a LlamaCloud
Node **HTTP Request** · POST `https://api.cloud.llamaindex.ai/api/v1/beta/files`
- Auth: credencial **LlamaCloud**.
- Body: **Form-Data (multipart)**:
  - `file` → tipo *n8n Binary File*, input field `data`.
  - `purpose` → `extract`.
- Respuesta: `{{$json.id}}` (un `dfl-...`).

## 6. Lanzar extracción
Node **HTTP Request** · POST `https://api.cloud.llamaindex.ai/api/v2/extract?project_id={{$vars.LLAMA_PROJECT_ID}}`
- Auth: credencial **LlamaCloud** · Body: **JSON**:
```json
{
  "file_input": "={{ $json.id }}",
  "configuration": {
    "tier": "agentic",
    "extraction_target": "per_doc",
    "confidence_scores": true,
    "data_schema": { /* PEGAR el contenido de llamaextract-factura-schema.json */ }
  }
}
```
- Respuesta: `{{$json.id}}` = **jobId**. Guardalo (Set node o referencialo luego).

## 7. Poll: Esperar → Estado (loop)
- Node **Wait** "Esperar" · 6 segundos.
- Node **HTTP Request** "Estado" · GET `https://api.cloud.llamaindex.ai/api/v2/extract/{{ $jobId }}?project_id={{$vars.LLAMA_PROJECT_ID}}` (auth LlamaCloud).
- Node **IF** "¿Listo?": `{{$json.status}}` *is one of* `SUCCESS`,`COMPLETED`.
  - **false** → si `{{$json.status}}` ∈ {`ERROR`,`FAILED`,`CANCELLED`} → Telegram «No pude leer la factura ⚠️, probá una foto más nítida». Si sigue procesando → volver al **Wait** (loop).
  - **true** → seguir. El resultado está en `{{$json.extract_result}}` (o `data`).

## 8. Mapear al contrato
Node **Code** "Mapear al contrato" — convierte `extract_result` al body del endpoint:
```js
const r = $json.extract_result ?? $json.data ?? {};
const conf = $json.extraction_metadata?.confidence ?? null; // 0..1 si confidence_scores=true
const num = (v) => (v == null || v === '' ? undefined : Number(v));
const body = {
  adjunto: { hash: $('Hash').item.json.adjuntoHash },
  proveedor: { nombre: r.proveedor_nombre, cuit: r.proveedor_cuit || undefined },
  comprobante: {
    tipo: r.tipo_comprobante || 'OTRO',
    puntoVenta: r.punto_venta || undefined,
    numero: String(r.numero ?? ''),
    fechaEmision: r.fecha_emision,
    fechaVencimiento: r.fecha_vencimiento || undefined,
  },
  montos: {
    neto: num(r.neto_gravado),
    ivaTotal: num(r.iva_total),
    total: num(r.total),
  },
  items: (r.items ?? []).map((it) => ({
    descripcion: it.descripcion,
    cantidad: num(it.cantidad) ?? 1,
    unidad: it.unidad || 'u',
    precioUnitario: num(it.precio_unitario) ?? 0,
    subtotal: num(it.subtotal) ?? 0,
  })),
  ocr: { confianza: conf, payload: r },
};
return [{ json: { chatId: $('Elegir archivo').item.json.chatId, body } }];
```

## 9. POST al programa
Node **HTTP Request** · POST `{{$vars.STA_API_URL}}/api/v1/ingest/facturas`
- Auth: credencial **STA Ingesta** · Body: JSON = `{{ $json.body }}`.
- **Settings → Continue On Fail: ON** + **Retry On Fail: 3, espera 5s** (cubre que el API arranque después que n8n tras un corte).

## 10. Responder por Telegram
Node **IF** sobre el statusCode / cuerpo:
- `201` → «✅ Factura de *{{proveedor}}* por $*{{total}}* cargada. Revisala y aceptala en el sistema.»
- cuerpo con `duplicate:true` → «ℹ️ Esa factura ya estaba cargada.»
- error/4xx/5xx → «⚠️ No pude cargar la factura. Reintentá o cargala a mano.»

> **Idempotencia**: el endpoint deduplica por `adjunto.hash` (misma foto) y por
> `proveedor+puntoVenta+numero+tipo` (misma factura re-fotografiada) → devuelve
> `200 {duplicate:true}` en vez de duplicar. n8n puede reintentar sin miedo.

---

## Dev local (Portugal) — probar sin S1

1. Levantá la API local apuntando al espejo, con el token de ingesta:
   ```powershell
   cd "D:\ALEJO\Ai automation\SANTA TERESITA APP\apps\api"
   $env:DATABASE_URL='postgresql://teresita:teresita_dev_pwd@localhost:5432/teresita'
   $env:AUTH_SECRET='dev_secret_min_32_chars_0123456789'
   $env:AUDIT_HASH_SALT='dev_salt_0123456789'
   $env:INGEST_API_TOKEN='dev-ingest-token-0123456789abcdef'   # 24+ chars
   $env:API_PORT='3001'
   pnpm exec tsx src/server.ts
   ```
   (Necesitás el espejo docker arriba: `pnpm docker:up`.)
2. Probá el endpoint sin n8n (simula lo que postea el workflow) — debe dar `201`
   y la factura aparece en `/admin/facturas`:
   ```bash
   curl -s -X POST http://localhost:3001/api/v1/ingest/facturas \
     -H "Authorization: Bearer dev-ingest-token-0123456789abcdef" \
     -H "Content-Type: application/json" \
     -d '{
       "adjunto": { "hash": "prueba0000000000000000000000000000000000000000000000000000dev01" },
       "proveedor": { "nombre": "Distribuidora de Prueba SA", "cuit": "30-11111111-1" },
       "comprobante": { "tipo": "FACTURA_A", "puntoVenta": "0001", "numero": "00099999", "fechaEmision": "2026-06-18" },
       "montos": { "neto": 10000, "ivaTotal": 2100, "total": 12100 },
       "items": [ { "descripcion": "Harina 000 x 25kg", "cantidad": 4, "unidad": "bolsa", "precioUnitario": 2000, "subtotal": 8000 } ],
       "ocr": { "confianza": 0.93 }
     }'
   # → {"ok":true,"id":"...","estado":"PENDIENTE_VALIDACION","reviewPath":"/admin/facturas/..."}
   # Reenviar el mismo hash → {"duplicate":true,...} (idempotencia)
   ```
3. En n8n local, `STA_API_URL=http://localhost:3001` y `INGEST_API_TOKEN` = el de arriba.
4. Mandá una factura al bot → la factura aparece en `PENDIENTE_VALIDACION`,
   visible en `/admin/facturas` de tu `.exe`/web local.

## A producción (S1)
- Poné `INGEST_API_TOKEN` en el `.env` del server de S1 (hoy NO está → el endpoint responde 503) y reiniciá `sta-server`.
- Importá el workflow en el n8n de S1; `STA_API_URL=http://localhost:3001`.
- Bot real + whitelist de remitentes (paso 2).
