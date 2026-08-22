# 11 — Admin · Banco de horas

> Especificado en [SPEC §14](../SPEC.md). Pantalla ADMIN-only. Responde tres
> preguntas: cuánto le debo a cada uno, cuánto debo en total, y cuánto me deben.

## Listado

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BANCO DE HORAS                                    [ Categorías ▾ ]  [ + ]   │
│  Horas trabajadas pendientes de pago y adelantos.                            │
├──────────────────────────────────────────────────────────────────────────────┤
│  [ Buscar empleado…        ]   Categoría [ Todas ▾ ]   [ ✓ ] Sólo con saldo  │
├──────────────────────────────────────────────────────────────────────────────┤
│  EMPLEADO          CATEGORÍA    HS.PEND.   $/H      EN PESOS   ADELANTOS  SALDO│
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄│
│  Marcela R.        Mostrador       42,0   3.400     142.800     −20.000  122.800 →│
│  Damián S.         Reparto         18,5   3.900      72.150           0   72.150 →│
│  Jorge P.          Cocina           8,0   4.100      32.800     −50.000  −17.200 →│  // saldo negativo
│  Lucía M.          Mostrador         0    3.400           0           0        0 →│
├──────────────────────────────────────────────────────────────────────────────┤
│  TOTAL ADEUDADO                            247.750      −70.000     177.750   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **HS. PEND.** son horas, no plata. **EN PESOS** es `horas × $/H vigente`, y se
  recalcula solo cuando cambia la categoría (SPEC §14.2) — por eso el saldo no
  se guarda en ninguna tabla.
- **Saldo negativo** (Jorge) = debe más de lo que tiene ganado. Se destaca pero
  **no se bloquea**: no hay tope de adelanto.
- El **TOTAL** de abajo es el pasivo del local. Es la razón de ser de la pantalla.

## Detalle del empleado

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Banco de horas                                                            │
│  MARCELA R.  ·  Mostrador · $3.400/h            [ Cargar horas ] [ Adelanto ] │
│                                                              [ Liquidar ]    │
├──────────────────────────────────────────────────────────────────────────────┤
│  42,0 hs pendientes  =  $142.800        Adelantos  −$20.000      SALDO $122.800│
├──────────────────────────────────────────────────────────────────────────────┤
│  FECHA        DETALLE                                 HORAS      PESOS        │
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄│
│  18/08        Horas normales                          +8,0                    │
│  17/08        Horas normales                          +8,0                    │
│  16/08        Feriado (×2)                            +6,0                    │
│  15/08        Adelanto — efectivo                              −20.000        │
│  14/08        Horas normales                          +8,0                    │
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄│
│  ✅ 31/07     Liquidación — 80,0 hs a $3.100          −80,0    −248.000       │
│               (valor congelado, no se revalúa)                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Lo liquidado queda visible pero apagado, con el valor hora **estampado**: es el
  único punto donde la revaluación se detiene (SPEC §14.2).
- Nada de esto se edita. Un error se corrige con un `AJUSTE`, que entra como una
  fila más.

## Cargar horas

```
┌───────────────────────────────────────────────┐
│  CARGAR HORAS — Marcela R.                    │
│                                               │
│  Día        [ 19/08/2026    ]                 │
│  Horas      [ 8,0  ]                          │
│  Tipo       [ Normales ▾ ]                    │
│                                               │
│  ⚠ El 19/08 ya tiene 4,0 hs cargadas.         │  // aviso, NO bloqueo:
│    ¿Es un turno partido?                      │  // el turno partido es legítimo
│                                               │
│  = 8,0 hs · $3.400 = $27.200                  │
│                          [ Cancelar ] [ Cargar ]│
└───────────────────────────────────────────────┘
```

## Configuración de categorías

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  CATEGORÍAS Y VALOR HORA                                          [ + Nueva ] │
├──────────────────────────────────────────────────────────────────────────────┤
│  Mostrador     $3.400/h   desde 01/08/2026    4 empleados    [ Historial ] [✎]│
│  Cocina        $4.100/h   desde 01/08/2026    3 empleados    [ Historial ] [✎]│
│  Reparto       $3.900/h   desde 15/07/2026    1 empleado     [ Historial ] [✎]│
├──────────────────────────────────────────────────────────────────────────────┤
│  TIPOS DE HORA                                                                │
│  Normales      ×1        Extra 50%   ×1,5      Feriado   ×2                   │
│  Nocturnas     $5.000/h fijo  ← no sigue a la categoría, se actualiza aparte  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Aviso al aumentar — obligatorio

```
┌───────────────────────────────────────────────┐
│  AUMENTAR MOSTRADOR                           │
│                                               │
│  Valor hora    $3.400  →  [ 3.740 ]   (+10%)  │
│  Rige desde    [ 22/08/2026 ]                 │
│                                               │
│  ⚠ Esto no afecta sólo a las horas futuras.   │
│                                               │
│    Las 61,5 hs pendientes de 4 empleados      │
│    pasan a valer más:                         │
│                                               │
│        $209.100   →   $230.010                │
│        La deuda sube $20.910.                 │
│                                               │
│                    [ Cancelar ] [ Confirmar ] │
└───────────────────────────────────────────────┘
```

Este aviso no es cortesía: con revaluación, un aumento mueve todo el pasivo
acumulado de golpe. Sin verlo antes, la encargada se entera cuando ya está hecho.

## Baja con saldo pendiente

Escondida en la ficha del empleado, no acá. Pide escribir el nombre completo
para confirmar. Cierra la deuda del banco de horas con un `AJUSTE` y archiva al
empleado; **los movimientos de caja quedan intactos** (SPEC §14.7). Deja registro
de quién la ejecutó y por cuánto.

## Responsive

En celular las filas del listado pasan a tarjetas —nombre, saldo grande,
categoría chica— como el resto del admin. El TOTAL queda fijo abajo.
