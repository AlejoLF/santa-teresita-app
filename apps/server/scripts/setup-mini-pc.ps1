# ====================================================================
#  Santa Teresita - provision del SERVIDOR LOCAL (mini PC headless)
#
#  Idempotente. Correr como ADMINISTRADOR desde la carpeta `dist/`:
#      powershell -ExecutionPolicy Bypass -File .\setup-mini-pc.ps1
#
#  Prerrequisitos (instalar ANTES, una sola vez - o usar bootstrap-mini-pc.ps1):
#    - Windows 10/11 x64
#    - PostgreSQL 16 x64  (service `postgresql-x64-16`, incluye psql)
#    - Node.js 20+ LTS    (el server corre bajo Node puro)
#    - NSSM               (winget install NSSM.NSSM)  - para los servicios
#
#  Que hace (todo idempotente, se puede re-correr):
#    1. Verifica prereqs.
#    2. Crea rol + DB `teresita` si no existen.
#    2.5 Configura acceso de red de Postgres para la LAN (listen_addresses
#       + pg_hba para CADA subred detectada - soporta mini PC con 2 placas /
#       2 internets).
#    3. Aplica las migraciones SQL pendientes (tracking por nombre en
#       _prisma_migrations - NO usa `prisma migrate dev`, ver CLAUDE.md).
#    4. Seed solo si la DB esta vacia (primer arranque).
#    5. Registra el Windows Service `sta-server` (Node, auto-start,
#       auto-restart, depende de Postgres) - headless, sin login/UAC.
#    6. Abre el firewall para 5432 y 3001 en TODAS las subredes LAN.
#    7. Imprime verificacion + las IPs del server (una por red).
#
#  MODOS (parametros opcionales):
#    -NetworkOnly        Solo (re)configura red: subredes + pg_hba + firewall.
#                        NO toca DB, migraciones, seed ni el service. Rapido,
#                        para corregir la red sin reinstalar todo.
#    -Subnets a,b        Fuerza estas subredes (CIDR) en vez de autodetectar.
#                        Ej: -Subnets "192.168.1.0/24","192.168.0.0/24"
#    -PrinterIp x.x.x.x  Al final testea si el server llega a la impresora.
#  Ejemplos:
#    .\setup-mini-pc.ps1
#    .\setup-mini-pc.ps1 -NetworkOnly
#    .\setup-mini-pc.ps1 -NetworkOnly -Subnets "192.168.1.0/24","192.168.0.0/24"
# ====================================================================

param(
  [switch]$NetworkOnly,
  [string[]]$Subnets,
  [string]$PrinterIp
)

$ErrorActionPreference = 'Stop'
$DistDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $DistDir

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  XX  $m" -ForegroundColor Red; exit 1 }

# Calcula la direccion de red (base) de una IP + prefijo. pg_hba y el firewall
# necesitan la base (ej. 192.168.1.0/24), no la IP del host (192.168.1.10/24).
function Get-NetworkBase([string]$ip, [int]$prefix) {
  # Aritmetica byte-a-byte (evita el 0xFFFFFFFF=-1 de PowerShell 5.1).
  $b = ([System.Net.IPAddress]::Parse($ip)).GetAddressBytes()  # big-endian, 4 bytes
  for ($i = 0; $i -lt 4; $i++) {
    $bitsLeft = $prefix - ($i * 8)
    if ($bitsLeft -ge 8) { continue }            # byte entero es de red
    elseif ($bitsLeft -le 0) { $b[$i] = 0 }      # byte entero es de host
    else {
      $keep = 8 - $bitsLeft
      $mask = [byte]((0xFF -shl $keep) -band 0xFF)
      $b[$i] = [byte]($b[$i] -band $mask)
    }
  }
  return ([System.Net.IPAddress]::new($b)).IPAddressToString
}

if ($NetworkOnly) { Info "MODO -NetworkOnly: solo reconfiguro red (no toco DB/service)." }

# -- 0. Admin + .env --------------------------------------------------
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Die "Hay que correr como Administrador (servicios + firewall lo requieren)."
}
if (-not (Test-Path "$DistDir\.env")) {
  if (Test-Path "$DistDir\.env.example") {
    Die "No existe .env. Copia .env.example a .env y completa las credenciales antes de correr esto."
  }
  Die "Falta .env en $DistDir"
}
$envMap = @{}
Get-Content "$DistDir\.env" | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $envMap[$matches[1]] = $matches[2] }
}
$dbUrl = $envMap['DATABASE_URL']
if (-not $dbUrl) { Die "DATABASE_URL no esta en .env" }

# Parsear DATABASE_URL: postgresql://user:pass@host:port/db?...
if ($dbUrl -notmatch '^postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?]+)') {
  Die "DATABASE_URL con formato inesperado."
}
$pgUser = $matches[1]; $pgPass = $matches[2]; $pgHost = $matches[3]
$pgPort = $matches[4]; $pgDb = $matches[5]

# -- 1. Prereqs -------------------------------------------------------
Info "Verificando prerrequisitos..."
if (-not $NetworkOnly) {
  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if (-not $node) { Die "Node.js no encontrado. Instala Node 20+ LTS (o corre bootstrap-mini-pc.ps1)." }
  $nodeVer = (node -v) -replace 'v',''
  if ([int]($nodeVer.Split('.')[0]) -lt 20) { Die "Node $nodeVer < 20. Actualiza a Node 20+." }
  Ok "Node $nodeVer"
}

$psql = (Get-Command psql -ErrorAction SilentlyContinue)
if (-not $psql) {
  $cand = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cand) { $env:Path += ";$($cand.DirectoryName)"; $psql = $cand }
}
if (-not $psql) { Die "psql no encontrado. Instala PostgreSQL 16 x64 (o corre bootstrap-mini-pc.ps1)." }
Ok "psql disponible"

$pgSvc = Get-Service -Name 'postgresql-x64-16' -ErrorAction SilentlyContinue
if (-not $pgSvc) { $pgSvc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $pgSvc) { Die "Service de PostgreSQL no encontrado." }
if ($pgSvc.Status -ne 'Running') { Start-Service $pgSvc.Name }
Set-Service -Name $pgSvc.Name -StartupType Automatic
Ok "Postgres service '$($pgSvc.Name)' Running + Automatic"

if (-not $NetworkOnly) {
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue)
  if (-not $nssm) { Die "NSSM no encontrado. Instala con: winget install NSSM.NSSM" }
  Ok "NSSM disponible"
}

# -- 1.5 Subredes LAN (autodetecta, o usa -Subnets si lo pasaste) -----
# Solo placas FISICAS (Ethernet/WiFi) que esten Up -> evita adaptadores
# virtuales (Hyper-V, WSL, VPN), Bluetooth y APIPA (169.254).
$physIdx = @(Get-NetAdapter -ErrorAction SilentlyContinue |
  Where-Object { $_.Status -eq 'Up' -and $_.PhysicalMediaType -match '802\.3|802\.11|Ethernet|Wireless' } |
  ForEach-Object { $_.ifIndex })
$lanIfaces = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' -and $physIdx -contains $_.InterfaceIndex })
$lanIps = @($lanIfaces | ForEach-Object { $_.IPAddress } | Select-Object -Unique)
if ($Subnets -and $Subnets.Count -gt 0) {
  $lanSubnets = @($Subnets | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$' })
  if ($lanSubnets.Count -ne $Subnets.Count) { Die "Alguna subred en -Subnets no tiene formato CIDR (ej. 192.168.1.0/24)." }
  Ok "Subredes (forzadas por -Subnets): $($lanSubnets -join ', ')"
} else {
  $lanSubnets = @()
  foreach ($if in $lanIfaces) {
    $base = Get-NetworkBase $if.IPAddress $if.PrefixLength
    $cidr = "$base/$($if.PrefixLength)"
    if ($lanSubnets -notcontains $cidr) { $lanSubnets += $cidr }
  }
  if ($lanSubnets.Count -gt 0) {
    Ok "Subredes LAN detectadas: $($lanSubnets -join ', ')"
  } else {
    Warn "No detecte subredes LAN. Usa -Subnets para forzarlas, o revisa la red (diagnose-red.ps1)."
  }
}

# -- 2. Superusuario postgres + (full) rol/DB -------------------------
# El superusuario 'postgres' hace falta para crear rol/DB y tocar
# listen_addresses / pg_hba. Su password sale de .env (PG_SUPERUSER_PASSWORD)
# o se pide una vez aca.
$pgSuperPass = $envMap['PG_SUPERUSER_PASSWORD']
if (-not $pgSuperPass) {
  Warn "No hay PG_SUPERUSER_PASSWORD en .env."
  $sec = Read-Host "  Password del superusuario 'postgres' de PostgreSQL" -AsSecureString
  $pgSuperPass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
function SuperPsql { $env:PGPASSWORD = $pgSuperPass; & psql -h $pgHost -p $pgPort -U postgres -d postgres @args }
function SuperPsqlVal { param([string]$sql) $env:PGPASSWORD = $pgSuperPass; ((& psql -h $pgHost -p $pgPort -U postgres -d postgres -tAc $sql 2>$null) | Out-String).Trim() }

if (-not $NetworkOnly) {
  Info "Asegurando rol y base '$pgDb'..."
  $roleExists = SuperPsqlVal "SELECT 1 FROM pg_roles WHERE rolname='$pgUser'"
  if ($roleExists -ne '1') {
    SuperPsql -c "CREATE ROLE `"$pgUser`" LOGIN PASSWORD '$pgPass'" | Out-Null
    Ok "Rol '$pgUser' creado"
  } else { Ok "Rol '$pgUser' ya existe" }
  $dbExists = SuperPsqlVal "SELECT 1 FROM pg_database WHERE datname='$pgDb'"
  if ($dbExists -ne '1') {
    SuperPsql -c "CREATE DATABASE `"$pgDb`" OWNER `"$pgUser`" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'" | Out-Null
    Ok "Base '$pgDb' creada (UTF8)"
  } else { Ok "Base '$pgDb' ya existe" }
}

# -- 2.5 Acceso de red de Postgres (cajas LAN, incluso 2 subredes) ----
Info "Configurando acceso de red de Postgres (LAN)..."
$pgNeedsRestart = $false
# listen_addresses='*' via ALTER SYSTEM (idempotente; requiere restart si cambia)
$curListen = SuperPsqlVal "SHOW listen_addresses"
if ($curListen -ne '*') {
  SuperPsql -c "ALTER SYSTEM SET listen_addresses = '*'" | Out-Null
  $pgNeedsRestart = $true
  Ok "listen_addresses = '*' (aplica tras restart)"
} else { Ok "listen_addresses ya es '*'" }

# pg_hba.conf: una linea 'host' por subred LAN (idempotente)
$hbaFile = SuperPsqlVal "SHOW hba_file"
if ($hbaFile -and (Test-Path $hbaFile)) {
  $hba = Get-Content $hbaFile -Raw
  foreach ($sn in $lanSubnets) {
    if ($hba -notmatch [Regex]::Escape($sn)) {
      Add-Content -Path $hbaFile -Value "`r`n# STA LAN access (setup-mini-pc.ps1)`r`nhost    all    all    $sn    scram-sha-256"
      Ok "pg_hba: permitido $sn"
    } else { Ok "pg_hba: $sn ya estaba" }
  }
  SuperPsql -c "SELECT pg_reload_conf()" | Out-Null
} else {
  Warn "No pude ubicar pg_hba.conf - configura el acceso LAN a mano (host all all <subred> scram-sha-256)."
}

if ($pgNeedsRestart) {
  Info "Reiniciando Postgres para aplicar listen_addresses..."
  Restart-Service $pgSvc.Name
  Start-Sleep -Seconds 3
  Ok "Postgres reiniciado"
}

# -- 3-5. DB: migraciones + seed + service (se saltean con -NetworkOnly) --
if (-not $NetworkOnly) {

# -- 3. Migraciones (tracking por nombre, idempotente) ----------------
Info "Aplicando migraciones SQL..."
$env:PGPASSWORD = $pgPass   # de aca en mas conectamos como el rol de la app
function PsqlDb($args) { $env:PGPASSWORD = $pgPass; & psql -h $pgHost -p $pgPort -U $pgUser -d $pgDb @args }
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
  if ($LASTEXITCODE -ne 0) { Die "Migracion $name fallo. Revisa el SQL / estado de la DB." }
  $guid = [guid]::NewGuid().ToString()
  PsqlDb @('-c', "INSERT INTO _prisma_migrations (id, migration_name, finished_at, applied_steps_count) VALUES ('$guid','$name', now(), 1)") | Out-Null
  Ok "  $name"
}
Ok "Migraciones al dia"

# -- 4. Seed (solo si la DB esta vacia) -------------------------------
$env:PGPASSWORD = $pgPass
$userCount = & psql -h $pgHost -p $pgPort -U $pgUser -d $pgDb -tAc "SELECT COUNT(*) FROM usuarios" 2>$null
if ($userCount -eq '0' -or [string]::IsNullOrWhiteSpace($userCount)) {
  Info "DB vacia -> corriendo seed..."
  $env:DATABASE_URL = $dbUrl
  & node "$DistDir\seed\seed.mjs"
  if ($LASTEXITCODE -ne 0) { Die "Seed fallo." }
  Ok "Seed completo"
} else {
  Ok "DB ya tiene datos ($userCount usuarios) - seed salteado"
}

# -- 5. Windows Service del API+replicator (headless) -----------------
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
# Recovery: reinicio en crash (3 reintentos rapidos, despues cada 1 min)
& nssm set $svcName AppExit Default Restart | Out-Null
& nssm set $svcName AppRestartDelay 3000 | Out-Null
# El service lee el .env via la app (env-loader) - apuntamos el cwd al dist/api
# pero el .env esta en dist/. Lo pasamos por NSSM AppEnvironmentExtra:
$envLines = (Get-Content "$DistDir\.env" | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' })
& nssm set $svcName AppEnvironmentExtra ($envLines -join "`r`n") | Out-Null
New-Item -ItemType Directory -Force -Path "$DistDir\logs" | Out-Null
& nssm start $svcName | Out-Null
Start-Sleep -Seconds 3
$svc = Get-Service -Name $svcName
if ($svc.Status -ne 'Running') {
  Warn "El service quedo en estado $($svc.Status). Revisa $DistDir\logs\sta-server.err.log"
} else { Ok "Service 'sta-server' Running + Automatic + recovery" }

}  # -- fin bloque DB/service (solo install completa) --

# -- 6. Firewall: 5432 y 3001 en TODAS las subredes LAN ---------------
Info "Configurando firewall (todas las subredes LAN)..."
if ($lanSubnets.Count -gt 0) {
  foreach ($p in 5432, 3001) {
    foreach ($sn in $lanSubnets) {
      $rn = "STA Server TCP $p ($sn)"
      Remove-NetFirewallRule -DisplayName $rn -ErrorAction SilentlyContinue
      New-NetFirewallRule -DisplayName $rn -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $p -RemoteAddress $sn | Out-Null
    }
  }
  Ok "Firewall: 5432 + 3001 permitidos desde $($lanSubnets -join ', ')"
} else {
  Warn "No detecte subredes LAN - configura el firewall a mano (5432 + 3001 por subred)."
}

# -- 7. Verificacion --------------------------------------------------
Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
if ($NetworkOnly) { Ok "Red reconfigurada (modo -NetworkOnly)." } else { Ok "Servidor local provisionado." }
Write-Host ""
Info "Verifica:"
Write-Host "    Get-Service postgresql*,sta-server" -ForegroundColor Gray
Write-Host "    curl http://localhost:3001/health" -ForegroundColor Gray
Write-Host "    curl http://localhost:3001/api/v1/sync/status   (mira 'replicacion')" -ForegroundColor Gray
Write-Host ""
Info "IPs de este server (una por placa de red / internet):"
if ($lanIps.Count -gt 0) {
  foreach ($ip in $lanIps) { Write-Host "    $ip   (API 3001, Postgres 5432)" -ForegroundColor Gray }
  Write-Host ""
  Warn "Cada caja debe apuntar (lanDbUrl) a la IP del server EN SU MISMA red."
} else {
  Warn "No detecte IPs de LAN - revisa la conexion de red del mini PC."
}

# Test opcional de la impresora termica (si pasaste -PrinterIp)
if ($PrinterIp) {
  Write-Host ""
  Info "Probando si el server llega a la impresora $PrinterIp : 9100 ..."
  $pr = Test-NetConnection -ComputerName $PrinterIp -Port 9100 -WarningAction SilentlyContinue
  if ($pr.TcpTestSucceeded) {
    Ok "Impresora $PrinterIp ALCANZABLE desde el server (puerto 9100 abierto)."
  } else {
    Warn "Impresora $PrinterIp NO alcanzable (ping responde: $($pr.PingSucceeded)). Revisa que este prendida y en una de las redes del server."
  }
}

Write-Host ""
Warn "Recorda: IP fija por placa (reserva DHCP en cada router), UPS, y NTP sincronizado."
