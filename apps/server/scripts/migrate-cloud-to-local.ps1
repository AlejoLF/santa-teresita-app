# ====================================================================
#  Santa Teresita - CARGA de datos de Supabase (nube) al Postgres LOCAL
#
#  Snapshot one-way: lee de la nube (NO la modifica) y reemplaza los datos
#  del server local con los de la nube. El schema local ya existe (migraciones)
#  -> carga DATA-ONLY. Pensado para el cutover (cajas pasan a local-first sin
#  perder historial / usuarios / saldos / cierres).
#
#  Excluye 3 tablas: _prisma_migrations (tracking local intacto),
#  trabajos_impresion (no reimprimir tickets viejos), outbox_events (evita
#  loop de replicacion al prender el replicator).
#
#  Uso (Administrador, en C:\sta-server):
#    .\migrate-cloud-to-local.ps1 -CloudUrl "<SUPABASE_DB_URL_POOLED>"
#    .\migrate-cloud-to-local.ps1 -CloudUrl "<...>" -DryRun   # solo prueba conexion
#
#  Pega tu SUPABASE_DB_URL_POOLED tal cual (puerto 6543); el script usa el
#  puerto 5432 (sesion) para pg_dump (el pooler 6543 transaccional no sirve).
#
#  Idempotente: se puede re-correr (vuelve a truncar y recargar). Hace backup
#  del local antes de tocar nada.
# ====================================================================
param(
  [Parameter(Mandatory = $true)][string]$CloudUrl,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$ServerDir = 'C:\sta-server'
$Service   = 'sta-server'
$BackupDir = Join-Path $ServerDir 'backups'
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
# Tablas que NO se copian de la nube.
$Exclude = @('_prisma_migrations', 'trabajos_impresion', 'outbox_events')

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Die($m)  { Write-Host "  XX  $m" -ForegroundColor Red; exit 1 }

# -- Herramientas PG: usar la version MAS NUEVA instalada --
# pg_dump se niega a dumpear de un server mas nuevo que el (Supabase = PG17 ->
# necesitamos pg_dump 17). psql/pg_restore 17 tambien sirven contra el local 16.
$pgCands = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | ForEach-Object {
  $vstr = Split-Path (Split-Path $_.DirectoryName -Parent) -Leaf  # "9.6","16","17"
  $major = 0; [void][int]::TryParse(($vstr -split '\.')[0], [ref]$major)
  [PSCustomObject]@{ Major = $major; Dir = $_.DirectoryName }
}
$pgBin = ($pgCands | Sort-Object Major -Descending | Select-Object -First 1).Dir
if (-not $pgBin) { Die 'No encontre PostgreSQL bin (C:\Program Files\PostgreSQL\*\bin).' }
Info "Herramientas PG: $pgBin"
$psql = "$pgBin\psql.exe"; $pgdump = "$pgBin\pg_dump.exe"; $pgrestore = "$pgBin\pg_restore.exe"

# -- Conexion LOCAL (del .env) --
$envMap = @{}
Get-Content "$ServerDir\.env" | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $envMap[$matches[1]] = $matches[2] }
}
$localUrl = $envMap['DATABASE_URL']
if ($localUrl -notmatch '^postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?]+)') { Die 'DATABASE_URL local invalida en .env.' }
$lUser = $matches[1]; $lPass = $matches[2]; $lHost = $matches[3]; $lPort = $matches[4]; $lDb = $matches[5]
$superPass = $envMap['PG_SUPERUSER_PASSWORD']
if (-not $superPass) { Die 'Falta PG_SUPERUSER_PASSWORD en .env (lo necesito para truncar/restaurar como superusuario).' }

# -- Conexion CLOUD: pooler de SESION (5432), sin query, con SSL --
$cloudSession = (($CloudUrl -replace ':6543', ':5432') -replace '\?.*$', '') + '?sslmode=require'
if ($cloudSession -notmatch '^postgresql://([^:]+):([^@]+)@([^:/]+):(\d+)/') { Die 'CloudUrl con formato inesperado.' }
$cHost = $matches[3]

# Helper de conteo
function Count-Table($conn, $useUri, $table) {
  # OJO: la URI de conexion va con -d (NO posicional): psql ignora el -c si la
  # URI viene como argumento posicional en el medio.
  if ($useUri) { (& $psql -w -d "$conn" -tAc "SELECT count(*) FROM $table" 2>$null).Trim() }
  else { $env:PGPASSWORD = $lPass; (& $psql -w -h $lHost -p $lPort -U $lUser -d $lDb -tAc "SELECT count(*) FROM $table" 2>$null).Trim() }
}

# ── 1. Test de conexion a la nube ANTES de tocar nada ──
Info "Probando conexion a la nube ($cHost, puerto 5432 sesion)..."
$cloudVentas = Count-Table $cloudSession $true 'ventas'
if (-not ($cloudVentas -match '^\d+$')) { Die "No pude conectar/leer de la nube. ¿URL/password correctos? ¿internet?" }
$cloudUsuarios  = Count-Table $cloudSession $true 'usuarios'
$cloudProductos = Count-Table $cloudSession $true 'productos'
$cloudCuentas   = Count-Table $cloudSession $true 'cuentas'
Ok "Nube OK -> ventas=$cloudVentas usuarios=$cloudUsuarios productos=$cloudProductos cuentas=$cloudCuentas"

if ($DryRun) { Ok 'DryRun: solo probe la conexion. No toque nada.'; exit 0 }

Write-Host ""
Write-Host "  Esto REEMPLAZA los datos del server local con los de la nube." -ForegroundColor Yellow
Write-Host "  (La nube NO se modifica. Se hace backup del local antes.)" -ForegroundColor Yellow

# ── 2. Parar el servicio (nadie escribe durante la migracion) ──
Info "Parando $Service..."
Stop-Service $Service -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ── 3. Backup del local actual (por las dudas) ──
$localBak = Join-Path $BackupDir "local-pre-cloudload-$stamp.dump"
Info "Backup del local -> $localBak"
$env:PGPASSWORD = $lPass
& $pgdump -w -h $lHost -p $lPort -U $lUser -d $lDb -F c -f $localBak
if ($LASTEXITCODE -ne 0) { Start-Service $Service -ErrorAction SilentlyContinue; Die 'pg_dump del local fallo (no toque mas nada).' }

# ── 4. Dump de la nube (data-only, sin las excluidas) ──
$cloudDump = Join-Path $BackupDir "cloud-data-$stamp.dump"
Info 'Dump de la nube (data-only)...'
$dumpArgs = @('-w', '--data-only', '--schema=public', '--no-owner', '--no-privileges', '-F', 'c')
foreach ($t in $Exclude) { $dumpArgs += @('--exclude-table', "public.$t") }
$dumpArgs += @('-f', $cloudDump, '-d', "$cloudSession")
& $pgdump @dumpArgs
if ($LASTEXITCODE -ne 0) { Start-Service $Service -ErrorAction SilentlyContinue; Die 'pg_dump de la nube fallo.' }
Ok ("Dump de la nube listo ({0} MB)" -f [math]::Round((Get-Item $cloudDump).Length / 1MB, 1))

# ── 5. Truncar el local (excepto excluidas) como superusuario ──
Info 'Limpiando datos locales (seed/anteriores)...'
$env:PGPASSWORD = $superPass
$exclList = ($Exclude | ForEach-Object { "'$_'" }) -join ','
$truncSql = "DO `$mig`$ DECLARE r RECORD; BEGIN FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ($exclList)) LOOP EXECUTE 'TRUNCATE TABLE public.'||quote_ident(r.tablename)||' CASCADE'; END LOOP; END `$mig`$;"
& $psql -w -h $lHost -p $lPort -U postgres -d $lDb -v ON_ERROR_STOP=1 -c $truncSql
if ($LASTEXITCODE -ne 0) { Start-Service $Service -ErrorAction SilentlyContinue; Die 'Truncate del local fallo (no carge nada; el backup esta en $localBak).' }

# ── 6. Restore de la nube en el local (data-only, FK off durante la carga) ──
Info 'Cargando datos de la nube en el local...'
# --disable-triggers requiere superusuario -> conectamos como postgres.
$env:PGPASSWORD = $superPass
& $pgrestore -w --data-only --disable-triggers --no-owner -h $lHost -p $lPort -U postgres -d $lDb $cloudDump
# pg_restore puede dar exit !=0 por warnings; verificamos por conteos abajo.

# ── 7. Reiniciar + verificar (local vs nube) ──
Info "Reiniciando $Service..."
Start-Service $Service
Start-Sleep -Seconds 4

Write-Host ""
Write-Host "==== VERIFICACION (local debe coincidir con la nube) ====" -ForegroundColor Green
$tablas = @(
  @('ventas', $cloudVentas), @('usuarios', $cloudUsuarios),
  @('productos', $cloudProductos), @('cuentas', $cloudCuentas)
)
$allOk = $true
foreach ($pair in $tablas) {
  $t = $pair[0]; $cloudN = $pair[1]
  $localN = Count-Table $null $false $t
  $mark = if ($localN -eq $cloudN) { 'OK ' } else { '!! '; $allOk = $false }
  $color = if ($localN -eq $cloudN) { 'Green' } else { 'Red' }
  Write-Host ("  {0}{1,-12} local={2}  nube={3}" -f $mark, $t, $localN, $cloudN) -ForegroundColor $color
}
# Tablas extra (solo informativo, sin comparar con la nube)
foreach ($t in @('movimientos', 'sesiones_caja', 'clientes', 'pagos', 'items_venta', 'audit_log')) {
  Write-Host ("     {0,-12} local={1}" -f $t, (Count-Table $null $false $t)) -ForegroundColor Gray
}

Write-Host ""
if ($allOk) {
  Ok 'MIGRACION DE DATOS COMPLETA. Local coincide con la nube.'
} else {
  Write-Host "  !! Algunos conteos NO coinciden. Revisa arriba. Backup del local previo:" -ForegroundColor Yellow
  Write-Host "     $localBak" -ForegroundColor Yellow
}
Write-Host "  Backup del local PREVIO a esta carga: $localBak" -ForegroundColor DarkGray
Write-Host "  Snapshot de la nube usado: $cloudDump" -ForegroundColor DarkGray
