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
  Quienes pueden usar el bot, separados por coma. Vale el ID numerico o el
  @usuario ('111,@julio'). SIN esto el bot no le contesta a nadie - un bot es
  publico y cualquiera puede escribirle.
  Preferir el ID numerico: el @usuario se puede soltar y otro tomarlo.

.PARAMETER LlamaCloudApiKey
  API key de LlamaCloud (`llx-...`), de https://cloud.llamaindex.ai.

.PARAMETER IngestToken
  El INGEST_API_TOKEN del server (el mismo que esta en el .env de sta-server).

.EXAMPLE
  .\setup-n8n.ps1 -TelegramBotToken '123:ABC' -TelegramAllowedIds '111,@julio' `
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

# Un comando nativo que escribe en stderr ABORTA el script cuando
# $ErrorActionPreference = 'Stop' y su stderr esta redirigido: PowerShell
# convierte cada linea de stderr en un ErrorRecord. El `2>$null` no protege,
# es justamente lo que dispara la conversion. Paso con `nssm status n8n`
# cuando el servicio todavia no existe: nssm escribe "Can't open service!",
# que es la respuesta CORRECTA a lo que le estabamos preguntando, y el script
# moria ahi. Esta helper baja la preferencia solo mientras corre el comando.
function Nativo([scriptblock]$Bloque) {
  $previo = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Bloque 2>&1 } finally { $ErrorActionPreference = $previo }
}

# Esperar a que n8n conteste, en vez de dormir un rato fijo y preguntar una
# sola vez. Arrancar n8n lleva bastante mas que unos segundos (migraciones de
# su base + carga del community node), asi que el chequeo temprano reportaba
# "no responde" sobre un n8n que un rato despues levantaba perfecto: un aviso
# que asustaba sin que pasara nada.
function Esperar-N8n([int]$Segundos = 120) {
  $fin = (Get-Date).AddSeconds($Segundos)
  while ((Get-Date) -lt $fin) {
    try {
      Invoke-WebRequest -Uri 'http://127.0.0.1:5678/healthz' -TimeoutSec 5 -UseBasicParsing | Out-Null
      return $true
    } catch { Start-Sleep -Seconds 3 }
  }
  return $false
}

# -- 1. Prerequisitos ---------------------------------------------------
Paso 1 'Verificando prerequisitos'

$node = (Nativo { & node --version })
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
  # /health va en la RAIZ, no bajo /api/v1 (server.ts lo registra sobre `app`,
  # antes del prefijo). Con la URL equivocada esto daba 404 y el script avisaba
  # "el API no responde" con sta-server corriendo perfecto.
  $salud = Invoke-RestMethod -Uri 'http://localhost:3001/health' -TimeoutSec 5
  Ok 'API del server respondiendo'
} catch {
  Aviso 'El API (localhost:3001) no responde: el servicio sta-server esta caido.'
  Aviso 'n8n se instala igual, pero la ULTIMA llamada del workflow va ahi, asi que'
  Aviso 'las facturas van a fallar al final. Arrancalo con:  nssm start sta-server'
}

# -- 2. n8n -------------------------------------------------------------
Paso 2 'Instalando n8n'
$yaEsta = (Nativo { & npm ls -g --depth=0 } | Select-String -Pattern '\bn8n@')
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
# N8N_BLOCK_ENV_ACCESS_IN_NODE=false: n8n bloquea $env dentro de los Code
# nodes por defecto, y los 4 nodos del workflow leen de ahi el token del bot,
# la lista blanca y la URL de ingesta. Sin esto el workflow falla en 11ms con
# "access to env vars denied", cada minuto, para siempre.
#
# CONTRAPARTIDA REAL: habilitarlo deja que CUALQUIER Code node de CUALQUIER
# workflow lea TODO el entorno del proceso, incluido N8N_ENCRYPTION_KEY (la
# que descifra las credenciales guardadas). n8n no ofrece lista blanca por
# variable. Se acepta porque el panel escucha solo en 127.0.0.1 y esta en S1:
# para escribir un Code node malicioso ya hay que tener la maquina, y con la
# maquina el n8n.env se lee igual. Si algun dia el panel se expone a la LAN,
# esto hay que revisarlo.
#
# NODE_FUNCTION_ALLOW_BUILTIN=crypto: la otra restriccion del sandbox. El Code
# node corre en el task runner, que arranca con la lista de modulos builtin
# VACIA (js-task-runner: allowedBuiltInModules = ''), asi que "Bajar archivo"
# moria con "Module 'crypto' is disallowed" DESPUES de haber bajado la foto.
# Se habilita solo 'crypto' y solo para el sha256 del archivo. A diferencia de
# la de arriba, esta no expone nada: es una libreria de hashing, y quien pueda
# editar un Code node ya tiene todo el entorno por la variable anterior.
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
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
NODE_FUNCTION_ALLOW_BUILTIN=crypto
TELEGRAM_BOT_TOKEN=$TelegramBotToken
TELEGRAM_ALLOWED_IDS=$TelegramAllowedIds
INGEST_URL=$IngestUrl
"@ | Set-Content -Path $envFile -Encoding ascii

# El archivo tiene tokens: solo Administradores y SYSTEM.
# Por SID y NO por nombre: 'BUILTIN\Administrators' no existe en un Windows en
# espanol (ahi es 'BUILTIN\Administradores') y AddAccessRule tira
# IdentityNotMappedException. Los SIDs son iguales en todos los idiomas.
#   S-1-5-32-544 = grupo local Administradores
#   S-1-5-18     = SYSTEM (la cuenta con la que corre el servicio NSSM)
$acl = Get-Acl $envFile
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-32-544', 'S-1-5-18')) {
  $id = New-Object System.Security.Principal.SecurityIdentifier($sid)
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
  # El 'id' es obligatorio: n8n 2.x NO lo genera al importar y la insercion
  # revienta con "NOT NULL constraint failed: credentials_entity.id". Van
  # fijos (no aleatorios) para que re-correr esto ACTUALICE la credencial en
  # vez de crear una nueva, y para que el workflow pueda referenciarlas por id.
  # Los mismos ids estan en workflow-facturas-ocr.json: si cambias uno, cambia
  # el otro o los nodos quedan sin credencial asignada.
  $credJson = @(
    @{ id = 'staLlamaParse001'; name = 'LlamaParse API'; type = 'llamaParseApi';
       data = @{ apiKey = $LlamaCloudApiKey; baseURL = $LlamaBaseUrl } },
    @{ id = 'staIngestaSTA001'; name = 'Ingesta STA';    type = 'httpHeaderAuth';
       data = @{ name = 'Authorization'; value = "Bearer $IngestToken" } }
  ) | ConvertTo-Json -Depth 5
  # WriteAllText con UTF8Encoding($false) = SIN BOM. `Set-Content -Encoding utf8`
  # en Windows PowerShell 5.1 escribe BOM (3 bytes invisibles al principio), y
  # el parser de JSON de Node se atraganta: "Unexpected token ... is not valid
  # JSON", sin decir que el problema es el encoding. Pasado en S1, 2026-08-12.
  [System.IO.File]::WriteAllText(
    $credFile, $credJson, (New-Object System.Text.UTF8Encoding($false)))

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
# Get-Service y no `nssm status`: es un cmdlet, no escribe en stderr, y con
# -ErrorAction SilentlyContinue devuelve $null limpio si el servicio no existe.
# NSSM tiene que arrancar un EJECUTABLE de verdad. `Get-Command n8n` devuelve
# el shim .cmd/.ps1 que crea npm: NSSM lo lanza, el shim arranca node como
# proceso HIJO y termina, NSSM ve morir el proceso que vigilaba y deja el
# servicio en Stopped. Hay que apuntar a node.exe + el .js real de n8n.
$nodeExe = (Get-Command node).Source
$npmRoot = (Nativo { & npm root -g } | Select-Object -Last 1).ToString().Trim()
$n8nJs   = Join-Path $npmRoot 'n8n\bin\n8n'
if (-not (Test-Path $n8nJs)) { throw "No encuentro el entrypoint de n8n en $n8nJs" }

$existe = Get-Service -Name n8n -ErrorAction SilentlyContinue
if ($existe) {
  Nativo { & nssm stop n8n } | Out-Null
  Ok 'Servicio existente detenido'
} else {
  & nssm install n8n $nodeExe
  if ($LASTEXITCODE -ne 0) { throw 'Fallo nssm install' }
}
# Application/AppParameters se setean SIEMPRE, no solo al instalar: asi una
# instalacion previa mal registrada (apuntando al shim) se corrige sola al
# volver a correr el script.
& nssm set n8n Application $nodeExe          | Out-Null
& nssm set n8n AppParameters "`"$n8nJs`" start" | Out-Null
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

Nativo { & nssm start n8n } | Out-Null

# -- 8. Activar el workflow ---------------------------------------------
Paso 8 'Activando el workflow'
# `update:workflow --all` esta deprecado: en n8n 2.x IMPRIME que ya no publica
# nada pero SALE CON CODIGO 0, asi que chequear solo $LASTEXITCODE daba un "OK
# Workflow activo" falso con el workflow desactivado. Se usa publish:workflow
# --id y ademas se mira la salida, no solo el codigo de salida.
# El id es el mismo de workflow-facturas-ocr.json.
$salidaPub = (Nativo { & n8n publish:workflow --id=staFacturasOCR01 } | Out-String)
if ($salidaPub.Trim()) { Write-Host $salidaPub.Trim() }
if ($LASTEXITCODE -ne 0 -or $salidaPub -match 'no longer supported|is deprecated|not found') {
  Aviso 'No quedo activo por CLI. Activalo a mano: http://localhost:5678 -> abri el workflow -> switch "Active" arriba a la derecha.'
} else {
  Ok 'Workflow activo'
}
# El restart NO es opcional: publish:workflow avisa que los cambios no toman
# efecto hasta reiniciar si n8n ya estaba corriendo.
Nativo { & nssm restart n8n } | Out-Null

# -- 9. Verificacion ----------------------------------------------------
Paso 9 'Verificando'
$svc = Get-Service -Name n8n -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') { Ok 'Servicio corriendo' }
else {
  $estado = if ($svc) { $svc.Status } else { 'el servicio no existe' }
  Aviso "Estado del servicio: $estado"
  # El log es lo unico que explica POR QUE no arranco. Mostrarlo aca ahorra
  # una vuelta entera de ida y vuelta con quien este instalando.
  $errLog = Join-Path $N8nDir 'n8n.err.log'
  if (Test-Path $errLog) {
    Write-Host "    --- ultimas 30 lineas de $errLog ---" -ForegroundColor Yellow
    Get-Content $errLog -Tail 30 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
  } else {
    # ${errLog} y no $errLog: en un string entrecomillado, "$var:" lo parsea
    # PowerShell como referencia con drive (la forma de $env:PATH) y el script
    # ni siquiera compila. Las llaves delimitan donde termina el nombre.
    Aviso "No existe ${errLog} - el proceso no llego ni a arrancar."
  }
}

Write-Host '    ... esperando a que n8n levante (puede tardar un minuto)' -ForegroundColor Gray
if (Esperar-N8n 120) {
  Ok 'n8n responde en http://localhost:5678'
} else {
  Aviso "n8n no respondio en 2 minutos. Mira $N8nDir\n8n.err.log"
}

# El bot tiene que existir y el token ser valido - se chequea aca y no cuando
# la encargada mande la primera factura.
try {
  $me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$TelegramBotToken/getMe" -TimeoutSec 10
  if ($me.ok) { Ok "Bot de Telegram: @$($me.result.username)" }
  else { Aviso 'El token del bot no valido.' }
} catch {
  # Telegram devuelve 404 cuando el token no existe. Distinguirlo de un
  # problema de red importa: decir "sin internet" cuando el token esta mal
  # manda a mirar el lugar equivocado (y encima la verificacion de LlamaCloud,
  # dos lineas mas abajo, prueba que internet hay).
  $codigo = $null
  if ($_.Exception.Response) { $codigo = [int]$_.Exception.Response.StatusCode }
  if ($codigo -eq 404) {
    Aviso 'Token del bot INVALIDO: Telegram devolvio 404. Genera uno nuevo con @BotFather y volve a correr esto.'
  } elseif ($codigo) {
    Aviso "Telegram respondio HTTP $codigo al validar el bot."
  } else {
    Aviso "No pude contactar api.telegram.org: $($_.Exception.Message)"
  }
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
