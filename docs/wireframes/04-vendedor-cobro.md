# Wireframe 04 — Pantalla de cobro

> **Cuándo aparece**: cuando el cajero clickea "COBRAR $X" en el carrito (Wireframe 02) o presiona F9.
> **Premisa**: hero del total + métodos de pago como botones grandes + descuento del 10% efectivo separado y opcional.

## Pantalla principal de cobro

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Volver al pedido                                                          │
│                                                                              │
│                                                                              │
│  PEDIDO #047  —  TOTAL A COBRAR                                              │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │                                                                        │ │
│  │                          $ 27.117                                      │ │
│  │                                                                        │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│                                                                              │
│  MÉTODO DE PAGO                                                              │
│                                                                              │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐             │
│  │                  │ │                  │ │                  │             │
│  │     EFECTIVO     │ │     DÉBITO       │ │     CRÉDITO      │             │
│  │        💵        │ │        💳        │ │        💳        │             │
│  │                  │ │                  │ │                  │             │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘             │
│                                                                              │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐             │
│  │                  │ │                  │ │                  │             │
│  │     MP / QR      │ │   TRANSFER.      │ │     DIVIDIR      │             │
│  │        📱        │ │        🏦        │ │        ⚖️        │             │
│  │                  │ │                  │ │                  │             │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘             │
│                                                                              │
│  ─────────────────────────────────────────────────────────────────           │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  💚  EFECTIVO con 10% DE DESCUENTO                                     │ │
│  │      Total con descuento:  $ 24.405                                    │ │
│  │      Ahorrás:              $  2.712                                    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Breakdown

- **Hero del total**: número gigante (`--text-4xl`, `--font-mono`), fondo `--surface-card`, borde verde sutil. Centrado.
- **Grid 3×2 de métodos** + 7° método separado (descuento 10%).
- Botones grandes (160×120px), accesibles, claramente visibles. Iconos grandes.
- **Descuento 10% efectivo**: card aparte debajo del divisor, color `--green-teresita-100` background. Solo visible si canal = MOSTRADOR. Atajo: F12.

### Atajos

| Tecla | Acción |
|-|-|
| `1` | Efectivo |
| `2` | Débito |
| `3` | Crédito |
| `4` | MP/QR |
| `5` | Transferencia |
| `6` | Dividir |
| `F12` | Efectivo con 10% descuento |
| `Esc` | Volver al pedido |

## Sub-pantalla: Cobro en efectivo (calcular cambio)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Volver       PEDIDO #047  —  $ 27.117                                     │
│                                                                              │
│  COBRAR EN EFECTIVO                                                          │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  ¿Cuánto recibiste?                                                    │ │
│  │  ┌──────────────────────────────────────────┐                          │ │
│  │  │ $ 30.000                                 │                          │ │
│  │  └──────────────────────────────────────────┘                          │ │
│  │                                                                        │ │
│  │  Sugerencias:                                                          │ │
│  │  [ Justo $27.117 ]  [ $30.000 ]  [ $35.000 ]  [ $50.000 ]              │ │
│  │                                                                        │ │
│  │  ─────────────────────────────────────────                             │ │
│  │                                                                        │ │
│  │  CAMBIO A DEVOLVER:        $ 2.883                                     │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│                                            [ Cancelar ]   [ Confirmar ⏎ ]    │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Input numérico grande, `--font-mono`, foco automático
- 4 sugerencias rápidas: justo / próximo redondo arriba / +$5k / +$10k+
- Cambio se calcula en vivo
- Si `recibido < total` → botón Confirmar deshabilitado, mensaje "falta $X"
- Atajo: Enter confirma, Esc cancela

## Sub-pantalla: Cobro con tarjeta (posnet integrado)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Volver       PEDIDO #047  —  $ 27.117                                     │
│                                                                              │
│  COBRAR CON DÉBITO                                                           │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │                       💳   Posnet Santander                           │ │
│  │                                                                        │ │
│  │                       Esperando confirmación...                        │ │
│  │                                                                        │ │
│  │                            ⏳  $ 27.117                               │ │
│  │                                                                        │ │
│  │                       Cliente acerca tarjeta al posnet                 │ │
│  │                                                                        │ │
│  │                                                                        │ │
│  │                  [ Cancelar operación en posnet ]                      │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Sistema le mandó el monto al posnet (Sección 4.8.2bis del SPEC)
- Cajero solo espera confirmación
- Cuando el posnet aprueba: transición fade-out a "Cobrado correctamente" + impresión ticket cliente

## Sub-pantalla: Cobro con tarjeta (posnet manual / legacy)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Volver       PEDIDO #047  —  $ 27.117                                     │
│                                                                              │
│  COBRAR CON DÉBITO — MODO MANUAL                                             │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │   1. Tipeá en el posnet:    $ 27.117                                   │ │
│  │                                                                        │ │
│  │   2. Cobrá la tarjeta del cliente                                      │ │
│  │                                                                        │ │
│  │   3. Cuando esté aprobado, confirmá acá:                               │ │
│  │                                                                        │ │
│  │                                                                        │ │
│  │   Últimos 4 dígitos de la tarjeta:    [ 1234         ]                 │ │
│  │   N° de autorización (opcional):      [              ]                 │ │
│  │                                                                        │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│                                  [ Cancelar ]    [ Confirmar pago ]          │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Sub-pantalla: Cobro MP / QR

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Volver       PEDIDO #047  —  $ 27.117                                     │
│                                                                              │
│  COBRAR CON MP / QR                                                          │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │     ┌──────────────────────────────┐                                   │ │
│  │     │                              │                                   │ │
│  │     │     ████ ██ █ ██ ████        │      Pediile al cliente           │ │
│  │     │     █  █ ██ █ ██ █  █        │      que escanee el QR            │ │
│  │     │     █  █ ██ █ ██ █  █        │      con su app de                │ │
│  │     │     ████ █  █ ██ ████        │      Mercado Pago                 │ │
│  │     │     █ █ █  ██ █ █  ██        │                                   │ │
│  │     │     █  █ █  █ █ ███          │      Total: $ 27.117              │ │
│  │     │     ████ ██ █ ██ ████        │                                   │ │
│  │     │                              │      ⏳ Esperando pago...         │ │
│  │     │     [ código QR generado ]   │                                   │ │
│  │     └──────────────────────────────┘                                   │ │
│  │                                                                        │ │
│  │             Tiempo restante: 4:32                                      │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│                                                          [ Cancelar QR ]     │
└──────────────────────────────────────────────────────────────────────────────┘
```

- QR generado con MP API (Sección 10.4.2)
- Timer de 5 min (configurable). Si vence, vuelve atrás automáticamente.
- Cuando llega webhook de MP → pantalla cambia a "Pagado" instantáneo

## Sub-pantalla: Pago dividido (split)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Volver                            PEDIDO #047  —  $ 27.117                │
│                                                                              │
│  DIVIDIR EL PAGO                                                             │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │  Método 1                                                              │ │
│  │  [ EFECTIVO         ▾ ]               $ [   10.000  ]      [ ✕ ]       │ │
│  │                                                                        │ │
│  │  Método 2                                                              │ │
│  │  [ DÉBITO   Posnet Sant.  ▾ ]         $ [   17.117  ]      [ ✕ ]       │ │
│  │                                                                        │ │
│  │                                                                        │ │
│  │  [ + Agregar otro método ]                                             │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ─────────────────────────────────────────────────────────────              │
│                                                                              │
│  Asignado:    $ 27.117      ✓                                                │
│  Falta:       $      0                                                       │
│                                                                              │
│  ─────────────────────────────────────────────────────────────              │
│                                                                              │
│                                            [ Confirmar y cobrar ]            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Cada método como fila editable (dropdown método + monto + remove)
- Botón "Agregar otro método" duplica una fila vacía
- "Falta" se actualiza en vivo, cambia color verde cuando = 0
- Botón Confirmar deshabilitado mientras `falta != 0`
- Para cada método de tarjeta, se ejecuta el subflow de tarjeta (integrado o manual)

## Estado: cobro exitoso

Después de confirmar el cobro, transición rápida (300ms ease-out):

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│                                                                              │
│                                                                              │
│                                  ✓                                           │
│                                                                              │
│                       PEDIDO #047 COBRADO                                    │
│                                                                              │
│                          $ 27.117                                            │
│                                                                              │
│                                                                              │
│                       Imprimiendo ticket...                                  │
│                                                                              │
│                                                                              │
│                       Volviendo en 2 segundos                                │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Check verde grande (`--basil-600`)
- Mensaje claro
- 2 segundos después, vuelve a pantalla principal del Vendedor con carrito vacío y nuevo pedido listo

## Estado: error (pago rechazado)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│                                  ✕                                           │
│                                                                              │
│                       PAGO RECHAZADO                                         │
│                                                                              │
│   El posnet rechazó la operación.                                            │
│   Razón: Fondos insuficientes / Tarjeta inválida / etc.                      │
│                                                                              │
│   El pedido #047 sigue ABIERTO. Probá con otro método.                       │
│                                                                              │
│                                                                              │
│                              [ Reintentar ]                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- ✕ rojo (`--pomodoro-600`)
- La venta NO pasa a Finalizada — sigue Procesada para que el cajero reintente
- Ningún Pago se confirma hasta que el método entero se complete OK

## Componentes usados

- `MoneyAmount` (hero variant)
- `PaymentMethodCard` (large button con icon + label)
- `DiscountCard` (variant especial para 10% efectivo)
- `NumericInput` (con tabular figures, sugerencias)
- `QrDisplay` (genera QR con expiración)
- `SplitPaymentRow` (método + monto + remove)

## Referencias

- SPEC §4.7 — Pagos
- SPEC §4.8.2 — Descuento 10% efectivo
- SPEC §4.8.2bis — Posnet integrado vs manual
- SPEC §7.4.3 — Pantalla de cobro
- SPEC §10.4 — MercadoPago QR
