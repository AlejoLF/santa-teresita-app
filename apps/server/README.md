# @sta/server — Servidor local LAN (mini PC)

Deliverable **separado** del `.exe` de las cajas. Esto es lo que se lleva al
mini PC del negocio.

## 📖 Para desplegar, leé el playbook completo

[**`docs/DEPLOY-SERVIDOR-LOCAL.md`**](../../docs/DEPLOY-SERVIDOR-LOCAL.md)

Tiene paso a paso: server local, cajas, PWA en Vercel, verificación
end-to-end (incluido el test del corte de luz) y troubleshooting. Si estás
en el mini PC y descomprimiste `dist/`, el playbook está copiado adentro:
`./DEPLOY-SERVIDOR-LOCAL.md`.

Diseño y rationale (por qué es así): [`docs/SERVIDOR-LOCAL.md`](../../docs/SERVIDOR-LOCAL.md).

## Quick reference

```bash
# En tu PC de dev, una vez:
pnpm install
pnpm --filter @sta/server build
# → apps/server/dist/ (llevar al mini PC)

# En el mini PC (Postgres 16 + Node 20 + NSSM instalados de antes):
cd C:\sta-server                       # donde copiaste el dist/
copy .env.example .env && notepad .env # completar passwords + secrets
powershell -ExecutionPolicy Bypass -File .\setup-mini-pc.ps1   # como Admin

# Verificación (127.0.0.1, NO localhost: el API escucha solo IPv4 y Node 17+
# resuelve localhost a ::1 primero — ver gotchas en CLAUDE.md):
Get-Service postgresql-x64-16, sta-server        # Running + Automatic
curl http://127.0.0.1:3001/health                # dbState=PRIMARY
curl http://127.0.0.1:3001/api/v1/sync/status    # rol=server + replicacion lag
```

## Cuando la replicación a la nube se atrasa

`/api/v1/sync/status` devuelve `replicacion: { pendientes, estancados, masViejoMs }`.
Con `estancados > 0` hay eventos que agotaron sus 25 reintentos: esas filas
existen **solo en S1**, se ven en el programa pero no en la nube. No frenan a
los eventos nuevos (el drenado los saltea), así que es una fuga silenciosa, no
una parada.

La causa típica es una fila creada sin `recordAudit`: nunca viaja, y el hijo que
la referencia rebota por FK. Para verlo y arreglarlo:

```powershell
cd C:\sta-server
node api\reparar-replicacion.mjs             # diagnóstico, no escribe nada
node api\reparar-replicacion.mjs --aplicar   # copia los padres faltantes y reactiva
```

Resetear los reintentos a mano **no alcanza**: el padre sigue sin existir en la
nube y la FK vuelve a fallar. El script copia primero los ancestros faltantes
(recursivo) y recién ahí reactiva los eventos.

## Pendientes / gotchas

- `AUTH_SECRET` y `AUDIT_HASH_SALT` **idénticos** en server, cajas y Vercel.
- Pooler de Supabase = **`aws-1-sa-east-1`** (no `aws-0` legacy).
- NTP sincronizado en el mini PC (fechas de sesión dependen de TZ).
- UPS recomendado (evita corrupción del WAL en cortes).
- **Nunca** `prisma migrate dev` contra este repo (genera migraciones de
  drift que dropean índices — ver gotchas en `CLAUDE.md`).
