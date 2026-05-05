# Wireframe 08 — Admin: pago de facturas con multi-cuenta

> **Cuándo aparece**: cuando el admin selecciona facturas para pagar desde la sección Insumos y Proveedores → Proveedor → Facturas pendientes. Pantalla full (no modal).
> **Premisa**: el flujo real del negocio es complejo — pagar varias facturas con plata de varias cuentas, distribuyendo libremente. La UI tiene que soportar eso sin marear.

## Layout — wizard de 3 pasos

### Paso 1 — Seleccionar facturas a pagar

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  ← Volver       Pagar facturas                                                               │
│                                                                                              │
│  PASO 1 DE 3 · Seleccionar facturas                                                          │
│  ────────────────────────────────────────────────────────────────────────────────────────   │
│                                                                                              │
│  PROVEEDOR:  [ Vacalin                       ▾ ]  ( cambiar / agregar otro proveedor )       │
│                                                                                              │
│  Mostrar: [ Pendientes ▾ ]   Filtrar por: [ Cualquier vencimiento ▾ ]                        │
│                                                                                              │
│  ──────────────────────────────────────────────────────────────────────────────────────     │
│                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ [☑] FB 0003-00012345   Em. 15/04   Vence 28/04 ⚠   Total $ 200.000   Saldo $ 200.000│ │
│  │     Aplicar al pago: $ [ 200.000 ]                                                    │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│  │ [☑] FB 0003-00012398   Em. 22/04   Vence 30/04 ⚠   Total $ 500.000   Saldo $ 500.000│ │
│  │     Aplicar al pago: $ [ 500.000 ]                                                    │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│  │ [☑] FB 0003-00012420   Em. 25/04   Vence 02/05     Total $ 300.000   Saldo $ 300.000│ │
│  │     Aplicar al pago: $ [ 300.000 ]                                                    │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│  │ [☐] FB 0003-00012445   Em. 28/04   Vence 05/05     Total $ 180.000   Saldo $ 180.000│ │
│  │                                                                                       │ │
│  │ [☐] FB 0003-00012501   Em. 30/04   Vence 10/05     Total $ 240.000   Saldo $ 240.000│ │
│  └──────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                              │
│  ────────────────────────────────────────────────                                            │
│                                                                                              │
│  Seleccionadas: 3 facturas                                                                   │
│  Total a pagar: $ 1.000.000                                                                  │
│                                                                                              │
│                                                                  [ Cancelar ]  [ Siguiente → ] │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Particularidades

- Lista de todas las facturas pendientes del proveedor seleccionado
- Iconos ⚠ destacan vencimientos próximos (hoy, mañana, en 3 días)
- Cada factura seleccionada permite **ajustar el monto a aplicar** (puede pagar parcial)
- Total a pagar = suma de "Aplicar al pago" de las marcadas
- Cambiar de proveedor mid-flow → opcional (pagar a varios proveedores en una sola transacción)

### Paso 2 — Distribuir entre cuentas

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  ← Atrás        Pagar facturas                                                               │
│                                                                                              │
│  PASO 2 DE 3 · Distribuir entre cuentas                                                      │
│  ────────────────────────────────────────────────────────────────────────────────────────   │
│                                                                                              │
│  Total a pagar:  $ 1.000.000                                                                 │
│                                                                                              │
│  ──────────────────────────────────────────────────────────────────────────────────────     │
│                                                                                              │
│  CUENTAS                                                                                     │
│                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Cuenta:  [ Caja física           ▾ ]                                                 │ │
│  │  Método:  [ EFECTIVO              ▾ ]                                                 │ │
│  │  Monto:   $ [ 300.000 ]                                                               │ │
│  │  Ref. operación (opcional):                                              [ ✕ Quitar ] │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│  │  Cuenta:  [ Santander             ▾ ]    Saldo actual: $ 850.000                      │ │
│  │  Método:  [ TRANSFERENCIA         ▾ ]                                                 │ │
│  │  Monto:   $ [ 400.000 ]                                                               │ │
│  │  Ref. operación: [ OP-12345                       ]                      [ ✕ Quitar ] │ │
│  ├──────────────────────────────────────────────────────────────────────────────────────┤ │
│  │  Cuenta:  [ Galicia               ▾ ]    Saldo actual: $ 420.000                      │ │
│  │  Método:  [ TRANSFERENCIA         ▾ ]                                                 │ │
│  │  Monto:   $ [ 300.000 ]                                                               │ │
│  │  Ref. operación: [ OP-67890                       ]                      [ ✕ Quitar ] │ │
│  └──────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                              │
│  [ + Agregar otra cuenta ]                                                                   │
│                                                                                              │
│  ──────────────────────────────────────────────────────────────────────────────────────     │
│                                                                                              │
│  Asignado:    $ 1.000.000      ✓                                                             │
│  Diferencia:  $          0                                                                   │
│                                                                                              │
│                                              [ ← Atrás ]   [ Siguiente → ]                   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Particularidades

- Cada fila: cuenta + método + monto + referencia opcional + remove
- Saldo actual de cada cuenta visible para no quedarse en rojo
- Validación: monto de la cuenta no puede superar el saldo (warning amarillo si supera)
- "Asignado" se actualiza en vivo
- Botón "Siguiente" deshabilitado mientras `diferencia != 0`

### Paso 3 — Distribuir cuentas a facturas (matriz)

Solo aparece si hay **>1 factura Y >1 cuenta**. Si no, se salta a confirmación.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  ← Atrás        Pagar facturas                                                               │
│                                                                                              │
│  PASO 3 DE 3 · Asignar pagos a facturas                                                      │
│  ────────────────────────────────────────────────────────────────────────────────────────   │
│                                                                                              │
│  El sistema propone una distribución automática (cubrir las facturas más viejas primero).   │
│  Podés ajustar manualmente cuánto de cada pago va a cada factura.                           │
│                                                                                              │
│  ──────────────────────────────────────────────────────────────────────────────────────     │
│                                                                                              │
│                          │ Caja física    │ Santander      │ Galicia        │  Aplicado     │
│                          │ EFECTIVO       │ TRANSFER.      │ TRANSFER.      │               │
│                          │ $ 300.000      │ $ 400.000      │ $ 300.000      │               │
│  ────────────────────────┼────────────────┼────────────────┼────────────────┼───────────    │
│  FB-12345  ($ 200.000)   │ [ 200.000 ]    │ [       0 ]    │ [       0 ]    │ $ 200.000 ✓   │
│  FB-12398  ($ 500.000)   │ [ 100.000 ]    │ [ 400.000 ]    │ [       0 ]    │ $ 500.000 ✓   │
│  FB-12420  ($ 300.000)   │ [       0 ]    │ [       0 ]    │ [ 300.000 ]    │ $ 300.000 ✓   │
│  ────────────────────────┼────────────────┼────────────────┼────────────────┼───────────    │
│  Total cuenta            │ $ 300.000  ✓   │ $ 400.000  ✓   │ $ 300.000  ✓   │ $ 1.000.000   │
│                                                                                              │
│  [ Restablecer distribución automática ]                                                     │
│                                                                                              │
│  ──────────────────────────────────────────────────────────────────────────────────────     │
│                                                                                              │
│                                              [ ← Atrás ]   [ Siguiente → ]                   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Particularidades

- **Matriz factura × cuenta**: las celdas son inputs editables
- Sistema pre-rellena con propuesta automática (FIFO por vencimiento)
- Sumas a la derecha (por factura) y abajo (por cuenta) en vivo
- ✓ verde cuando coinciden con el target esperado, ✕ rojo si no
- Botón "Restablecer" vuelve a la propuesta automática
- Si la matriz es muy grande (>5 facturas × >3 cuentas), reflow a layout vertical en mobile

### Paso final — Confirmación

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  ← Atrás        Pagar facturas                                                               │
│                                                                                              │
│  CONFIRMAR PAGO                                                                              │
│  ────────────────────────────────────────────────────────────────────────────────────────   │
│                                                                                              │
│  PROVEEDOR:  Vacalin                                                                         │
│  TOTAL:      $ 1.000.000                                                                     │
│  FECHA:      27/04/2026                                                                      │
│                                                                                              │
│  FACTURAS A CANCELAR:                                                                        │
│  • FB 0003-00012345   $ 200.000   (saldo restante: $ 0)                                     │
│  • FB 0003-00012398   $ 500.000   (saldo restante: $ 0)                                     │
│  • FB 0003-00012420   $ 300.000   (saldo restante: $ 0)                                     │
│                                                                                              │
│  PAGOS QUE SE GENERAN:                                                                       │
│  • Caja física  EFECTIVO        $ 300.000                                                    │
│  • Santander    TRANSFER. OP-12345        $ 400.000                                          │
│  • Galicia      TRANSFER. OP-67890        $ 300.000                                          │
│                                                                                              │
│  Observaciones (opcional):                                                                   │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                                      │ │
│  └──────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                              │
│  ⚠ Una vez confirmado, los saldos de las cuentas se actualizan inmediatamente.              │
│                                                                                              │
│                                            [ ← Atrás ]   [ ✓ Confirmar y registrar pago ]    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Comportamiento responsive (mobile)

En mobile, el wizard se mantiene pero cada paso es full-screen:
- Paso 1: lista de facturas con checkboxes y montos editables
- Paso 2: cuentas como cards apiladas
- Paso 3: para cada factura, lista de cuentas con monto editable (no matriz)
- Confirmación: scroll vertical, botón fijo abajo

## Componentes usados

- `WizardStepper` (1/3, 2/3, 3/3, confirmación)
- `InvoiceRow` (con checkbox y monto editable)
- `AccountPaymentRow` (cuenta + método + monto + ref)
- `DistributionMatrix` (custom — celdas editables, sumas en vivo)
- `ConfirmationCard`

## Referencias

- SPEC §5.6 — Pagos a proveedores
- SPEC §5.6.4 — UI propuesta
- SPEC §7.5.3 — Pago multi-cuenta
