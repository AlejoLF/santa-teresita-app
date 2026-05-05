# Wireframe 02 — Vendedor: pantalla principal (cargar pedido)

> **La pantalla más usada del sistema.** El cajero pasa el 90% de su tiempo acá. Optimizada para velocidad: target de 30 segundos para cargar un pedido típico de 3 items. Cada milímetro de pixel cuenta.
>
> **Premisa**: el cajero tiene mouse + teclado + posiblemente touch. Tres modos de input simultáneos. Atajos de teclado robustos para los rápidos, botones grandes para los más lentos.

## Layout (desktop, 1366×768 mínimo, optimizado para 1920×1080)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ 🍝 SANTA TERESITA      Sesión: TARDE 27/04 19:42      PC2          [ 📋 Pedido nuevo + ]    │ ← Header 56px
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                              │               │
│  CATÁLOGO  (50% ancho)                                                       │  CARRITO     │
│ ─────────────────────────────────────────────────────────────────────────── │  (35% ancho) │
│                                                                              │              │
│  🔥 TOP 3 — Pastas frescas                                                   │ ┌──────────┐ │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐               │ │ PEDIDO   │ │
│  │ Sorrentinos     │ │ Fideos al huevo │ │ Ñoquis          │               │ │  #047    │ │
│  │ Ricot. Mozz.J.  │ │ Cinta media     │ │ Papa            │               │ │          │ │
│  │ $ 23.500/doc    │ │ $ 13/g          │ │ $ 13,9/g        │               │ │ TARDE    │ │
│  │ [Top 1]         │ │ [Top 2]         │ │ [Top 3]         │               │ │ 19:42    │ │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘               │ │ Mostrad. │ │
│                                                                              │ ├──────────┤ │
│ ─────────────────────────────────────────────────────────────────────────── │ │          │ │
│                                                                              │ │ Items:   │ │
│  CATEGORÍAS                                                                  │ │          │ │
│  ╔═══════════════╗ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │ │ Sorrent. │ │
│  ║ Pastas frescas║ │Porc.calientes│ │   Pizzas     │ │   Tartas     │       │ │ Ricot.MJ │ │
│  ╚═══════════════╝ └──────────────┘ └──────────────┘ └──────────────┘       │ │  6 u     │ │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │ │  $11.750 │ │
│  │   Salsas     │ │  Empanadas   │ │    Otros     │ │   Combos     │        │ │ [✕][⚙]   │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘        │ │          │ │
│                                                                              │ │ Salsa    │ │
│ ─────────────────────────────────────────────────────────────────────────── │ │ Fileto   │ │
│                                                                              │ │  1 u     │ │
│  PRODUCTOS — Pastas frescas                                                  │ │  $6.000  │ │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐          │ │ [✕][⚙]   │ │
│  │Ravioles│ │Sorrent.│ │Fideos  │ │Ñoquis  │ │Tortelet│ │Lasagna │          │ │          │ │
│  │$7.650  │ │$23.500 │ │$13/g   │ │$13,9/g │ │$14.200 │ │$23.500 │          │ │ ┌──────┐ │ │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘          │ │ │ + + +│ │ │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐          │ │ └──────┘ │ │
│  │Rondelli│ │Canelone│ │Crepes  │ │Raviolon│ │Fid.Mor.│ │Fid.Esp.│          │ │ Agregar  │ │
│  │$23.500 │ │$3.800  │ │$3.900  │ │$23.500 │ │$13.700 │ │$13.700 │          │ │ otro     │ │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘          │ │          │ │
│  ┌────────┐                                                                  │ ├──────────┤ │
│  │Sorrent.│                                                                  │ │          │ │
│  │Salmón  │                                                                  │ │Subtotal: │ │
│  │$45.000 │                                                                  │ │ $17.750  │ │
│  └────────┘                                                                  │ │          │ │
│                                                                              │ │ ┌──────┐ │ │
│ ─────────────────────────────────────────────────────────────────────────── │ │ │COBRAR│ │ │
│                                                                              │ │ │$17.7K│ │ │
│  [ 🔍  Buscar producto / código...                                  ]        │ │ └──────┘ │ │
│                                                                              │ └──────────┘ │
├──────────────────────────────────────────────────────────────────────────────┴──────────────┤
│ 📋 Abiertos: 4    ✓ Cerrados hoy: 23    ⚠ Imp.cocina: OK    🔔  ⚙ Config (PIN admin)        │ ← Footer 48px
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Breakdown de zonas

### Zona 1 — Header (56px alto, ancho completo)

```
🍝 SANTA TERESITA      Sesión: TARDE 27/04 19:42      PC2          [ 📋 Pedido nuevo + ]
```

- **Logo + wordmark** a la izquierda
- **Info de contexto** centrada: turno actual + fecha + hora + PC. Tipografía mono pequeña (`--font-mono`, `--text-xs`)
- **Botón primario "Pedido nuevo"** a la derecha. CTA verde Teresita. Atajo: F1.
- Background `--cream-50` con `--shadow-sm` abajo
- Persiste durante todo el flujo del cajero

### Zona 2 — Catálogo (~50% ancho, scrollable verticalmente)

#### Sub-zona 2.1: Top 3 contextual

- 3 cards horizontales con los 3 productos más vendidos **de la categoría seleccionada actualmente** (últimos 30 días, fijo, no editable — Sección 7.4.5 del SPEC)
- Cada card 96px alto
- Click en card → si el producto tiene modificadores, abre modal (Wireframe 03); si no, agrega al carrito directo
- Visualmente diferenciado del resto: badge "🔥 TOP" + sutil acento verde

#### Sub-zona 2.2: Categorías (chips)

- 8 chips horizontales (las 8 categorías del catálogo + "Combos")
- Chip activo en `--green-teresita-700` con texto blanco
- Chips inactivos en `--cream-200` con texto `--ink-700`
- Hover: `--cream-300`
- Atajo: F1–F8 saltan a categorías 1–8

#### Sub-zona 2.3: Productos de la categoría seleccionada

- Grid de cards 96×96px
- Por defecto 6 columnas en pantalla 1920px, 4 columnas en 1366px (responsive grid)
- Cada card:
  - Nombre del producto (1–2 líneas, truncado con `…` si pasa)
  - Precio con unidad (ej. "$ 23.500/doc", "$ 13/g")
  - Click → si tiene modificadores, modal (Wireframe 03); si no, agrega al carrito directo
- Hover: leve elevación + border verde
- Active: efecto de "pulse" verde 100ms al click

#### Sub-zona 2.4: Buscador rápido

- Input grande, full-width al pie de la zona catálogo
- Placeholder: "Buscar producto / código..."
- Atajo: F2 enfoca el input
- Búsqueda fuzzy: tipea "rav v" → muestra "Ravioles Verdura"
- Resultados aparecen como dropdown debajo del input
- Enter selecciona el primero, agrega al carrito (o abre modal)

### Zona 3 — Carrito (~35% ancho, vertical, scrollable)

```
┌──────────┐
│ PEDIDO   │
│  #047    │
│  TARDE   │
│  19:42   │
│  Mostrad.│
├──────────┤
│ Sorrent. │
│ Ricot.MJ │
│  6 u     │
│ $11.750  │
│ [✕][⚙]   │
│          │
│ Salsa    │
│ Fileto   │
│  1 u     │
│ $6.000   │
│ [✕][⚙]   │
├──────────┤
│Subtotal: │
│ $17.750  │
│          │
│ ┌──────┐ │
│ │COBRAR│ │
│ │$17.7K│ │
│ └──────┘ │
└──────────┘
```

#### Header del carrito (sticky top)

- "PEDIDO #047" — número de orden del turno (no el ID interno) en `--font-display`, `--text-xl`
- Meta info debajo: turno, hora apertura, modalidad (Mostrador / Delivery)
- Si modalidad = Delivery, también muestra "🚚 Cliente: [nombre]" si está cargado

#### Lista de items (scrollable si supera el alto disponible)

- Cada item en card pequeña con:
  - Nombre del producto (línea 1)
  - Modificadores principales (línea 2, color `--ink-500`, `--text-xs`)
  - Cantidad + unidad (ej. "6 u", "380 g")
  - Subtotal (en mono, color `--ink-900`, `--text-md`)
  - Botones flotantes: `[✕]` eliminar, `[⚙]` editar (abre modal pre-cargado con valores actuales)
- Si hay observación del cliente, badge amarillo: `// SIN SAL`
- Si forma parte de combo: tag `[COMBO: nombre]` color verde
- Atajo: Ctrl+Z deshace último item agregado

#### Footer del carrito (sticky bottom)

- "Subtotal: $X" — tipografía mono, `--text-md`
- Si hay descuento aplicado o recargo, se muestra desglose
- **Botón COBRAR gigante** (96px alto) con el monto total
  - Background `--green-teresita-700`, hover `--green-teresita-900`
  - Texto blanco, mono, `--text-2xl` para el monto
  - Atajo: F9

### Zona 4 — Footer (48px alto, ancho completo)

```
📋 Abiertos: 4    ✓ Cerrados hoy: 23    ⚠ Imp.cocina: OK    🔔   ⚙ Config (PIN admin)
```

- **Indicadores en vivo** del turno:
  - Pedidos abiertos (Procesada): click → drawer historial filtrado
  - Pedidos cerrados (Finalizada) hoy: click → drawer historial
  - Estado de impresoras: ⚠ rojo si alguna está caída
- **Notificaciones** (🔔): badge con contador si hay alertas
- **Config** a la derecha: requiere PIN admin para entrar — abre menú con opciones avanzadas

## Estados especiales

### Carrito vacío

```
┌──────────┐
│ PEDIDO   │
│  NUEVO   │
│  Listo   │
├──────────┤
│          │
│   📦    │
│          │
│ Empezá   │
│ agregando│
│ producto │
│ del      │
│ catálogo │
│          │
│          │
└──────────┘
```

- Empty state con icono y mensaje
- El botón COBRAR aparece deshabilitado (gris `--ink-300`)

### Producto seleccionado activo (con modificadores en modal)

- Mientras el modal de modificadores está abierto, el catálogo se oscurece levemente (overlay 30% negro)
- El carrito sigue visible y editable

### Pedido con observación importante

```
┌──────────┐
│ PEDIDO   │
│  #047    │
│ ⚠ NOTA   │
│ "Sin sal,│
│ extra    │
│ queso"   │
├──────────┤
│ ...      │
```

- Si el pedido tiene observación, banner amarillo arriba del listado
- Click → editar la observación

### Impresora cocina caída

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⚠ IMPRESORA COCINA CAÍDA — los pedidos con cocina no salen automáticamente   │ ← Banner persistente
│ [ Reintentar ]  [ Ignorar por ahora ]  [ Llamar a soporte ]                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ ... (resto de la pantalla normal)
```

- Banner rojo pomodoro arriba del header, sticky
- No bloquea operación — el cajero sigue cargando y los pedidos quedan en cola para imprimir cuando vuelva la impresora

## Atajos de teclado (resumen, ver SPEC §7.4.6)

| Tecla | Acción |
|-|-|
| `F1` | Pedido nuevo |
| `F2` | Foco en buscador |
| `F3` | Top 3 |
| `F4` | Foco en carrito (cuando no es visible) |
| `F9` | Cobrar |
| `F10` | Drawer historial |
| `1`–`8` | Saltar a categoría 1–8 |
| `Esc` | Cerrar modal / cancelar acción |
| `Enter` | Confirmar acción primaria del foco actual |
| `Ctrl+Z` | Deshacer último item agregado |
| `Ctrl+Backspace` | Vaciar carrito (con confirmación) |
| `Ctrl+P` | Reimprimir último ticket (PIN admin) |

## Componentes usados

- `Header` (custom, sticky)
- `CategoryChip` (active / inactive states)
- `ProductCard` (96×96, con foto opcional + nombre + precio)
- `Top3Card` (variante de ProductCard con badge "🔥 TOP")
- `SearchInput` (con dropdown de resultados)
- `CartItem` (card en el carrito, con acciones inline)
- `CartHeader` (sticky)
- `CartFooter` (sticky con botón COBRAR)
- `Footer` (status bar)
- `Banner` (warning persistente cuando impresora cae)

## Comportamiento responsive

- **Desktop ≥1366px**: layout completo como arriba.
- **Desktop 1024–1365px**: catálogo y carrito mantienen proporciones, productos se acomodan a 4 columnas en lugar de 6.
- **Tablet / Mobile**: ❌ Vendedor desktop-only.

## Notas de implementación

- **Performance crítica**: el catálogo se carga al iniciar la sesión y queda en memoria. Cambiar de categoría es instantáneo (no llama a la API).
- **Sync en background**: cada cambio del carrito (agregar item, cambiar cantidad) se sincroniza al servidor local en background pero la UI no espera la respuesta — optimistic updates.
- **Foco visible**: el cajero tiene que ver claramente dónde está el foco del teclado en todo momento (focus ring `--shadow-focus-ring`).
- **Tab navigation**: orden lógico Top3 → Categorías → Productos → Buscador → Carrito → Cobrar.
- **Reload-safe**: si el navegador refresca, el carrito persiste (la venta ya está creada en estado PROCESADA en la base, se recarga del servidor).

## Referencias

- SPEC §7.4 — Sesión Vendedor diseño detallado
- SPEC §7.4.1 — Layout principal
- SPEC §7.4.6 — Atajos de teclado
- SPEC §4.4 — Numeración de ventas
