# @sta/server — Servidor local LAN (mini PC)

Deliverable **separado** del `.exe` de las cajas. Esto es lo que se lleva al
mini PC del negocio. Diseño completo: [`docs/SERVIDOR-LOCAL.md`](../../docs/SERVIDOR-LOCAL.md).

El mini PC corre: **Postgres (fuente de verdad)** + **API Fastify** +
**replicator → Supabase**. Las cajas (`.exe`) le pegan por LAN. Headless,
arranca solo tras un corte de luz (Windows Services, sin login/UAC/humano).

---

## 1. Buildear el paquete (en tu máquina de dev)

```bash
pnpm install
pnpm --filter @sta/server build
```

Produce `apps/server/dist/` autocontenido:

```
dist/
  api/server.mjs + node_modules/   API bundleada + @prisma/client + engine
  migrations/*.sql                  todas las migraciones (orden cronológico)
  seed/seed.mjs + seed-data/        seed compilado
  .env.example                      template de config
  setup-mini-pc.ps1                 provisión
  README.md                         este archivo
```

## 2. Llevarlo al mini PC

Copiá la carpeta `dist/` completa al mini PC (USB, red, o `git clone` + build
ahí si tiene toolchain). No depende del `.exe` para nada.

## 3. Prerrequisitos en el mini PC (una vez)

- Windows 10/11 x64
- **PostgreSQL 16 x64** — instalá el oficial (incluye `psql`, crea el service
  `postgresql-x64-16`). Anotá la password del superusuario `postgres`.
- **Node.js 20+ LTS**
- **NSSM**: `winget install NSSM.NSSM`

## 4. Configurar y provisionar

```powershell
cd dist
copy .env.example .env
notepad .env          # completar credenciales (ver abajo)
powershell -ExecutionPolicy Bypass -File .\setup-mini-pc.ps1   # como Admin
```

`.env` — campos críticos:

| Var | Qué poner |
|-|-|
| `DATABASE_URL` | Postgres local del mini PC. Password fuerte. |
| `REPLICATE_TO_URL` | Pooler Supabase **aws-1** (no aws-0). Vacío = sin backup cloud. |
| `AUTH_SECRET` / `AUDIT_HASH_SALT` | **IDÉNTICOS** a los del resto del sistema (cajas + Vercel). Si difieren se rompe el hash-chain y las sesiones. |
| `TZ` | `America/Argentina/Buenos_Aires` (no cambiar) + configurar NTP. |

`setup-mini-pc.ps1` es **idempotente**: crea rol+DB, aplica migraciones
pendientes (tracking por nombre, **no** usa `prisma migrate dev` — ver gotcha
en CLAUDE.md), seedea solo si la DB está vacía, registra el Windows Service
`sta-server` (auto-start + auto-restart + depende de Postgres), y abre el
firewall (5432 + 3001) **solo** en la subred LAN.

## 5. Verificación

```powershell
Get-Service postgresql*, sta-server          # ambos Running + Automatic
curl http://localhost:3001/health
curl http://localhost:3001/api/v1/sync/status   # ver "rol":"server" + "replicacion"
```

`sync/status.replicacion` muestra el lag del replicator: `pendientes`,
`estancados`, `masViejoMs`. Si `pendientes` no baja → revisar
`dist/logs/sta-server.err.log` (¿Supabase inalcanzable? ¿REPLICATE_TO_URL mal?).

## 6. Apuntar las cajas a este server

En cada caja, en `%APPDATA%/Santa Teresita/config.json`:

```json
{
  "rol": "caja",
  "lanDbUrl": "postgresql://teresita:PASS@<IP_DEL_MINIPC>:5432/teresita",
  "cloudDbUrl": "postgresql://postgres.<ref>:PASS@aws-1-sa-east-1.pooler.supabase.com:6543/postgres",
  "webRemoteUrl": "https://sta-desktop.vercel.app"
}
```

(El soporte de `lanDbUrl` + failover en el `.exe` es parte de la entrega de
la caja — ver plan Fase 1 en `docs/SERVIDOR-LOCAL.md §7`.)

## 7. Operación headless

- Corte de luz → vuelve la luz → Windows bootea → Postgres service →
  `sta-server` service → replicator drena lo pendiente. **Cero intervención.**
- Sin monitor: admin remoto por RDP / OpenSSH (habilitar a gusto).
- **UPS recomendado**: evita reinicios por parpadeos y corrupción del WAL.
- Logs: `dist/logs/sta-server.{out,err}.log` (rotan a 10 MB).

## 8. Qué NO hace esta Fase

- El catch-up Supabase→local tras un corte de luz (cuando se operó por la PWA
  móvil) es **Fase 1.5** — ver `docs/SERVIDOR-LOCAL.md §5.2 / §7`.
- `prisma migrate dev` **nunca** acá: rompe por drift (gotcha CLAUDE.md). Las
  migraciones nuevas se agregan como `.sql` y `setup-mini-pc.ps1` las aplica.
