# Wireframe 01 — Login Vendedor (entrada por PIN)

> **Cuándo aparece**: en PCs del local (PC1, PC2, PC3, PC4 + PC encargada-en-oficina), al iniciar el sistema o después de un logout manual. **No** aparece por inactividad — la sesión Vendedor en local es permanente (Sección 6.3.1 del SPEC).
>
> **Objetivo de UX**: que el cajero entre a operar en menos de 3 segundos. Tipear 4 dígitos, foco automático, submit al cuarto dígito sin Enter.

## Layout (desktop, 1366×768+)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│                                                                            │
│                                                                            │
│                                                                            │
│                                                                            │
│                          🍝  SANTA TERESITA                                │
│                              pastas & co                                   │
│                                                                            │
│                                                                            │
│                          ─────────────────                                 │
│                                                                            │
│                                                                            │
│                              Bienvenido                                    │
│                                                                            │
│                            Ingresá tu PIN                                  │
│                                                                            │
│                                                                            │
│                          ┌───┐ ┌───┐ ┌───┐ ┌───┐                          │
│                          │ ● │ │ ● │ │   │ │   │                          │
│                          └───┘ └───┘ └───┘ └───┘                          │
│                                                                            │
│                                                                            │
│                          ┌───┬───┬───┐                                    │
│                          │ 1 │ 2 │ 3 │                                    │
│                          ├───┼───┼───┤                                    │
│                          │ 4 │ 5 │ 6 │                                    │
│                          ├───┼───┼───┤                                    │
│                          │ 7 │ 8 │ 9 │                                    │
│                          ├───┼───┼───┤                                    │
│                          │   │ 0 │ ⌫ │                                    │
│                          └───┴───┴───┘                                    │
│                                                                            │
│                                                                            │
│                                                                            │
│                                                                            │
│                              PC1 · 27/04 19:32                             │
│                                                                            │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## Breakdown de zonas

### Zona 1 — Identidad (top, centrado, ~30% del alto)

- **Logo + wordmark**: 🍝 SANTA TERESITA / pastas & co
- En `--font-display` (Fraunces variable)
- Color: `--green-teresita-700` sobre fondo `--cream-100`
- Sutil — el protagonista es el PIN, no el logo

### Zona 2 — Greeting (center)

- "Bienvenido" en `--text-lg` `--ink-700`
- "Ingresá tu PIN" en `--text-md` `--ink-500`

### Zona 3 — PIN input (center, hero)

- 4 cuadros de 56×56px con `--radius-md`, gap `--space-3`
- Cada cuadro tiene fondo `--cream-200`, border `--cream-300`
- El cuadro **activo** tiene border `--green-teresita-700` (focus ring)
- Cuando se tipea un dígito, se muestra `●` (no el número — para privacidad)
- Auto-foco al primer cuadro al cargar
- Avance automático al siguiente cuadro al tipear
- **Submit automático** cuando se completa el 4° dígito
- Tipografía del `●` en `--font-display` para tener peso visual

### Zona 4 — Numpad táctil/mouse (center, debajo del PIN)

- Grid 3×4 de botones de 64×64px
- Cada botón con fondo `--surface-card`, border `--cream-300`, `--radius-md`
- Hover: fondo `--cream-200`
- Active: fondo `--green-teresita-100`
- El "0" centrado en su fila (espacio vacío a la izquierda)
- "⌫" (backspace) a la derecha de "0"
- **Optimizado para mouse Y touch** (PCs del local pueden tener touch screen)

### Zona 5 — Footer (bottom, pequeño)

- Identificador del PC + fecha/hora actuales
- En `--text-xs` `--ink-300`
- Sirve para que el cajero confirme que está en la PC correcta

## Interacciones

### Flujo feliz (PIN correcto)

1. Sistema arranca → pantalla aparece con PIN input vacío + foco en el primer cuadro
2. Cajero tipea "1" → primer cuadro muestra `●`, foco salta al segundo
3. Tipea "2" → segundo cuadro `●`, foco salta al tercero
4. Tipea "3" → tercero `●`, foco salta al cuarto
5. Tipea "4" → cuarto `●`
6. Auto-submit (sin Enter): se valida contra la base
7. Si correcto: transición fade-out a la pantalla principal del Vendedor (250ms)

### Flujo de error (PIN incorrecto)

1. Cajero termina de tipear los 4 dígitos
2. Sistema valida → incorrecto
3. Los 4 cuadros se sacuden (shake animation, 300ms) y se vuelven rojo `--pomodoro-100` border `--pomodoro-600`
4. Mensaje aparece debajo: "PIN incorrecto. Intentá de nuevo."
5. Después de 800ms: cuadros se limpian, vuelven al estado normal, foco al primer cuadro
6. Si lleva 5 intentos fallidos seguidos: bloqueo de 10 minutos
   - Mensaje: "Demasiados intentos fallidos. Esperá 10 minutos o pedile a la encargada que reactive."
   - PIN input deshabilitado durante el bloqueo

### Atajos de teclado

| Tecla | Acción |
|-|-|
| Números 0–9 | Tipear dígito (avanza al siguiente cuadro) |
| Backspace | Borrar el último dígito tipeado |
| Esc | Limpiar todo el PIN |
| Tab | (deshabilitado — solo el numpad y los inputs son interactivos) |

## Componentes usados

- `PinInput` (custom, 4 cuadros, auto-foco, auto-submit) → SPEC 7.7
- `Numpad` (grid 3×4 con backspace) → componente nuevo, agregar al inventario
- `Logo` (versión wordmark)

## Estados especiales

### Estado: bloqueado por intentos fallidos

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│                          🍝  SANTA TERESITA                                │
│                              pastas & co                                   │
│                                                                            │
│                          ─────────────────                                 │
│                                                                            │
│                                                                            │
│                                  🔒                                        │
│                                                                            │
│                          PIN bloqueado                                     │
│                                                                            │
│                  Demasiados intentos fallidos                              │
│                                                                            │
│                  Esperá 9:42 o pedile a la encargada                       │
│                          que reactive el PIN                                │
│                                                                            │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

- Icono 🔒 grande en `--saffron-600`
- Contador en vivo (mm:ss) en `--font-mono`
- Sin botones de "salir" — el cajero tiene que esperar o pedir reactivación

### Estado: pantalla de selección de rol (cuando el local pasa a Admin temporal)

> No aplica para el Vendedor — solo para la PC encargada en su oficina cuando ella entra como Admin. Wireframe aparte.

## Comportamiento responsive

- **Desktop ≥1024px**: layout completo como arriba.
- **Tablet 768–1023px**: igual, con paddings ajustados.
- **Mobile <768px**: ❌ **No aplica** — Vendedor desktop-only (Sección 7.3.4 del SPEC). Si alguien entra desde mobile a la URL del Vendedor, ve la pantalla de bloqueo "Esta sesión solo está disponible en computadoras del local".

## Notas de implementación

- El PIN viaja al backend solo después de los 4 dígitos (no en cada keystroke).
- Hash bcrypt en backend; el cliente nunca conoce el PIN correcto.
- El "session_id" generado al login se guarda en localStorage del navegador.
- Sesión persistente: si el navegador cierra y se vuelve a abrir, sigue logueado (no expira por inactividad en Vendedor de local).
- En la transición de fade-out al éxito, se precarga la pantalla principal para que aparezca instantánea.

## Referencias

- SPEC §6.2 — Autenticación con PIN de 4 dígitos
- SPEC §6.3.1 — Sesiones del Vendedor en local (permanentes)
- SPEC §7.7 — Componentes core (PinInput)
