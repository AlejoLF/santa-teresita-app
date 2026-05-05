# Wireframe 09 — Admin: experiencia móvil

> **Cuándo aparece**: la encargada o el dueño Julio acceden desde el celular para consultar/actuar puntualmente. Mobile only para el rol Admin.
> **Premisa**: información condensada, navegación por bottom tabs, flujos críticos disponibles en wizard multi-step.

## Pantalla 1 — Login mobile

```
┌─────────────────────────┐
│                         │
│                         │
│                         │
│      🍝                 │
│  SANTA TERESITA         │
│                         │
│                         │
│   ─────────────         │
│                         │
│   Bienvenido            │
│   Ingresá tu PIN        │
│                         │
│                         │
│   ┌─┐ ┌─┐ ┌─┐ ┌─┐       │
│   │●│ │●│ │ │ │ │       │
│   └─┘ └─┘ └─┘ └─┘       │
│                         │
│                         │
│   ┌───┬───┬───┐         │
│   │ 1 │ 2 │ 3 │         │
│   ├───┼───┼───┤         │
│   │ 4 │ 5 │ 6 │         │
│   ├───┼───┼───┤         │
│   │ 7 │ 8 │ 9 │         │
│   ├───┼───┼───┤         │
│   │   │ 0 │⌫ │         │
│   └───┴───┴───┘         │
│                         │
│                         │
│  Encargada — iPhone     │
│                         │
└─────────────────────────┘
```

- Numpad táctil grande (40px+ touch targets)
- PIN input con 4 cuadros, auto-foco, auto-submit
- Footer con identificación del dispositivo

## Pantalla 2 — Dashboard mobile

```
┌─────────────────────────┐
│ ☰  Santa Teresita  🔔  │  Header 56px
├─────────────────────────┤
│                         │
│  Hoy 27/04 · 19:42      │
│                         │
│  ━━━━━━━━━━━━━━━━━━━━   │
│                         │
│  VENTAS HOY             │
│  $ 487.230              │
│  ↑ 12% vs ayer          │
│                         │
│  ━━━━━━━━━━━━━━━━━━━━   │
│                         │
│  COBRADO EN CAJA        │
│  $ 312.450              │
│  103 ventas             │
│                         │
│  ━━━━━━━━━━━━━━━━━━━━   │
│                         │
│  POR COBRAR             │
│  $ 174.780              │
│  Tarj $130k / Plat $44k │
│                         │
│  ━━━━━━━━━━━━━━━━━━━━   │
│                         │
│  ⚠ PENDIENTES (3)       │
│  ┌─────────────────────┐│
│  │ → 3 cambios Excel   ││
│  ├─────────────────────┤│
│  │ → 5 facturas OCR    ││
│  ├─────────────────────┤│
│  │ → Cierre tarde      ││
│  └─────────────────────┘│
│                         │
│  ━━━━━━━━━━━━━━━━━━━━   │
│                         │
│  💰 PRÓXIMO DEPÓSITO    │
│  Mañana 28/04           │
│  $ 145.230              │
│  Tarj. Débito Sant.     │
│                         │
│  [ Ver todos los próx ]  │
│                         │
│  ━━━━━━━━━━━━━━━━━━━━   │
│                         │
│  💳 SALDOS              │
│  Caja:      $ 312.450   │
│  Santander: $ 850.000   │
│  Galicia:   $ 420.000   │
│  Cta DNI:   $  85.000 ⚠ │
│  MP:        $ 245.180   │
│  ─────                  │
│  Total:   $ 1.912.630   │
│                         │
│  ━━━━━━━━━━━━━━━━━━━━   │
│                         │
│                         │
├─────────────────────────┤
│ 🏠   💸    📋    ⚙      │  Bottom tabs
│Inicio Mov Prod  Más     │  56px
└─────────────────────────┘
```

- Cards apiladas verticalmente
- KPIs full-width, no en grid
- Pendientes como lista clickeable
- Próximo depósito destacado (el dato más útil para planificación)
- Saldos compactos al final
- Pull-to-refresh

## Pantalla 3 — Bottom navigation expandida

```
┌─────────────────────────┐
│ ╳        Más            │
├─────────────────────────┤
│                         │
│  📊 Estadísticas        │
│     Reportes y gráficos │
│                         │
│  ─────────────────      │
│                         │
│  👥 Empleados            │
│  🤝 Clientes             │
│  📦 Insumos             │
│  🏪 Proveedores          │
│                         │
│  ─────────────────      │
│                         │
│  📅 Caja sesión          │
│  💵 Cierres de caja      │
│                         │
│  ─────────────────      │
│                         │
│  ⚙ Configuración         │
│  🔔 Alertas              │
│  📝 Audit log            │
│                         │
│  ─────────────────      │
│                         │
│  Encargada              │
│  PIN admin              │
│  [ Cerrar sesión ]      │
│                         │
└─────────────────────────┘
```

- Sheet que se desliza desde abajo cuando se toca "Más" (4° tab)
- Lista de secciones secundarias
- Identificación del usuario activo + opción cerrar sesión

## Pantalla 4 — Movimientos mobile

```
┌─────────────────────────┐
│ ←  Movimientos     🔍   │
├─────────────────────────┤
│ [ Todos ▾ ]  [ Hoy ▾ ]  │
├─────────────────────────┤
│                         │
│  $ 25.000               │
│  EDGARDO                │
│  Adelanto · Empleados   │
│  20/04 21:22 · Alicar   │
│  Caja física · Conf.    │
│                  →      │
│  ─────────────────      │
│                         │
│  $ 1.651.395            │
│  Aporte Banco           │
│  Genérico · Comisión    │
│  23/04 21:38 · Alicar   │
│  Santander · Conf.      │
│                  →      │
│  ─────────────────      │
│                         │
│  $ 700.000              │
│  LUIS GOURMET           │
│  Insumos · Pago factura │
│  24/04 16:53 · Alicar   │
│  Galicia · Confirmado   │
│                  →      │
│  ─────────────────      │
│                         │
│  ...                    │
│                         │
│           [ + ]         │  Floating Action Button
├─────────────────────────┤
│ 🏠   💸    📋    ⚙      │
│Inicio Mov Prod  Más     │
└─────────────────────────┘
```

- Lista de movimientos como cards (no tabla)
- Cada card: monto + entidad + categoría + fecha + cuenta + estado
- Swipe lateral para ver acciones rápidas (anular, editar)
- FAB (botón flotante) verde Teresita para "Nuevo movimiento" (ingreso o egreso)
- Tap → drill-down al detalle

## Pantalla 5 — Pagar facturas mobile (wizard)

Versión simplificada del Wireframe 08, en pasos:

```
Paso 1: Seleccionar facturas
┌─────────────────────────┐
│ ←  Pagar facturas        │
│  Paso 1 de 3             │
├─────────────────────────┤
│                         │
│  PROVEEDOR              │
│  [ Vacalin           ▾]│
│                         │
│  ───────────────        │
│                         │
│  ☑ FB-12345             │
│    $ 200.000            │
│    Vence 28/04 ⚠         │
│    Aplicar: $ 200.000   │
│                         │
│  ☑ FB-12398             │
│    $ 500.000            │
│    Vence 30/04 ⚠         │
│    Aplicar: $ 500.000   │
│                         │
│  ☑ FB-12420             │
│    $ 300.000            │
│    Vence 02/05          │
│    Aplicar: $ 300.000   │
│                         │
│  ☐ FB-12445             │
│    $ 180.000            │
│    Vence 05/05          │
│                         │
│  ───────────────        │
│                         │
│  Total a pagar:         │
│  $ 1.000.000            │
│                         │
│   [ Siguiente → ]       │
│                         │
└─────────────────────────┘
```

```
Paso 2: Distribuir entre cuentas
┌─────────────────────────┐
│ ←  Pagar facturas        │
│  Paso 2 de 3             │
├─────────────────────────┤
│                         │
│  Total: $ 1.000.000     │
│                         │
│  CUENTAS                │
│                         │
│  ┌──────────────────┐   │
│  │ Caja física      │   │
│  │ EFECTIVO         │   │
│  │ $ [ 300.000 ]    │   │
│  │           [ ✕ ]   │   │
│  └──────────────────┘   │
│                         │
│  ┌──────────────────┐   │
│  │ Santander        │   │
│  │ TRANSFER.        │   │
│  │ Saldo: $ 850k    │   │
│  │ $ [ 400.000 ]    │   │
│  │ Ref: [ OP-12345 ]│   │
│  │           [ ✕ ]   │   │
│  └──────────────────┘   │
│                         │
│  ┌──────────────────┐   │
│  │ Galicia          │   │
│  │ TRANSFER.        │   │
│  │ Saldo: $ 420k    │   │
│  │ $ [ 300.000 ]    │   │
│  │ Ref: [ OP-67890 ]│   │
│  │           [ ✕ ]   │   │
│  └──────────────────┘   │
│                         │
│  [ + Agregar cuenta ]   │
│                         │
│  ───────────────        │
│                         │
│  Asignado: $ 1.000.000  │
│  Faltan:   $ 0      ✓   │
│                         │
│  [ ← Atrás ] [ Sig. → ] │
│                         │
└─────────────────────────┘
```

## Pantalla 6 — Aprobación cambios Excel mobile

```
┌─────────────────────────┐
│ ✕  Cambios pendientes   │
├─────────────────────────┤
│                         │
│  Lista de Precios.xlsx  │
│  Detectado hace 2 hs    │
│  ↓                      │
│                         │
│  ✓ 137 cambios          │
│  ⚠ 4 no encontrados     │
│  ✕ 2 errores             │
│                         │
│  ───────────────        │
│                         │
│  CAMBIOS DE PRECIO      │
│                         │
│  ☑ Sorrentinos          │
│    $ 23.500             │
│       ↓                 │
│    $ 24.205   +3,0%     │
│                         │
│  ☑ Sorr. Salmón          │
│    $ 45.000             │
│       ↓                 │
│    $ 46.350   +3,0%     │
│                         │
│  ☑ Fideos huevo          │
│    $ 13.000             │
│       ↓                 │
│    $ 13.390   +3,0%     │
│                         │
│  [ Ver 134 más ▾ ]      │
│                         │
│  ───────────────        │
│                         │
│  ⚠ NO ENCONTRADOS       │
│                         │
│  ☐ "Sorr. de Trufa"     │
│    $ 38.000             │
│    ¿Crear nuevo?        │
│                         │
│  [ Ver más ]            │
│                         │
│  ───────────────        │
│                         │
│  ✕ ERRORES (no aplican) │
│                         │
│  • "Pizza Rúcula"       │
│    Precio negativo      │
│                         │
│  ───────────────        │
│                         │
│  Seleccionados: 137     │
│                         │
│  [ Posponer ]           │
│  [ Rechazar todo ]      │
│  ┌───────────────────┐  │
│  │ ✓ Aprobar 137     │  │
│  └───────────────────┘  │
│                         │
└─────────────────────────┘
```

- Diff vertical (precio anterior arriba, ↓, precio nuevo abajo) en lugar de horizontal por falta de espacio
- Listas truncadas con "Ver más"
- Botones de acción al pie (sticky footer)

## Pantalla 7 — Pantalla de bloqueo en Vendedor

Si la encargada o el dueño accidentalmente ingresan al URL del Vendedor desde mobile:

```
┌─────────────────────────┐
│                         │
│                         │
│         🚫              │
│                         │
│   Esta sesión solo      │
│   está disponible en    │
│   computadoras del      │
│   local                 │
│                         │
│                         │
│   Ingresá desde una     │
│   PC del local.         │
│                         │
│                         │
│   ¿Sos admin?           │
│                         │
│   [ Ir al panel admin ] │
│                         │
└─────────────────────────┘
```

## Patrones móviles aplicados

- **Bottom tabs**: 4 ítems máximo (Inicio / Movimientos / Productos / Más)
- **Pull to refresh** en listados y dashboards
- **Touch targets ≥44px**
- **Swipe lateral** en filas para acciones rápidas
- **Floating Action Button (FAB)** para acciones primarias contextuales
- **Sheet desde abajo** para navegación secundaria
- **Inputs numéricos** con teclado numérico (`inputmode="decimal"`)
- **Sin hover** — todo tap o long-press
- **Wizards** para flujos complejos (en lugar de formularios largos)

## Referencias

- SPEC §7.3 — Estrategia responsive
- SPEC §7.6 — Sesión Admin móvil
- SPEC §7.3.5 — Mobile patterns
