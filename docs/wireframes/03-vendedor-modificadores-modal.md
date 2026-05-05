# Wireframe 03 — Modal de modificadores y combos

> **Cuándo aparece**: cuando el cajero clickea un producto que tiene modificadores (sabor, forma, tamaño, etc.) o un combo. Se superpone sobre la pantalla principal (Wireframe 02) con un overlay sutil.
>
> **Premisa**: el cajero debe completar y agregar al carrito en ≤10 segundos. Cantidades preset, modificadores grandes, atajos de teclado para los rápidos.

## Caso 1 — Producto con modificadores simples (Sorrentinos)

```
                     ┌───────────────────────────────────────────────────┐
                     │                                                   │
                     │   Sorrentinos                          [ ✕ ]      │
                     │                                                   │
                     │   ────────────────────────────────────────────    │
                     │                                                   │
                     │   CANTIDAD                                        │
                     │   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────────┐    │
                     │   │  6  │ │ 12  │ │ 24  │ │ 48  │ │ Otra... │    │
                     │   └─────┘ └─────┘ └─────┘ └─────┘ └─────────┘    │
                     │                                                   │
                     │                                                   │
                     │   RELLENO  *(obligatorio)*                        │
                     │                                                   │
                     │   ◉  Ricotta, Mozzarella y Jamón                 │
                     │   ○  Calabaza y Mozzarella                       │
                     │   ○  Caprese (Ricota, Mozz, Cherry, Albahaca)    │
                     │   ○  Cipollino (Ricota, Mozz, Jamón, Verdeo)     │
                     │   ○  Verdura, Jamón y Mozzarella                 │
                     │   ○  Roquefort, Mozz, Ricota y Nuez              │
                     │   ○  Mozzarella, Ricota y Nuez                   │
                     │                                                   │
                     │                                                   │
                     │   OBSERVACIONES *(opcional)*                      │
                     │   ┌──────────────────────────────────────────┐    │
                     │   │ ej. sin sal, extra queso...              │    │
                     │   └──────────────────────────────────────────┘    │
                     │                                                   │
                     │   ─────────────────────────────────────────       │
                     │                                                   │
                     │                            Subtotal:  $ 11.750    │
                     │                                                   │
                     │   [ Cancelar ]                  [ Agregar ⏎ ]     │
                     │                                                   │
                     └───────────────────────────────────────────────────┘
```

### Breakdown

#### Zona 1: Header del modal

- Nombre del producto en `--font-display`, `--text-xl`
- Botón `[ ✕ ]` para cerrar (Esc también)
- Background `--surface-card`, `--shadow-modal`

#### Zona 2: Cantidad (presets + custom)

- 4 presets de cantidad **adaptados al producto**:
  - Sorrentinos: 6 / 12 / 24 / 48 (defaults sugeridos por encargada)
  - Fideos al huevo: 200 / 500 / 1000 g
  - Ñoquis: 200 / 500 / 1000 g
  - Empanadas: 1 / 6 / 12 / 24
- "Otra..." abre un input numérico para tipear cualquier cantidad
- Click en preset: lo selecciona + recalcula subtotal
- Atajo: 1, 2, 3, 4 seleccionan los 4 presets; 5 abre "Otra..."

#### Zona 3: Modificador "Relleno" (obligatorio)

- Radio buttons grandes (44px alto cada uno)
- Click directo en cualquier parte de la fila (no solo en el círculo)
- Tipografía clara, `--text-base`
- Pre-seleccionado el primero por defecto (puede cambiar según frecuencia de uso aprendida)
- Atajo: flechas ↑/↓ navegan; Enter selecciona

#### Zona 4: Observaciones (opcional)

- Textarea de 2 líneas, expandible
- Placeholder con ejemplos
- Si el cajero escribe algo, aparece bandera amarilla en el carrito

#### Zona 5: Footer del modal

- Subtotal en vivo (recalcula al cambiar cantidad o modificador)
- Botón "Cancelar" secundario
- Botón "Agregar" primario verde, con icono ⏎ que indica que Enter lo dispara

## Caso 2 — Producto con múltiples modificadores (Fideos al huevo)

```
┌───────────────────────────────────────────────────┐
│   Fideos al huevo                      [ ✕ ]      │
│   ────────────────────────────────────────────    │
│                                                   │
│   CANTIDAD                                        │
│   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────────┐             │
│   │200g │ │500g │ │ 1kg │ │ Otra... │             │
│   └─────┘ └─────┘ └─────┘ └─────────┘             │
│                                                   │
│                                                   │
│   FORMA  *(obligatorio)*                          │
│                                                   │
│   ◉  Cinta fina                                   │
│   ○  Cinta media                                  │
│   ○  Cinta ancha                                  │
│   ○  Spaghetti                                    │
│   ○  Fuccile                                      │
│   ○  Foratti                                      │
│   ○  Mostacholes                                  │
│                                                   │
│                                                   │
│   OBSERVACIONES                                   │
│   ┌──────────────────────────────────────────┐    │
│   │                                          │    │
│   └──────────────────────────────────────────┘    │
│                                                   │
│   ─────────────────────────────────────────       │
│                                                   │
│                          200 g × $ 13/g           │
│                          Subtotal:  $ 2.600       │
│                                                   │
│   [ Cancelar ]                  [ Agregar ⏎ ]     │
└───────────────────────────────────────────────────┘
```

- Cantidades en **gramos** preset: 200 / 500 / 1.000 / Otra...
- Si se elige "Otra...", input numérico con suffijo "g"
- Sin modificador de "Sabor" (los fideos al huevo no varían en sabor — solo en forma)
- Subtotal muestra el cálculo desglosado: "200 g × $ 13/g = $ 2.600"

## Caso 3 — Combo con componentes seleccionables (Promo 4 canelones + salsa + postre)

```
┌────────────────────────────────────────────────────────────┐
│   PROMO 4 Canelones + Salsa + Postre        [ ✕ ]          │
│   ─────────────────────────────────────────────────────    │
│                                                            │
│   PRECIO COMBO:  $ 18.500                                  │
│                                                            │
│   ─────────────────────────────────────────────────────    │
│                                                            │
│   1️⃣  CANELONES (4)  *(elegí el sabor)*                    │
│                                                            │
│       ◉  Jamón y Queso                                     │
│       ○  Verdura                                           │
│       ○  Verdura y Carne                                   │
│                                                            │
│   ─────────────────────────────────────────────────────    │
│                                                            │
│   2️⃣  SALSA (1)  *(elegí una)*                             │
│                                                            │
│       ◉  Fileto                                            │
│       ○  Bolognesa                                         │
│       ○  Cuatro Quesos                                     │
│       ○  Roquefort                                         │
│       ○  Crema al Verdeo                                   │
│       ○  Príncipe de Nápoles                               │
│       ○  Crema de Hongos                                   │
│       ○  Salsa Blanca                                      │
│       ○  Pesto                                             │
│       ○  Crema Vacalin                                     │
│                                                            │
│   ─────────────────────────────────────────────────────    │
│                                                            │
│   3️⃣  POSTRE (1)  *(elegí uno)*                            │
│                                                            │
│       ◉  Tiramisú                                          │
│       ○  Chocotorta                                        │
│       ○  Lemon Pie                                         │
│       ○  Budín de pan                                      │
│       ○  Cheesecake                                        │
│                                                            │
│   ─────────────────────────────────────────────────────    │
│                                                            │
│   OBSERVACIONES *(opcional)*                               │
│   ┌──────────────────────────────────────────────────┐     │
│   │                                                  │     │
│   └──────────────────────────────────────────────────┘     │
│                                                            │
│   ─────────────────────────────────────────────────────    │
│                                                            │
│                                Combo:  $ 18.500            │
│                                                            │
│   [ Cancelar ]                       [ Agregar ⏎ ]         │
└────────────────────────────────────────────────────────────┘
```

### Particularidades del combo

- **Cada componente** del combo es una sub-sección con su propio modificador
- Numerado 1️⃣ 2️⃣ 3️⃣ para que el cajero vea el progreso visual
- El **precio del combo es fijo** (no varía con la elección de componentes — salvo que un componente tenga un upsell, que se muestra explícitamente)
- Subtotal abajo muestra "Combo: $X" — no el desglose
- Cuando se agrega al carrito, en el carrito aparecen los 3 items individuales con tag `[COMBO: nombre]`

### Atajos de combo

- Tab navega entre las sub-secciones
- 1, 2, 3 seleccionan opciones de la sub-sección actual

## Caso 4 — Producto sin modificadores (Salsa Fileto)

Los productos simples sin modificadores **no abren modal**. Click directo en el producto desde el catálogo → se agrega al carrito con cantidad = 1.

Si el cajero quiere cambiar la cantidad después, click en el item del carrito + botón `[⚙]` → abre un modal mini con solo:

```
┌───────────────────────────────────────┐
│   Salsa Fileto              [ ✕ ]     │
│   ─────────────────────────────       │
│                                       │
│   CANTIDAD                            │
│   ┌─────┐ ┌─────┐ ┌─────┐ ┌──────┐    │
│   │  1  │ │  2  │ │  3  │ │Otra..│    │
│   └─────┘ └─────┘ └─────┘ └──────┘    │
│                                       │
│   ─────────────────────────────       │
│                                       │
│           1 u × $ 6.000               │
│           Subtotal: $ 6.000           │
│                                       │
│   [ Cancelar ]    [ Agregar ⏎ ]       │
└───────────────────────────────────────┘
```

## Caso 5 — Editar item del carrito

Click en `[⚙]` de un item ya cargado → abre el mismo modal pero **pre-rellenado** con los valores actuales:

- Cantidad pre-seleccionada
- Modificador pre-seleccionado
- Observación pre-cargada
- Botón cambia de "Agregar" a "Actualizar"

Si se clickea "Actualizar", el item del carrito se modifica (no se duplica).

## Caso 6 — Validaciones y errores

### Modificador obligatorio sin elegir

Si el cajero intenta agregar sin elegir un modificador obligatorio:

```
   RELLENO  *(obligatorio — elegí uno)* ⚠
   
   ○  Ricotta, Mozzarella y Jamón
   ...
```

- Label cambia a `--pomodoro-600`
- Borde de la sección cambia a `--pomodoro-100`
- Icono ⚠ aparece
- Botón "Agregar" se deshabilita
- Auto-foco en el primer modificador

### Cantidad inválida (negativa, cero, o no numérica)

```
   CANTIDAD
   [ -5    ] ⚠ La cantidad debe ser mayor a 0
```

- Input rojo, mensaje inline debajo
- Botón "Agregar" deshabilitado

## Atajos de teclado del modal

| Tecla | Acción |
|-|-|
| `Esc` | Cerrar modal sin agregar |
| `Enter` | Agregar al carrito (si todo es válido) |
| `Tab` / `Shift+Tab` | Navegar entre secciones |
| `↑` / `↓` | Mover selección dentro de un grupo de radio buttons |
| `1`–`9` | Seleccionar la opción numerada (presets de cantidad o opciones de modificador) |
| `0` | Seleccionar "Otra..." |

## Componentes usados

- `Modal` (centered, `--shadow-modal`, max-width 600px)
- `QuantityPicker` (presets + custom input)
- `RadioGroup` (vertical, large touch targets)
- `Textarea` (auto-resize)
- `ModalFooter` (primary + secondary buttons)
- `SubtotalDisplay` (live calc)

## Comportamiento responsive

Solo desktop (Vendedor desktop-only). En desktop chico (1024px) el modal mantiene padding pero ajusta su ancho a 90vw máximo.

## Notas de implementación

- **Pre-foco**: al abrir el modal, foco automático en el primer preset de cantidad. El cajero rápido tipea "1 1 ⏎" en menos de 1 segundo (cantidad 1, modificador 1, agregar).
- **Recálculo de subtotal**: en cada cambio del cajero, el subtotal se actualiza sin lag (cálculo en cliente, sin llamar al backend).
- **Cierre por click fuera**: click en el overlay de fondo cierra el modal sin agregar (con confirmación si ya hay cambios respecto al estado inicial).
- **Stacking de modales**: si un combo abre modificadores anidados (raro), los modales se apilan con z-index. Por defecto, los combos del wireframe son de un solo nivel.

## Referencias

- SPEC §2.2.4–2.2.6 — Modelo de modificadores
- SPEC §2.4 — Combos y promos
- SPEC §7.4.2 — Carga de producto con modificadores
