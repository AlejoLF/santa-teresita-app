<#
.SYNOPSIS
  Instala n8n en TU PC para armar y probar workflows a mano. NO es el de S1.

.DESCRIPTION
  El otro script (setup-n8n.ps1) deja n8n como servicio de Windows en el mini PC
  del local. Este es lo contrario: un n8n de banco de pruebas, que arranca cuando
  vos lo arrancas y se apaga con Ctrl+C. Sirve para configurar el workflow con
  el editor visual y despues exportarlo.

  Que hace:
    1. Verifica Node 22+.
    2. Instala n8n global (si ya esta, no lo toca).
    3. Instala el nodo de LlamaCloud (@llamaindex/n8n-nodes-llamacloud).
    4. Escribe un entorno en una carpeta APARTE (por default C:\sta\n8n-dev),
       para no pisar nada del n8n de S1.
    5. Importa el workflow del repo, si se lo pedis con -ImportarWorkflow.
    6. Arranca n8n y te deja el editor en http://localhost:5678

  ------------------------------------------------------------------------
   OJO: DOS n8n CONTRA EL MISMO BOT SE PISAN
  ------------------------------------------------------------------------
  Telegram deja UN solo getUpdates en vuelo por token. Si el n8n de S1 y el de
  tu PC poletean el mismo bot al mismo tiempo:
    - a uno lo corta con 409 (error instantaneo), y
    - al otro lo deja colgado hasta que el gateway lo mata con 504 a los 120s.
  Como el trigger dispara cada minuto, las ejecuciones se encavalgan y NO se
  recupera solo. Es exactamente el sintoma de "Error in 2m 0.6s" repetido.

  Por eso el script te obliga a elegir (ver -TelegramBotToken):
    a) usar un bot de prueba aparte, creado con @BotFather  <- recomendado
    b) o parar el de S1 antes:  nssm stop n8n   (y arrancarlo al terminar)

.PARAMETER TelegramBotToken
  Token del bot que va a usar ESTA instalacion. Usa uno de PRUEBA, distinto al
  de S1. Si de verdad queres el mismo, pasa tambien -MismoBotQueS1 y para el
  servicio de S1 primero.

.PARAMETER MismoBotQueS1
  Confirma que sabes que vas a usar el mismo bot que S1 y que ya lo paraste.

.PARAMETER LlamaCloudApiKey
  API key de LlamaCloud (llx-...). Opcional: sin ella el editor abre igual y la
  cargas a mano, pero el nodo de OCR no va a poder correr.

.PARAMETER IngestUrl
  A donde postea las facturas. En una PC de pruebas normalmente NO hay un
  sta-server escuchando, asi que por default apunta a un webhook de prueba
  vacio y vos lo cambias en el editor.

.PARAMETER ImportarWorkflow
  Importa tools/n8n/workflow-facturas-ocr.json como punto de partida.

.PARAMETER N8nDir
  Carpeta de datos. Default C:\sta\n8n-dev (aparte del de S1 a proposito).

.EXAMPLE
  # Lo tipico: bot de prueba propio, arrancando del workflow del repo
  .\setup-n8n-dev.ps1 -TelegramBotToken '123:ABC' -LlamaCloudApiKey 'llx-...' -ImportarWorkflow

.EXAMPLE
  # Solo levantar el editor, sin credenciales, para mirar/armar
  .\setup-n8n-dev.ps1 -TelegramBotToken 'no-usar'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TelegramBotToken,
  [string]$TelegramAllowedIds = '',
  [string]$LlamaCloudApiKey = '',
  # 127.0.0.1 y NO 'localhost': desde Node 17 'localhost' resuelve primero a
  # IPv6 (::1) y el API escucha en 0.0.0.0, que es solo IPv4 -> ECONNREFUSED.
  [string]$IngestUrl = 'http://127.0.0.1:3001/api/v1/ingest/facturas',
  [string]$N8nDir = 'C:\sta\n8n-dev',
  [switch]$MismoBotQueS1,
  [switch]$ImportarWorkflow,
  [switch]$NoArrancar
)

$ErrorActionPreference = 'Stop'
$paso = 0
function Paso([string]$t) { $script:paso++; Write-Host "`n[$script:paso] $t" -ForegroundColor Cyan }
function Ok([string]$t)    { Write-Host "    OK  $t" -ForegroundColor Green }
function Aviso([string]$t) { Write-Host "    !   $t" -ForegroundColor Yellow }

# Corre nativos sin que un stderr inocente aborte el script.
function Nativo([scriptblock]$Bloque) {
  $previo = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Bloque 2>&1 } finally { $ErrorActionPreference = $previo }
}

# Corre npm MOSTRANDO por que fallo.
#
# La primera version de esto mandaba la salida a Out-Null y, cuando npm fallaba,
# el script decia "Fallo npm install -g n8n" y nada mas: el error real
# (permisos, red, un modulo nativo) quedaba tapado justo cuando mas se
# necesitaba. Ahora se guarda todo en un log y se muestran las ultimas lineas.
# OJO con el nombre: NO se puede llamar "Npm". PowerShell no distingue
# mayusculas al resolver comandos, asi que adentro `& npm` volvia a entrar a
# esta misma funcion en vez de ejecutar el programa -> recursion infinita
# ("call depth overflow"). Por las dudas, ademas, se resuelve el ejecutable a
# mano con -CommandType Application.
function CorrerNpm([string]$Que, [string[]]$Argumentos, [string]$LogPath) {
  $npmExe = (Get-Command npm -CommandType Application -ErrorAction SilentlyContinue |
             Select-Object -First 1).Source
  if (-not $npmExe) { throw 'No encuentro npm en el PATH (viene con Node).' }
  $salida = Nativo { & $npmExe @Argumentos }
  $codigo = $LASTEXITCODE
  if ($LogPath) { $salida | Out-File -FilePath $LogPath -Encoding utf8 }
  if ($codigo -ne 0) {
    Write-Host "    npm salio con codigo $codigo. Ultimas lineas:" -ForegroundColor Yellow
    $salida | Select-Object -Last 25 | ForEach-Object {
      Write-Host "      $_" -ForegroundColor Gray
    }
    if ($LogPath) { Write-Host "    (salida completa en $LogPath)" -ForegroundColor Gray }
    $texto = ($salida | Out-String)
    # Las dos causas mas comunes en Windows, con el remedio al lado.
    if ($texto -match 'EACCES|EPERM|operation not permitted|Access is denied') {
      Aviso 'Parece un problema de PERMISOS: abri PowerShell como Administrador y repeti.'
    }
    if ($texto -match 'ETIMEDOUT|ENOTFOUND|ECONNRESET|network|proxy') {
      Aviso 'Parece un problema de RED/proxy llegando a registry.npmjs.org.'
    }
    if ($texto -match 'EBADENGINE|engine') {
      Aviso "Version de Node incompatible. n8n pide Node >=22.22 (tenes $nodeV)."
    }
  }
  return $codigo
}

Write-Host "`n=== n8n de PRUEBAS (tu PC) ===" -ForegroundColor Magenta
Write-Host "Datos en: $N8nDir  |  editor: http://localhost:5678" -ForegroundColor Gray

# -- 0. El choque de bots ------------------------------------------------
# Se chequea ANTES de instalar nada: es el error que mas tiempo hace perder,
# y no se manifiesta como un error de instalacion sino como ejecuciones que
# mueren a los 2 minutos, dias despues.
Paso 'Chequeando que no vayas a pisar el bot de S1'
$servicioS1 = Get-Service -Name 'n8n' -ErrorAction SilentlyContinue
if ($servicioS1 -and $servicioS1.Status -eq 'Running') {
  if (-not $MismoBotQueS1) {
    Aviso 'En ESTA maquina hay un servicio n8n corriendo (el de S1).'
    Aviso 'Si las dos instalaciones poletean el mismo bot, se pisan:'
    Aviso '  una recibe 409 y la otra queda colgada hasta el 504 de los 120s.'
    Aviso 'Usa un bot de prueba de @BotFather, o paralo:  nssm stop n8n'
  } else {
    Aviso 'Pediste usar el mismo bot que S1: PARA el servicio antes de probar.'
    Aviso '  nssm stop n8n     (y al terminar:  nssm start n8n)'
  }
} else {
  Ok 'No hay un servicio n8n corriendo en esta maquina'
}
if (-not $MismoBotQueS1) {
  Ok 'Recorda que este bot tiene que ser DISTINTO al de S1'
}

# -- 1. Node -------------------------------------------------------------
Paso 'Verificando Node'
$nodeV = (Nativo { & node -v } | Select-Object -Last 1).ToString().Trim()
if (-not $nodeV) { throw 'Node no esta instalado. Bajalo de https://nodejs.org (LTS 22+).' }
$mayor = [int](($nodeV -replace '^v', '') -split '\.')[0]
if ($mayor -lt 22) { throw "Node $nodeV es viejo. Hace falta 22 o mas." }
Ok "Node $nodeV"

# -- 2. n8n --------------------------------------------------------------
Paso 'Instalando n8n (puede tardar varios minutos la primera vez)'
$yaEsta = (Nativo { & npm ls -g --depth=0 n8n } | Out-String) -match '\bn8n@'
if ($yaEsta) {
  Ok 'n8n ya estaba instalado (no lo toco)'
} else {
  $log = Join-Path $env:TEMP 'n8n-install.log'
  $codigo = CorrerNpm 'n8n' @('install', '-g', 'n8n') $log
  if ($codigo -ne 0) {
    throw "npm install -g n8n fallo (codigo $codigo). Mira las lineas de arriba o $log"
  }
  Ok 'n8n instalado'
}

# -- 3. Carpeta de datos + nodo de LlamaCloud ----------------------------
# El nodo community se instala DENTRO de la carpeta de datos de n8n, no global:
# asi esta instalacion de pruebas queda aislada de la de S1.
Paso 'Preparando la carpeta de datos'
New-Item -ItemType Directory -Force -Path $N8nDir | Out-Null
$nodesDir = Join-Path $N8nDir '.n8n\nodes'
New-Item -ItemType Directory -Force -Path $nodesDir | Out-Null
Push-Location $nodesDir
try {
  if (-not (Test-Path (Join-Path $nodesDir 'package.json'))) {
    Nativo { & npm init -y } | Out-Null
  }
  $tieneLlama = Test-Path (Join-Path $nodesDir 'node_modules\@llamaindex\n8n-nodes-llamacloud')
  if ($tieneLlama) {
    Ok 'Nodo de LlamaCloud ya estaba'
  } else {
    $logLlama = Join-Path $env:TEMP 'n8n-llamacloud-install.log'
    $codigo = CorrerNpm 'LlamaCloud' @('install', '@llamaindex/n8n-nodes-llamacloud') $logLlama
    # No corta el script: sin este nodo el editor abre igual y se puede armar
    # todo lo demas. Solo el paso de OCR queda sin poder ejecutarse.
    if ($codigo -ne 0) { Aviso 'No se pudo instalar el nodo de LlamaCloud (seguis sin OCR)' }
    else { Ok 'Nodo de LlamaCloud instalado' }
  }
} finally { Pop-Location }

# -- 4. Entorno ----------------------------------------------------------
# Las dos variables del sandbox son las mismas que en S1: sin ellas los Code
# nodes fallan con "access to env vars denied" y "Module 'crypto' is disallowed".
# Ver docs/N8N-FACTURAS-OCR.md.
Paso 'Escribiendo el entorno'
$envFile = Join-Path $N8nDir 'n8n-dev.env'
@"
N8N_USER_FOLDER=$N8nDir
GENERIC_TIMEZONE=America/Argentina/Buenos_Aires
TZ=America/Argentina/Buenos_Aires
N8N_PORT=5678
N8N_HOST=127.0.0.1
N8N_LISTEN_ADDRESS=127.0.0.1
N8N_DIAGNOSTICS_ENABLED=false
N8N_RUNNERS_ENABLED=true
N8N_COMMUNITY_PACKAGES_ENABLED=true
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
NODE_FUNCTION_ALLOW_BUILTIN=crypto
TELEGRAM_BOT_TOKEN=$TelegramBotToken
TELEGRAM_ALLOWED_IDS=$TelegramAllowedIds
INGEST_URL=$IngestUrl
"@ | Set-Content -Path $envFile -Encoding ascii
Ok "Entorno en $envFile"

# Cargarlo en ESTA sesion de PowerShell (n8n lo lee del proceso).
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process')
  }
}

# -- 5. Credenciales y workflow (opcional) -------------------------------
if ($LlamaCloudApiKey) {
  Paso 'Importando la credencial de LlamaCloud'
  # IDs fijos: n8n 2.x no los genera solo al importar.
  $credJson = @(
    @{ id = 'staLlamaParseDev'; name = 'LlamaParse API'; type = 'llamaParseApi';
       data = @{ apiKey = $LlamaCloudApiKey; baseURL = 'https://api.cloud.llamaindex.ai' } }
  ) | ConvertTo-Json -Depth 5
  $tmp = Join-Path $env:TEMP ("n8n-cred-dev-{0}.json" -f ([guid]::NewGuid()))
  try {
    # WriteAllText sin BOM: Set-Content -Encoding utf8 en PS 5.1 lo agrega y
    # el import falla con "is not valid JSON".
    [System.IO.File]::WriteAllText($tmp, $credJson, (New-Object System.Text.UTF8Encoding($false)))
    Nativo { & n8n import:credentials --input="$tmp" } | Out-Null
    Ok 'Credencial importada'
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

if ($ImportarWorkflow) {
  Paso 'Importando el workflow del repo'
  $wf = Join-Path $PSScriptRoot 'workflow-facturas-ocr.json'
  if (-not (Test-Path $wf)) { throw "No encuentro $wf" }
  Nativo { & n8n import:workflow --input="$wf" } | Out-Null
  Ok 'Workflow importado (queda DESACTIVADO: lo activas vos desde el editor)'
  Aviso 'Si lo activas, va a poletear el bot que pusiste. No actives dos a la vez.'
}

# -- 6. Arrancar ---------------------------------------------------------
Write-Host "`n=== Listo ===" -ForegroundColor Green
Write-Host @"
  Editor   : http://localhost:5678
  Datos    : $N8nDir
  Entorno  : $envFile

  Para exportar lo que armes y traerlo al repo:
    n8n export:workflow --id=<id> --output=workflow-facturas-ocr.json
  (el id se ve en la URL del editor)

  Recorda: NO tengas este n8n y el de S1 poleando el mismo bot.
"@ -ForegroundColor Gray

if ($NoArrancar) {
  Write-Host "`nArrancalo cuando quieras con:  n8n start" -ForegroundColor Gray
} else {
  Write-Host "`nArrancando n8n. Ctrl+C para cortar.`n" -ForegroundColor Cyan
  & n8n start
}
