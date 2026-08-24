<#
.SYNOPSIS
  Arranca el n8n de pruebas que ya instalaste. No instala nada.

.DESCRIPTION
  setup-n8n-dev.ps1 carga el entorno en LA SESION de PowerShell donde corre. Si
  cerraste esa terminal (Ctrl+C, o la cruz), las variables se fueron con ella y
  un `n8n start` a secas arranca SIN el token del bot, sin la whitelist y sin
  las dos variables del sandbox: los Code nodes vuelven a fallar con
  "access to env vars denied".

  Este script relee el archivo de entorno y arranca. Es lo que conviene usar
  para el ciclo de todos los dias; setup-n8n-dev.ps1 es solo para instalar o
  para cambiar credenciales.

.PARAMETER N8nDir
  Carpeta de datos. Tiene que ser la misma que le diste al setup.

.EXAMPLE
  .\n8n-dev.ps1
#>
[CmdletBinding()]
param([string]$N8nDir = 'C:\sta\n8n-dev')

$ErrorActionPreference = 'Stop'

$envFile = Join-Path $N8nDir 'n8n-dev.env'
if (-not (Test-Path $envFile)) {
  throw "No encuentro $envFile. Corre primero setup-n8n-dev.ps1."
}

$cargadas = 0
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process')
    $cargadas++
  }
}
Write-Host "Entorno cargado desde $envFile ($cargadas variables)" -ForegroundColor Green

# Aviso: si el bot de este entorno tiene un webhook puesto, getUpdates NO anda.
# Telegram no deja las dos cosas a la vez. Es facil quedar asi despues de
# probar el nodo "Telegram Trigger", que registra un webhook.
$token = [System.Environment]::GetEnvironmentVariable('TELEGRAM_BOT_TOKEN', 'Process')
if ($token -and $token -ne 'no-usar') {
  try {
    $info = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getWebhookInfo" -TimeoutSec 15
    if ($info.ok -and $info.result.url) {
      Write-Host ""
      Write-Host "!   Este bot tiene un WEBHOOK puesto: $($info.result.url)" -ForegroundColor Yellow
      Write-Host "!   Mientras este ahi, getUpdates devuelve 409 y el workflow de" -ForegroundColor Yellow
      Write-Host "!   polling NO recibe nada. Para sacarlo:" -ForegroundColor Yellow
      Write-Host "!     Invoke-RestMethod `"https://api.telegram.org/bot`$token/deleteWebhook`"" -ForegroundColor Yellow
      Write-Host ""
    } else {
      Write-Host "Sin webhook puesto: el polling puede recibir mensajes." -ForegroundColor Gray
    }
  } catch {
    # No es critico: puede no haber internet todavia. Solo se avisa.
    Write-Host "(no pude consultar getWebhookInfo: $($_.Exception.Message))" -ForegroundColor Gray
  }
}

Write-Host "Editor: http://localhost:5678   |   Ctrl+C para cortar" -ForegroundColor Cyan
& n8n start
