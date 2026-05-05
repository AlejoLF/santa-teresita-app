# API scripts — utilidades manuales

Scripts ejecutables manuales (smoke tests, generadores de data de prueba, limpiezas one-shot).
**No se incluyen en el bundle de producción** — viven acá para que estén accesibles
sin contaminar `apps/api/src`.

## Cómo correrlos

Desde la raíz del repo, usando `tsx` (más rápido que `ts-node`):

```bash
pnpm exec tsx tools/api-scripts/smoke-dashboard.ts
pnpm exec tsx tools/api-scripts/check-ventas.ts
# etc.
```

Necesitan las mismas env vars que el API (`DATABASE_URL`, `AUTH_SECRET`, etc. — mirá `apps/api/.env`).

## Inventario

| Script | Para qué |
|---|---|
| `smoke-cashflow-writeback.ts` | Verifica el writeback de cashflow al Excel del cliente |
| `smoke-cierre-email.ts` | Test del envío de email de cierre de caja (a `alejolafalce@gmail.com`) |
| `smoke-cleanup.ts` | Limpieza de data de smoke tests previos |
| `smoke-dashboard.ts` | Smoke del endpoint `/admin/dashboard` |
| `smoke-excel-sync.ts` | Test del flujo de aprobación de cambios desde Drive |
| `smoke-insumos-catalogo.ts` | Smoke del catálogo de insumos/proveedores |
| `check-modificadores.ts` | Inspeccionar modificadores en DB |
| `check-ventas.ts` | Listar ventas con filtros |
| `generar-dia-prueba.ts` | Genera ~50 ventas ficticias para testear el dashboard |
| `limpiar-productos-legacy.ts` | Borra productos viejos del seed legacy |
| `simulate-price-change.ts` | Simula un cambio de precio para testear el flow de aprobación |
