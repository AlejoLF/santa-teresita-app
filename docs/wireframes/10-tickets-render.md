# Wireframe 10 — Render de los 3 tickets

> Formato real de los 3 tickets que el sistema imprime. Ya estaban diseñados en SPEC §8 — acá los muestro cómo se verán impresos, con todos los elementos visuales en su lugar.

## Ancho real de las impresoras

- **Térmica EPSON TM-T20II**: 80mm de ancho de papel = ~42 caracteres por línea con la fuente default. Soporta doble alto (`ESC ! 0x10`), doble ancho (`ESC ! 0x20`), negrita (`ESC E 1`), negativo (`GS B 1`), QR codes, imágenes monocromas.
- **Lexmark E460 láser**: tamaño TBD (más chico que A5, confirmar con encargada — pendiente E-C6).

## Ticket 1 — Comanda de cocina

**Cuándo se imprime**: al pasar venta a `PROCESADA` si algún item tiene `cocina_interviene=true`.
**Quién la lee**: el cocinero — tiene que entender el pedido en 3 segundos.
**Sale en**: térmica de cocina (EPSON TM-T20II en cocina).

```
==========================================
        SANTA TERESITA PASTAS
==========================================

         ╔════════════════╗
         ║                ║
         ║   COMANDA      ║
         ║                ║
         ║    # 047       ║
         ║                ║
         ╚════════════════╝

  Hora pedido:   19:42
  Canal:         MOSTRADOR

------------------------------------------
  ITEMS
------------------------------------------

  ## 380g  Sorrentinos
            > Relleno: Ricotta, Mozz, Jamón
            > OBS: SIN SAL

  ##   4   Canelones J&Q
            > [COMBO: Promo 4 Canelones]

  ##   1   Salsa Fileto
            > [COMBO: Promo 4 Canelones]

  ##   1   Postre Tiramisú
            > [COMBO: Promo 4 Canelones]

------------------------------------------
  PC2  ·  19:42:08
==========================================
```

### Elementos visuales

- **Header**: nombre del local en doble ancho
- **Número de orden**: en doble alto + doble ancho, dentro de un box con bordes ASCII
- **Cantidades**: en doble alto (`##`), super legibles
- **Modificadores**: con `>` indentado debajo del producto
- **Observaciones**: prefijo `OBS:` en negrita + texto en mayúsculas para destacar
- **Combos**: cada componente marcado con `[COMBO: nombre]` para que cocina sepa que pertenecen juntos
- **Footer**: PC + hora exacta para audit interno

### Variantes especiales

#### Comanda de delivery (entra desde plataforma o delivery propio)

Igual que la mostrador pero con la modalidad y datos del cliente:

```
==========================================
        SANTA TERESITA PASTAS
==========================================

         ╔════════════════╗
         ║   COMANDA      ║
         ║    # 048       ║
         ║   DELIVERY     ║
         ╚════════════════╝

  Hora pedido:    19:46
  Hora entrega:   20:30
  Canal:          PEDIDOS YA
  ID externo:     PY-12345

  CLIENTE: CRISTINA
  Tel:     2216124035
  Direc:   50 4 Y 5 481 D 4°

------------------------------------------
  ITEMS
------------------------------------------

  ##   1   Canelones J&Q

------------------------------------------
  PC4  ·  19:46:12
==========================================
```

#### Comanda CANCELADA (cuando se anula venta cuya comanda ya se imprimió)

```
==========================================

       ╔══════════════════════════╗
       ║                          ║
       ║      *** CANCELADA ***   ║
       ║                          ║
       ║         ORDEN # 047      ║
       ║                          ║
       ╚══════════════════════════╝

  Hora cancelación:  19:48
  Cancelada por:     Encargada

  Motivo:  Cliente se arrepintió

==========================================
```

- **Negativo** (negro sobre blanco invertido con `GS B 1`) para máximo contraste visual
- Sale automáticamente cuando se anula (Sección 4.10 SPEC)
- Sin texto adicional ("no preparar este pedido" lo sacamos por feedback del usuario — la palabra CANCELADA es suficiente)

## Ticket 2 — Ticket cliente (mostrador)

**Cuándo se imprime**: al pasar venta a `FINALIZADA` (modalidad TAKE_AWAY).
**Quién lo lee**: el cliente.
**Sale en**: térmica de mostrador (EPSON TM-T20II en mostrador).

```
==========================================
       SANTA TERESITA PASTAS
       Av. 44 e. 12 y Plaza Paso
       La Plata, Bs. As.
==========================================

  Venta:    460079
  Orden:    # 047
  Cliente:  Casual / Cliente
  Vendedor: Vendedor (PC2)

------------------------------------------
 Cant. Descripción            Unit.  Monto
------------------------------------------
  380g Sorrent. RMJ          23,5  8.930
   4   Canelones J&Q       3.800 15.200
   1   Salsa Fileto        6.000  6.000
------------------------------------------

                       Subtotal: $ 30.130
                  Descuento 10%: -$ 3.013
                                ─────────
                            TOTAL: $ 27.117
                                ─────────

  Pago:    Efectivo
  Recibí:  $ 30.000
  Cambio:  $  2.883

         ¡Gracias por su compra!

------------------------------------------
  Ticket no fiscal
  23/04/2026 11:40:09

  📷 @santateresitapastas
  📞 (221) 123-4567
  🌐 santateresitapastas.com.ar
==========================================
```

### Elementos visuales

- **Header**: marca + dirección
- **Identificación de la venta**: número interno + número de orden + cliente + vendedor + PC
- **Tabla de items**: alineación con tabular figures, columnas Cant / Desc / Unit / Monto
- **Subtotal / Descuento / Total**: alineados a la derecha, con separadores
- **TOTAL**: en doble alto destacado
- **Pago**: método + recibido + cambio (cuando aplica)
- **Mensaje de agradecimiento**: simple, centrado
- **Footer**: leyenda fiscal + fecha exacta + redes sociales (configurable por dueño)

### Mejoras vs Innovo

| Elemento | Innovo actual | Sistema nuevo |
|-|-|-|
| Método de pago | No aparece | ✅ Aparece |
| Cambio dado | No aparece | ✅ Aparece si efectivo |
| Número de orden del turno | No existe | ✅ "Orden # 047" |
| Recargo / descuento desglosado | Solo descuento | ✅ Ambos visibles |
| Footer marketing | No hay | ✅ Configurable |

## Ticket 3 — Ticket delivery

**Cuándo se imprime**: al pasar venta a `PROCESADA` (modalidad DELIVERY_*).
**Quién lo lee**: cocina (lo prepara) + repartidor (lo lleva) + cliente (lo recibe).
**Sale en**: láser Lexmark E460 en oficina delivery, formato compacto.

```
┌────────────────────────────────────────────┐
│  🍝 SANTA TERESITA PASTAS                  │
│     Av. 44 e. 12 y Plaza Paso              │
│     La Plata, Bs. As.                      │
│  ════════════════════════════════════════  │
│                                            │
│       DELIVERY # 459959                    │
│       ORDEN # 047                          │
│                                            │
│       Canal:  PEDIDOS YA                   │
│       ID ext: PY-12345                     │
│                                            │
│  ════════════════════════════════════════  │
│                                            │
│  📍 ENTREGA                                │
│                                            │
│  Cliente:   CRISTINA                       │
│  Teléfono:  📞 2216124035                  │
│  Dirección: 50 4 Y 5 481 dpto D 4° piso    │
│  Localidad: La Plata                       │
│                                            │
│  ⚠ Indicaciones:                            │
│     Tocar timbre fuerte,                   │
│     no funciona el portero                 │
│                                            │
│  Hora prometida: 13:30 hs                  │
│                                            │
│  ════════════════════════════════════════  │
│                                            │
│  📋 ITEMS                                  │
│                                            │
│  ┌───┬────────────────────┬──────┬──────┐  │
│  │ 1 │ ENVIO              │ 3.800│ 3.800│  │
│  │ 1 │ PROMO 1Kg Fid+2Sal │27.900│27.900│  │
│  │   │   • Cinta media    │      │      │  │
│  │   │   • Salsa Fileto   │      │      │  │
│  │   │   • Salsa Bolog.   │      │      │  │
│  │   │   • Reggianito     │      │      │  │
│  └───┴────────────────────┴──────┴──────┘  │
│                                            │
│                  Subtotal:    $ 31.700     │
│                                            │
│           ╔══════════════════════╗         │
│           ║  TOTAL:    $ 31.700  ║         │
│           ╚══════════════════════╝         │
│                                            │
│  ════════════════════════════════════════  │
│                                            │
│  💳 PAGO                                   │
│                                            │
│  Método:        EFECTIVO                   │
│  A cobrar:      $ 31.700                   │
│  (cobrar al entregar)                      │
│                                            │
│  ════════════════════════════════════════  │
│                                            │
│  Repartidor:  Damián                       │
│  Cajero:      Vendedor (PC4)               │
│  Impreso:     22/04/2026  13:31:42         │
│                                            │
└────────────────────────────────────────────┘
```

### Variantes según modalidad de pago

#### Pago anticipado (tarjeta / plataforma)

Reemplazar la sección 💳 PAGO por:

```
  💳 PAGO

  Método:    PEDIDOS YA (online)
  Estado:    ╔════════════╗
             ║   PAGADO   ║
             ╚════════════╝
```

#### Pago en mostrador (cliente lo retira)

```
  💳 PAGO

  Método:    Pagado en mostrador
  Estado:    ╔════════════╗
             ║   PAGADO   ║
             ╚════════════╝
```

### Elementos visuales

- **Header**: marca + dirección con logo color (láser permite color)
- **Identificación**: 2 números (delivery + orden) bien grandes
- **Sección entrega**: la más importante para el repartidor — datos del cliente con iconos para escanear visualmente
- **Indicaciones**: en banner amarillo destacado (timbre roto, perro, etc.)
- **Hora prometida**: visible para presionar a cocina
- **Items**: tabla con cantidades, modificadores indentados con bullets
- **TOTAL**: destacado en box
- **Pago**: con leyenda clara — efectivo a cobrar o "PAGADO"
- **Footer**: identificación interna (cajero, hora exacta)

## Tickets adicionales (variantes)

### Ticket reimpresión

Ticket cliente con marca arriba:

```
==========================================
       SANTA TERESITA PASTAS
       Av. 44 e. 12 y Plaza Paso

       *** DUPLICADO ***
       Reimpresión hoy 27/04 21:30
       Original: 23/04 11:40
==========================================

  ... (resto del ticket normal)
```

### Comanda reimpresión

```
==========================================
        SANTA TERESITA PASTAS
==========================================

       *** REIMPRESIÓN ***
       Original: 19:42

         ╔════════════════╗
         ║   COMANDA      ║
         ║    # 047       ║
         ╚════════════════╝
       ...
```

## Configuración del sistema

(Sección 8.6 SPEC) — desde Admin → Configuración → Tickets:

- Header del ticket cliente: nombre, dirección, logos (térmica + láser)
- Footer: mensaje, redes, teléfono
- Mostrar precios en comanda: ❌ siempre off (decisión cerrada)
- Tamaño del papel delivery: TBD según confirmación

## Referencias

- SPEC §8 — Tickets completo
- SPEC §8.2 — Comanda
- SPEC §8.3 — Ticket cliente
- SPEC §8.4 — Ticket delivery
- SPEC §8.7 — Stack técnico de impresión
