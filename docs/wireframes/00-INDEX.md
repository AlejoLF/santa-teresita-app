# Wireframes — índice

> Wireframes de baja fidelidad en ASCII art que definen la **estructura, jerarquía visual, componentes presentes e interacción** de cada pantalla del sistema. **No son mockups finales** — son la base sobre la que se trabajarán los mockups en alta fidelidad (Figma) y luego el código.
>
> Cada wireframe acá referenciado se documenta con el mismo patrón: layout ASCII + breakdown de zonas + componentes usados + interacciones + comportamiento responsive (cuando aplica).

## Convenciones del wireframe

- `┌─┐ │ └─┘` — bordes de contenedores (cards, modales, secciones)
- `[ Texto ]` — botones
- `[ ✓ ]` / `[ ✕ ]` — checkboxes / radio buttons (o iconos)
- `▾` — dropdowns
- `⏳ ⚠ ✅ ❌` — estados / iconos
- `(◯◯◯◯)` — PIN input fields
- `═══════` — divisores fuertes / hero
- `┄┄┄┄┄┄` — divisores sutiles
- `→` — drill-down / push navigation
- `▤▤▤▤` — gráfico (barra / línea / torta)
- Texto en MAYÚSCULAS = display de marca / hero / labels importantes
- Anotaciones `// ...` al margen explican comportamiento

## Lista de wireframes

### Sesión Vendedor (desktop-only)

| # | Pantalla | Estado |
|-|-|-|
| 01 | [Login con PIN](01-vendedor-login.md) | ✅ |
| 02 | [Pantalla principal — cargar pedido](02-vendedor-cargar-pedido.md) | ✅ |
| 03 | [Modal de modificadores y combos](03-vendedor-modificadores-modal.md) | ✅ |
| 04 | [Pantalla de cobro (incluye split y 10% efectivo)](04-vendedor-cobro.md) | ✅ |
| 05 | [Historial de la sesión actual (drawer)](05-vendedor-historial.md) | ✅ |

### Sesión Admin

| # | Pantalla | Estado |
|-|-|-|
| 06 | [Dashboard inicial](06-admin-dashboard.md) | ✅ |
| 07 | [Aprobación de cambios pendientes en Excel](07-admin-aprobacion-excel.md) | ✅ |
| 08 | [Pago de facturas con multi-cuenta](08-admin-pago-multicuenta.md) | ✅ |

### Sesión Admin móvil

| # | Pantalla | Estado |
|-|-|-|
| 09 | [Admin mobile — dashboard + bottom nav](09-admin-mobile.md) | ✅ |

### Tickets

| # | Pantalla | Estado |
|-|-|-|
| 10 | [Render de los 3 tickets (cocina / cliente / delivery)](10-tickets-render.md) | ✅ |

## Pantallas que NO están en este índice

Las pantallas más simples (CRUDs estándar de productos, proveedores, clientes, etc.) **no requieren wireframe específico** — siguen el patrón estándar de "tabla con filtros + modal de edición". Se diseñan como sub-componentes durante implementación.

Pantallas complejas que faltan diseñar (a hacer en una segunda iteración si el cliente lo pide):
- Login admin con expiración por inactividad
- Aprobación admin in-line (modal — está parcialmente en SPEC sección 7.9.5)
- Cierre de caja con conteo físico
- Configuración del sistema (tab por área)
- Audit log con filtros y drill-down

## Aesthetic direction aplicado

Todos los wireframes asumen el aesthetic direction definido en SPEC sección 7.1:

- **Verde Teresita** (`#1F4D3C`) como color de marca y CTA
- **Crema** (`#FAF6EE`) como fondo principal
- **Display serif** (Fraunces) para hero numbers, page titles
- **Body sans** (Geist) para todo el UI
- **Mono** (JetBrains Mono) para números en tablas
- Densidad alta en Vendedor, respiración generosa en Admin
- Animaciones mínimas, solo cuando comunican estado
