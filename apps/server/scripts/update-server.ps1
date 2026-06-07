# ====================================================================
#  Santa Teresita - AUTO-UPDATE del servidor local desde GitHub Releases
#
#  Chequea si hay una version nueva (release `server-v*`), y si la hay:
#  backup de la DB -> para el servicio -> reemplaza el codigo (api/migrations/
#  seed, NO toca .env ni la base) -> aplica migraciones nuevas -> reinicia ->
#  verifica /health. Si algo falla -> ROLLBACK al codigo anterior.
#
#  Uso (como Administrador, desde C:\sta-server):
#    .\update-server.ps1 -Install   # registra la tarea programada (4 AM diaria)
#    .\update-server.ps1            # chequea y actualiza si hay version nueva
#    .\update-server.ps1 -Force     # reinstala la ultima aunque sea la misma
#    .\update-server.ps1 -SetVersion 1.0.0   # marca la version actual sin actualizar
#
#  Idempotente y seguro: si no hay version nueva, no hace nada.
# ====================================================================
param(
  [switch]$Install,
  [switch]$Force,
  [string]$SetVersion
)

$ErrorActionPreference = 'Stop'

# -- Config --
$Repo        = 'AlejoLF/santa-teresita-app'
$ServerDir   = 'C:\sta-server'
$ServiceName = 'sta-server'
$LogDir      = Join-Path $ServerDir 'logs'
$LogFile     = Join-Path $LogDir 'update.log'
$VersionFile = Join-Path $ServerDir 'VERSION'
$BackupDir   = Join-Path $ServerDir 'backups'
$HealthUrl   = 'http://localhost:3001/health'
# Carpetas de codigo que se reemplazan en cada update (el resto NO se toca).
$CodeFolders = @('api', 'migrations', 'seed')

New-Item -ItemType Directory -Force -Path $LogDir, $BackupDir | Out-Null

function Log($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $LogFile -Value $line
  Write-Host $line
}

function Find-PgBin {
  $p = Get-ChildItem 'C:\Program Files\PostgreSQL\16\bin\psql.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { $p = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 }
  if (-not $p) { throw 'No encontre psql.exe' }
  return $p.DirectoryName
}

# ── -Install: registrar la tarea programada y salir ──
if ($Install) {
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ServerDir\update-server.ps1`""
  $trigger = New-ScheduledTaskTrigger -Daily -At 4am
  $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName 'STA Server Update' -Action $action -Trigger $trigger `
    -Settings $set -RunLevel Highest -User 'SYSTEM' -Force | Out-Null
  Log 'Tarea programada "STA Server Update" registrada (4 AM diaria, como SYSTEM).'
  Write-Host "OK: la tarea corre todos los dias 4 AM. Para probar ahora: .\update-server.ps1 -Force" -ForegroundColor Green
  exit 0
}

# ── -SetVersion: marcar version actual sin actualizar (para sincronizar) ──
if ($SetVersion) {
  Set-Content -Path $VersionFile -Value $SetVersion -NoNewline
  Log "VERSION marcada manualmente como $SetVersion (sin actualizar)."
  exit 0
}

Log "=== Chequeo de update ==="

# 1. Version instalada
$current = if (Test-Path $VersionFile) { (Get-Content $VersionFile -Raw).Trim() } else { '0.0.0' }
Log "Version actual: $current"

# 2. Ultimo release server-v* de GitHub
$headers = @{ 'User-Agent' = 'sta-server-updater'; 'Accept' = 'application/vnd.github+json' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
try {
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=30" -Headers $headers -TimeoutSec 30
} catch {
  Log "ERROR consultando GitHub: $($_.Exception.Message)"; exit 1
}
$serverRel = $releases | Where-Object { $_.tag_name -like 'server-v*' -and -not $_.draft } |
  Sort-Object { [datetime]$_.published_at } -Descending
$latest = $serverRel | Select-Object -First 1
if (-not $latest) { Log 'No hay releases server-v*. Nada que hacer.'; exit 0 }
$latestVer = ($latest.tag_name -replace '^server-v', '')
Log "Ultima disponible: $latestVer"

if (-not $Force -and $latestVer -eq $current) {
  Log "Ya estas en la ultima ($current). Nada que hacer."
  exit 0
}
Log "Actualizando $current -> $latestVer ..."

# 3. Bajar el asset .zip
$asset = $latest.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
if (-not $asset) { Log "El release $latestVer no tiene .zip. Aborto."; exit 1 }
$work = Join-Path $env:TEMP ("sta-update-" + $latestVer)
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null
$zip = Join-Path $work 'dist.zip'
Log "Descargando $($asset.name) ..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -Headers $headers -TimeoutSec 600
Expand-Archive -Path $zip -DestinationPath $work -Force

# Ubicar la raiz del dist dentro del extraido (api/server.mjs presente)
$newRoot = if (Test-Path (Join-Path $work 'api\server.mjs')) { $work }
           elseif (Test-Path (Join-Path $work 'dist\api\server.mjs')) { Join-Path $work 'dist' }
           else { $null }
if (-not $newRoot) { Log "El zip no tiene api/server.mjs. Aborto."; exit 1 }
foreach ($cf in $CodeFolders) {
  if (-not (Test-Path (Join-Path $newRoot $cf))) { Log "Al zip le falta la carpeta '$cf'. Aborto."; exit 1 }
}

# 4. Backup de la DB (pg_dump) — leyendo DATABASE_URL del .env
$pgBin = Find-PgBin
$envMap = @{}
Get-Content "$ServerDir\.env" | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $envMap[$matches[1]] = $matches[2] }
}
$dbUrl = $envMap['DATABASE_URL']
if ($dbUrl -notmatch '^postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?]+)') { Log "DATABASE_URL invalida en .env. Aborto."; exit 1 }
$pgUser=$matches[1]; $pgPass=$matches[2]; $pgHost=$matches[3]; $pgPort=$matches[4]; $pgDb=$matches[5]
$env:PGPASSWORD = $pgPass
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dumpFile = Join-Path $BackupDir "pre-update-$current-to-$latestVer-$stamp.dump"
Log "Backup de la DB -> $dumpFile"
& "$pgBin\pg_dump.exe" -w -h $pgHost -p $pgPort -U $pgUser -d $pgDb -F c -f $dumpFile
if ($LASTEXITCODE -ne 0) { Log "pg_dump fallo. Aborto (no toco nada)."; exit 1 }
# Podar backups viejos (dejar los ultimos 10)
Get-ChildItem $BackupDir -Filter '*.dump' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force -ErrorAction SilentlyContinue

# 5. Parar el servicio
Log "Parando servicio $ServiceName ..."
Stop-Service $ServiceName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 6. Swap del codigo: mover el actual a rollback/, copiar el nuevo
$rollback = Join-Path $work 'rollback'
New-Item -ItemType Directory -Force -Path $rollback | Out-Null
$swapped = @()
function Restore-Rollback {
  Log "ROLLBACK: restaurando codigo anterior..."
  foreach ($cf in $swapped) {
    $live = Join-Path $ServerDir $cf
    Remove-Item $live -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item (Join-Path $rollback $cf) $live -Force
  }
  # re-crear junction del seed por las dudas
  $seedNm = Join-Path $ServerDir 'seed\node_modules'
  if (-not (Test-Path $seedNm) -and (Test-Path (Join-Path $ServerDir 'api\node_modules'))) {
    New-Item -ItemType Junction -Path $seedNm -Target (Join-Path $ServerDir 'api\node_modules') -ErrorAction SilentlyContinue | Out-Null
  }
  Start-Service $ServiceName -ErrorAction SilentlyContinue
  Log "ROLLBACK hecho. Server quedo en la version $current. Backup DB: $dumpFile"
}

try {
  foreach ($cf in $CodeFolders) {
    $live = Join-Path $ServerDir $cf
    if (Test-Path $live) { Move-Item $live (Join-Path $rollback $cf) -Force }
    Copy-Item (Join-Path $newRoot $cf) $live -Recurse -Force
    $swapped += $cf
  }
  Log "Codigo nuevo copiado (api, migrations, seed). .env y DB intactos."

  # 7. Migraciones nuevas (idempotente, -w para no colgar, ON_ERROR_STOP)
  $psql = "$pgBin\psql.exe"
  & $psql -w -h $pgHost -p $pgPort -U $pgUser -d $pgDb -c "CREATE TABLE IF NOT EXISTS _prisma_migrations (id varchar(36) primary key, migration_name varchar(255) not null, finished_at timestamptz, applied_steps_count int not null default 1);" | Out-Null
  $applied = 0
  Get-ChildItem (Join-Path $ServerDir 'migrations\*.sql') | Sort-Object Name | ForEach-Object {
    $n = $_.BaseName
    $done = & $psql -w -tAc "SELECT 1 FROM _prisma_migrations WHERE migration_name='$n'" -h $pgHost -p $pgPort -U $pgUser -d $pgDb
    if ($done -eq '1') { return }
    Log "  aplicando migracion: $n"
    & $psql -w -v ON_ERROR_STOP=1 -f $_.FullName -h $pgHost -p $pgPort -U $pgUser -d $pgDb
    if ($LASTEXITCODE -ne 0) { throw "Migracion $n FALLO" }
    & $psql -w -c "INSERT INTO _prisma_migrations (id,migration_name,finished_at) VALUES ('$([guid]::NewGuid())','$n',now());" -h $pgHost -p $pgPort -U $pgUser -d $pgDb | Out-Null
    $applied++
  }
  Log "Migraciones nuevas aplicadas: $applied"

  # 8. Arrancar + verificar /health (varios reintentos)
  Start-Service $ServiceName
  $ok = $false
  foreach ($i in 1..15) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
      if ($r.ok) { $ok = $true; break }
    } catch {}
  }
  if (-not $ok) { throw "El server no respondio OK en /health tras el update" }

  # 9. Exito: marcar version + limpiar
  Set-Content -Path $VersionFile -Value $latestVer -NoNewline
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  Log "=== UPDATE OK: ahora en v$latestVer (migraciones nuevas: $applied) ==="
  exit 0

} catch {
  Log "ERROR durante el update: $($_.Exception.Message)"
  Restore-Rollback
  Log "El backup de la DB quedo en: $dumpFile (restaurar a mano solo si hace falta)."
  exit 1
}
