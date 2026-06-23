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

Abrí **PowerShell como Administrador** en S1 y corré:

```powershell
# 1) Instalar el servidor OpenSSH (incluido en Windows Home como feature)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# 2) Arrancarlo + que arranque solo en el boot
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

# 3) Firewall: asegurar la regla de entrada para el puerto 22
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
}

# 4) (Recomendado) Que las sesiones SSH abran PowerShell en vez de cmd.exe.
#    Usa PowerShell 7 si está (el de S1 lo tiene), sino Windows PowerShell.
$pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
$shell = if ($pwsh) { $pwsh } else { "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" }
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $shell -PropertyType String -Force

# 5) Verificar
Get-Service sshd | Format-Table Name,Status,StartType
```

**Autenticación:** por defecto usa la contraseña de tu usuario Windows de S1. Como el
acceso ya va por dentro de Tailscale (autenticado por dispositivo), alcanza. Si querés
endurecer, después configuramos clave SSH (key-based) y desactivamos password.
Asegurate de que el usuario de Windows tenga **contraseña fuerte**.

---

## Paso 3 — RustDesk en S1 (escritorio gráfico, opcional)

Para cuando necesites ver la pantalla / Task Scheduler:
1. Descargá RustDesk: https://rustdesk.com → instalá en S1.
2. Settings → **Enable unattended access** y poné una **contraseña permanente** fuerte.
3. Habilitá que arranque con Windows / corra como servicio (Settings → "Start on boot").
4. Anotá el **ID de RustDesk** de S1.
5. Desde tu PC: RustDesk → ingresás el ID de S1 + la contraseña permanente.
   - Funciona por el relay de RustDesk (como AnyDesk) **o**, mejor, por conexión
     directa usando la IP Tailscale `100.x.y.z` (Settings → permitir IP directa).

> RustDesk es el plan B gráfico. El 90% de lo que necesitamos (deploys, logs,
> servicios) se hace por SSH, más rápido y confiable.

---

## Cómo te conectás desde Portugal

**Consola (lo habitual):**
```bash
ssh Usuario@100.x.y.z        # IP Tailscale de S1  (o el nombre MagicDNS)
# ya adentro, PowerShell de S1:
cd C:\sta-server
.\update-server.ps1 -Now          # forzar update
Get-Content .\logs\update.log -Tail 30
Get-Content .\VERSION
Restart-Service sta-server         # reiniciar el server (requiere sesión admin)
```
(`Usuario` = el nombre de la cuenta Windows de S1 — la del prompt `C:\Users\Usuario`.)

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
