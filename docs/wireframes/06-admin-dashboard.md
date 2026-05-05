# Wireframe 06 — Admin: dashboard inicial

> **Cuándo aparece**: home del admin después del login. La encargada o el dueño Julio entran y ven el resumen ejecutivo.
> **Premisa**: información de un solo vistazo. KPIs > pendientes > próximos depósitos > gráficos. Drill-down disponible en cada bloque.

## Layout (desktop, 1366×768+)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ 🍝 Santa Teresita                                              Encargada  ⚙  🔔 (3)   ▾    │
├────────────┬─────────────────────────────────────────────────────────────────────────────────┤
│            │                                                                                 │
│ NAVEGAC.   │  Inicio                                          Hoy ▾  ⟳  [ Exportar Excel ]   │
│            │  ─────────────────────────────────────────────────────────────────────────      │
│ ▾ Inicio   │                                                                                 │
│   📊 Dash. │  KPIs PRINCIPALES                                                               │
│            │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│ ▾ Movim.   │  │ Ventas hoy   │ │ Cobrado caja │ │ Por cobrar   │ │ Egresos hoy  │            │
│   💸 Egres │  │              │ │              │ │              │ │              │            │
│   💰 Ingr. │  │  $ 487.230   │ │  $ 312.450   │ │  $ 174.780   │ │  $  38.100   │            │
│            │  │  ↑ 12% ayer  │ │  103 ventas  │ │  Tarj. $130k │ │  4 movs.     │            │
│ ▾ Productos│  │              │ │              │ │  Plat. $44k  │ │              │            │
│   📋 Listd.│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘            │
│   🏷 Precios│                                                                                 │
│            │                                                                                 │
│ ▾ Admin.   │  ⚠ PENDIENTES (3)                                                               │
│   👥 Empl. │  ┌──────────────────────────────────────────────────────────────────────────┐  │
│   🤝 Clien.│  │  • 3 cambios de Excel pendientes de aprobar                            → │  │
│   📦 Insum.│  │  • 5 facturas cargadas por OCR sin validar                             → │  │
│   📈 Estad.│  │  • Sesión caja TARDE de ayer sin aprobar                               → │  │
│   ⚙  Conf.  │  │  • 2 facturas vencen en los próximos 3 días                            → │  │
│            │  └──────────────────────────────────────────────────────────────────────────┘  │
│ ▾ Caja     │                                                                                 │
│   📅 Sesión│                                                                                 │
│   💵 Cierr.│  💰 PRÓXIMOS DEPÓSITOS (próximos 20 días)                                       │
│            │  ┌──────────────────────────────────────────────────────────────────────────┐  │
│            │  │  Mañana 28/04         $ 145.230   Tarjeta Débito Santander            → │  │
│            │  │  02/05                $ 320.180   Tarjeta Crédito Santander           → │  │
│            │  │  02/05                $ 387.500   Pedidos YA                          → │  │
│            │  │  04/05                $  87.000   RAPPI                               → │  │
│            │  │  ...                                                                   → │  │
│            │  │  ─────────────────────────                                                │  │
│            │  │  Total 20 días:       $ 5.599.920                                         │  │
│            │  └──────────────────────────────────────────────────────────────────────────┘  │
│            │                                                                                 │
│            │                                                                                 │
│            │  📊 GRÁFICOS                                                                    │
│            │  ┌─────────────────────────────────────┐ ┌─────────────────────────────────┐   │
│            │  │ Ventas por hora (hoy)               │ │ Top 10 productos del mes        │   │
│            │  │                                     │ │                                 │   │
│            │  │     ▆▇                              │ │ Sorrentinos     ▰▰▰▰▰▰▰▰  847   │   │
│            │  │   ▆▇██▆                             │ │ Fideos huevo    ▰▰▰▰▰▰▰  712    │   │
│            │  │ ▄▆██▇▇▇▆▄                           │ │ Ñoquis          ▰▰▰▰▰▰   612    │   │
│            │  │ ▄██████▇▆▇▆▄                        │ │ Canelones J&Q   ▰▰▰▰▰    498    │   │
│            │  │ 9 10 11 12 13 14 15 16 17 18 19 20  │ │ Pizza Especial  ▰▰▰▰     422    │   │
│            │  │                                     │ │ ...                              │   │
│            │  └─────────────────────────────────────┘ └─────────────────────────────────┘   │
│            │                                                                                 │
│            │                                                                                 │
│            │  💳 SALDO DE CUENTAS                                                            │
│            │  ┌──────────────────────────────────────────────────────────────────────────┐  │
│            │  │  Caja física:        $ 312.450    ⏰ Hace 5 min                          │  │
│            │  │  Santander:          $ 850.000    ⏰ Hace 2 horas                         │  │
│            │  │  Galicia:            $ 420.000    ⏰ Hace 2 horas                         │  │
│            │  │  Cuenta DNI:         $  85.000    ⚠ Sin actualizar 3 días                 │  │
│            │  │  MercadoPago:        $ 245.180    ✓ En vivo                              │  │
│            │  │  ─────────────────────                                                    │  │
│            │  │  TOTAL DISPONIBLE:   $ 1.912.630                                          │  │
│            │  └──────────────────────────────────────────────────────────────────────────┘  │
│            │                                                                                 │
└────────────┴─────────────────────────────────────────────────────────────────────────────────┘
```

## Breakdown

### Header (56px)

- Logo + wordmark izq.
- Usuario activo + ⚙ + 🔔 con badge contador (alertas pendientes) + dropdown ▾ (logout, cambiar PIN, etc.)

### Sidebar (240px persistente desktop, colapsable a 64px)

- 4 secciones principales: Inicio, Movimientos, Productos, Administración + 1 (Caja)
- Sección activa highlighteada con `--green-teresita-700` background
- Click ▾ expande sub-secciones

### Toolbar contextual (top del contenido)

- Título de la sección actual ("Inicio")
- Selector de período: Hoy / Esta semana / Este mes / Este año / Personalizado
- Botón ⟳ para refrescar
- Botón "Exportar Excel" con la data actual

### KPIs (grid 4 col)

Cada KPI en card 240×140px con:
- Label superior (12px)
- Hero number (`--font-display`, `--text-2xl`, mono opcional para números puros)
- Comparativo dinámico (↑/↓ % vs período anterior, color verde/rojo)
- Sub-info (cantidad de transacciones, desglose, etc.)

### Pendientes

- Card con borde `--saffron-100`, lista de items accionables
- Cada item con icono → drill-down al lugar correspondiente
- Si no hay pendientes: empty state "✅ Todo al día"

### Próximos depósitos

- Tabla compacta con fecha + monto + fuente
- Total del período al final
- Click en una fila → drill-down a la liquidación (Sección 3.7.2 SPEC)

### Gráficos (grid 2 col en desktop)

- Bar chart de ventas por hora (Recharts / Apache ECharts, color `--green-teresita-700`)
- Top 10 productos en bar chart horizontal con cantidades
- Hover en barras → tooltip con detalle
- Click en barra → drill-down (ej. click en "ventas a las 19h" → lista de ventas de esa hora)

### Saldo de cuentas

- Las 5 cuentas con saldo + indicador de "frescura" del dato (en vivo / hace X / sin actualizar)
- ⚠ rojo si una cuenta tiene >24hs sin actualizar (Belvo no respondió)
- Total al pie

## Comportamiento responsive

- **≥1366px**: layout completo arriba.
- **1024–1365px**: sidebar colapsa a iconos solamente, KPIs en grid 2×2, gráficos full-width apilados.
- **<1024px**: ver Wireframe 09 (mobile).

## Atajos

| Tecla | Acción |
|-|-|
| `Ctrl+1` a `Ctrl+5` | Saltar a sección 1–5 |
| `Ctrl+R` | Refrescar dashboard |
| `Ctrl+E` | Exportar Excel |
| `Ctrl+B` | Colapsar/expandir sidebar |
| `/` | Foco en buscador global (futuro) |

## Componentes usados

- `Sidebar` (con dropdowns y collapse)
- `KPI` (hero variant)
- `PendingTaskCard`
- `Table` (compact)
- `Chart` (bar, horizontal-bar)
- `AccountBalanceList`

## Referencias

- SPEC §3.7.2 — Próximos depósitos
- SPEC §7.5.1 — Layout admin
- SPEC §7.5.2 — Dashboard inicial
