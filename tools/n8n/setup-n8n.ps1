<#
.SYNOPSIS
  Instala n8n en S1 como servicio de Windows y deja el workflow de facturas
  por OCR listo para producción. Un solo comando.

.DESCRIPTION
  Hace, en orden:
    1. Verifica Node 22 y NSSM.
    2. Instala n8n global.
    3. Genera (o reusa) la clave de cifrado de n8n.
    4. Escribe el archivo de entorno con los tokens.
    5. Registra el servicio `n8n` con NSSM (arranca solo tras corte de luz).
    6. Importa las credenciales y el workflow.
    7. Activa el workflow y arranca el servicio.
    8. Verifica que responde.

  IDEMPOTENTE: se puede volver a correr. Reusa la clave de cifrado existente
  (perderla inutiliza las credenciales guardadas) y re-importa el workflow
  sobreescribiendo la versión anterior.

.PARAMETER TelegramBotToken
  Token del bot de @BotFather.

.PARAMETER TelegramAllowedIds
  IDs de Telegram que pueden usar el bot, separados por coma. SIN esto el bot
  no le contesta a nadie — un bot es público y cualquiera puede escribirle.

.PARAMETER LlamaCloudApiKey
  API key de LlamaCloud (`llx-...`).

.PARAMETER IngestToken
  El INGEST_API_TOKEN del server (el mismo que está en el .env de sta-server).

.PARAMETER LlamaExtractUrl
  Endpoint de extracción de LlamaCloud. Ver la nota en docs/N8N-FACTURAS-OCR.md:
  hay que confirmarlo contra la cuenta porque la API cambió en la v2.

.EXAMPLE
  .\setup-n8n.ps1 -TelegramBotToken '123:ABC' -TelegramAllowedIds '111,222' `
                  -LlamaCloudApiKey 'llx-...' -IngestToken '...' `
                  -LlamaExtractUrl 'https://api.cloud.llamaindex.ai/api/v1/...'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TelegramBotToken,
  [Parameter(Mandatory = $true)][string]$TelegramAllowedIds,
  [Parameter(Mandatory = $true)][string]$LlamaCloudApiKey,
  [Parameter(Mandatory = $true)][string]$IngestToken,
  [Parameter(Mandatory = $true)][string]$LlamaExtractUrl,
  [string]$IngestUrl = 'http://localhost:3001/api/v1/ingest/facturas',
  [string]$N8nDir    = 'C:\sta\n8n'
)

$ErrorActionPreference = 'Stop'
function Paso($n, $txt) { Write-Host "`n[$n] $txt" -ForegroundColor Cyan }
function Ok($txt)       { Write-Host "    OK  $txt" -ForegroundColor Green }
function Aviso($txt)    { Write-Host "    !   $txt" -ForegroundColor Yellow }

# ── 1. Prerequisitos ───────────────────────────────────────────────────
Paso 1 'Verificando prerequisitos'

$node = (& node --version 2>$null)
if (-not $node) { throw 'Node no está instalado o no está en el PATH.' }
$major = [int]($node -replace '^v(\d+)\..*$', '$1')
if ($major -lt 20) { throw "n8n necesita Node 20+. Encontré $node." }
Ok "Node $node"

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue)
if (-not $nssm) {
  throw @'
NSSM no está instalado. Es lo que hace que n8n arranque solo tras un corte de luz.
Instalalo con:  choco install nssm -y      (o bajalo de https://nssm.cc)
'@
}
Ok 'NSSM presente'

# El API tiene que estar arriba: si no, el workflow importa igual pero la
# primera factura va a fallar y no se va a entender por qué.
try {
  $salud = Invoke-RestMethod -Uri 'http://localhost:3001/api/v1/health' -TimeoutSec 5
  Ok 'API del server respondiendo'
} catch {
  Aviso 'El API (localhost:3001) no responde. n8n se instala igual, pero arrancá sta-server antes de mandar la primera factura.'
}

# ── 2. n8n ─────────────────────────────────────────────────────────────
Paso 2 'Instalando n8n'
$yaEsta = (& npm ls -g --depth=0 2>$null | Select-String -Pattern '\bn8n@')
if ($yaEsta) {
  Ok "Ya instalado: $($yaEsta.ToString().Trim())"
} else {
  & npm install -g n8n
  if ($LASTEXITCODE -ne 0) { throw 'Falló npm install -g n8n' }
  Ok 'n8n instalado'
}

New-Item -ItemType Directory -Force -Path $N8nDir | Out-Null

# ── 3. Clave de cifrado ────────────────────────────────────────────────
Paso 3 'Clave de cifrado'
$claveFile = Join-Path $N8nDir 'encryption-key.txt'
if (Test-Path $claveFile) {
  $clave = (Get-Content $claveFile -Raw).Trim()
  Ok 'Reusando la clave existente (cambiarla inutilizaría las credenciales guardadas)'
} else {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $clave = [Convert]::ToBase64String($bytes)
  # -Encoding ascii a propósito: utf8 en Windows PowerShell escribe BOM, y 3
  # bytes invisibles al principio de la clave la vuelven otra clave.
  Set-Content -Path $claveFile -Value $clave -Encoding ascii -NoNewline
  Ok 'Clave nueva generada'
  Aviso "GUARDÁ UNA COPIA de $claveFile — sin ella, las credenciales de n8n no se pueden descifrar."
}

# ── 4. Entorno ─────────────────────────────────────────────────────────
Paso 4 'Escribiendo el entorno'
$envFile = Join-Path $N8nDir 'n8n.env'
@"
N8N_ENCRYPTION_KEY=$clave
N8N_USER_FOLDER=$N8nDir
GENERIC_TIMEZONE=America/Argentina/Buenos_Aires
TZ=America/Argentina/Buenos_Aires
N8N_PORT=5678
N8N_HOST=127.0.0.1
N8N_LISTEN_ADDRESS=127.0.0.1
N8N_DIAGNOSTICS_ENABLED=false
N8N_RUNNERS_ENABLED=true
TELEGRAM_BOT_TOKEN=$TelegramBotToken
TELEGRAM_ALLOWED_IDS=$TelegramAllowedIds
LLAMA_EXTRACT_URL=$LlamaExtractUrl
INGEST_URL=$IngestUrl
"@ | Set-Content -Path $envFile -Encoding ascii

# El archivo tiene tokens: solo Administradores y SYSTEM.
$acl = Get-Acl $envFile
$acl.SetAccessRuleProtection($true, $false)
foreach ($id in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $id, 'FullControl', 'Allow')))
}
Set-Acl -Path $envFile -AclObject $acl
Ok "Entorno en $envFile (solo Administradores y SYSTEM)"

# ── 5. Credenciales + workflow ─────────────────────────────────────────
Paso 5 'Importando credenciales y workflow'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$wf   = Join-Path $aqui 'workflow-facturas-ocr.json'
if (-not (Test-Path $wf)) { throw "No encuentro $wf" }

# Las credenciales van en un temporal que se borra sí o sí: n8n las cifra al
# importarlas, pero el archivo plano no puede quedar en disco.
$credFile = Join-Path $env:TEMP "n8n-creds-$([guid]::NewGuid()).json"
try {
  @(
    @{ name = 'LlamaCloud API'; type = 'httpHeaderAuth';
       data = @{ name = 'Authorization'; value = "Bearer $LlamaCloudApiKey" } },
    @{ name = 'Ingesta STA';    type = 'httpHeaderAuth';
       data = @{ name = 'Authorization'; value = "Bearer $IngestToken" } }
  ) | ConvertTo-Json -Depth 5 | Set-Content -Path $credFile -Encoding utf8

  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+)=(.*)$') {
      [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), 'Process')
    }
  }

  & n8n import:credentials --input="$credFile"
  if ($LASTEXITCODE -ne 0) { throw 'Falló import:credentials' }
  Ok 'Credenciales importadas (cifradas por n8n)'

  & n8n import:workflow --input="$wf"
  if ($LASTEXITCODE -ne 0) { throw 'Falló import:workflow' }
  Ok 'Workflow importado'
} finally {
  if (Test-Path $credFile) { Remove-Item $credFile -Force }
}

# ── 6. Servicio ────────────────────────────────────────────────────────
Paso 6 'Registrando el servicio'
$existe = (& nssm status n8n 2>$null)
if ($existe) {
  & nssm stop n8n 2>$null | Out-Null
  Ok 'Servicio existente detenido'
} else {
  $n8nCmd = (Get-Command n8n).Source
  & nssm install n8n $n8nCmd start
  if ($LASTEXITCODE -ne 0) { throw 'Falló nssm install' }
}
& nssm set n8n AppDirectory $N8nDir              | Out-Null
& nssm set n8n AppEnvironmentExtra (Get-Content $envFile) | Out-Null
& nssm set n8n Start SERVICE_AUTO_START          | Out-Null
& nssm set n8n AppStdout (Join-Path $N8nDir 'n8n.log')     | Out-Null
& nssm set n8n AppStderr (Join-Path $N8nDir 'n8n.err.log') | Out-Null
& nssm set n8n AppRotateFiles 1                  | Out-Null
& nssm set n8n AppRotateBytes 10485760           | Out-Null
# Reinicio automático: si n8n muere, vuelve solo.
& nssm set n8n AppExit Default Restart           | Out-Null
& nssm set n8n AppRestartDelay 5000              | Out-Null
Ok 'Servicio configurado (arranque automático + reinicio ante caída)'

& nssm start n8n | Out-Null
Start-Sleep -Seconds 8

# ── 7. Activar el workflow ─────────────────────────────────────────────
Paso 7 'Activando el workflow'
& n8n update:workflow --all --active=true
if ($LASTEXITCODE -ne 0) {
  Aviso 'No pude activarlo por CLI. Activalo a mano en http://localhost:5678'
} else {
  Ok 'Workflow activo'
}
& nssm restart n8n | Out-Null
Start-Sleep -Seconds 8

# ── 8. Verificación ────────────────────────────────────────────────────
Paso 8 'Verificando'
$estado = (& nssm status n8n)
if ($estado -match 'SERVICE_RUNNING') { Ok 'Servicio corriendo' }
else { Aviso "Estado del servicio: $estado — mirá $N8nDir\n8n.err.log" }

try {
  Invoke-WebRequest -Uri 'http://127.0.0.1:5678/healthz' -TimeoutSec 10 -UseBasicParsing | Out-Null
  Ok 'n8n responde en http://localhost:5678'
} catch {
  Aviso "n8n todavía no responde. Esperá unos segundos y mirá $N8nDir\n8n.err.log"
}

# El bot tiene que existir y el token ser válido — se chequea acá y no cuando
# la encargada mande la primera factura.
try {
  $me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$TelegramBotToken/getMe" -TimeoutSec 10
  if ($me.ok) { Ok "Bot de Telegram: @$($me.result.username)" }
  else { Aviso 'El token del bot no validó.' }
} catch {
  Aviso 'No pude verificar el bot de Telegram (¿sin internet?).'
}

Write-Host "`n═══ Listo ═══" -ForegroundColor Green
Write-Host @"
  Panel de n8n : http://localhost:5678   (solo desde S1 o por Tailscale)
  Logs         : $N8nDir\n8n.log
  Entorno      : $envFile

  PROBALO: mandale una foto de una factura al bot desde una cuenta que esté
  en -TelegramAllowedIds. El workflow poletea cada minuto, así que puede
  tardar hasta 60s en contestar.

  La factura entra como SIN VALIDAR en Admin → Facturas. No mueve plata
  hasta que un humano la revise y la acepte.
"@ -ForegroundColor Gray
