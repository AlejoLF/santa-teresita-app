<#
.SYNOPSIS
    Diagnostica por que se cae el acceso remoto a una maquina Windows.

.DESCRIPTION
    SOLO LECTURA — no cambia absolutamente nada. Identifica cual de las 3 causas
    posibles esta en juego:
      1. Congelado/restauracion de disco (UWF, Deep Freeze, ...)
      2. Shell de kiosco que mata las apps al arrancar
      3. Apps corriendo como usuario en vez de servicio  <- la mas comun

    Ver workflows/diagnostico-acceso-remoto.md para leer la salida.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\diagnostico-acceso-remoto.ps1
#>

$ErrorActionPreference = 'Continue'

$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "Usuario: $(whoami)   |   Admin: $esAdmin" -ForegroundColor Cyan
if (-not $esAdmin) {
    Write-Host "Sin admin: el bloque 1 (UWF) puede fallar. El resto funciona igual." -ForegroundColor Yellow
}

Write-Host "`n===== 1. WRITE FILTER de Windows (UWF) — el 'congelado' nativo de POS =====" -ForegroundColor Cyan
try { uwfmgr.exe get-config }
catch { Write-Host "uwfmgr no existe -> UWF no instalado (bien, no hay congelado nativo)" -ForegroundColor Yellow }

Write-Host "`n===== 2. Software de RESTAURACION conocido =====" -ForegroundColor Cyan
$svcRestore = Get-Service | Where-Object {
    $_.Name -match 'DFServ|Faronics|Shield|RebootRestore|Shadow|TimeFreeze|Wondershare|HDGuard'
}
if ($svcRestore) { $svcRestore | Format-Table Name,Status,StartType -Auto }
else { Write-Host "Ningun servicio de restauracion. OK." -ForegroundColor Green }

Get-CimInstance Win32_Product -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match 'Deep Freeze|Faronics|Reboot Restore|Shadow Defender|Time Freeze|Drive Vaccine|HDGuard'
} | Select-Object Name,Vendor

Write-Host "`n===== 3. SHELL personalizado (kiosco que reemplaza el explorer) =====" -ForegroundColor Cyan
# Tiene que decir explorer.exe. Cualquier otra cosa = kiosco.
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name Shell -ErrorAction SilentlyContinue |
    Select-Object Shell
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name Shell -ErrorAction SilentlyContinue |
    Select-Object Shell

Write-Host "`n===== 4. TAREAS PROGRAMADAS de reinicio/reset =====" -ForegroundColor Cyan
$tareas = Get-ScheduledTask | Where-Object {
    $_.TaskName -match 'reset|restore|reboot|reinicio|restaur|clean|kiosk|refresh' -or
    $_.Actions.Execute -match 'shutdown|restart'
}
if ($tareas) { $tareas | Select-Object TaskName,State }
else { Write-Host "Ninguna tarea de reset/reboot. OK." -ForegroundColor Green }

Write-Host "`n===== 5. Ultimo arranque + historial de reinicios =====" -ForegroundColor Cyan
# Un ultimo boot de hace semanas descarta el reinicio automatico.
Write-Host ("Ultimo boot: " + (Get-CimInstance Win32_OperatingSystem).LastBootUpTime)
Get-WinEvent -FilterHashtable @{LogName='System'; Id=1074,6008} -MaxEvents 8 -ErrorAction SilentlyContinue |
    Select-Object TimeCreated,Id,@{n='Msg';e={$_.Message.Substring(0,[Math]::Min(90,$_.Message.Length))}}

Write-Host "`n===== 6. AUTO-LOGIN (define si tras un reinicio hay sesion) =====" -ForegroundColor Cyan
# AutoAdminLogon=0 -> tras reiniciar NO hay sesion -> las apps de usuario NO existen.
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction SilentlyContinue |
    Select-Object AutoAdminLogon, DefaultUserName, DefaultDomainName

Write-Host "`n===== 7. Canales de acceso: servicio o app? =====" -ForegroundColor Cyan
$canales = Get-Service | Where-Object { $_.Name -match 'Tailscale|RustDesk|sshd|AnyDesk' }
if ($canales) { $canales | Format-Table Name,Status,StartType -Auto }
Write-Host "Lo que NO aparezca arriba corre como APP DE USUARIO -> se cae al cerrar sesion." -ForegroundColor Yellow
Write-Host "(Esa es la causa mas comun de 'andaba y de repente no'.)`n" -ForegroundColor Yellow

Get-Process rustdesk,tailscale-ipn,anydesk -ErrorAction SilentlyContinue |
    Select-Object Name,Id,Path | Format-Table -Auto
