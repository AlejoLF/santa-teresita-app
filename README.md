# 🍝 Santa Teresita Pastas — Sistema de gestión

POS + cashflow + proveedores + ticketing térmico para Santa Teresita Pastas (La Plata, AR).

Reemplaza Innovo Suite, integra apps de delivery (RAPPI, Pedidos YA, MELI, DELIVERATE),
sincroniza con Excels operativos vía Drive, automatiza facturación de proveedores con
N8N + bot Telegram + OCR LLM.

---

## Quickstart

```bash
cp .env.example .env
cp .env packages/db/.env          # Prisma busca el .env donde corre, no en root
pnpm install
pnpm docker:up                    # Postgres + Redis + Adminer
pnpm db:generate
pnpm --filter @sta/db migrate -- --name init
pnpm db:seed
pnpm dev
```

En PowerShell (Windows), `cp` es `Copy-Item` y `&&` no existe — corré los comandos
de a uno o usá `;`:

```powershell
Copy-Item .env.example .env
Copy-Item .env packages\db\.env
pnpm install
pnpm docker:up
pnpm db:generate
pnpm --filter @sta/db migrate -- --name init
pnpm db:seed
pnpm dev
```

- Web: http://localhost:3000  (PIN `0001` para Vendedor)
- API: http://localhost:3001
- Adminer: http://localhost:8080

## Documentación

| Archivo | Para qué |
|-|-|
| [CLAUDE.md](CLAUDE.md) | Guía Claude Code + cómo operar el repo |
| [docs/SPEC.md](docs/SPEC.md) | Especificación funcional completa (13 secciones) |
| [docs/PREGUNTAS.md](docs/PREGUNTAS.md) | Pendientes a confirmar con el cliente |
| [docs/wireframes/](docs/wireframes/) | Wireframes ASCII (10 pantallas) |
| [workflows/](workflows/) | SOPs ejecutables (parsers, agentes) |

## Arquitectura

WAT (Workflows / Agents / Tools) — ver `CLAUDE.md`. Stack: Node 22 + TS + Fastify +
Prisma + Postgres 16 + Redis 7 + Next.js 15. Local-first hybrid con replicación lógica.

## Status

Bootstrap inicial completo. Lo que hay funcionando hoy:
- Login del Vendedor con PIN bcrypt
- Pantalla principal del cajero con catálogo + carrito + modal de modificadores
- API REST con auth, catálogo, ventas, audit hash-chain
- Seeds desde el Excel "Lista de Precios.xlsx" (parser Python)
- Drivers ESC/POS para EPSON TM-T20II en local-agent

Próximo: dashboard admin, pago multi-cuenta, integraciones de delivery, sync Excel.

## Licencia

Propietario / privado.
