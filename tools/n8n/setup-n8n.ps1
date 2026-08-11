<#
.SYNOPSIS
  Instala n8n en S1 como servicio de Windows y deja el workflow de facturas
  por OCR listo para produccion. Un solo comando.

.DESCRIPTION
  Hace, en orden:
    1. Verifica Node 22 y NSSM.
    2. Instala n8n global.
    3. Instala el nodo oficial de LlamaCloud (community node).
    4. Genera (o reusa) la clave de cifrado de n8n.
    5. Escribe el archivo de entorno con los tokens.
    6. Importa las credenciales y el workflow.
    7. Registra el servicio `n8n` con NSSM (arranca solo tras corte de luz).
    8. Activa el workflow y arranca el servicio.
    9. Verifica que responde.

  IDEMPOTENTE: se puede volver a correr. Reusa la clave de cifrado existente
  (perderla inutiliza las credenciales guardadas) y re-importa el workflow
  sobreescribiendo la version anterior.

.PARAMETER TelegramBotToken
  Token del bot de @BotFather.

.PARAMETER TelegramAllowedIds
  IDs de Telegram que pueden usar el bot, separados por coma. SIN esto el bot
  no le contesta a nadie - un bot es publico y cualquiera puede escribirle.

.PARAMETER LlamaCloudApiKey
  API key de LlamaCloud (`llx-...`), de https://cloud.llamaindex.ai.

.PARAMETER IngestToken
  El INGEST_API_TOKEN del server (el mismo que esta en el .env de sta-server).

.EXAMPLE
  .\setup-n8n.ps1 -TelegramBotToken '123:ABC' -TelegramAllowedIds '111,222' `
                  -LlamaCloudApiKey 'llx-...' -IngestToken '...'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TelegramBotToken,
  [Parameter(Mandatory = $true)][string]$TelegramAllowedIds,
  [Parameter(Mandatory = $true)][string]$LlamaCloudApiKey,
  [Parameter(Mandatory = $true)][string]$IngestToken,
  [string]$IngestUrl = 'http://localhost:3001/api/v1/ingest/facturas',
  [string]$LlamaBaseUrl = 'https://api.cloud.llamaindex.ai',
  [string]$N8nDir    = 'C:\sta\n8n'
)

# ASCII PURO A PROPOSITO -- no agregues acentos ni guiones largos aca.
# Windows PowerShell 5.1 lee los .ps1 como ANSI (CP1252), no UTF-8. Un em-dash
# se decodifica como tres bytes, y el ultimo es la comilla tipografica de
# cierre, que PowerShell acepta como delimitador de string: cierra la comilla
# en medio de una frase y el parser explota lineas mas abajo con un
# MissingEndCurlyBrace que no tiene nada que ver. Pasado en S1, 2026-08-11.
$ErrorActionPreference = 'Stop'
function Paso($n, $txt) { Write-Host "`n[$n] $txt" -ForegroundColor Cyan }
function Ok($txt)       { Write-Host "    OK  $txt" -ForegroundColor Green }
function Aviso($txt)    { Write-Host "    !   $txt" -ForegroundColor Yellow }

# -- 1. Prerequisitos ---------------------------------------------------
Paso 1 'Verificando prerequisitos'

$node = (& node --version 2>$null)
if (-not $node) { throw 'Node no esta instalado o no esta en el PATH.' }
$major = [int]($node -replace '^v(\d+)\..*$', '$1')
if ($major -lt 20) { throw "n8n necesita Node 20+. Encontre $node." }
Ok "Node $node"

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue)
if (-not $nssm) {
  throw @'
NSSM no esta instalado. Es lo que hace que n8n arranque solo tras un corte de luz.
Instalalo con:  choco install nssm -y      (o bajalo de https://nssm.cc)
'@
}
Ok 'NSSM presente'

# El API tiene que estar arriba: si no, el workflow importa igual pero la
# primera factura va a fallar y no se va a entender por que.
try {
  $salud = Invoke-RestMethod -Uri 'http://localhost:3001/api/v1/health' -TimeoutSec 5
  Ok 'API del server respondiendo'
} catch {
  Aviso 'El API (localhost:3001) no responde. n8n se instala igual, pero arranca sta-server antes de mandar la primera factura.'
}

# -- 2. n8n -------------------------------------------------------------
Paso 2 'Instalando n8n'
$yaEsta = (& npm ls -g --depth=0 2>$null | Select-String -Pattern '\bn8n@')
if ($yaEsta) {
  Ok "Ya instalado: $($yaEsta.ToString().Trim())"
} else {
  & npm install -g n8n
  if ($LASTEXITCODE -ne 0) { throw 'Fallo npm install -g n8n' }
  Ok 'n8n instalado'
}

New-Item -ItemType Directory -Force -Path $N8nDir | Out-Null

# -- 3. Nodo de LlamaCloud ----------------------------------------------
# Es un community node: n8n los carga desde <userFolder>\.n8n\nodes\node_modules.
# Instalarlo por npm ahi es la via manual documentada - equivale a apretar
# "Install" en el panel, y funciona headless (que es como corre el servicio).
Paso 3 'Instalando el nodo de LlamaCloud'
$nodesDir = Join-Path $N8nDir '.n8n\nodes'
New-Item -ItemType Directory -Force -Path $nodesDir | Out-Null
Push-Location $nodesDir
try {
  # Rango ^6.7.2: la version contra la que se armo el workflow. Un major nuevo
  # podria renombrar parametros del nodo y romperlo en silencio.
  & npm install '@llamaindex/n8n-nodes-llamacloud@^6.7.2' --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Fallo la instalacion del nodo de LlamaCloud' }
} finally {
  Pop-Location
}
$nodePkg = Join-Path $nodesDir 'node_modules\@llamaindex\n8n-nodes-llamacloud\package.json'
if (-not (Test-Path $nodePkg)) {
  throw "El nodo no quedo en $nodesDir. Instalalo desde el panel de n8n (Settings -> Community nodes -> @llamaindex/n8n-nodes-llamacloud)."
}
Ok "Nodo LlamaParse Platform v$((Get-Content $nodePkg -Raw | ConvertFrom-Json).version)"

# -- 4. Clave de cifrado ------------------------------------------------
Paso 4 'Clave de cifrado'
$claveFile = Join-Path $N8nDir 'encryption-key.txt'
if (Test-Path $claveFile) {
  $clave = (Get-Content $claveFile -Raw).Trim()
  Ok 'Reusando la clave existente (cambiarla inutilizaria las credenciales guardadas)'
} else {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $clave = [Convert]::ToBase64String($bytes)
  # -Encoding ascii a proposito: utf8 en Windows PowerShell escribe BOM, y 3
  # bytes invisibles al principio de la clave la vuelven otra clave.
  Set-Content -Path $claveFile -Value $clave -Encoding ascii -NoNewline
  Ok 'Clave nueva generada'
  Aviso "GUARDA UNA COPIA de $claveFile - sin ella, las credenciales de n8n no se pueden descifrar."
}

# -- 5. Entorno ---------------------------------------------------------
Paso 5 'Escribiendo el entorno'
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
N8N_COMMUNITY_PACKAGES_ENABLED=true
TELEGRAM_BOT_TOKEN=$TelegramBotToken
TELEGRAM_ALLOWED_IDS=$TelegramAllowedIds
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

# -- 6. Credenciales + workflow -----------------------------------------
Paso 6 'Importando credenciales y workflow'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$wf   = Join-Path $aqui 'workflow-facturas-ocr.json'
if (-not (Test-Path $wf)) { throw "No encuentro $wf" }

# Las credenciales van en un temporal que se borra si o si: n8n las cifra al
# importarlas, pero el archivo plano no puede quedar en disco.
$credFile = Join-Path $env:TEMP "n8n-creds-$([guid]::NewGuid()).json"
try {
  # 'llamaParseApi' es el tipo que define el community node del paso 3 - por eso
  # se instala ANTES de importar: si no, n8n no sabe que es esta credencial.
  @(
    @{ name = 'LlamaParse API'; type = 'llamaParseApi';
       data = @{ apiKey = $LlamaCloudApiKey; baseURL = $LlamaBaseUrl } },
    @{ name = 'Ingesta STA';    type = 'httpHeaderAuth';
       data = @{ name = 'Authorization'; value = "Bearer $IngestToken" } }
  ) | ConvertTo-Json -Depth 5 | Set-Content -Path $credFile -Encoding utf8

  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+)=(.*)$') {
      [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), 'Process')
    }
  }

  & n8n import:credentials --input="$credFile"
  if ($LASTEXITCODE -ne 0) { throw 'Fallo import:credentials' }
  Ok 'Credenciales importadas (cifradas por n8n)'

  & n8n import:workflow --input="$wf"
  if ($LASTEXITCODE -ne 0) { throw 'Fallo import:workflow' }
  Ok 'Workflow importado'
} finally {
  if (Test-Path $credFile) { Remove-Item $credFile -Force }
}

# -- 7. Servicio --------------------------------------------------------
Paso 7 'Registrando el servicio'
$existe = (& nssm status n8n 2>$null)
if ($existe) {
  & nssm stop n8n 2>$null | Out-Null
  Ok 'Servicio existente detenido'
} else {
  $n8nCmd = (Get-Command n8n).Source
  & nssm install n8n $n8nCmd start
  if ($LASTEXITCODE -ne 0) { throw 'Fallo nssm install' }
}
& nssm set n8n AppDirectory $N8nDir              | Out-Null
& nssm set n8n AppEnvironmentExtra (Get-Content $envFile) | Out-Null
& nssm set n8n Start SERVICE_AUTO_START          | Out-Null
& nssm set n8n AppStdout (Join-Path $N8nDir 'n8n.log')     | Out-Null
& nssm set n8n AppStderr (Join-Path $N8nDir 'n8n.err.log') | Out-Null
& nssm set n8n AppRotateFiles 1                  | Out-Null
& nssm set n8n AppRotateBytes 10485760           | Out-Null
# Reinicio automatico: si n8n muere, vuelve solo.
& nssm set n8n AppExit Default Restart           | Out-Null
& nssm set n8n AppRestartDelay 5000              | Out-Null
Ok 'Servicio configurado (arranque automatico + reinicio ante caida)'

& nssm start n8n | Out-Null
Start-Sleep -Seconds 8

# -- 8. Activar el workflow ---------------------------------------------
Paso 8 'Activando el workflow'
& n8n update:workflow --all --active=true
if ($LASTEXITCODE -ne 0) {
  Aviso 'No pude activarlo por CLI. Activalo a mano en http://localhost:5678'
} else {
  Ok 'Workflow activo'
}
& nssm restart n8n | Out-Null
Start-Sleep -Seconds 8

# -- 9. Verificacion ----------------------------------------------------
Paso 9 'Verificando'
$estado = (& nssm status n8n)
if ($estado -match 'SERVICE_RUNNING') { Ok 'Servicio corriendo' }
else { Aviso "Estado del servicio: $estado - mira $N8nDir\n8n.err.log" }

try {
  Invoke-WebRequest -Uri 'http://127.0.0.1:5678/healthz' -TimeoutSec 10 -UseBasicParsing | Out-Null
  Ok 'n8n responde en http://localhost:5678'
} catch {
  Aviso "n8n todavia no responde. Espera unos segundos y mira $N8nDir\n8n.err.log"
}

# El bot tiene que existir y el token ser valido - se chequea aca y no cuando
# la encargada mande la primera factura.
try {
  $me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$TelegramBotToken/getMe" -TimeoutSec 10
  if ($me.ok) { Ok "Bot de Telegram: @$($me.result.username)" }
  else { Aviso 'El token del bot no valido.' }
} catch {
  Aviso 'No pude verificar el bot de Telegram (sin internet?).'
}

# La API key tambien se valida aca y no cuando llegue la primera factura.
try {
  Invoke-RestMethod -Uri "$LlamaBaseUrl/api/v1/projects" -TimeoutSec 15 `
    -Headers @{ Authorization = "Bearer $LlamaCloudApiKey"; Accept = 'application/json' } | Out-Null
  Ok 'API key de LlamaCloud valida'
} catch {
  Aviso "La API key de LlamaCloud no valido contra $LlamaBaseUrl/api/v1/projects. Revisala en https://cloud.llamaindex.ai"
}

Write-Host "`n=== Listo ===" -ForegroundColor Green
Write-Host @"
  Panel de n8n : http://localhost:5678   (solo desde S1 o por Tailscale)
  Logs         : $N8nDir\n8n.log
  Entorno      : $envFile

  PROBALO: mandale una foto de una factura al bot desde una cuenta que este
  en -TelegramAllowedIds. El workflow poletea cada minuto, asi que puede
  tardar hasta 60s en contestar.

  La factura entra como SIN VALIDAR en Admin -> Facturas. No mueve plata
  hasta que un humano la revise y la acepte.
"@ -ForegroundColor Gray
