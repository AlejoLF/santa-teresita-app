# ====================================================================
#  Santa Teresita - DIAGNOSTICO DE RED del mini PC.  *** SOLO LECTURA ***
#  No cambia NADA. Sirve para ver la estructura real (cable/WiFi, cuantas
#  internets, subredes, impresora) ANTES de instalar el server.
#
#  Correr (no hace falta admin, pero conviene):
#      powershell -ExecutionPolicy Bypass -File .\diagnose-red.ps1
#  Para probar la impresora termica:
#      powershell -ExecutionPolicy Bypass -File .\diagnose-red.ps1 -PrinterIp 192.168.1.60
#
#  Guarda TODO en red-diagnostico.txt -> mandaselo a tu dev.
# ====================================================================

param([string]$PrinterIp)

$ErrorActionPreference = 'SilentlyContinue'
$reporte = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'red-diagnostico.txt'
try { Stop-Transcript | Out-Null } catch {}
Start-Transcript -Path $reporte -Force | Out-Null

function Get-NetworkBase([string]$ip, [int]$prefix) {
  $b = ([System.Net.IPAddress]::Parse($ip)).GetAddressBytes()
  for ($i = 0; $i -lt 4; $i++) {
    $bitsLeft = $prefix - ($i * 8)
    if ($bitsLeft -ge 8) { continue }
    elseif ($bitsLeft -le 0) { $b[$i] = 0 }
    else {
      $keep = 8 - $bitsLeft
      $mask = [byte]((0xFF -shl $keep) -band 0xFF)
      $b[$i] = [byte]($b[$i] -band $mask)
    }
  }
  return ([System.Net.IPAddress]::new($b)).IPAddressToString
}

Write-Host "=== DIAGNOSTICO DE RED - Santa Teresita mini PC ==="
Write-Host ("Equipo: {0}" -f $env:COMPUTERNAME)
Write-Host ""

Write-Host "--- 1) Placas de red (cable vs WiFi, prendidas/apagadas) ---"
Get-NetAdapter | Sort-Object Status | Format-Table Name, InterfaceDescription, Status, `
  @{n='Tipo'; e={ if ($_.PhysicalMediaType -match '802\.11|Wireless|WiFi') {'WiFi'} elseif ($_.PhysicalMediaType -match '802\.3|Ethernet') {'Cable'} else { "$($_.PhysicalMediaType)" } }}, `
  LinkSpeed -AutoSize | Out-String | Write-Host

Write-Host "--- 2) IP / mascara / gateway / DNS por placa activa ---"
$cfgs = @(Get-NetIPConfiguration | Where-Object { $_.IPv4Address })
foreach ($c in $cfgs) {
  $ip  = $c.IPv4Address.IPAddress
  $pfx = $c.IPv4Address.PrefixLength
  $base = Get-NetworkBase $ip $pfx
  $gw  = ($c.IPv4DefaultGateway.NextHop) -join ', '
  $dns = ($c.DNSServer.ServerAddresses) -join ', '
  Write-Host ("Placa  : {0}" -f $c.InterfaceAlias)
  Write-Host ("  IP     : {0}/{1}    (subred {2}/{1})" -f $ip, $pfx, $base)
  if ($gw) { Write-Host ("  Gateway: {0}  (=> esta placa tiene internet)" -f $gw) }
  else     { Write-Host  "  Gateway: (ninguno => esta placa NO sale a internet)" }
  Write-Host ("  DNS    : {0}" -f $dns)
  Write-Host ""
}

Write-Host "--- 3) Subredes LAN REALES (solo placas fisicas Up = lo que usaria el server) ---"
$physIdx = @(Get-NetAdapter -ErrorAction SilentlyContinue |
  Where-Object { $_.Status -eq 'Up' -and $_.PhysicalMediaType -match '802\.3|802\.11|Ethernet|Wireless' } |
  ForEach-Object { $_.ifIndex })
$subnets = @()
foreach ($c in $cfgs) {
  if ($c.IPv4Address.IPAddress -match '^(127\.|169\.254\.)') { continue }
  if ($physIdx -notcontains $c.InterfaceIndex) { continue }   # descarta virtuales (WSL/Hyper-V/VPN)
  $cidr = "$(Get-NetworkBase $c.IPv4Address.IPAddress $c.IPv4Address.PrefixLength)/$($c.IPv4Address.PrefixLength)"
  if ($subnets -notcontains $cidr) { $subnets += $cidr }
}
Write-Host ("Cantidad de subredes reales: {0}  (deberian ser 2 si hay 2 internets por cable/WiFi fisico)" -f $subnets.Count)
$subnets | ForEach-Object { Write-Host ("  - {0}" -f $_) }
Write-Host ""

Write-Host "--- 4) Rutas por defecto (cada 'internet') ---"
Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric |
  Format-Table ifIndex, InterfaceAlias, NextHop, RouteMetric -AutoSize | Out-String | Write-Host

Write-Host "--- 5) Salida a internet por cada gateway ---"
$gws = @((Get-NetRoute -DestinationPrefix '0.0.0.0/0').NextHop | Where-Object { $_ -and $_ -ne '0.0.0.0' } | Select-Object -Unique)
foreach ($g in $gws) {
  $r = Test-Connection -ComputerName $g -Count 1 -Quiet
  Write-Host ("  gateway {0} -> {1}" -f $g, $(if ($r) {'responde'} else {'NO responde'}))
}
$inet = Test-Connection -ComputerName 8.8.8.8 -Count 1 -Quiet
Write-Host ("  internet (8.8.8.8) -> {0}" -f $(if ($inet) {'OK'} else {'sin salida'}))
Write-Host ""

Write-Host "--- 6) Dispositivos vistos en la LAN (ARP) - aca suele aparecer la impresora ---"
arp -a | Out-String | Write-Host

if ($PrinterIp) {
  Write-Host ("--- 7) Test impresora termica {0}:9100 ---" -f $PrinterIp)
  $p = Test-NetConnection -ComputerName $PrinterIp -Port 9100 -WarningAction SilentlyContinue
  Write-Host ("  ping   -> {0}" -f $(if ($p.PingSucceeded) {'responde'} else {'no responde'}))
  Write-Host ("  9100   -> {0}" -f $(if ($p.TcpTestSucceeded) {'ALCANZABLE (imprime)'} else {'NO alcanzable'}))
  Write-Host ""
}

Write-Host "=== FIN ==="
Stop-Transcript | Out-Null
Write-Host ("Reporte guardado en: {0}" -f $reporte)
Write-Host "Mandaselo a tu dev para ajustar la instalacion a la red real."
