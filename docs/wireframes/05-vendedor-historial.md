# Wireframe 05 — Historial de la sesión actual (drawer)

> **Cuándo aparece**: cajero clickea "📋 Abiertos" en el footer (Wireframe 02) o presiona F10. Drawer lateral derecho de 480px.
> **Premisa**: el cajero ve solo SU sesión actual (Sección 4 SPEC). Para ver otras sesiones / días, requiere Admin.

## Layout

```
                                                ┌──────────────────────────────────┐
                                                │  HISTORIAL — TARDE 27/04   [ ✕ ] │
                                                │  ──────────────────────────────  │
                                                │                                  │
                                                │  Filtros:                        │
                                                │  [ Todos ▾ ] [ Hora ▾ ]         │
                                                │  [ 🔍 Buscar... ]                │
                                                │                                  │
                                                │  ────────────────────────────    │
                                                │                                  │
                                                │  📋 ABIERTOS (4)                 │
                                                │                                  │
                                                │  ┌──────────────────────────┐    │
                                                │  │ #050  19:54  Mostrador   │    │
                                                │  │ $ 31.700                 │    │
                                                │  │ Sin saldar               │    │
                                                │  │                       →  │    │
                                                │  └──────────────────────────┘    │
                                                │  ┌──────────────────────────┐    │
                                                │  │ #049  19:51  Mostrador   │    │
                                                │  │ $  8.200                 │    │
                                                │  │                       →  │    │
                                                │  └──────────────────────────┘    │
                                                │  ┌──────────────────────────┐    │
                                                │  │ #048  19:46  Pedidos YA  │    │
                                                │  │ $ 19.000                 │    │
                                                │  │ Esperando preparación    │    │
                                                │  │                       →  │    │
                                                │  └──────────────────────────┘    │
                                                │  ┌──────────────────────────┐    │
                                                │  │ #047  19:42  Mostrador   │    │
                                                │  │ $ 27.117                 │    │
                                                │  │                       →  │    │
                                                │  └──────────────────────────┘    │
                                                │                                  │
                                                │  ────────────────────────────    │
                                                │                                  │
                                                │  ✓ CERRADOS HOY (23)             │
                                                │                                  │
                                                │  ┌──────────────────────────┐    │
                                                │  │ #046  19:28  Mostrador   │    │
                                                │  │ ✓ $ 12.400  Efectivo     │    │
                                                │  │                       →  │    │
                                                │  └──────────────────────────┘    │
                                                │  ┌──────────────────────────┐    │
                                                │  │ #045  19:15  Delivery    │    │
                                                │  │ ✓ $ 22.800  Tarj. Sant.  │    │
                                                │  │                       →  │    │
                                                │  └──────────────────────────┘    │
                                                │  ...  (scroll)                   │
                                                │                                  │
                                                │  ────────────────────────────    │
                                                │                                  │
                                                │  ✕ ANULADOS HOY (1)              │
                                                │                                  │
                                                │  ┌──────────────────────────┐    │
                                                │  │ #042  18:45  Mostrador   │    │
                                                │  │ ✕ $ 5.600                │    │
                                                │  │ Motivo: Cliente arrep.   │    │
                                                │  │                       →  │    │
                                                │  └──────────────────────────┘    │
                                                │                                  │
                                                │  ────────────────────────────    │
                                                │                                  │
                                                │  RESUMEN DEL TURNO                │
                                                │                                  │
                                                │  Total cerrado: $ 487.230        │
                                                │  Cant. ventas:  23               │
                                                │  Ticket prom.:  $ 21.184         │
                                                │                                  │
                                                └──────────────────────────────────┘
```

## Breakdown

### Filtros (sticky top)

- Dropdown 1: estado (Todos / Abiertos / Cerrados / Anulados)
- Dropdown 2: orden (Hora desc / Hora asc / Monto desc / Monto asc)
- Buscador (ID interno, nombre cliente, monto)

### Secciones por estado

- **Abiertos** (rojo sutil) → cards más prominentes, primero
- **Cerrados hoy** (verde sutil) → segunda sección
- **Anulados hoy** (rojo sutil con tachado) → última sección, comprimida

### Card de venta

- ID interno (numero de orden del turno) en `--font-display`
- Hora + canal (Mostrador / Delivery / Pedidos YA / etc.)
- Estado con icono (✓ verde / ⏳ amarillo / ✕ rojo)
- Monto en mono
- Si delivery: nombre del cliente
- Si anulado: motivo en línea
- Click → drill-down a detalle de la venta (sub-drawer)

### Resumen del turno (sticky bottom)

- Total cobrado en la sesión actual
- Cantidad de ventas finalizadas
- Ticket promedio (monto)

## Drill-down: detalle de venta

Click en card → drawer secundario con detalle completo:

```
┌──────────────────────────────────────┐
│  ← Volver         PEDIDO #047        │
│  ──────────────────────────────────  │
│                                      │
│  Estado:    ✓ FINALIZADA             │
│  Canal:     Mostrador                │
│  Cargado:   PC2  19:42               │
│  Cerrado:   PC2  19:48               │
│                                      │
│  ─────────────────────────────       │
│                                      │
│  ITEMS                               │
│                                      │
│  380g  Sorrentinos                   │
│        Relleno: Ricot. Mozz. Jamón   │
│        $ 23,5/g            $ 8.930   │
│                                      │
│  4   Canelones J&Q                   │
│        $ 3.800            $ 15.200   │
│                                      │
│  1   Salsa Fileto                    │
│        $ 6.000             $ 6.000   │
│                                      │
│  ─────────────────────────────       │
│                                      │
│  Subtotal:           $ 30.130        │
│  Descuento 10%:     -$  3.013        │
│  TOTAL:              $ 27.117        │
│                                      │
│  ─────────────────────────────       │
│                                      │
│  PAGO                                │
│  Efectivo: $ 30.000                  │
│  Cambio:   $  2.883                  │
│                                      │
│  ─────────────────────────────       │
│                                      │
│  [ Reimprimir ticket ]               │
│  [ Anular venta ]                    │  ← requiere PIN admin
│                                      │
└──────────────────────────────────────┘
```

- Detalle completo de items + descuentos + pagos
- Botón "Reimprimir ticket" → modal de PIN admin → imprime con marca DUPLICADO
- Botón "Anular venta" → modal de PIN admin + motivo → anula y revierte movimientos

## Atajos

| Tecla | Acción |
|-|-|
| `F10` | Abrir/cerrar drawer |
| `Esc` | Cerrar drawer (si está abierto) |
| `↑` / `↓` | Navegar entre cards |
| `Enter` | Abrir detalle de la card seleccionada |
| `/` | Foco en buscador |

## Referencias

- SPEC §4 — Modelo de ventas
- SPEC §7.4.5 — Historial de la sesión
