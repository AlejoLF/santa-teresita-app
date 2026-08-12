<#
.SYNOPSIS
  Valida los .ps1 del repo ANTES de mandarlos a S1: sintaxis + encoding.

.DESCRIPTION
  Chequea dos cosas por archivo:

  1. PARSEA. Usa el parser de PowerShell, asi que detecta lo mismo que
     detectaria al correrlo, sin ejecutar nada: una llave sin cerrar, un
     "$var:" que PowerShell lee como referencia con drive, etc.

  2. ENCODING COHERENTE. Windows PowerShell 5.1 (el de S1) lee los .ps1 como
     ANSI salvo que el archivo tenga BOM UTF-8. Entonces:
       - con BOM   -> los acentos y los guiones largos se leen bien. OK.
       - sin BOM   -> cada byte >127 se decodifica mal. Un em-dash se vuelve
                      tres caracteres y el ultimo es la comilla tipografica de
                      cierre, que PowerShell ACEPTA como delimitador de
                      string: si eso cae dentro de un string entrecomillado,
                      cierra la comilla en medio de una frase y el parser
                      explota lineas mas abajo con un error que no menciona
                      el encoding por ningun lado.
     Por eso un archivo sin BOM tiene que ser ASCII puro. Si necesitas
     acentos, guardalo con BOM UTF-8.

     Ojo: el parser de PowerShell 7 (el que corre este chequeo) NO detecta
     esto, porque lee UTF-8 y ve el archivo bien. El problema aparece recien
     en S1. De ahi que el chequeo de encoding vaya aparte del de sintaxis.

  Los dos casos costaron varias vueltas de ida y vuelta con S1 en agosto
  2026: pushear, correr alla, leer el error, arreglar. Correr esto antes de
  pushear los caza en el momento.

.EXAMPLE
  pwsh tools/check-ps1.ps1                        # todos los .ps1 del repo
  pwsh tools/check-ps1.ps1 tools/n8n/setup-n8n.ps1
#>
param([string[]]$Path)

if (-not $Path) {
  $raiz = Split-Path -Parent $PSScriptRoot
  $Path = (Get-ChildItem -Path $raiz -Filter '*.ps1' -Recurse -File |
           Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
           ForEach-Object { $_.FullName } | Sort-Object)
}

$fallas = 0
foreach ($archivo in $Path) {
  $nombre = (Resolve-Path $archivo).Path
  $errs = @()   # rompen
  $avisos = @() # todavia no rompen, pero son una mina enterrada

  $parseErrs = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    $nombre, [ref]$null, [ref]$parseErrs) | Out-Null
  foreach ($e in $parseErrs) {
    $errs += ("linea {0}: {1}" -f $e.Extent.StartLineNumber, $e.Message)
  }

  $bytes = if ($PSVersionTable.PSVersion.Major -ge 6) {
    Get-Content -Path $nombre -AsByteStream -Raw
  } else {
    Get-Content -Path $nombre -Encoding Byte -Raw
  }
  $tieneBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and
               $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)

  if (-not $tieneBom) {
    # Se reporta por LINEA, no por byte: un solo em-dash son 3 bytes y
    # listarlos por separado ahoga la salida sin agregar informacion.
    # @(...) a proposito: con UNA sola linea Get-Content devuelve un String,
    # no un array, y $lineas[0] daria el primer CARACTER en vez de la linea.
    # El chequeo pasaba en verde sobre archivos rotos de una sola linea.
    $lineas = @(Get-Content -Path $nombre)
    for ($i = 0; $i -lt $lineas.Count; $i++) {
      $texto = $lineas[$i]
      if ($texto -notmatch '[^\x00-\x7E\t]') { continue }
      $sucios = -join ([char[]]$texto | Where-Object { [int]$_ -gt 126 } |
                       Select-Object -Unique)
      $n = $i + 1
      # En un comentario el destrozo queda contenido hasta el fin de linea, asi
      # que hoy no rompe; en cualquier otro lado puede cerrar un string.
      if ($texto.TrimStart().StartsWith('#')) {
        $avisos += "linea ${n}: no-ASCII en un comentario ($sucios) y el archivo no tiene BOM"
      } else {
        $errs += "linea ${n}: no-ASCII FUERA de un comentario ($sucios) y el archivo no tiene BOM - puede romper el parseo en S1"
      }
    }
  }

  if ($errs) {
    $fallas++
    Write-Host "FALLA  $nombre" -ForegroundColor Red
    $errs | Select-Object -First 8 | ForEach-Object { Write-Host "       $_" -ForegroundColor Gray }
    if ($errs.Count -gt 8) { Write-Host "       ... y $($errs.Count - 8) mas" -ForegroundColor Gray }
  } elseif ($avisos) {
    Write-Host "aviso  $nombre" -ForegroundColor Yellow
    $avisos | Select-Object -First 5 | ForEach-Object { Write-Host "       $_" -ForegroundColor Gray }
    if ($avisos.Count -gt 5) { Write-Host "       ... y $($avisos.Count - 5) mas" -ForegroundColor Gray }
    Write-Host "       (no rompe hoy; se arregla guardando el archivo con BOM UTF-8)" -ForegroundColor Gray
  } else {
    Write-Host "ok     $nombre" -ForegroundColor Green
  }
}

if ($fallas) { Write-Host "`n$fallas archivo(s) con problemas." -ForegroundColor Red; exit 1 }
Write-Host "`nTodos los .ps1 parsean y tienen encoding coherente." -ForegroundColor Green
