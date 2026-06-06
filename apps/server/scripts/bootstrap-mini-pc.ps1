# ════════════════════════════════════════════════════════════════════
#  Santa Teresita - BOOTSTRAP del mini PC (instala prerrequisitos)
#
#  Corré esto PRIMERO, como ADMINISTRADOR, desde la carpeta `dist/`:
#      powershell -ExecutionPolicy Bypass -File .\bootstrap-mini-pc.ps1
#
#  Instala automáticamente (vía winget):
#    - Node.js 20 LTS        (OpenJS.NodeJS.LTS)
#    - NSSM                   (NSSM.NSSM)
#    - PostgreSQL 16          (PostgreSQL.PostgreSQL.16, modo unattended)
#
#  Después de esto:
#    1. Cerrá y reabrí PowerShell (refresca PATH de node/psql).
#    2. copy .env.example .env  ; notepad .env   (completá credenciales).
#    3. powershell -ExecutionPolicy Bypass -File .\setup-mini-pc.ps1
#
#  Opcional: pasar la password del superusuario de Postgres sin que te la
#  pregunte:  .\bootstrap-mini-pc.ps1 -PostgresSuperPassword "TuPass"
# ════════════════════════════════════════════════════════════════════

param(
  [string]$PostgresSuperPassword
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  XX  $m" -ForegroundColor Red; exit 1 }

# ── Admin + winget ───────────────────────────────────────────────────
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Die "Corré como Administrador."
}
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Die "winget no está disponible. Actualizá 'App Installer' desde la Microsoft Store y reintentá."
}

function Install-Pkg([string]$id, [string]$name) {
  Info "Instalando $name ($id)..."
  & winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -eq 0) { Ok "$name listo" }
  else { Warn ("{0}: winget devolvio {1} (probablemente ya estaba instalado; sigo)" -f $name, $LASTEXITCODE) }
}

# ── 1. Node + NSSM (instalación silenciosa confiable) ────────────────
Install-Pkg 'OpenJS.NodeJS.LTS' 'Node.js 20 LTS'
Install-Pkg 'NSSM.NSSM' 'NSSM'

# ── 2. PostgreSQL 16 (unattended) ────────────────────────────────────
$pgSvc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pgSvc) {
  Ok "PostgreSQL ya instalado (service $($pgSvc.Name)) - salteo"
} else {
  if (-not $PostgresSuperPassword) {
    Warn "Necesito una password para el superusuario 'postgres' de PostgreSQL."
    Warn "ANOTALA: la vas a poner en .env como PG_SUPERUSER_PASSWORD."
    $sec = Read-Host "  Password para 'postgres'" -AsSecureString
    $PostgresSuperPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  if ([string]::IsNullOrWhiteSpace($PostgresSuperPassword)) { Die "Password vacía - abortando." }

  Info "Instalando PostgreSQL 16 (unattended, puerto 5432)..."
  $override = "--mode unattended --unattendedmodeui none --superpassword `"$PostgresSuperPassword`" --serverport 5432 --enable-components server,commandlinetools"
  & winget install --id PostgreSQL.PostgreSQL.16 -e --accept-source-agreements --accept-package-agreements --override $override
  if ($LASTEXITCODE -ne 0) {
    Warn "winget no pudo instalar PostgreSQL automáticamente (código $LASTEXITCODE)."
    Warn "Instalalo a mano desde https://www.postgresql.org/download/windows/ (PostgreSQL 16 x64),"
    Warn "anotá la password del superusuario, y después corré setup-mini-pc.ps1."
  } else {
    Start-Sleep -Seconds 5
    $pgSvc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pgSvc) { Ok "PostgreSQL 16 instalado (service $($pgSvc.Name))" }
    else { Warn "PostgreSQL instalado pero no veo el service todavía - puede tardar. Verificá con: Get-Service postgresql*" }
  }
}

# ── Refrescar PATH en esta sesión (para verificar) ───────────────────
$pgBin = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pgBin) { $env:Path += ";$($pgBin.DirectoryName)" }

Write-Host ""
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Green
Ok "Bootstrap completo."
Write-Host ""
Info "Próximos pasos:"
Write-Host "   1) Cerrá y volvé a abrir PowerShell como Administrador (refresca PATH)." -ForegroundColor Gray
Write-Host "   2) cd a la carpeta dist\  ;  copy .env.example .env  ;  notepad .env" -ForegroundColor Gray
Write-Host "      - Completá DATABASE_URL, REPLICATE_TO_URL, AUTH_SECRET, AUDIT_HASH_SALT." -ForegroundColor Gray
Write-Host "      - Poné PG_SUPERUSER_PASSWORD = la password de 'postgres' que usaste recién." -ForegroundColor Gray
Write-Host "   3) powershell -ExecutionPolicy Bypass -File .\setup-mini-pc.ps1" -ForegroundColor Gray
