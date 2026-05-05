# Wireframe 07 — Admin: aprobación de cambios pendientes en Excel

> **Cuándo aparece**: cuando el admin entra y el sistema detectó cambios en el Excel `Lista de Precios.xlsx` desde la última aprobación. Modal grande centrado.
> **Premisa**: el admin debe poder aprobar/rechazar de a uno o en bloque, ver el diff claro, y entender qué errores hay.

## Layout (modal grande centrado, ~80% viewport en desktop)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  CAMBIOS DETECTADOS EN EXCEL                                                       [ ✕ ]    │
│  Archivo: Lista de Precios.xlsx                                                              │
│  Detectado: hace 2 horas (hoy 15:23)                                                         │
│  Modificado por: Julio (julio@santateresita.com.ar)                                          │
│  ──────────────────────────────────────────────────────────────────────────────────────     │
│                                                                                              │
│  RESUMEN                                                                                     │
│  ✓ 137 productos con cambio de precio                                                        │
│  ⚠   4 productos no encontrados en el sistema (filas nuevas o tipos)                        │
│  ✕   2 filas con errores (precio negativo o vacío)                                          │
│                                                                                              │
│  ──────────────────────────────────────────────────────────────────────────────────────     │
│                                                                                              │
│  Filtros:  [ Todos ▾ ]  [ ✓ Aplicables ]  [ ⚠ Sospechosos ]  [ ✕ Inválidos ]                │
│  Búsqueda: [ 🔍 producto, categoría... ]                                                    │
│                                                                                              │
│  ──────────────────────────────────────────────────────────────────────────────────────     │
│                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ [☑] CAMBIOS DE PRECIO  (137)                                                         │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│  │ [☑] Sorrentinos                  $ 23.500   →   $ 24.205   (+3,0%)        Hoja 1!B10 │ │
│  │ [☑] Sorrentinos de Salmón        $ 45.000   →   $ 46.350   (+3,0%)        Hoja 1!B11 │ │
│  │ [☑] Fideos al huevo (kg)         $ 13.000   →   $ 13.390   (+3,0%)        Hoja 1!B6  │ │
│  │ [☑] Ñoquis (kg)                  $ 13.900   →   $ 14.317   (+3,0%)        Hoja 1!B8  │ │
│  │ [☑] Ravioles Verdura (plancha)   $  7.650   →   $  7.880   (+3,0%)        Hoja 1!B2  │ │
│  │ [☑] Pizza Muzzarella             $ 11.700   →   $ 12.051   (+3,0%)        Hoja 1!D4  │ │
│  │ [☑] Pizza Especial               $ 12.300   →   $ 12.669   (+3,0%)        Hoja 1!D3  │ │
│  │ ...                                                                                   │ │
│  │ [ Ver los 130 restantes ▾ ]                                                          │ │
│  └──────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ ⚠ NO ENCONTRADOS EN EL SISTEMA  (4)                                                  │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│  │ [☐] "Sorrentinos de Trufa"        $ 38.000   ¿crear como producto nuevo?  Hoja 1!B30 │ │
│  │ [☐] "Lasagna de Salmón"           $ 28.500   ¿crear como producto nuevo?  Hoja 1!B31 │ │
│  │ [☐] "Tortelletini"                $ 18.500   ¿typo de Tortelettis?         Hoja 1!B32 │ │
│  │ [☐] "Pizza Hawaiana"              $ 13.500   ¿crear como sabor de pizza?  Hoja 1!D8  │ │
│  └──────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ ✕ ERRORES — NO SE APLICAN                                                            │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│  │  ⚠ "Pizza Rúcula y panceta": precio negativo (-$ 100)             Hoja 1!D7         │ │
│  │     → Corregí la celda en el Excel y volvé a presionar "Buscar cambios"             │ │
│  │                                                                                       │ │
│  │  ⚠ "Tarta Vigilia chica": fila vacía en Excel                     Hoja 1!H22        │ │
│  │     → Si querés borrar el producto, hacelo desde el sistema, no desde Excel         │ │
│  └──────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                              │
│  ──────────────────────────────────────────────────────────────────────────────────────     │
│                                                                                              │
│  Seleccionados:  137 cambios                                                                 │
│                                                                                              │
│  [ Posponer ]                       [ Rechazar todo ]              [ ✓ Aprobar 137 ]         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Breakdown

### Header

- Título claro + archivo de origen
- Cuándo se detectó + quién modificó (si hay info de Drive)
- Botón ✕ cierra (= "Posponer")

### Resumen

- Conteo por categoría (aplicables / sospechosos / inválidos)
- Iconos en colores: ✓ verde / ⚠ amarillo / ✕ rojo

### Filtros y búsqueda

- Filtros tipo chips para segmentar
- Búsqueda para encontrar productos específicos en listas largas

### Sección "Cambios de precio" (los aplicables)

- Header con checkbox master "[☑]" para seleccionar/deseleccionar todos
- Cada fila con:
  - Checkbox individual
  - Nombre del producto
  - Precio anterior → precio nuevo (con flecha visual)
  - Variación porcentual (verde si subió ≤20%, amarillo si subió >20%, rojo si bajó)
  - Celda exacta del Excel donde está el cambio (para que el admin pueda verificar)
- Si la lista es muy larga, muestra los primeros 7 con "[ Ver los X restantes ▾ ]" expandible

### Sección "No encontrados"

- Productos en el Excel que no matchearon con el catálogo
- Cada uno con sugerencia automática (typo del LLM, producto nuevo, etc.)
- Checkbox **desmarcado por defecto** — el admin debe explícitamente decidir crear

### Sección "Errores — no se aplican"

- Lista de errores con celda exacta + descripción + sugerencia de cómo arreglar
- No tiene checkboxes — son solo informativos
- Background `--pomodoro-100`

### Footer (sticky bottom)

- Contador de seleccionados
- 3 botones:
  - **"Posponer"** (secundario): cierra sin aplicar nada, los cambios siguen pendientes
  - **"Rechazar todo"** (destructivo): marca el snapshot como rechazado, no aplica nada y no vuelve a aparecer
  - **"Aprobar X"** (primario verde): aplica los seleccionados

## Estado: aprobación en progreso

Después de clickear "Aprobar":

```
┌──────────────────────────────────────────┐
│                                          │
│         APLICANDO CAMBIOS...             │
│                                          │
│         ▰▰▰▰▰▰▰▰▰▱▱  73 / 137            │
│                                          │
│         Actualizando "Foratti"...        │
│                                          │
└──────────────────────────────────────────┘
```

Progreso bar en vivo. Al terminar, modal de éxito:

```
┌──────────────────────────────────────────┐
│              ✓                           │
│                                          │
│    137 CAMBIOS APLICADOS                 │
│                                          │
│   Los nuevos precios ya están vigentes.  │
│                                          │
│   Histórico de precios actualizado.      │
│                                          │
│              [ Volver al panel ]         │
└──────────────────────────────────────────┘
```

## Estado: snapshot vacío (al refrescar)

Si el admin entra y no hay cambios pendientes, **NO** aparece el modal. En su lugar, en la sección Configuración → Sync hay un botón "Buscar cambios ahora" que dispara la detección manual.

## Componentes usados

- `Modal` (large variant, max-width 1200px)
- `DiffRow` (componente custom: label + valor anterior → valor nuevo + delta %)
- `CheckboxGroup` (con master + items)
- `FilterChips`
- `ExpandablList` (truncate + "ver más")
- `EmptyState`
- `ProgressBar` (durante aplicación)

## Comportamiento responsive

- **Desktop**: modal centrado 80% viewport.
- **Mobile**: full-screen, secciones colapsables, 1 cambio por línea.

## Referencias

- SPEC §9.3 — Sync Excel → programa
- SPEC §9.3.4 — UI de aprobación
- SPEC §7.5.4 — Aprobación de cambios pendientes
