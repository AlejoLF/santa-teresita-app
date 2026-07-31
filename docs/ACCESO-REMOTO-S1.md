# Acceso remoto permanente a S1 (sin AnyDesk roulette)

Playbook para administrar el mini PC **S1** (Windows **Home**, en el local de La Plata)
desde cualquier lado, de forma confiable y segura — reemplazando la dependencia de
AnyDesk. Pensado para correr comandos de admin (`update-server.ps1`, ver logs,
reiniciar servicios, poner tokens) sin pelear con la conexión.

## Qué instalamos y por qué

| Pieza | Para qué | Por qué esta |
|-|-|-|
| **Tailscale** | Red privada (VPN malla WireGuard) siempre conectada entre S1 y tu PC | Always-on, reconexión automática, sin abrir puertos en el router, cifrada, gratis. Es la base: pone a S1 "al lado tuyo". |
| **OpenSSH Server** | Consola remota (correr PowerShell en S1) | Viene en Windows Home, liviano, scriptable. **Es lo que más vas a usar** (deploys, logs, servicios). |
| **RustDesk** | Escritorio gráfico (ver pantalla, Task Scheduler, clicks) | Home **no** hostea RDP; RustDesk es open-source, gratis y hace acceso desatendido. |

> Regla de oro de seguridad: **NO** abras puertos (SSH/RDP) en el router hacia internet
> — te barren con bots. **Todo** va por dentro de Tailscale, que ya autentica por
> dispositivo. El repo es público y S1 tiene la base fuente-de-verdad: esto importa.

Todo es **instalación de una sola vez en S1** (la hacés ahora por AnyDesk; después
nunca más dependés de AnyDesk).

---

## Paso 1 — Tailscale (la base)

### En S1
1. Descargá el instalador: https://tailscale.com/download/windows → instalá.
2. Iniciá sesión con una cuenta (Google/Microsoft/email). Usá **una cuenta tuya
   dedicada** para la infra del local.
3. Tailscale instala un **servicio de Windows** (`Tailscale`) que arranca solo en
   el boot — no necesita que nadie inicie sesión en S1. Queda conectado tras reiniciar.
4. **Importante (servidor headless):** en el admin console
   (https://login.tailscale.com/admin/machines) → buscá el equipo S1 → menú **⋯** →
   **Disable key expiry**. Sin esto, a los ~6 meses la sesión expira y S1 se cae de
   la red hasta re-autenticar. Desactivado = nunca se desconecta.
5. Anotá la **IP Tailscale** de S1 (formato `100.x.y.z`) y/o su nombre MagicDNS
   (ej. `s1.tu-tailnet.ts.net`).

### En tu PC (Portugal)
1. Instalá Tailscale, iniciá sesión con **la misma cuenta**.
2. Listo: tu PC y S1 quedan en la misma red privada. Desde tu PC alcanzás a S1 por
   su IP `100.x.y.z` como si estuvieran en la misma LAN.

---

## Paso 2 — OpenSSH Server en S1 (consola)

Abrí **PowerShell como Administrador** en S1.

> ⚠️ **OJO en S1**: a esta máquina le **sacaron Windows Update** (la imagen de POS
> viene "debloated"), así que el método estándar `Add-WindowsCapability -Online -Name
> OpenSSH.Server...` **falla** con error 0x80070424 ("el servicio no existe", porque
> `wuauserv` no está). Por eso instalamos OpenSSH **desde los binarios de GitHub**
> (no usan Windows Update). En una máquina con Windows Update normal, el
> `Add-WindowsCapability` alcanza.

```powershell
# 1) Descargar e instalar OpenSSH desde GitHub (sin Windows Update)
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest 'https://github.com/PowerShell/Win32-OpenSSH/releases/latest/download/OpenSSH-Win64.zip' -OutFile "$env:TEMP\OpenSSH.zip"
Expand-Archive "$env:TEMP\OpenSSH.zip" -DestinationPath 'C:\Program Files\OpenSSH-Win64' -Force

# 2) Instalar el servicio + generar host keys (la ExecutionPolicy suele estar Restricted)
Set-ExecutionPolicy -Scope Process Bypass -Force
Set-Location 'C:\Program Files\OpenSSH-Win64\OpenSSH-Win64'
& .\install-sshd.ps1
& .\ssh-keygen.exe -A
# Arreglar permisos de las host keys (sino sshd NO arranca):
& .\FixHostFilePermissions.ps1 -Confirm:$false

# 3) Arrancar + auto-start
Set-Service sshd -StartupType Automatic
Start-Service sshd

# 4) Firewall: asegurar la regla de entrada para el puerto 22
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
}

# 5) (Recomendado) Que las sesiones SSH abran PowerShell en vez de cmd.exe.
#    Usa PowerShell 7 si está (el de S1 lo tiene), sino Windows PowerShell.
if (-not (Test-Path 'HKLM:\SOFTWARE\OpenSSH')) { New-Item 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null }
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
$shell = if ($pwsh) { $pwsh } else { "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" }
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $shell -PropertyType String -Force

# 5) Verificar
Get-Service sshd | Format-Table Name,Status,StartType
```

### Autenticación por CLAVE SSH (así quedó configurado — 2026-07-30)

**No usamos contraseña.** El usuario de S1 es `usuario`, y su password no está
guardado en ningún lado (`AutoAdminLogon=0`, `DefaultPassword` vacío): no se
puede recuperar. Y **no conviene cambiarlo** — hay servicios corriendo bajo esa
cuenta. Con clave SSH el problema desaparece: se entra sin password.

En **tu PC**, generar el par de claves una sola vez:
```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\s1_key" -C "s1-tailscale"
Get-Content "$env:USERPROFILE\.ssh\s1_key.pub"   # copiar la línea ENTERA
```

En **S1** (PowerShell admin), instalarla:
```powershell
$pub = 'ssh-ed25519 AAAA... s1-tailscale'   # la línea completa

# Guardia: si no es una clave válida, no escribe nada (es fácil pegar cualquier cosa).
if ($pub -notmatch '^ssh-(ed25519|rsa) AAAA') {
    Write-Host "NO es una clave publica valida. No guardo nada." -ForegroundColor Red
} else {
    $akf = "$env:ProgramData\ssh\administrators_authorized_keys"
    Set-Content -Path $akf -Value $pub -Encoding ascii
    # Permisos OBLIGATORIOS: solo Administrators + SYSTEM, sino sshd IGNORA la llave.
    icacls $akf /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null
    Restart-Service sshd
    Get-Content $akf
}
```

> **Por qué `administrators_authorized_keys` y no `~/.ssh/authorized_keys`:** en
> Windows, si el usuario es administrador, sshd lee **sólo** ese archivo global
> (lo fija `AuthorizedKeysFile` en `sshd_config`). Poner la clave en el home del
> usuario no hace nada. Y si los permisos no son exactamente Administrators +
> SYSTEM, sshd la descarta **en silencio** — se ve como "sigue pidiendo password".

Conectarse:
```bash
ssh -i "$env:USERPROFILE\.ssh\s1_key" usuario@100.x.y.z
```

⚠️ **La clave privada (`s1_key`) es el acceso al server.** Backup en un lugar
seguro; si la perdés, hay que volver a instalar una nueva desde el S1.

---

## Paso 3 — RustDesk en S1 (escritorio gráfico)

**Tiene que correr como SERVICIO, no como app.** Si corre como app de usuario
queda atado a la sesión de Windows: cuando esa sesión se cierra, RustDesk muere
y no vuelve hasta que alguien lo abra a mano. Ese fue el síntoma real de
"andaba varios días y de repente no". Con `AutoAdminLogon=0` (S1 no auto-loguea)
es peor todavía: tras un reinicio no hay sesión, así que no habría RustDesk.

1. Descargá RustDesk: https://rustdesk.com → instalá en S1.
2. Registrarlo como servicio + auto-restart si crashea:
   ```powershell
   & "C:\Program Files\RustDesk\RustDesk.exe" --install-service
   Start-Sleep -Seconds 6
   $svc = Get-Service | ? { $_.Name -match 'RustDesk' } | Select -First 1
   Set-Service -Name $svc.Name -StartupType Automatic
   sc.exe failure $svc.Name reset= 86400 actions= restart/5000/restart/10000/restart/30000
   Get-Service $svc.Name | Format-Table Name,Status,StartType -Auto   # -> Running / Automatic
   ```
3. En la ventana de RustDesk: `⋮` → **Set permanent password** (fuerte), y
   **Enable unattended access**. Sin esto nadie puede entrar si no hay alguien
   del otro lado aceptando.
4. Anotá el **ID de RustDesk** de S1.
5. Desde tu PC: RustDesk → ID de S1 + la contraseña permanente.
   - Funciona por el relay de RustDesk (como AnyDesk) **o**, mejor, por conexión
     directa usando la IP Tailscale `100.x.y.z` (Settings → permitir IP directa).

> RustDesk es el plan B gráfico. El 90% de lo que necesitamos (deploys, logs,
> servicios) se hace por SSH, más rápido y confiable.

---

## Estado verificado (2026-07-30)

Diagnóstico corrido sobre S1 — **no hay ningún sistema de congelado/restauración**
(ni UWF, ni Deep Freeze, ni shell de kiosco: `Shell = explorer.exe`, sin tareas de
reset). Lo que se configura en S1 **persiste**. La causa de las caídas era
únicamente RustDesk corriendo como app en vez de servicio.

Los tres canales, todos servicios con auto-restart:

| Servicio | Estado | Para qué |
|-|-|-|
| `sshd` | Running / Automatic | consola (clave SSH) |
| `Tailscale` | Running / Automatic | la red privada |
| `RustDesk` | Running / Automatic | escritorio gráfico |

Comando de verificación (por SSH, cuando algo se sienta raro):
```powershell
Get-Service | ? { $_.Name -match 'RustDesk|Tailscale|sshd' } | Format-Table Name,Status,StartType -Auto
```

Si alguna vez sospechás de un mecanismo de restauración en otra máquina, el
diagnóstico completo está en `workflows/diagnostico-acceso-remoto.md`.

---

## Cómo te conectás desde Portugal

**Consola (lo habitual):**
```bash
ssh -i "$env:USERPROFILE\.ssh\s1_key" usuario@100.x.y.z   # IP Tailscale de S1
# ya adentro, PowerShell de S1:
cd C:\sta-server
.\update-server.ps1 -Now          # forzar update
Get-Content .\logs\update.log -Tail 30
Get-Content .\VERSION
Restart-Service sta-server         # reiniciar el server (requiere sesión admin)
```
(`usuario` = la cuenta Windows de S1. La sesión SSH entra **elevada**, así que
los comandos de admin andan directo — a diferencia del escritorio, donde UAC
puede frenarte.)

**Escritorio:** RustDesk con el ID + contraseña de S1.

---

## El pago: cómo queda la operación

- **Deploys sin AnyDesk roulette:** te conectás por SSH (siempre disponible) y corrés
  el update a mano, ves logs, reiniciás — en 2 minutos. Nunca más "15 horas intentando".
- **Diagnóstico instantáneo:** `Get-Content VERSION`, `update.log`, `Get-Service` —
  todo a un `ssh` de distancia. Incluso me podés pegar la salida y te digo el paso.
- **Independiente de que alguien esté en el local:** S1 está siempre en la red.

## Seguridad (resumen)
- Todo el acceso es **dentro de Tailscale** (device-auth). Cero puertos abiertos al router.
- **Disable key expiry** en el nodo S1 (sino se desconecta a los ~6 meses).
- Contraseña fuerte del usuario Windows. Opcional: clave SSH + desactivar password.
- Opcional: ACLs de Tailscale para limitar qué dispositivos llegan a S1.

---

*Creado 2026-06-23. Una vez instalado, administrar S1 deja de depender de AnyDesk.*
