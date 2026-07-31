# Workflow: por qué se cae el acceso remoto a una máquina Windows

## Objetivo
Una máquina remota (S1, una caja) "andaba y de repente dejó de andar" — RustDesk
no conecta, o Tailscale desapareció de la red. Encontrar **cuál** de las causas
posibles es, antes de tocar nada.

Aplicado a S1 el 2026-07-30. Resultado: no había ningún sistema de restauración;
la causa era RustDesk corriendo como app de usuario. Ver
[docs/ACCESO-REMOTO-S1.md](../docs/ACCESO-REMOTO-S1.md).

## Las 3 causas posibles (en orden de gravedad)

| Causa | Síntoma típico | Fix |
|-|-|-|
| **Congelado/restauración de disco** (UWF, Deep Freeze) | todo lo que instalás desaparece al reiniciar | meter las apps en la imagen base, o excluir sus carpetas |
| **Shell de kiosco** | al arrancar sólo abren ciertas apps de una lista blanca | registrar las apps como **servicios** (el kiosco no las toca) |
| **App de usuario, no servicio** ← la más común | anda mientras hay sesión abierta; muere al cerrarla | `--install-service` + `StartupType Automatic` |

La tercera es la más frecuente y la que más se confunde con las otras dos,
porque también da la sensación de "se resetea solo".

## Tool
`tools/diagnostico-acceso-remoto.ps1` — **sólo lectura**, no cambia nada.
Correr en PowerShell (admin si se puede; sin admin igual sirve, salvo el bloque
de UWF).

```powershell
powershell -ExecutionPolicy Bypass -File .\diagnostico-acceso-remoto.ps1
```

## Cómo leer la salida

- **Bloque 1 (UWF)** — `uwfmgr` no existe → no hay congelado nativo (lo normal).
  Si dice `Filter state: ON`, ahí está el problema: Windows revierte el disco en
  cada reinicio.
- **Bloque 2** — servicios/programas tipo Deep Freeze, Reboot Restore, Shadow
  Defender. Vacío = bien.
- **Bloque 3** — `Shell` tiene que decir `explorer.exe`. Cualquier otra cosa es
  un kiosco que reemplaza el escritorio.
- **Bloque 4/5** — tareas de reset/reboot, y cada cuánto reinicia realmente la
  máquina. Un "último boot" de hace semanas descarta el reinicio automático.
- **Bloque 6** — **el decisivo**: si Tailscale/RustDesk NO aparecen como
  servicios, corren como apps de usuario y por eso se caen.

## Si la causa es "app de usuario" (lo habitual)

```powershell
& "C:\Program Files\RustDesk\RustDesk.exe" --install-service
Start-Sleep -Seconds 6
$svc = Get-Service | ? { $_.Name -match 'RustDesk' } | Select -First 1
Set-Service -Name $svc.Name -StartupType Automatic
sc.exe failure $svc.Name reset= 86400 actions= restart/5000/restart/10000/restart/30000
```
El `sc.exe failure` es la red de seguridad: si el servicio crashea, Windows lo
levanta solo a los 5s, 10s y 30s.

## Orden de trabajo (importante)

**Primero asegurar el canal que NO estás usando.** Si entraste por RustDesk,
arreglá y verificá SSH antes de tocar RustDesk. Nunca te quedes con una sola vía
mientras modificás esa misma vía — es la forma clásica de quedarse afuera de un
server remoto.

## Gotchas aprendidos

- **No cambies el password del usuario Windows** para "recuperar" el SSH. Si hay
  auto-login o servicios corriendo bajo esa cuenta, los rompés y quedás peor.
  La salida correcta es clave SSH (ver ACCESO-REMOTO-S1.md).
- **`AutoAdminLogon=0`** significa que tras un reinicio NO hay sesión iniciada.
  Cualquier cosa que dependa de la sesión (apps de usuario) no va a existir.
  Único camino: servicios.
- **Tailscale: "Disable key expiry"** en el admin console, por nodo. Sin eso, a
  los ~6 meses la máquina se cae de la red aunque todo lo demás esté perfecto.
  Es una caída diferida que no se parece a nada de lo de arriba.
