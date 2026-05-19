# ════════════════════════════════════════════════════════════════════
#  Santa Teresita — provisión del SERVIDOR LOCAL (mini PC headless)
#
#  Idempotente. Correr como ADMINISTRADOR desde la carpeta `dist/`:
#      powershell -ExecutionPolicy Bypass -File .\setup-mini-pc.ps1
#
#  Prerrequisitos (instalar ANTES, una sola vez):
#    - Windows 10/11 x64
#    - PostgreSQL 16 x64  (service `postgresql-x64-16`, incluye psql)
#    - Node.js 20+ LTS    (el server corre bajo Node puro)
#    - NSSM               (winget install NSSM.NSSM)  — para los servicios
#
#  Qué hace (todo idempotente, se puede re-correr):
#    1. Verifica prereqs.
#    2. Crea rol + DB `teresita` si no existen.
#    3. Aplica las migraciones SQL pendientes (tracking por nombre en
#       _prisma_migrations — NO usa `prisma migrate dev`, ver CLAUDE.md).
#    4. Seed solo si la DB está vacía (primer arranque).
#    5. Registra el Windows Service `sta-server` (Node, auto-start,
#       auto-restart, depende de Postgres) — headless, sin login/UAC.
#    6. Abre el firewall para 5432 y 3001 SOLO en la subred LAN.
#    7. Imprime verificación.
# ════════════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'
$DistDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $DistDir

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  XX  $m" -ForegroundColor Red; exit 1 }

# ── 0. Admin + .env ──────────────────────────────────────────────────
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Die "Hay que correr como Administrador (servicios + firewall lo requieren)."
}
if (-not (Test-Path "$DistDir\.env")) {
  if (Test-Path "$DistDir\.env.example") {
    Die "No existe .env. Copiá .env.example a .env y completá las credenciales antes de correr esto."
  }
  Die "Falta .env en $DistDir"
}
$envMap = @{}
Get-Content "$DistDir\.env" | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $envMap[$matches[1]] = $matches[2] }
}
$dbUrl = $envMap['DATABASE_URL']
if (-not $dbUrl) { Die "DATABASE_URL no está en .env" }

# Parsear DATABASE_URL: postgresql://user:pass@host:port/db?...
if ($dbUrl -notmatch '^postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?]+)') {
  Die "DATABASE_URL con formato inesperado."
}
$pgUser = $matches[1]; $pgPass = $matches[2]; $pgHost = $matches[3]
$pgPort = $matches[4]; $pgDb = $matches[5]

# ── 1. Prereqs ───────────────────────────────────────────────────────
Info "Verificando prerrequisitos..."
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Die "Node.js no encontrado. Instalá Node 20+ LTS." }
$nodeVer = (node -v) -replace 'v',''
if ([int]($nodeVer.Split('.')[0]) -lt 20) { Die "Node $nodeVer < 20. Actualizá a Node 20+." }
Ok "Node $nodeVer"

$psql = (Get-Command psql -ErrorAction SilentlyContinue)
if (-not $psql) {
  $cand = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cand) { $env:Path += ";$($cand.DirectoryName)"; $psql = $cand }
}
if (-not $psql) { Die "psql no encontrado. Instalá PostgreSQL 16 x64." }
Ok "psql disponible"

$pgSvc = Get-Service -Name 'postgresql-x64-16' -ErrorAction SilentlyContinue
if (-not $pgSvc) { $pgSvc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $pgSvc) { Die "Service de PostgreSQL no encontrado." }
if ($pgSvc.Status -ne 'Running') { Start-Service $pgSvc.Name }
Set-Service -Name $pgSvc.Name -StartupType Automatic
Ok "Postgres service '$($pgSvc.Name)' Running + Automatic"

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue)
if (-not $nssm) { Die "NSSM no encontrado. Instalá con: winget install NSSM.NSSM" }
Ok "NSSM disponible"

# ── 2. Rol + DB ──────────────────────────────────────────────────────
Info "Asegurando rol y base '$pgDb'..."
# Usamos el superusuario 'postgres' (pide su password una vez si no hay .pgpass)
$env:PGPASSWORD = $pgPass
function PsqlPostgres($sql) {
  & psql -h $pgHost -p $pgPort -U postgres -d postgres -tAc $sql 2>$null
}
# Crear rol si no existe
$roleExists = & psql -h $pgHost -p $pgPort -U postgres -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$pgUser'" 2>$null
if ($roleExists -ne '1') {
  & psql -h $pgHost -p $pgPort -U postgres -d postgres -c "CREATE ROLE `"$pgUser`" LOGIN PASSWORD '$pgPass'" | Out-Null
  Ok "Rol '$pgUser' creado"
} else { Ok "Rol '$pgUser' ya existe" }
$dbExists = & psql -h $pgHost -p $pgPort -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$pgDb'" 2>$null
if ($dbExists -ne '1') {
  & psql -h $pgHost -p $pgPort -U postgres -d postgres -c "CREATE DATABASE `"$pgDb`" OWNER `"$pgUser`" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'" | Out-Null
  Ok "Base '$pgDb' creada (UTF8)"
} else { Ok "Base '$pgDb' ya existe" }

# ── 3. Migraciones (tracking por nombre, idempotente) ────────────────
Info "Aplicando migraciones SQL..."
function PsqlDb($args) { & psql -h $pgHost -p $pgPort -U $pgUser -d $pgDb @args }
PsqlDb @('-c', @'
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY,
  "checksum" VARCHAR(64) NOT NULL DEFAULT '',
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);
'@) | Out-Null

$migFiles = Get-ChildItem "$DistDir\migrations\*.sql" | Sort-Object Name
foreach ($f in $migFiles) {
  $name = $f.BaseName  # ej. 20260427202705_init
  $done = & psql -h $pgHost -p $pgPort -U $pgUser -d $pgDb -tAc "SELECT 1 FROM _prisma_migrations WHERE migration_name='$name'" 2>$null
  if ($done -eq '1') { continue }
  Info "  aplicando $name"
  PsqlDb @('-v', 'ON_ERROR_STOP=1', '-f', $f.FullName) | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "Migración $name falló. Revisá el SQL / estado de la DB." }
  $guid = [guid]::NewGuid().ToString()
  PsqlDb @('-c', "INSERT INTO _prisma_migrations (id, migration_name, finished_at, applied_steps_count) VALUES ('$guid','$name', now(), 1)") | Out-Null
  Ok "  $name"
}
Ok "Migraciones al día"

# ── 4. Seed (solo si la DB está vacía) ───────────────────────────────
$userCount = & psql -h $pgHost -p $pgPort -U $pgUser -d $pgDb -tAc "SELECT COUNT(*) FROM usuarios" 2>$null
if ($userCount -eq '0' -or [string]::IsNullOrWhiteSpace($userCount)) {
  Info "DB vacía → corriendo seed..."
  $env:DATABASE_URL = $dbUrl
  & node "$DistDir\seed\seed.mjs"
  if ($LASTEXITCODE -ne 0) { Die "Seed falló." }
  Ok "Seed completo"
} else {
  Ok "DB ya tiene datos ($userCount usuarios) — seed salteado"
}

# ── 5. Windows Service del API+replicator (headless) ─────────────────
Info "Registrando Windows Service 'sta-server'..."
$svcName = 'sta-server'
$nodeExe = $node.Source
$entry = "$DistDir\api\server.mjs"
$existing = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if ($existing) {
  & nssm stop $svcName 2>$null | Out-Null
  & nssm remove $svcName confirm 2>$null | Out-Null
}
& nssm install $svcName $nodeExe $entry | Out-Null
& nssm set $svcName AppDirectory "$DistDir\api" | Out-Null
& nssm set $svcName AppStdout "$DistDir\logs\sta-server.out.log" | Out-Null
& nssm set $svcName AppStderr "$DistDir\logs\sta-server.err.log" | Out-Null
& nssm set $svcName AppRotateFiles 1 | Out-Null
& nssm set $svcName AppRotateBytes 10485760 | Out-Null
& nssm set $svcName Start SERVICE_AUTO_START | Out-Null
& nssm set $svcName DependOnService $pgSvc.Name | Out-Null
# Recovery: reinicio en crash (3 reintentos rápidos, después cada 1 min)
& nssm set $svcName AppExit Default Restart | Out-Null
& nssm set $svcName AppRestartDelay 3000 | Out-Null
# El service lee el .env vía la app (env-loader) — apuntamos el cwd al dist/api
# pero el .env está en dist/. Lo pasamos por NSSM AppEnvironmentExtra:
$envLines = (Get-Content "$DistDir\.env" | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' })
& nssm set $svcName AppEnvironmentExtra ($envLines -join "`r`n") | Out-Null
New-Item -ItemType Directory -Force -Path "$DistDir\logs" | Out-Null
& nssm start $svcName | Out-Null
Start-Sleep -Seconds 3
$svc = Get-Service -Name $svcName
if ($svc.Status -ne 'Running') {
  Warn "El service quedó en estado $($svc.Status). Revisá $DistDir\logs\sta-server.err.log"
} else { Ok "Service 'sta-server' Running + Automatic + recovery" }

# ── 6. Firewall: 5432 y 3001 solo en la subred LAN ───────────────────
Info "Configurando firewall (solo subred LAN)..."
$lan = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^127\.' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1)
if ($lan) {
  $subnet = "$($lan.IPAddress)/$($lan.PrefixLength)"
  foreach ($p in 5432, 3001) {
    $rn = "STA Server TCP $p (LAN)"
    Remove-NetFirewallRule -DisplayName $rn -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $rn -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $p -RemoteAddress $subnet | Out-Null
  }
  Ok "Firewall: 5432 + 3001 permitidos solo desde $subnet"
} else {
  Warn "No detecté la IP de LAN — configurá el firewall a mano (5432 + 3001 solo subred)."
}

# ── 7. Verificación ──────────────────────────────────────────────────
Write-Host ""
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Green
Ok "Servidor local provisionado."
Write-Host ""
Info "Verificá:"
Write-Host "    Get-Service postgresql*,sta-server" -ForegroundColor Gray
Write-Host "    curl http://localhost:3001/health" -ForegroundColor Gray
Write-Host "    curl http://localhost:3001/api/v1/sync/status   (mirá 'replicacion')" -ForegroundColor Gray
Write-Host ""
Info "IP de este server para configurar las cajas:"
if ($lan) { Write-Host "    $($lan.IPAddress)   (puerto API 3001, Postgres 5432)" -ForegroundColor Gray }
Write-Host ""
Warn "Recordá: IP fija (reserva DHCP), UPS, y NTP sincronizado en este mini PC."
