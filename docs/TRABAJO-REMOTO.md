# Trabajar desde la nube (sin la PC)

Guía rápida para operar el proyecto desde el celular / cualquier navegador.
Todo el ciclo de release corre en GitHub Actions — la PC ya no buildea nada.

## 1. Publicar un nuevo alpha (.exe de las cajas) 📱

**Desde el navegador del teléfono** (la app de GitHub para celular NO dispara
workflows bien — usá el navegador):

1. github.com/AlejoLF/santa-teresita-app → pestaña **Actions**.
2. Elegí **Release Desktop** (columna izquierda) → botón **Run workflow**.
3. Dejá `bump = prerelease` (bumpea `alpha.NN` → `alpha.NN+1` solo).
   - Si querés una versión exacta: `bump = custom` y escribí la versión en
     el campo (ej. `2.0.0-alpha.60`).
4. **Run workflow**. En ~9 min queda publicado y las cajas se auto-actualizan
   (electron-updater).

El workflow hace TODO solo: bump de versión, commit a `main`, tag, build en
Windows y publish al Release. No hay que tocar archivos ni tipear tags.

> Alternativa: pedíselo a Claude (web) y corre `gh workflow run "Release Desktop"`.

## 2. Aplicar migraciones a Supabase (cambios de schema) 📱

Cuando un fix incluye cambio de base de datos (columna nueva, tabla, etc.):

1. Actions → **Cloud Migrate** → **Run workflow** → Run.
2. Aplica solo las migraciones **pendientes** (idempotente — si no hay nada
   pendiente, no rompe nada, dice "0 aplicadas").

**Orden correcto** cuando un release trae cambio de schema:
**primero Cloud Migrate, después Release Desktop** — así las cajas ya
encuentran las columnas nuevas cuando se auto-actualizan.

## 3. Editar código y deployar la web 📱

- **Editar**: desde Claude en la web (claude.ai/code) apuntando a este repo,
  o el editor web de GitHub (tecla `.` sobre el repo).
- **Deploy web + API**: automático en cada push a `main` (Vercel = web,
  Railway = API). No hay que hacer nada más.

## 4. Publicar el servidor local S1 📱

Actions → **Release Server (S1)** → *Run workflow*.

| Campo | Qué poner |
|-|-|
| `bump` | `patch` (1.1.9 → 1.1.10) — el caso normal |
| `inmediato` | dejalo en `false` salvo hotfix |

El workflow bumpea `apps/server/package.json`, commitea a `main` y publica el
release `server-v*` con el zip. **S1 lo aplica solo en la tarea de las 4 AM**:
hace backup de la base, para el servicio, reemplaza el código, aplica las
migraciones nuevas, reinicia y verifica `/health`. Si algo falla, rollback.

Con `inmediato: true` el release sale marcado `STA_DEPLOY_NOW` y lo agarra la
tarea que corre cada 5 min. Usalo solo para hotfixes: reinicia el servicio en
medio del día.

> **Ojo con el runner.** El job corre en `windows-latest` y no es preferencia:
> el build empaqueta el engine nativo de Prisma y el prebuilt de
> `better-sqlite3` **de la plataforma donde corre**. Compilado en Linux, S1
> recibe un `.so` y no levanta — y como el updater hace rollback ante el primer
> error, se ve como "no entró la actualización", no como "está mal compilado".

> **S1 tiene su propio ciclo, separado del `.exe`.** Publicar un alpha NO
> actualiza S1, ni al revés. Si una feature toca la API y la usás desde S1, hay
> que correr los dos. Síntoma de haberlo olvidado: la pantalla tira 404 en una
> ruta que existe en el código — y ese 404 viene sin código `STA-`, porque el
> código viejo no los emitía.

## Lo único que TODAVÍA necesita la PC 🖥️

**Testear el `.exe` contra el mirror local** (Docker en la PC). Es inherente a
una app de escritorio Windows con impresora térmica: no se puede emular en la
nube. Igual, las features de **web** (admin, pedidos, encargos) se testean
perfecto desde el celu contra el deploy de Vercel — solo lo específico de las
cajas (impresión, outbox offline, sync multi-PC) pide la máquina física.

## Secrets (ya configurados, no hace falta tocar)

En repo → Settings → Secrets and variables → Actions:
`SUPABASE_DB_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`AUTH_SECRET`, `AUDIT_HASH_SALT`, `SMTP_USER`, `SMTP_PASS`.
