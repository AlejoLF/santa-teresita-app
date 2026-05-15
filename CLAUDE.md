# CLAUDE.md — Santa Teresita Pastas

Guía para Claude Code y desarrolladores trabajando sobre este repo.

## Contexto

App de gestión integral para Santa Teresita Pastas (La Plata, AR) — POS + cashflow +
proveedores + ticketing térmico + sync con Excel + integraciones externas (RAPPI, Pedidos
YA, MELI, MercadoPago, Belvo). Reemplaza Innovo Suite (USD 180/mo) y resuelve sus
problemas estructurales.

**Documentación viva**:
- [docs/SPEC.md](docs/SPEC.md) — especificación funcional completa (13 secciones, ~5.000 líneas).
- [docs/PREGUNTAS.md](docs/PREGUNTAS.md) — pendientes a resolver con el cliente.
- [docs/wireframes/00-INDEX.md](docs/wireframes/00-INDEX.md) — wireframes ASCII.

## Arquitectura: WAT (Workflows / Agents / Tools)

Tres capas separadas — la IA razona, el código ejecuta. Compounding de errores es la
razón: 5 pasos al 90% = 59% end-to-end. Offloadear ejecución a scripts mantiene la
orquestación confiable.

- **[workflows/](workflows/)** — SOPs en markdown. Cada uno define objetivo, inputs, tools, edge cases.
- **Agents** (Claude leyendo workflows) — secuencian tools y manejan errores. No ejecutan lógica directa.
- **[tools/](tools/)** — scripts deterministas (Python para parsers de Excel, scripts de mantenimiento).

## Stack

| Capa | Tech | Notas |
|-|-|-|
| Backend | Node 22 + TS + Fastify + Prisma | tipado end-to-end |
| DB | PostgreSQL 16 | replicación lógica local↔VPS |
| Cola | Redis 7 + BullMQ | webhooks, impresión, jobs |
| Web | Next.js 15 + React 19 + Tailwind | PWA instalable |
| Auth | better-auth + PIN 4 dígitos | bcrypt |
| Agente local | Node daemon + node-thermal-printer | EPSON TM-T20II |
| Sync Excel | Google Drive API + exceljs | aprobación admin |
| OCR facturas | LLM con visión (Haiku/4o-mini) en N8N | bot Telegram |
| Deploy | Docker Compose + Caddy | VPS + LAN local |

## Estructura del repo

```
.
├── apps/
│   ├── api/          ─ Fastify API (auth, catálogo, ventas, audit)
│   ├── web/          ─ Next.js (Vendedor + Admin)
│   └── local-agent/  ─ daemon de impresión ESC/POS
├── packages/
│   ├── db/           ─ Prisma schema + seeds
│   └── shared/       ─ types, zod schemas, money utils, hash chain
├── tools/            ─ scripts Python (parsers de Excel)
├── workflows/        ─ SOPs en markdown
├── infra/
│   ├── docker/       ─ compose + init SQL
│   └── caddy/        ─ Caddyfile prod
├── docs/             ─ SPEC.md, PREGUNTAS.md, wireframes/
└── *.xlsx            ─ Excels del cliente (input)
```

## Cómo arrancar dev

Prerequisitos: Node 22+, pnpm 9+, Docker, Python 3.10+.

```bash
# 1. Variables de entorno
cp .env.example .env

# 2. Instalar deps
pnpm install

# 3. Postgres + Redis + Adminer
pnpm docker:up

# 4. Generar el cliente Prisma
pnpm db:generate

# 5. Migrar DB (genera y aplica migración inicial)
pnpm --filter @sta/db migrate -- --name init

# 6. Parsear el Excel (opcional, output ya está committeado)
pip install openpyxl
python tools/parse_lista_precios.py \
  --excel "Lista de Precios.xlsx" \
  --output packages/db/prisma/seed-data/lista-precios.json

# 7. Cargar datos iniciales (usuarios, categorías, productos)
pnpm db:seed

# 8. Levantar todo en paralelo
pnpm dev
# API   → http://localhost:3001
# Web   → http://localhost:3000
# Adminer (DB UI) → http://localhost:8080  (server: postgres / user: teresita / db: teresita)
```

PINs default (cambiar en producción):
- Vendedor: `0001`
- Encargada: `0002`
- Julio: `0003`

## Cómo operar

1. **Antes de codear**: leé el SPEC sección relevante. La fuente de verdad operativa
   es el SPEC + wireframes.
2. **Antes de armar tooling**: chequeá `tools/` y `workflows/`. No reinventes scripts.
3. **Cuando una tarea sea ejecutable**: NO la inlinees en el razonamiento. Encontrá el
   workflow + tool, o creá uno nuevo.
4. **Workflows acumulan aprendizaje** (rate limits, quirks, formato del Excel). No los
   reescribas casualmente — agregá notas.
5. **Failure → system improvement.** Leé el trace completo, arreglá el tool, verificá,
   actualizá el workflow con lo aprendido. Si un retry quema créditos pagos, confirmar
   con el user primero.

## Testing

Pendiente — el alcance del MVP no incluyó suite de tests. La rama `feat/tests` levanta
Vitest + Playwright cuando se priorice.

## Decisiones cerradas (no re-discutir sin evidencia nueva)

Ver SPEC §1.5. Punteo:
- Local-first hybrid (Postgres replicado).
- 2 roles operativos: Vendedor (PIN compartido) + Admin (PIN por persona).
- 3 estados de venta: Procesada / Finalizada / Anulada.
- Modelo de productos con modificadores y combos (no SKUs aplanados).
- Sin ARCA en este sistema.
- Sin stock control en fase 1.
- Bot WhatsApp es fase 2.
- Aesthetic: "Trattoria refinada" — verde Teresita + cremoso + serif Fraunces.

## Invariantes / gotchas (no romper sin entender por qué)

- **Todo registro transaccional atado a un turno DEBE setear `sesionCajaId`
  vía `getOrCreateSesionActual(usuarioId)`.** Aplica a ventas Y movimientos
  (aportes/egresos/transferencias). Síntoma si se rompe: el registro queda
  con `sesion_caja_id = NULL`, NO entra al cierre de caja (que filtra por
  sesión) pero SÍ aparece en `/admin/movimientos` (filtra por fecha) — da
  la falsa sensación de que "se mezcla con sesiones pasadas". Incidente real:
  alpha.18 y anteriores, `POST /admin/movimientos` no seteaba el campo.
  Fix en alpha.19. Si agregás un endpoint nuevo que crea algo que debería
  contar para el cierre del turno, llamá `getOrCreateSesionActual` y manejá
  el `FueraDeHorarioError` (devolver 423).

- **Fechas de sesión: usar siempre TZ Argentina explícita.** El cálculo de
  `fecha` de `SesionCaja` depende de la TZ del proceso. El .exe spawnea el
  API con `TZ='America/Argentina/Buenos_Aires'` — si corrés el API en otro
  contexto (Vercel, CI, dev sin TZ) las sesiones creadas en madrugada AR
  quedan con la fecha del día anterior. El resolver de `horarios.ts` usa
  `getFullYear/Month/Date` (TZ-local) — correcto solo si la TZ está bien.

- **Pooler de Supabase: `aws-1-sa-east-1`, NO `aws-0`.** Supabase migró la
  infra de Supavisor. La URL legacy `aws-0-*` devuelve "tenant not found".
  El default está en `scripts/cloud/_url.mjs`. Si `cloud:migrate`/`status`
  fallan con ese error, la conexión directa (`SUPABASE_DB_URL_DIRECT`,
  puerto 5432) funciona como fallback para aplicar migraciones.

- **`prisma generate` falla con EPERM si el .exe está abierto.** El proceso
  `Santa Teresita.exe` mantiene `query_engine-windows.dll.node` lockeado.
  Cerrar la app antes de regenerar. Verificar con:
  `Get-Process | ? { $_.Modules.FileName -like '*query_engine-windows*' }`.

- **Repartidor en tickets: se infiere del canal** (`repartidorPorCanal()` en
  `services/impresion.ts`). RAPPI/PYA/MELI/DELIVERATE no requieren asignación
  manual. Prioridad: empleado interno asignado > empresa explícita > inferido
  del canal. Los 3 tickets (comanda cocina, ticket cliente, ticket delivery)
  deben mostrarlo — si tocás uno, revisá los otros dos.

## Estado del bootstrap (2026-04-27)

✅ Schema Prisma con todas las entidades de SPEC §2-11
✅ Seeds idempotentes (usuarios, cuentas, categorías, productos desde Excel)
✅ Parser de "Lista de Precios.xlsx" → JSON de seed
✅ API Fastify: auth con PIN bcrypt, sesiones, hash-chain audit, catálogo, ventas
✅ Web Next.js: design tokens (verde Teresita + cremoso), login Vendedor (Wireframe 01),
   pantalla cargar pedido (Wireframe 02) con catálogo + carrito + modal modificadores,
   pantalla cobro con descuento 10%, historial de sesión
✅ Local agent stub con drivers ESC/POS para EPSON TM-T20II
✅ Docker Compose dev (Postgres + Redis + Adminer)
✅ Caddyfile prod
✅ Workflows iniciales

## Pendientes priorizados

| # | Item | Bloqueante para |
|-|-|-|
| 1 | Resolver pendientes del cliente (PREGUNTAS.md) | Producción |
| 2 | Implementar pago multi-cuenta UI (Wireframe 08) | Pago a proveedores |
| 3 | Implementar dashboard admin (Wireframe 06) | Sesión Admin |
| 4 | Implementar sync Excel ↔ programa | Aprobación de cambios masivos |
| 5 | Conectar webhooks RAPPI/PYA/MELI | Integración delivery |
| 6 | Hash-chain audit triggers en Postgres (no solo app-level) | Forensic strength |
| 7 | Cola BullMQ para impresión (en lugar de polling del agent) | Throughput alto |
| 8 | Tests E2E con Playwright | Calidad |
| 9 | Setup CI/CD GitHub Actions | Deploy automático |

## Datos del cliente

- Local: Av. 44 e. 12 y Plaza Paso, La Plata, Bs. As.
- Volumen: 200–2.500 ventas/día
- Personal: encargada + dueño Julio + cajeros + cocineros + 1 motoquero (Damián)
- Apps usadas: RAPPI, Pedidos YA, Mercado Libre, DELIVERATE
- Cuentas: Caja física, Santander, Galicia, Cuenta DNI (BAPRO), MercadoPago

---

*Última actualización: 2026-05-15 (alpha.19). Sección "Invariantes / gotchas"
agregada tras el incidente de movimientos sin sesión reportado por la encargada.*
