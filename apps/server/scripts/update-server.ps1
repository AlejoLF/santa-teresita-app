# ====================================================================
#  Santa Teresita - AUTO-UPDATE del servidor local desde GitHub Releases
#
#  Chequea si hay una version nueva (release `server-v*`), y si la hay:
#  backup de la DB -> para el servicio -> reemplaza el codigo (api/migrations/
#  seed) + los scripts .ps1 -> re-sincroniza el env de NSSM desde .env ->
#  aplica migraciones nuevas -> reinicia -> verifica /health. Si algo falla
#  -> ROLLBACK al codigo anterior.
#
#  DOS CANALES de actualizacion (se instalan juntos con -Install):
#    * Nocturno (tarea "STA Server Update", 4 AM): aplica CUALQUIER version
#      nueva. Es el camino normal -> los updates esperan a la madrugada,
#      con el local cerrado, sin interrumpir ventas.
#    * Inmediato (tarea "STA Server Update NOW", cada 5 min, modo -Now):
#      aplica SOLO los releases marcados como inmediatos (publicados con
#      `release --now`). Sirve para pushear un hotfix y que entre en
#      minutos, SIN AnyDesk -> solo pusheas a GitHub.
#
#  Uso (como Administrador, desde C:\sta-server):
#    .\update-server.ps1 -Install        # registra las 2 tareas (nocturna + inmediata)
#    .\update-server.ps1                  # chequea y actualiza si hay version nueva
#    .\update-server.ps1 -Now             # aplica SOLO si el ultimo release es inmediato
#    .\update-server.ps1 -Force           # reinstala la ultima aunque sea la misma
#    .\update-server.ps1 -SyncEnv         # re-sincroniza NSSM env desde .env y reinicia
#    .\update-server.ps1 -SetVersion 1.0.0  # marca la version actual sin actualizar
#
#  Idempotente y seguro: si no hay version nueva, no hace nada.
# ====================================================================
param(
  [switch]$Install,
  [switch]$Force,
  [switch]$Now,        # modo poll inmediato: solo aplica releases marcados STA_DEPLOY_NOW
  [switch]$SyncEnv,    # solo re-sincroniza NSSM AppEnvironmentExtra desde .env y reinicia
  [string]$SetVersion
)

$ErrorActionPreference = 'Stop'
# Apagar la barra de progreso: Invoke-WebRequest en PS 5.1 con el progreso
# activado (default) es 10-50x mas lento — convertia la descarga de ~28 MB del
# asset de segundos a 20+ minutos. Se hereda por todo el script (ver download).
$ProgressPreference = 'SilentlyContinue'

# -- Config --
$Repo            = 'AlejoLF/santa-teresita-app'
$ServerDir       = 'C:\sta-server'
$ServiceName     = 'sta-server'
$LogDir          = Join-Path $ServerDir 'logs'
$LogFile         = Join-Path $LogDir 'update.log'
$VersionFile     = Join-Path $ServerDir 'VERSION'
$BackupDir       = Join-Path $ServerDir 'backups'
$LockFile        = Join-Path $ServerDir 'update.lock'
$HealthUrl       = 'http://localhost:3001/health'
# Marcador que un release lleva en su body para que el canal INMEDIATO lo aplique
# (lo pone `release.mjs --now`). El canal nocturno ignora el marcador (aplica todo).
$ImmediateMarker = 'STA_DEPLOY_NOW'
# Carpetas de codigo que se reemplazan en cada update (el resto NO se toca).
$CodeFolders     = @('api', 'migrations', 'seed')
# Nombres de las tareas programadas.
$TaskNightly     = 'STA Server Update'
$TaskImmediate   = 'STA Server Update NOW'

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

# Ubica nssm.exe (winget/choco/Program Files). Devuelve $null si no esta.
function Find-Nssm {
  $c = Get-Command nssm -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $cands = @(
    'C:\ProgramData\chocolatey\bin\nssm.exe',
    'C:\Program Files\nssm\win64\nssm.exe',
    'C:\Program Files\nssm\nssm.exe',
    'C:\Program Files\WinGet\Links\nssm.exe'
  )
  foreach ($p in $cands) { if (Test-Path $p) { return $p } }
  $wg = Get-ChildItem 'C:\Users\*\AppData\Local\Microsoft\WinGet\Links\nssm.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($wg) { return $wg.FullName }
  return $null
}

# Re-pushea el .env al AppEnvironmentExtra de NSSM. NSSM congela el env al
# registrar el servicio; editar .env no alcanza (dotenv NO pisa lo que NSSM ya
# inyecto en process.env). Esto refresca ese snapshot. Non-fatal si no hay nssm.
function Sync-NssmEnv {
  $nssm = Find-Nssm
  if (-not $nssm) { Log 'WARN: no encontre nssm.exe -> salteo re-sync de env (NSSM queda como estaba).'; return }
  $envPath = Join-Path $ServerDir '.env'
  if (-not (Test-Path $envPath)) { Log 'WARN: no hay .env -> salteo re-sync de env.'; return }
  $envLines = (Get-Content $envPath | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' })
  & $nssm set $ServiceName AppEnvironmentExtra ($envLines -join "`r`n") | Out-Null
  Log "NSSM AppEnvironmentExtra re-sincronizado desde .env ($($envLines.Count) vars)."
}

# Registra (idempotente, -Force) las 2 tareas: nocturna 4 AM + inmediata cada 5 min.
function Ensure-Tasks {
  $exe = 'powershell.exe'
  # -- Nocturna: aplica cualquier version nueva --
  $actN = New-ScheduledTaskAction -Execute $exe `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ServerDir\update-server.ps1`""
  $trgN = New-ScheduledTaskTrigger -Daily -At 4am
  $setN = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -MultipleInstances IgnoreNew -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName $TaskNightly -Action $actN -Trigger $trgN `
    -Settings $setN -RunLevel Highest -User 'SYSTEM' -Force | Out-Null

  # -- Inmediata: cada 5 min, modo -Now (solo releases marcados) --
  $actNow = New-ScheduledTaskAction -Execute $exe `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ServerDir\update-server.ps1`" -Now"
  # Truco PS 5.1 para repeticion indefinida: arrancar -Once y "prestar" la
  # Repetition de un trigger auxiliar (evita el bug de [TimeSpan]::MaxValue).
  $start = (Get-Date).AddMinutes(2)
  $trgNow = New-ScheduledTaskTrigger -Once -At $start
  $aux    = New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $trgNow.Repetition = $aux.Repetition
  $setNow = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskImmediate -Action $actNow -Trigger $trgNow `
    -Settings $setNow -RunLevel Highest -User 'SYSTEM' -Force | Out-Null
}

# Lock simple para que la tarea nocturna y la inmediata (o dos corridas) no
# apliquen un update en paralelo. Stale > 30 min se pisa (crash anterior).
function Acquire-Lock {
  if (Test-Path $LockFile) {
    $age = (Get-Date) - (Get-Item $LockFile).LastWriteTime
    if ($age.TotalMinutes -lt 30) {
      Log ("Otro update en progreso (lock de hace {0} min). Salgo." -f [int]$age.TotalMinutes)
      return $false
    }
    Log 'Lock viejo (> 30 min) -> lo piso.'
  }
  Set-Content -Path $LockFile -Value (Get-Date -Format o) -NoNewline
  return $true
}
function Release-Lock { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue }

# ── -Install: registrar las tareas y salir ──
if ($Install) {
  Ensure-Tasks
  Log 'Tareas "STA Server Update" (4 AM) y "STA Server Update NOW" (cada 5 min) registradas como SYSTEM.'
  Write-Host "OK: nocturna 4 AM + inmediata cada 5 min." -ForegroundColor Green
  Write-Host "  Deploy normal:    pnpm --filter @sta/server release        (entra a las 4 AM)" -ForegroundColor Gray
  Write-Host "  Deploy inmediato: pnpm --filter @sta/server release -- --now  (entra en ~5 min)" -ForegroundColor Gray
  Write-Host "  Probar ahora:     .\update-server.ps1 -Force" -ForegroundColor Gray
  exit 0
}

# ── -SyncEnv: re-sincronizar NSSM env desde .env y reiniciar (sin update) ──
if ($SyncEnv) {
  Log '=== Re-sync de NSSM env (sin update) ==='
  Stop-Service $ServiceName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Sync-NssmEnv
  Start-Service $ServiceName
  $ok = $false
  foreach ($i in 1..15) {
    Start-Sleep -Seconds 2
    try { if ((Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5).ok) { $ok = $true; break } } catch {}
  }
  if ($ok) { Log 'Env re-sincronizado y server OK en /health.' }
  else { Log 'WARN: server no respondio OK en /health tras el re-sync. Revisa logs.' }
  exit 0
}

# ── -SetVersion: marcar version actual sin actualizar (para sincronizar) ──
if ($SetVersion) {
  Set-Content -Path $VersionFile -Value $SetVersion -NoNewline
  Log "VERSION marcada manualmente como $SetVersion (sin actualizar)."
  exit 0
}

Log "=== Chequeo de update$(if ($Now) { ' (modo INMEDIATO)' }) ==="

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

# 2.b Modo inmediato: SOLO seguir si el ultimo release esta marcado como inmediato.
if ($Now) {
  if (-not ($latest.body -match $ImmediateMarker)) {
    Log "El ultimo release ($latestVer) no esta marcado como inmediato. El canal inmediato no hace nada (lo aplica la tarea de las 4 AM)."
    exit 0
  }
  Log "Release $latestVer marcado como INMEDIATO -> se aplica ya."
}

if (-not $Force -and $latestVer -eq $current) {
  Log "Ya estas en la ultima ($current). Nada que hacer."
  exit 0
}

# A partir de aca SI vamos a aplicar -> tomar el lock (evita solapamiento).
if (-not (Acquire-Lock)) { exit 0 }
Log "Actualizando $current -> $latestVer ..."

try {
  # 3. Bajar el asset .zip
  $asset = $latest.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
  if (-not $asset) { throw "El release $latestVer no tiene .zip." }
  $work = Join-Path $env:TEMP ("sta-update-" + $latestVer)
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $zip = Join-Path $work 'dist.zip'
  Log "Descargando $($asset.name) ..."
  # curl.exe (incluido en Windows 10+) es rapido y robusto a conexiones flojas.
  # browser_download_url es el CDN publico de GitHub → no necesita auth (mandar
  # el header Authorization rompe el redirect a S3). Fallback a iwr si no esta.
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path $curl) {
    & $curl -L --fail --silent --show-error --connect-timeout 30 --max-time 600 --retry 3 -o $zip $asset.browser_download_url
    if ($LASTEXITCODE -ne 0) { throw "curl fallo al bajar el asset (exit $LASTEXITCODE)" }
  } else {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -TimeoutSec 600
  }
  Expand-Archive -Path $zip -DestinationPath $work -Force

  # Ubicar la raiz del dist dentro del extraido (api/server.mjs presente)
  $newRoot = if (Test-Path (Join-Path $work 'api\server.mjs')) { $work }
             elseif (Test-Path (Join-Path $work 'dist\api\server.mjs')) { Join-Path $work 'dist' }
             else { $null }
  if (-not $newRoot) { throw "El zip no tiene api/server.mjs." }
  foreach ($cf in $CodeFolders) {
    if (-not (Test-Path (Join-Path $newRoot $cf))) { throw "Al zip le falta la carpeta '$cf'." }
  }

  # 4. Backup de la DB (pg_dump) — leyendo DATABASE_URL del .env
  $pgBin = Find-PgBin
  $envMap = @{}
  Get-Content "$ServerDir\.env" | ForEach-Object {
    if ($_ -match '^\s*#') { return }
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $envMap[$matches[1]] = $matches[2] }
  }
  $dbUrl = $envMap['DATABASE_URL']
  if ($dbUrl -notmatch '^postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?]+)') { throw "DATABASE_URL invalida en .env." }
  $pgUser=$matches[1]; $pgPass=$matches[2]; $pgHost=$matches[3]; $pgPort=$matches[4]; $pgDb=$matches[5]
  $env:PGPASSWORD = $pgPass
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dumpFile = Join-Path $BackupDir "pre-update-$current-to-$latestVer-$stamp.dump"
  Log "Backup de la DB -> $dumpFile"
  & "$pgBin\pg_dump.exe" -w -h $pgHost -p $pgPort -U $pgUser -d $pgDb -F c -f $dumpFile
  if ($LASTEXITCODE -ne 0) { throw "pg_dump fallo." }
  # Podar backups viejos (dejar los ultimos 10)
  Get-ChildItem $BackupDir -Filter '*.dump' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force -ErrorAction SilentlyContinue

  # 5. Parar el servicio
  Log "Parando servicio $ServiceName ..."
  Stop-Service $ServiceName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2

  # 6. Swap del codigo: mover el actual a rollback/, copiar el nuevo
  $rollback = Join-Path $work 'rollback'
  New-Item -ItemType Directory -Force -Path $rollback | Out-Null
  $script:swapped = @()
  function Restore-Rollback {
    Log "ROLLBACK: restaurando codigo anterior..."
    foreach ($cf in $script:swapped) {
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

  foreach ($cf in $CodeFolders) {
    $live = Join-Path $ServerDir $cf
    # Mover el actual a rollback/ y recien ahi marcarlo como restaurable: si el
    # Copy-Item de abajo falla, el catch sabe que rollback/$cf existe y lo repone.
    if (Test-Path $live) {
      Move-Item $live (Join-Path $rollback $cf) -Force
      $script:swapped += $cf
    }
    Copy-Item (Join-Path $newRoot $cf) $live -Recurse -Force
  }
  Log "Codigo nuevo copiado (api, migrations, seed). .env y DB intactos."

  # 6.b Auto-actualizar los scripts .ps1 (incluido este updater) desde el dist
  #     nuevo -> futuros cambios de scripts se propagan solos. El .ps1 que esta
  #     corriendo ya esta en memoria; pisar el archivo no afecta esta corrida.
  Get-ChildItem (Join-Path $newRoot '*.ps1') -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $ServerDir $_.Name) -Force
  }

  # 6.c Re-sincronizar el env de NSSM desde .env (con el servicio parado, antes
  #     de arrancar -> el restart toma valores frescos).
  Sync-NssmEnv

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

  # 9. Exito: marcar version + refrescar tareas (self-heal) + limpiar
  Set-Content -Path $VersionFile -Value $latestVer -NoNewline
  try { Ensure-Tasks } catch { Log "WARN: no pude refrescar las tareas programadas: $($_.Exception.Message)" }
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  Release-Lock
  Log "=== UPDATE OK: ahora en v$latestVer (migraciones nuevas: $applied) ==="
  exit 0

} catch {
  Log "ERROR durante el update: $($_.Exception.Message)"
  if ($script:swapped -and $script:swapped.Count -gt 0) { Restore-Rollback }
  Release-Lock
  Log "El backup de la DB quedo en: $dumpFile (restaurar a mano solo si hace falta)."
  exit 1
}
