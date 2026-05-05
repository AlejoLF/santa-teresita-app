# Santa Teresita Pastas — Especificación funcional

> Este documento es la **especificación viva** del sistema. Se construye por secciones; cada sección se valida con el cliente antes de avanzar a la siguiente. Las decisiones cerradas quedan marcadas como tales; lo pendiente queda en la sección 12 (Pendientes / TBD).

| | |
|-|-|
| **Producto** | App de administración integral para Santa Teresita Pastas (La Plata, AR) |
| **Cliente** | Negocio de pastas frescas, take-away + delivery, local único |
| **Reemplaza** | Innovo Suite (POS local que usan hoy) + automatizaciones manuales sobre Excel |
| **Estado del documento** | En construcción — sección 1 de 13 |
| **Última actualización** | 2026-04-27 |

---

## Sección 1 — Arquitectura general, decisiones técnicas y glosario

### 1.1 Visión del producto

Sistema de gestión integral para un negocio de pastas que opera con **alto volumen** (200–2.500 ventas/día según día), **multi-canal** (mostrador físico, teléfono, WhatsApp, web propia, RAPPI, Pedidos YA, MercadoLibre, DELIVERATE) y **multi-dispositivo** (5 PCs + 2 ubicaciones externas). El sistema reemplaza al POS comercial actual (Innovo Suite), corrige sus problemas estructurales (catálogo aplanado de 1.673 SKUs, modelo contable que obliga a workarounds, ausencia de integraciones con plataformas de delivery), y agrega capacidades nuevas (sync con Excel para edición masiva, dashboards interactivos, integración con N8N para facturas de proveedores, bot de WhatsApp para pedidos automáticos en fase 2).

El sistema **no** se ocupa de la facturación fiscal con ARCA; eso queda fuera de scope y lo maneja la encargada por afuera.

### 1.2 Principios de diseño

Cinco principios guían cada decisión técnica de este documento:

1. **Local-first, nube-segundo.** El local debe poder operar sin internet. La nube es para sync, acceso remoto y backup, no para que el cajero cargue un pedido. Los cortes de luz e internet son una realidad operativa que ya golpeó al negocio.
2. **El programa es la fuente de verdad operativa; los Excel son una capa de presentación / edición masiva.** Cuando hay conflicto, gana lo que se aprobó en el programa. Pero las ediciones masivas (ej. aumento del 3% a todos los precios) se permiten desde Excel con aprobación posterior del admin.
3. **Modelar reglas, no enumerar combinaciones.** Productos, modificadores, combos y promos se modelan como reglas componibles, no como SKUs aplanados. El catálogo nuevo va de ~1.673 ítems a ~150–250 productos base + un set de modificadores y combos.
4. **Trazabilidad total.** Cada acción que afecta plata, stock o configuración queda registrada con usuario, dispositivo, timestamp, valor anterior y valor nuevo. Es el reemplazo del workaround "Aporte Banco" y de la sospecha de malversación que motiva todo este sistema.
5. **Exportable a Excel siempre.** Toda tabla, listado o reporte tiene un botón "Exportar a Excel". El dueño y la encargada se mueven más cómodos con fórmulas que con UIs propietarias; no peleamos contra eso, lo abrazamos.

### 1.3 Topología del sistema

```
┌───────────────────────── LOCAL FÍSICO ─────────────────────────┐
│                                                                 │
│   PC1 ─┐                                                        │
│   PC2 ─┤                                                        │
│   PC3 ─┼─── LAN (wifi router) ─── Servidor local (NUC/PC)       │
│   PC4 ─┤                                  │                     │
│   PC encargada                            │  PostgreSQL réplica │
│                                           │  Redis              │
│                                           │  Agente impresión   │
│                                           │  (EPSON TM-T20II    │
│                                           │   + Lexmark E460)   │
│                                           │                     │
└───────────────────────────────────────────┼─────────────────────┘
                                            │
                                  Sync continuo (replicación lógica
                                  Postgres) + outbox para eventos
                                            │
┌───────────────────────────── VPS ──────────────────────────────┐
│                                                                 │
│   PostgreSQL primario   ←→   API (Node + Fastify)               │
│   Redis + BullMQ                    │                           │
│   Caddy (HTTPS)                     ├─→ Webhooks RAPPI / PYA /  │
│                                     │   MELI / DELIVERATE       │
│                                     ├─→ MercadoPago API         │
│                                     ├─→ Belvo (saldos bancarios)│
│                                     └─→ N8N (facturas Telegram) │
│                                                                 │
└─────────────────────────────────────┼───────────────────────────┘
                                      │
                                      │ Internet
                                      │
                             PC dueño Julio (acceso remoto al panel admin)
```

**Reglas de la topología:**

- Los 5 dispositivos del local le pegan al **servidor local** (latencia LAN, ms). Si se cae internet, siguen operando.
- El servidor local se **sincroniza continuamente** con la VPS. Si se cae el servidor local, los dispositivos pueden caer al modo VPS (degradación) o esperar a que vuelva. Se evalúa según volumen y latencia.
- La **PC del dueño** vive fuera del local; pega directo a la VPS por internet. Solo accede al panel admin (no carga ventas).
- Las **integraciones externas** (apps de delivery, MP, Belvo, N8N) se conectan a la VPS, no al servidor local. Eso garantiza estabilidad de webhooks (IP pública, certificado, uptime).
- La **impresión** se dispara desde un agente local en la PC del local (no desde la VPS), porque las impresoras viven en LAN y no son alcanzables desde internet sin túneles.

### 1.4 Stack técnico (decisión cerrada)

| Capa | Tecnología | Justificación 1-línea |
|-|-|-|
| Backend / API | **Node.js 22 + TypeScript + Fastify + Prisma** | Tipado end-to-end con la DB, ecosistema top para webhooks, mismo lenguaje que frontend |
| Base de datos | **PostgreSQL 16** | JSONB para webhooks, replicación lógica nativa, triggers para audit, lo mismo que ya conocían en Innovo |
| Cola / jobs | **Redis 7 + BullMQ** | Reintentos de webhook, cola de impresión, imports diferidos, jobs programados |
| Panel admin (web) | **Next.js 16 + React + Tailwind + Recharts** | Dashboards con drill-down, accesible desde cualquier navegador |
| App del local (mostrador / delivery / encargada) | **PWA instalable** sobre la misma base Next.js | Sin instaladores, actualizaciones transparentes |
| Agente local | **Node.js daemon** corriendo como servicio en cada PC con impresora | ESC/POS para EPSON TM-T20II + driver láser para Lexmark E460 |
| Sync local ↔ VPS | **Replicación lógica Postgres + outbox pattern** | Sin vendor de sync, control total |
| Auth | **better-auth** + PIN de 4 dígitos | Login rápido para uso operativo; sesiones largas en dispositivos del local |
| Bot WhatsApp (fase 2) | **WhatsApp Cloud API (Meta)** + lib de orquestación | Oficial, barato, sin revendedor |
| OCR de facturas (en N8N) | **LLM con visión** (Claude Haiku o GPT-4o-mini) | Más preciso y barato que OCR tradicional |
| Impresión térmica | **node-thermal-printer** | ESC/POS estándar, EPSON TM-T20II soportada nativa |
| Observabilidad | **Pino + Better Stack** (logs) + **Grafana + Prometheus** (métricas) | Suficiente para esta escala, sin sobre-ingeniería |
| Deploy | **Docker Compose + Caddy** sobre VPS Linux | Reproducible, simple, HTTPS automático |
| Repo / CI | **GitHub + GitHub Actions** | Standard |

### 1.5 Decisiones arquitectónicas cerradas

Estas decisiones no se vuelven a discutir salvo que aparezca evidencia nueva fuerte:

- **Nada de ARCA / facturación electrónica fiscal en este sistema.** La facturación cuando hace falta la maneja la encargada por afuera (probablemente por la app de ARCA / portal AFIP).
- **Las facturas de proveedores no las carga este sistema.** Las carga un flujo de N8N independiente con bot de Telegram + Drive + Excels. Este sistema las **lee** del flujo de N8N (vía API o sync con Drive) para mostrar saldos a proveedor y deudas, pero no las gestiona.
- **Los Excels existentes (Cashflow, Ventas x día, Proveedores) se mantienen vivos.** El sistema escribe en ellos automáticamente (ventas, cashflow), y el admin puede editarlos desde Drive con aprobación posterior en el programa.
- **No se enumeran combinaciones de productos.** El modelo es: producto base + modificadores + combos.
- **Cuentas contables por separado** (Caja, Santander, Galicia, Cuenta DNI, MP) sí se modelan, **pero el diseño detallado queda pendiente** hasta que el dueño defina sus preferencias. Hasta entonces se usa una cuenta general provisoria.
- **Roles**: Vendedor (PIN compartido) + Admin (PIN por persona — encargada y dueño tienen el mismo nivel de permisos pero PINs distintos para trazabilidad).
- **2 turnos de caja por día** (mañana y tarde), independientes. La caja de la tarde no acumula la de la mañana.
- **Exportable a Excel** como funcionalidad transversal de toda tabla.

### 1.6 Glosario de términos del negocio

Términos que aparecen en este documento y conviene fijar para evitar ambigüedad:

| Término | Definición |
|-|-|
| **Mostrador** | Punto físico donde el cliente se acerca a comprar y retirar. En Santa Teresita hay 1 mostrador. |
| **Delivery** | Modalidad de entrega a domicilio, en cualquiera de sus formas (propio, plataforma). |
| **Delivery propio** | Repartidor del local (Damián) que sale desde el mismo local con el pedido. |
| **DELIVERATE** | Empresa tercera de delivery contratada por el local. Cobra al cliente, retiene el efectivo, lo entrega al local después con descuento de comisión. |
| **Plataformas** | Apps externas: RAPPI, Pedidos YA, Mercado Libre Envíos. El cliente pide por la app, la app cobra (efectivo o tarjeta), un repartidor de la app retira del local. |
| **Local y Web** | Pedidos que entran por canales propios del local: presencial, teléfono, WhatsApp, página web. Distinto de Plataformas. |
| **Sesión** | Turno de venta del día (mañana o tarde). Cada sesión arranca con apertura de caja y termina con cierre. |
| **Cierre de caja** | Acto formal de finalizar una sesión. La encargada (o el cajero con aprobación de la encargada) cuenta el efectivo físico, lo concilia contra lo esperado, y emite un resumen que se manda por mail al dueño y a la encargada. |
| **Ticket no fiscal** | Comprobante interno impreso en térmica que se entrega al cliente. No tiene validez fiscal. La factura fiscal, cuando aplica, es independiente y la maneja la encargada por ARCA. |
| **Comanda** | Ticket impreso destinado a la cocina, con los items del pedido para que cocina los prepare. No lleva precios. |
| **Pedido / venta** | Misma cosa en este documento. Una transacción comercial (cliente → local). |
| **Estado Procesada** | Venta abierta y editable. El cliente todavía no pagó. Se pueden agregar/quitar productos. |
| **Estado Finalizada** | Venta cerrada con pago confirmado. Ya no se puede modificar. |
| **Estado Anulada** | Venta cancelada. Queda en el sistema con motivo y usuario que la anuló. |
| **Modificador** | Atributo configurable de un producto. Ej.: en "Fideos al huevo", el modificador "Forma" tiene opciones (Cinta fina, Cinta media, Cinta ancha, Spaghetti, Fuccile, Foratti, Mostacholes). |
| **Combo / Promo** | Agrupación de productos vendidos como una unidad con precio especial. Ej.: "Promo 4 canelones + salsa + postre". |
| **Recargo de canal** | Sobreprecio que se aplica automáticamente cuando un pedido entra por un canal específico (ej. Pedidos YA tiene un recargo de ~20% sobre el precio base). Cubre la comisión que la plataforma le va a cobrar al local. |
| **Lista de precios** | Conjunto de precios por canal. Cada producto puede tener un precio distinto en Local, en Pedidos YA, en RAPPI, etc. |
| **Cuenta** | Recipiente de plata. Hay 5 hoy: Caja física, Santander, Banco Galicia, Cuenta DNI (BAPRO), MercadoPago. Cada movimiento afecta una o más cuentas. |
| **Cuenta a cobrar** | Plata que ya se "vendió" pero todavía no llegó. Ej.: tarjetas (acreditan en 2–15 días con comisión), DELIVERATE (entrega después con comisión). |
| **Movimiento** | Ingreso o egreso de plata. Tiene cuenta origen / destino, monto, categoría, entidad asociada (empleado, proveedor, etc.) y fecha de cómputo. |
| **Audit log** | Registro append-only de cada acción del sistema. No se modifica nunca. Sirve como caja negra para auditorías futuras. |
| **Sync** | Sincronización bidireccional entre el servidor local y la VPS. Continua, en background, automática. |
| **Aprobación admin** | Mecanismo por el cual los cambios sensibles (ediciones masivas en Excel, cambios de precios) requieren confirmación del admin antes de aplicarse. |
| **Retiro Julio** | Categoría especial de movimiento. Plata que el dueño retira para uso personal. Se distingue de gastos operativos para no falsear el resultado del negocio. |

### 1.7 Volumen y dimensionamiento

Cifras de referencia que el sistema debe soportar:

- **Ventas/día**: 200 (común), 650 (cargado), 2.500 (día fuerte como Día del Padre/Madre, fin de año).
- **Picos**: ~3,5 ventas/minuto en horas de mayor volumen.
- **Concurrencia**: hasta 8 usuarios simultáneos (6 en local + 2 ubicaciones externas).
- **Catálogo**: ~150–250 productos base + ~30 modificadores + ~20 combos/promos (en lugar de 1.673 SKUs aplanados de Innovo).
- **Histórico**: el sistema arranca desde cero. El histórico de Innovo no se migra (no hay acceso a la base de datos por contrato de soporte). Lo que sí se migra es el catálogo de productos (vía Excel pasado por la encargada).
- **Crecimiento esperado**: estable. No hay planes de expansión a sucursales en el horizonte de 12 meses, pero el modelo de datos contempla `local_id` para permitir multi-sucursal sin migraciones futuras.

Una VPS de 4 vCPU / 8 GB RAM / SSD NVMe está holgada para este perfil. Postgres bien indexado maneja >1.000 transacciones/seg con esos recursos; el cuello de botella en la práctica son las consultas mal escritas, no el hardware.

### 1.8 Restricciones operativas a recordar

- **Cortes de luz e internet** son frecuentes en La Plata. El sistema debe seguir operando localmente durante caídas de hasta varias horas y reconciliarse cuando vuelve la conexión.
- **No hay administrador de sistemas en el local.** La encargada y el dueño no son técnicos. Cualquier acción operativa (reiniciar un servicio, cambiar una contraseña, agregar una categoría) tiene que ser hacible desde la UI, no desde una consola.
- **El soporte de Innovo va a seguir activo durante la transición.** El nuevo sistema corre en paralelo a Innovo durante 2–4 semanas hasta validar que no falta nada operativamente. Recién ahí se da de baja Innovo (ahorro: ~USD 180/mes).
- **El bot de WhatsApp es fase 2.** Pero la arquitectura del sistema desde el día uno ya prevé que N8N pueda crear pedidos vía API y disparar impresión automática, así no hay que rehacer nada cuando se incorpore.

---

## Sección 2 — Modelo de productos (catálogo, modificadores, combos, listas de precios)

> **Premisa que enmarca todo lo que sigue**: la estructura del catálogo replica exactamente la hoja **"RESTO SIMPLE"** del Excel `Lista de Precios.xlsx` (Sección 1.5, decisión cerrada). No se inventan categorías ni se reorganizan jerarquías. Lo que hacemos es traducir esa estructura plana de Excel a un modelo de datos relacional con modificadores y combos, eliminando los ~1.673 SKUs aplanados de Innovo y dejando ~150–250 productos base.

### 2.1 Jerarquía del catálogo

```
Categoría
  └── TipoProducto
        └── Producto (vendible)
              └── Modificadores aplicables (0..N grupos)
                    └── Opciones (1..N por grupo)
```

**Categorías** que se modelan en fase 1 (las del Excel):

1. **Pastas frescas** (crudas, para llevar y cocinar en casa)
2. **Porciones calientes** (cocidas, listas para consumir en el local o delivery)
3. **Pizzas** (Grandes e Individuales / Midi)
4. **Tartas** (Grandes e Individuales)
5. **Salsas** (envasadas para llevar)
6. **Empanadas**
7. **Otros** (tapas pascualina, panqueques, tapas de empanada, tapa de lasagna, queso, prepizza)
8. **Picada**

**Categorías futuras (fase 2)**: Helados, Embutidos, Vinos, Fiambres. El modelo ya las soporta sin migración, solo hay que dar de alta los productos cuando lleguen.

### 2.2 Entidades principales

#### 2.2.1 `Categoria`

| Campo | Tipo | Descripción |
|-|-|-|
| `id` | uuid | PK |
| `nombre` | string | "Pastas frescas", "Porciones calientes", etc. |
| `orden` | int | Para ordenar en la UI del cajero |
| `icono` | string nullable | Para el botón de la UI del cajero |
| `activa` | bool | Soft-delete |

#### 2.2.2 `TipoProducto`

| Campo | Tipo | Descripción |
|-|-|-|
| `id` | uuid | PK |
| `categoria_id` | uuid FK | A `Categoria` |
| `nombre` | string | "Ravioles", "Sorrentinos", "Pizza Grande", etc. |
| `descripcion` | string nullable | "Cada plancha trae 48 ravioles", "Se calculan 6 sorrentinos por porción" |
| `cocina_interviene` | bool | Si es **true**, vender este producto dispara la impresión de comanda (Sección 8). Para "Sorrentinos crudos" = false; para "Sorrentinos porción simple" = true. |
| `orden` | int | Orden dentro de su categoría |
| `activo` | bool | |

#### 2.2.3 `Producto`

| Campo | Tipo | Descripción |
|-|-|-|
| `id` | uuid | PK |
| `tipo_producto_id` | uuid FK | A `TipoProducto` |
| `nombre` | string | "Sorrentinos" (heredan el nombre del tipo si no se sobreescribe), o "Sorrentinos de Salmón" cuando es producto distinto. |
| `forma_venta` | enum | `UNIDAD` / `GRAMO` / `PLANCHA` / `PORCION` |
| `precio_base` | decimal | Precio en pesos para el canal Local. Otras listas de precios se calculan o sobreescriben (Sección 2.5). |
| `unidad_precio` | enum | `POR_UNIDAD` / `POR_GRAMO` / `POR_KILO` / `POR_PORCION` / `POR_PLANCHA`. Define cómo se interpreta `precio_base`. |
| `cantidad_default` | decimal nullable | Cantidad sugerida al cargar (ej. fideos suelen pedir 200g, lo precarga) |
| `descripcion` | string nullable | Descripción adicional opcional (ingredientes, etc.) |
| `imagen_url` | string nullable | Para la UI del cajero (touch en imagen para agregar) |
| `codigo` | string nullable | Código corto opcional para búsqueda rápida del cajero |
| `activo` | bool | |

#### 2.2.4 `GrupoModificador`

Un grupo agrupa opciones que se eligen juntas. Ej.: el grupo "Sabor de sorrentinos" tiene 7 opciones; el cajero elige 1.

| Campo | Tipo | Descripción |
|-|-|-|
| `id` | uuid | PK |
| `nombre` | string | "Sabor", "Forma", "Tamaño", "Relleno" |
| `tipo_seleccion` | enum | `UNICA` (radio) / `MULTIPLE` (checkbox) |
| `obligatorio` | bool | Si true, el cajero debe elegir antes de finalizar la línea |
| `min_opciones` | int | Mínimo de opciones a elegir (si MULTIPLE) |
| `max_opciones` | int | Máximo de opciones a elegir (si MULTIPLE) |

#### 2.2.5 `OpcionModificador`

| Campo | Tipo | Descripción |
|-|-|-|
| `id` | uuid | PK |
| `grupo_id` | uuid FK | A `GrupoModificador` |
| `nombre` | string | "Verdura", "Cinta fina", "Roquefort", "Caprese", etc. |
| `delta_precio` | decimal | Diferencia respecto al precio base del producto. Default 0. Ej. "Salmón" en sorrentinos = +21.500. |
| `activa` | bool | |
| `orden` | int | |

#### 2.2.6 `ModificadorAplicable`

Tabla intermedia que define qué grupos de modificadores se aplican a qué productos (o a qué tipos de producto, para herencia masiva).

| Campo | Tipo | Descripción |
|-|-|-|
| `id` | uuid | PK |
| `grupo_modificador_id` | uuid FK | |
| `tipo_producto_id` | uuid FK nullable | Si está set, el grupo aplica a todos los productos de ese tipo |
| `producto_id` | uuid FK nullable | Si está set, el grupo aplica solo a ese producto específico |
| `obligatorio_override` | bool nullable | Permite forzar obligatoriedad solo en este contexto |

> Solo uno de `tipo_producto_id` o `producto_id` debe estar set por fila.

### 2.3 Modificadores — ejemplos concretos del catálogo real

#### Ejemplo 1: Fideos al huevo

```
Producto: "Fideos al huevo"
  forma_venta: GRAMO
  unidad_precio: POR_KILO  (valor: $13.000/kg)
  cantidad_default: 200 (gramos)
  
  Grupos aplicables:
    - "Forma" (UNICA, obligatorio)
        Opciones (todas con delta 0):
          - Cinta fina
          - Cinta media
          - Cinta ancha
          - Spaghetti
          - Fuccile
          - Foratti
          - Mostacholes
```

#### Ejemplo 2: Sorrentinos clásicos

```
Producto: "Sorrentinos"
  forma_venta: UNIDAD
  unidad_precio: POR_DOCENA (valor: $23.500 por docena — TBD confirmar)
  cantidad_default: 6 (media docena)
  
  Grupos aplicables:
    - "Relleno" (UNICA, obligatorio)
        Opciones (todas con delta 0):
          - Ricotta, Muzzarella y Jamón
          - Calabaza y Muzzarella
          - Caprese (Ricota, Muzzarella, Cherry y Albahaca)
          - Cipollino (Ricota, Muzz, Jamón y Verdeo)
          - Verdura, Jamón y Muzzarella
          - Roquefort, Muzz, Ricota y Nuez
          - Muzzarella, Ricota y Nuez

Producto separado: "Sorrentinos de Salmón"
  forma_venta: UNIDAD
  precio_base: $45.000
  Razón de ser producto separado: precio mucho mayor + ingrediente diferente
```

#### Ejemplo 3: Ñoquis de sémola

```
Producto: "Ñoquis de sémola"
  forma_venta: GRAMO
  unidad_precio: POR_KILO (valor: $13.900/kg)
  cantidad_default: 300 (gramos)
  
  Grupos aplicables:
    - "Sabor" (UNICA, obligatorio)
        Opciones (todas con delta 0, excepto Tricolor y Mixtos que pueden tener delta TBD):
          - Papa
          - Ricota
          - Espinaca
          - Remolacha
          - Calabaza
          - Morrón
          - Tricolor (papa + ricota + espinaca)
          - Mixtos (todos)
```

#### Ejemplo 4: Pizzas

```
Producto: "Pizza Grande"
  forma_venta: UNIDAD
  unidad_precio: POR_UNIDAD
  precio_base: variable según sabor (ver más abajo)

  Grupos aplicables:
    - "Sabor" (UNICA, obligatorio)
        Opciones:
          - Muzzarella       delta_precio: 0      (precio_base = $11.700)
          - Especial         delta_precio: +600   (= $12.300)
          - Gourmet          delta_precio: +1.100 (= $12.800)
          - Napolitana       delta_precio: TBD
          - Fugazzetta       delta_precio: TBD
          - Caprese          delta_precio: TBD
          - Rúcula y panceta delta_precio: TBD
```

> Nota: el Excel actual tiene precios distintos por sabor para Especial/Muzz/Gourmet pero no muestra Napolitana/Fugazzetta/Caprese/Rúcula con precio. Pendiente: confirmar precios de los sabores que faltan.

#### Ejemplo 5: Porciones calientes — Simple vs Especial

En el Excel hay dos versiones de cada porción caliente: "Simple" y "Especial". Ej. "Ravioles simple porción" $13.800 vs "Ravioles especial porción" $14.900.

**Decisión propuesta**: Simple y Especial son **TipoProducto** distintos dentro de la categoría "Porciones calientes":
- "Ravioles porción simple"
- "Ravioles porción especial"

Cada uno con su propio modificador "Relleno" con las mismas opciones que en Pastas frescas. La diferencia entre Simple y Especial **TBD** — tengo que confirmar con vos: ¿es la cantidad de pasta? ¿La salsa incluida? ¿La presentación?

### 2.4 Combos y promos

#### 2.4.1 Modelo

```
Combo
  ├── id
  ├── nombre               "Promo 4 canelones + salsa + postre"
  ├── precio_combo         (precio del combo, no necesariamente la suma de componentes)
  ├── vigencia_desde       date nullable
  ├── vigencia_hasta       date nullable
  ├── canales_aplicables   array de Canal (Local, Pedidos YA, RAPPI, etc.)
  ├── activo
  └── ComponenteCombo[]
        ├── id
        ├── combo_id
        ├── tipo: PRODUCTO_FIJO | OPCION_ENTRE_VARIOS
        ├── cantidad
        ├── producto_id           (si tipo = PRODUCTO_FIJO)
        └── productos_opciones[]  (si tipo = OPCION_ENTRE_VARIOS)
```

#### 2.4.2 Ejemplos concretos del Excel

**Combo 1: "Promo 4 canelones + salsa + postre"** (componentes fijos parcialmente)
- Componente 1: Canelones (a elegir entre J&Q / Verdura / Verdura y Carne) × 4 → `OPCION_ENTRE_VARIOS`
- Componente 2: Salsa (a elegir entre las 10 salsas) × 1 → `OPCION_ENTRE_VARIOS`
- Componente 3: Postre (a elegir entre los postres disponibles) × 1 → `OPCION_ENTRE_VARIOS`

**Combo 2: "Promo Pizza + 8 Empanadas"**
- Componente 1: Pizza (a elegir entre los sabores) × 1 → `OPCION_ENTRE_VARIOS`
- Componente 2: Empanadas (a elegir entre los sabores) × 8 → `OPCION_ENTRE_VARIOS`

**Combo 3: "PROMO 24 Sorrentinos + Postre"**
- Componente 1: Sorrentinos (a elegir entre rellenos clásicos) × 24 → `OPCION_ENTRE_VARIOS`
- Componente 2: Postre × 1 → `OPCION_ENTRE_VARIOS`

**Combo 4: "PROMO 1 Kg Fideos + 2 Salsas + 1 Queso"** (visto en ticket de delivery)
- Componente 1: Fideos al huevo × 1000g → `PRODUCTO_FIJO` con cantidad fija
- Componente 2: Salsa × 2 → `OPCION_ENTRE_VARIOS`
- Componente 3: Queso (la unidad de "queso" del Excel "Otros") × 1 → `PRODUCTO_FIJO`

#### 2.4.3 Comportamiento en la UI del cajero

Cuando el cajero selecciona un combo:
1. Ve el nombre del combo y el precio total.
2. Si tiene componentes con `OPCION_ENTRE_VARIOS`, la UI le pregunta secuencialmente "¿Qué canelones?" "¿Qué salsa?" "¿Qué postre?" hasta completar.
3. Cada componente seleccionado entra a la venta como una línea separada (con su nombre, cantidad y un marcador de "parte del combo X"). Eso permite que la cocina sepa qué preparar.
4. El precio del combo se aplica como descuento implícito (la suma de los componentes "individualmente" sería mayor que el precio del combo).

#### 2.4.4 Combos vs. Productos individuales — regla de modelado

Un agrupamiento es Combo cuando:
- Tiene un nombre comercial propio ("Promo 4 canelones + salsa + postre").
- Tiene un precio **distinto** a la suma de sus componentes.
- Tiene componentes que pueden variar (cliente elige el sabor).

Un agrupamiento NO es Combo (es producto individual con modificador) cuando:
- Es solo un producto con variantes (ej. "Pizza Especial" no es un combo, es un producto con modificador "Sabor = Especial").

### 2.5 Listas de precios por canal

#### 2.5.1 Canales modelados

| Canal | Tipo de cobro | % default sobre precio Local | Notas |
|-|-|-|-|
| **Local mostrador** | Efectivo / Tarjeta / MP / Transferencia | 0% (precio base) | Precio de referencia |
| **Local web** (cuando exista) | Efectivo / Tarjeta | 0% | Confirmar |
| **WhatsApp / teléfono** | Efectivo / Tarjeta / MP / Transferencia | 0% | Toma pedidos como mostrador, sale por delivery propio o retiro |
| **RAPPI** | Pago en plataforma | TBD (esperando alta partner) | El % cubre la comisión que cobra RAPPI al local |
| **Pedidos YA** | Pago en plataforma | ~20% confirmado | Ratio real medido en el Excel: 1,185 a 1,203 |
| **Mercado Libre** | Pago en plataforma | TBD | |
| **DELIVERATE** | DELIVERATE cobra al cliente | TBD | Empresa tercera |
| **Mayorista** (futuro) | A definir | -X% (descuento, opcional) | Para clientes que compran en cantidad |

#### 2.5.2 Modelo

```
ListaPrecios
  ├── id
  ├── nombre              "Local", "Pedidos YA", "RAPPI", etc.
  ├── canal_default       enum (mismo que la tabla anterior)
  ├── ajuste_pct_default  decimal (% sobre precio_base — puede ser negativo)
  ├── activa
  └── moneda              ARS por default

PrecioPorLista (override por producto)
  ├── id
  ├── producto_id
  ├── lista_id
  ├── precio_efectivo     decimal (sobre-escribe el cálculo del % default)
  ├── vigencia_desde      timestamp
  ├── vigencia_hasta      timestamp nullable
  └── usuario_id          (quién lo cargó, para audit)
```

**Regla de cálculo**: cuando una venta entra por canal X, para cada producto el sistema busca:
1. Si existe `PrecioPorLista` con `vigencia_desde <= hoy` y (`vigencia_hasta` nulo o `>= hoy`), usa ese precio.
2. Si no existe, usa `producto.precio_base × (1 + lista.ajuste_pct_default)`.

Esto da flexibilidad: para Pedidos YA podemos cargar manualmente el precio publicado por producto (porque el ratio no es exactamente 20%), y para RAPPI podemos arrancar con un % global y refinar después.

#### 2.5.3 Historial de precios

```
HistorialPrecio
  ├── id
  ├── producto_id
  ├── lista_id            (si fue cambio en una lista específica)
  ├── precio_anterior
  ├── precio_nuevo
  ├── fecha_cambio        timestamp
  ├── usuario_id
  └── motivo              text nullable ("Aumento general 3%", "Ajuste por inflación", etc.)
```

Para reportes "¿cuánto subió el precio de la mozzarella en los últimos 6 meses?" o "¿cuándo se actualizó el precio de los sorrentinos?".

### 2.6 Forma de venta y unidad de precio

Esta es la parte que más ojo necesita porque el Excel es ambiguo. Hago una propuesta y dejo TBD las dudas para que vos confirmes con la encargada.

#### 2.6.1 Combinaciones soportadas

| `forma_venta` | `unidad_precio` | Ejemplo | Cómo se carga en el cajero |
|-|-|-|-|
| `GRAMO` | `POR_KILO` | Fideos al huevo $13.000/kg | Cajero ingresa peso en gramos. Sistema calcula: precio = peso/1000 × precio_kilo |
| `GRAMO` | `POR_GRAMO` | Ñoquis $13,9/g (visto en ticket) | Cajero ingresa peso. Sistema: precio = peso × precio_gramo |
| `UNIDAD` | `POR_UNIDAD` | Canelones $3.800/unidad | Cajero ingresa cantidad. Sistema: precio = cantidad × precio_unidad |
| `UNIDAD` | `POR_DOCENA` | Sorrentinos (TBD si es así) | Cajero ingresa cantidad de docenas. Sistema: precio = docenas × precio_docena |
| `PLANCHA` | `POR_PLANCHA` | Ravioles crudos (1 plancha = 48 ravioles) | Cajero elige cuántas planchas |
| `PORCION` | `POR_PORCION` | Porciones calientes | Cajero elige cuántas porciones |

#### 2.6.2 TBD que necesito que confirmes con la encargada

- **Sorrentinos**: ¿el precio del Excel ($23.500) es por kilo, por docena, por unidad? ¿Cómo los carga el cajero hoy en Innovo? El ticket vimos "380 Sorrentinos × $23,5" lo cual sugiere $23,5 por sorrentino unitario (no por docena). Pero entonces $23.500 del Excel sería 1.000 sorrentinos, lo cual no tiene sentido. Hay algo raro. Probablemente el precio del Excel está en otra unidad. **Confirmar.**
- **Ravioles**: ¿se venden por plancha (48 ravioles) o también por unidad / porción? Si solo por plancha, simplificamos.
- **Lasagna / Rondelli / Canelones**: ¿se venden por unidad, por porción individual, por bandeja? El precio del Excel ($23.500 lasagna, $3.800 canelones) sugiere unidades muy distintas.
- **Pizzas**: ¿hay variantes de tamaño (Grande, Midi, Individual)? El Excel tiene "Pizza Grande" y "Midi Pizza" — son dos productos separados con sabores compartidos. Lo modelamos así por defecto.

### 2.7 Cocina interviene — disparador de impresión de comanda

El campo `cocina_interviene` (bool) en `TipoProducto` decide si vender ese producto dispara la impresión de comanda en cocina (Sección 8). La regla:

- **Productos crudos / ya listos para llevar** → `cocina_interviene = false`. Ej.: Pastas frescas crudas, salsas envasadas, empanadas (si ya están hechas), tartas (si ya están hechas), etc.
- **Productos que se preparan al momento** → `cocina_interviene = true`. Ej.: Porciones calientes (cualquiera), pizzas que se hornean al momento (si aplica), cualquier producto con cocción al momento.

**Regla a nivel venta**: si **al menos uno** de los items de la venta tiene `cocina_interviene = true`, se imprime comanda al pasar la venta a estado Procesada. Si **ninguno** de los items la tiene, no se imprime comanda — solo el ticket cliente al cobrar (Sección 8).

### 2.8 Stock — modelado pero no implementado en fase 1

El modelo de datos contempla stock para futuro, pero **fase 1 no controla stock**:

```
Stock
  ├── producto_id
  ├── cantidad_actual
  ├── unidad              (gramos, unidades, planchas)
  ├── stock_minimo        (alerta cuando baja)
  └── ultima_actualizacion
```

Razones para diferir:
- El user explicitó que stock no es prioritario.
- Implementar stock de productos terminados requiere recetas (qué insumos consume cada producto), y eso es un módulo aparte que demanda mucho input de la encargada.
- Implementar stock de insumos (materia prima) requiere conciliar con compras automatizadas de N8N — flujo cruzado complejo.

Cuando quieran activar stock, se puebla la tabla y se prenden los flags de descuento automático en cada venta.

### 2.9 Migración del catálogo desde el Excel "RESTO SIMPLE"

Plan de carga inicial:

1. **Parser automático del Excel "RESTO SIMPLE"**: un script Python lee la hoja, identifica jerarquía (categoría → tipo → variantes), y emite un seed SQL con productos y modificadores estructurados.
2. **Parser de la hoja "Hoja 1"**: extrae los precios actuales (16/04/2026) y los carga como `precio_base` en cada producto.
3. **Parser de la hoja "Pedidos YA"**: extrae precios efectivos publicados en Pedidos YA y los carga como `PrecioPorLista` para esa lista.
4. **Revisión humana**: la encargada (o vos) revisa el resultado del parser en una UI especial de "carga inicial" antes de confirmar y dejar el catálogo en producción.
5. **Helados / embutidos / vinos / fiambres** (fase 2): se cargan manualmente cuando lleguen las listas.

### 2.10 Pendientes y supuestos de esta sección

| # | Pendiente | A confirmar con |
|-|-|-|
| 2.10.1 | Sorrentinos: precio del Excel ¿es por kilo / docena / unidad? | Encargada |
| 2.10.2 | Ravioles: ¿venden por plancha solamente, o también por unidad? | Encargada |
| 2.10.3 | Lasagna / Rondelli / Canelones: unidad de venta exacta | Encargada |
| 2.10.4 | Porciones Simple vs Especial: qué cambia (cantidad, salsa incluida, presentación) | Encargada |
| 2.10.5 | Combo "Mixtos" en Ñoquis: ¿precio igual al base o tiene delta? | Encargada |
| 2.10.6 | Sabores de Pizza con precio TBD (Napolitana, Fugazzetta, Caprese, Rúcula y panceta) | Excel actualizado o encargada |
| 2.10.7 | Recargo % por canal para RAPPI / MELI / DELIVERATE | A obtener cuando llegue el alta de partner |
| 2.10.8 | Lista de combos / promos vigentes hoy | Encargada — pasar lista completa con sus componentes y precios |
| 2.10.9 | ¿Existe lista mayorista? ¿Cuáles son los descuentos típicos? | Dueño |

---

## Sección 3 — Modelo de caja (cuentas, movimientos, fórmula de cierre)

> **Premisa que enmarca esta sección**: el modelo contable interno reemplaza el workaround "Aporte Banco" de Innovo (Sección 1.2, principio 4 — trazabilidad total) modelando cuentas separadas. El **diseño detallado de cómo se separan las cuentas** está en pausa hasta que el dueño defina sus preferencias (Sección 1.5, decisión cerrada). Esta sección define la **estructura técnica** del modelo, agnóstica al diseño final del dueño — cuando él decida, llenamos los huecos sin tocar el modelo.

### 3.1 Cuentas

#### 3.1.1 Cuentas con saldo real (5)

Cada una es un "recipiente de plata" físico o virtual. El sistema lleva su saldo al instante.

| Cuenta | Tipo | Cómo se actualiza | Notas |
|-|-|-|-|
| **Caja física** | Efectivo en local | Cada venta cash, cada egreso cash, cada movimiento manual | Una sola caja física, compartida entre turnos |
| **Santander** | Cuenta corriente bancaria | Belvo (saldo en vivo) + import de extracto manual como respaldo | |
| **Banco Galicia** | Cuenta corriente bancaria | Belvo + import manual | |
| **Cuenta DNI** (BAPRO) | Wallet / cuenta digital | Import manual (Belvo a confirmar cobertura) | App de Banco Provincia |
| **MercadoPago** | Wallet | API directa de MP (gratuita, en vivo) | Saldo + movimientos al detalle |

**Modelo de datos**:

```
Cuenta
  ├── id
  ├── nombre               "Caja física", "Santander", "Galicia", "Cuenta DNI", "MercadoPago"
  ├── tipo                 enum: EFECTIVO | BANCO | WALLET
  ├── banco                string nullable  ("Santander", "Galicia", etc.)
  ├── cbu_cvu              string nullable
  ├── alias                string nullable
  ├── moneda               default "ARS"
  ├── saldo_actual         decimal (calculado)
  ├── metodo_actualizacion enum: MANUAL | API_MP | BELVO | IMPORT_EXTRACTO
  ├── ultima_conciliacion  timestamp nullable
  ├── comision_mensual     decimal nullable  (mantenimiento de cuenta, gasto recurrente)
  └── activa
```

#### 3.1.2 Cuentas transitorias (a cobrar)

Plata que ya se "vendió" pero todavía no llegó. **No** entran al saldo de caja física hasta que se liquidan.

| Cuenta transitoria | De qué viene | Plazo típico | Comisión |
|-|-|-|-|
| **Tarjeta Débito (por banco)** | Cobros con débito en mostrador o delivery propio | ~2 días hábiles | ~1,5–2,5% + IVA |
| **Tarjeta Crédito 1 pago (por banco)** | Cobros con crédito 1 pago | ~15–18 días hábiles | ~2–3% + IVA |
| **Tarjeta Crédito en cuotas** | Cobros con crédito en cuotas | Mensual por cuota | ~3–6% + IVA |
| **DELIVERATE** | Ventas cobradas por DELIVERATE (efectivo o tarjeta del cliente que ellos retienen) | A definir (consultar a la encargada) | A definir |
| **RAPPI** | Ventas RAPPI (cobradas por la app) | Liquidación periódica de RAPPI | ~30% del valor del pedido |
| **Pedidos YA** | Ventas Pedidos YA | Liquidación periódica | ~22–32% |
| **Mercado Libre** | Ventas MELI | Liquidación periódica | ~13–18% |

**Modelo de datos**:

```
CuentaACobrar
  ├── id
  ├── nombre               "Tarjeta Débito Galicia", "DELIVERATE", "Pedidos YA", etc.
  ├── tipo                 enum: TARJETA_DEBITO | TARJETA_CREDITO | TARJETA_CUOTAS | PLATAFORMA_DELIVERY | EMPRESA_DELIVERY
  ├── cuenta_destino_id    FK a Cuenta  (a qué cuenta liquida cuando llega la plata)
  ├── plazo_dias           int  (estimado, para mostrar "se acreditará el día X")
  ├── comision_pct         decimal  (porcentaje sobre el bruto, configurable)
  ├── saldo_pendiente      decimal (calculado: lo que está esperando liquidar)
  └── activa

LiquidacionPendiente
  ├── id
  ├── cuenta_a_cobrar_id   FK
  ├── venta_id             FK nullable (si es de una venta específica)
  ├── monto_bruto          decimal
  ├── comision_estimada    decimal
  ├── monto_neto_esperado  decimal
  ├── fecha_acreditacion_esperada  date
  ├── estado               enum: PENDIENTE | LIQUIDADA | ANULADA
  ├── fecha_liquidacion_real  timestamp nullable
  ├── monto_liquidado_real    decimal nullable
  └── diferencia              decimal nullable  (real vs estimado, para análisis de comisión efectiva)
```

#### 3.1.3 Vinculación entre cuenta a cobrar y cuenta destino

Ejemplo: el posnet Santander cobra con débito → la liquidación cae en cuenta Santander en 2 días → la `CuentaACobrar` "Tarjeta Débito Santander" tiene `cuenta_destino_id` apuntando a la Cuenta "Santander". Cuando se concilia, el saldo pendiente baja y el saldo de Santander sube por el monto neto.

### 3.2 Movimientos

Cada `Movimiento` es la unidad atómica de cualquier cosa que afecte saldo de cuenta(s). Siempre tiene cuenta origen y/o destino.

#### 3.2.1 Tipos

| Tipo | Cuenta origen | Cuenta destino | Ejemplo |
|-|-|-|-|
| `INGRESO` | (nada) | una cuenta | Venta cobrada en efectivo → entra a Caja física |
| `EGRESO` | una cuenta | (nada) | Pago de luz desde Galicia |
| `TRANSFERENCIA_INTERNA` | una cuenta | otra cuenta | Encargada saca $500.000 de Santander y los pone en Caja física |
| `LIQUIDACION` | una `CuentaACobrar` | una cuenta | Tarjeta liquida → la cuenta a cobrar baja, Santander sube por monto neto |
| `AJUSTE` | (nada o cuenta) | (nada o cuenta) | Diferencia de caja, error contable corregido |

#### 3.2.2 Modelo

```
Movimiento
  ├── id
  ├── tipo                  enum (ver arriba)
  ├── monto                 decimal
  ├── moneda                "ARS"
  ├── cuenta_origen_id      FK Cuenta nullable
  ├── cuenta_destino_id     FK Cuenta nullable
  ├── cuenta_a_cobrar_id    FK CuentaACobrar nullable  (para LIQUIDACION)
  ├── categoria_id          FK CategoriaMovimiento
  ├── entidad_id            FK Entidad nullable  (empleado, proveedor, etc.)
  ├── venta_id              FK Venta nullable  (si proviene de una venta)
  ├── factura_id            FK Factura nullable  (si proviene de pagar una factura)
  ├── fecha_computo         timestamp  (cuándo lo cuenta el negocio — puede no ser hoy)
  ├── fecha_alta            timestamp  (cuándo se cargó en el sistema)
  ├── fecha_vencimiento     timestamp nullable  (para movimientos pendientes)
  ├── estado                enum: PENDIENTE | CONFIRMADO | ANULADO
  ├── observacion           text nullable
  ├── usuario_id            FK Usuario  (quién lo cargó)
  ├── sesion_caja_id        FK SesionCaja nullable  (si fue en una sesión de caja específica)
  └── adicionales[]         (campo flexible para datos extra: nro de cheque, banco, sucursal, etc.)
```

#### 3.2.3 Estados

- `PENDIENTE`: cargado pero no confirmado. Ej.: factura recibida que todavía no se pagó. Aparece en deudas pero no descuenta saldo.
- `CONFIRMADO`: ejecutado, afecta saldos. Default.
- `ANULADO`: revertido. Queda en histórico, no afecta saldo.

#### 3.2.4 Categorías de movimientos

Las categorías son **abiertas y extensibles**. La encargada puede crear nuevas desde la UI (Sección 1.5, decisión cerrada).

**Categorías base que vienen pre-cargadas:**

| Categoría | Tipo | Uso |
|-|-|-|
| Venta mostrador | INGRESO | Venta presencial |
| Venta delivery propio | INGRESO | Venta atendida por Damian |
| Venta DELIVERATE | INGRESO | Venta por la empresa tercera |
| Venta plataforma | INGRESO | RAPPI, Pedidos YA, MELI (subcategoría con el canal) |
| Otros ingresos | INGRESO | Para ingresos no de venta (devoluciones, premios, ventas de activos, etc.) |
| Sueldos | EGRESO | Sueldos del personal |
| Adelanto a empleado | EGRESO | Adelanto que se descuenta de sueldo |
| Comisiones (motoqueros, vinos) | EGRESO | Pagos por comisión |
| Insumos (compras a proveedores) | EGRESO | Compra de mercadería / insumos |
| Servicios | EGRESO | Luz, gas, teléfono, internet, etc. |
| Mantenimiento | EGRESO | Arreglos, repuestos, equipamiento |
| Impuestos y tasas | EGRESO | Monotributo, ARBA, ABL, etc. |
| Gastos financieros | EGRESO | Mantenimiento de cuenta, comisiones bancarias |
| Publicidad | EGRESO | Marketing |
| Movilidad | EGRESO | Combustible, transporte |
| **Retiro Julio** | EGRESO | Plata que retira el dueño para uso personal. **No** es gasto operativo — se contabiliza aparte para no falsear el resultado del negocio (Sección 1.5, decisión cerrada) |
| **Diferencia de caja** | INGRESO o EGRESO | Cuando lo contado al cierre no coincide con lo esperado |
| Transferencia interna | TRANSFERENCIA_INTERNA | Movimiento de plata entre cuentas (no es ingreso ni egreso real) |
| Extraordinario / Sin categoría | INGRESO o EGRESO | Comodín para movimientos que no encajan |

**Modelo**:

```
CategoriaMovimiento
  ├── id
  ├── nombre
  ├── tipo                 enum: INGRESO | EGRESO | TRANSFERENCIA | AMBOS
  ├── es_sistema           bool  (las categorías base no se pueden borrar; las creadas por el user sí)
  ├── es_operativa         bool  (false para "Retiro Julio" — no entra al cálculo de resultado operativo)
  ├── orden                int
  └── activa               bool
```

#### 3.2.5 Categoría obsoleta: "Aporte Banco"

En Innovo había una categoría "Aporte Banco" para neutralizar pagos hechos desde el banco (Sección 1.6, glosario). **En el sistema nuevo esta categoría no existe** porque las cuentas separadas eliminan la necesidad del workaround. Si la encargada pagó una factura desde Galicia, el sistema sabe que la plata salió de Galicia (no de la caja física), entonces la caja física no se afecta — y no hace falta inventar un aporte ficticio.

Si la encargada al migrar quiere preservar el histórico, lo dejamos como categoría legacy de solo lectura, marcada como "no usar — workaround Innovo, ya no aplica".

### 3.3 Pagos asociados a movimientos

Un mismo movimiento puede tener uno o varios "pagos" (ej. una factura que se paga 50% en efectivo + 50% transferencia). Replica la estructura que vimos en el modal de Innovo (Sección "Movimientos de entidad" / "Movimiento económico genérico").

```
Pago
  ├── id
  ├── movimiento_id          FK Movimiento
  ├── metodo                 enum: EFECTIVO | DEBITO | CREDITO_1_PAGO | CREDITO_CUOTAS | TRANSFERENCIA | DEPOSITO | MERCADOPAGO_QR | CHEQUE | TARJETA_NARANJA | OTRO
  ├── cuenta_id              FK Cuenta (de qué cuenta sale o entra el efectivo correspondiente)
  ├── cuenta_a_cobrar_id     FK CuentaACobrar nullable (si genera una a cobrar — ej. tarjeta crédito)
  ├── monto                  decimal
  ├── cambio_dado            decimal default 0  (si pagó con efectivo y dieron cambio)
  ├── retenido               decimal default 0  (retención impositiva si aplica)
  ├── numero_referencia      string nullable  (nro de cheque, número de operación bancaria, etc.)
  ├── titular                string nullable  (titular del cheque o tarjeta)
  ├── banco                  string nullable
  ├── tarjeta_ultimos4       string nullable
  ├── posnet_id              FK Posnet nullable
  ├── estado                 enum: PENDIENTE | CONFIRMADO | ANULADO
  └── fecha                  timestamp
```

#### 3.3.1 Posnets

Cada posnet físico está vinculado a una cuenta destino. Cuando se cobra con tarjeta por un posnet, el sistema sabe a qué `CuentaACobrar` va.

```
Posnet
  ├── id
  ├── nombre                 "Posnet Santander mostrador", "Posnet MP móvil", etc.
  ├── marca                  "Lapos", "Mercado Pago Point", "Naranja", "Visa Posnet", etc.
  ├── modelo                 string nullable
  ├── adquirente             "Prisma", "Fiserv", "Mercado Pago", "Cabal", etc.
  ├── cuenta_a_cobrar_debito_id    FK CuentaACobrar
  ├── cuenta_a_cobrar_credito_id   FK CuentaACobrar
  ├── cuenta_destino_id      FK Cuenta  (a qué cuenta liquida)
  ├── ubicacion              "Mostrador" | "Móvil delivery" | etc.
  ├── soporta_integracion    bool  (si el modelo tiene API y se integra al sistema, false por default)
  └── activo
```

> Modelos exactos de los posnets actuales: pendientes (Sección 12). Por defecto se asume `soporta_integracion = false`, lo que implica que el cajero confirma manualmente cada cobro con tarjeta.

### 3.4 Comisiones y plazos de acreditación

Cada `CuentaACobrar` tiene `comision_pct` y `plazo_dias` configurables. Cuando se carga una venta con un método de pago que entra ahí, el sistema:

1. Crea una `LiquidacionPendiente` con `monto_bruto` = lo que cobró, `comision_estimada` = bruto × comision_pct, `monto_neto_esperado` = bruto − comisión, `fecha_acreditacion_esperada` = hoy + plazo_dias.
2. Esa liquidación pendiente sube el `saldo_pendiente` de la cuenta a cobrar.
3. Cuando llega el extracto bancario o la API de MP/Belvo confirma la acreditación (Sección 10), se concilia: la liquidación pasa a `LIQUIDADA`, baja del saldo pendiente, y entra al saldo de la cuenta destino con el monto **real** (no el estimado).
4. Si hay diferencia entre estimado y real, queda registrada — sirve para ajustar el `comision_pct` configurado si está mal calibrado.

### 3.5 Sesión de caja (turno)

Una `SesionCaja` representa un turno completo (mañana o tarde). Es independiente del calendario — un día tiene 2 sesiones.

```
SesionCaja
  ├── id
  ├── fecha                date
  ├── turno                enum: MAÑANA | TARDE
  ├── horario_apertura     timestamp
  ├── horario_cierre       timestamp nullable
  ├── existencia_inicial   decimal  (efectivo en caja al abrir)
  ├── existencia_final     decimal nullable  (efectivo en caja al cerrar — contado físicamente)
  ├── recaudacion_esperada decimal  (calculada por el sistema según movimientos del turno)
  ├── diferencia           decimal nullable  (existencia_final − existencia_esperada)
  ├── usuario_apertura_id  FK Usuario
  ├── usuario_cierre_id    FK Usuario nullable
  ├── aprobada_por_admin   bool default false
  ├── aprobada_admin_id    FK Usuario nullable
  ├── estado               enum: ABIERTA | CERRADA | APROBADA
  ├── observaciones        text nullable
  └── email_enviado_a      text  (lista de mails que recibieron el resumen)
```

#### 3.5.1 Apertura

- El primer cajero del turno abre la sesión. Cuenta el efectivo físico que recibió y lo declara como `existencia_inicial`.
- Si la sesión anterior dejó efectivo, ese es el punto de partida (pero NO se suma automáticamente al cierre — Sección 3.6).
- Apertura no requiere aprobación.

#### 3.5.2 Operación

- Durante el turno, todas las ventas y movimientos del turno se asocian a esa `SesionCaja` (campo `sesion_caja_id` en `Movimiento`).
- En cualquier momento la encargada puede ver "Recaudación parcial del turno actual".

#### 3.5.3 Cierre

Flujo de cierre:

1. El cajero (o encargada) inicia el cierre del turno.
2. El sistema calcula la **recaudación esperada en efectivo** según los movimientos del turno (Sección 3.6).
3. El cajero cuenta el efectivo físico de la caja y lo ingresa como `existencia_final`.
4. El sistema calcula `diferencia = existencia_final − existencia_esperada`.
5. Si la diferencia es ≠ 0, se genera automáticamente un `Movimiento` de tipo "Diferencia de caja" (signo según corresponda) para que los saldos cuadren.
6. La sesión queda en estado `CERRADA`. Pendiente de aprobación.
7. **Aprobación admin**: la encargada (o el dueño) revisa el cierre y lo aprueba. Solo ahí pasa a `APROBADA`. Esto es el "autorización del administrador general" original.
8. Al aprobar, se dispara el envío de **email del resumen** a las direcciones configuradas (dueño, encargada, contador si lo quieren).

#### 3.5.4 Resumen email

Mismo formato que hoy emite Innovo, replicando el flujo del Miro corregido (Sección 3.6). Asunto: `[Santa Teresita] Cierre caja [TURNO] - [FECHA]`.

### 3.6 Fórmula de cierre detallada

Esta es la fórmula que el sistema calcula y envía por mail al cierre de cada turno. Replica el Miro corregido.

```
═══════════════════════════════════════════════════════════════════
RESUMEN CIERRE DE CAJA — TURNO [MAÑANA/TARDE] — [FECHA]
═══════════════════════════════════════════════════════════════════

╔═══════════════════════════════════╗
║  VENTAS MOSTRADOR                 ║
╠═══════════════════════════════════╣
║  Débito          $ X              ║
║  Crédito         $ X              ║
║  Efectivo        $ X              ║
║  ──────────────────               ║
║  Total mostrador $ X              ║
╚═══════════════════════════════════╝

╔═══════════════════════════════════════════════════╗
║  VENTAS DELIVERY                                  ║
╠═══════════════════════════════════════════════════╣
║  Local y Web (delivery propio: Damián + Deliverate) ║
║    Tarjeta              $ X                       ║
║    Efectivo Damián      $ X                       ║
║    Efectivo Deliverate  $ X  *(no entra a caja)*  ║
║    ────────────────                               ║
║    Subtotal local y web $ X                       ║
║                                                    ║
║  Plataformas (RAPPI / Pedidos YA / MELI)          ║
║    Tarjeta              $ X                       ║
║    Efectivo apps        $ X                       ║
║    ────────────────                               ║
║    Subtotal plataformas $ X                       ║
║                                                    ║
║  TOTAL DELIVERY         $ X                       ║
╚═══════════════════════════════════════════════════╝

╔═══════════════════════════════════╗
║  EGRESOS DEL TURNO                ║
╠═══════════════════════════════════╣
║  [lista de egresos]               ║
║  Total egresos   $ X              ║
╚═══════════════════════════════════╝

═══════════════════════════════════════════════════════════════════
TOTAL CAJA FÍSICA ESPERADA (efectivo en mostrador al cierre)
═══════════════════════════════════════════════════════════════════
    Existencia inicial             $ X
  + Efectivo mostrador              $ X
  + Efectivo delivery Damián        $ X
  + Efectivo apps (RAPPI/PYA/MELI)  $ X
  − Egresos del turno               $ X
  ─────────────────────
  TOTAL ESPERADO                    $ X

CONTADO FÍSICAMENTE                 $ X
DIFERENCIA                          $ X  (positiva = sobró; negativa = faltó)

═══════════════════════════════════════════════════════════════════
CUENTAS A COBRAR ACUMULADAS DEL TURNO (no entran a caja física)
═══════════════════════════════════════════════════════════════════
  Tarjeta Débito (acredita en ~2 días)     $ X
  Tarjeta Crédito (acredita en ~15 días)   $ X
  DELIVERATE (entrega después con comisión) $ X
  Apps con liquidación diferida             $ X (si aplica)

═══════════════════════════════════════════════════════════════════
APROBADO POR: [encargada o dueño]   FECHA APROBACIÓN: [timestamp]
═══════════════════════════════════════════════════════════════════
```

#### 3.6.1 Reglas de la fórmula (cerradas)

1. **Cada turno se calcula independientemente.** El cierre de tarde **no** acumula la caja de la mañana (Sección 1.5, decisión cerrada).
2. **Tarjetas no entran al efectivo físico esperado.** Van a sus cuentas a cobrar respectivas y se concilian aparte.
3. **Efectivo DELIVERATE no entra al efectivo físico esperado.** Es cuenta a cobrar hasta que ellos liquiden.
4. **Efectivo de apps SÍ entra al efectivo físico esperado**, porque los repartidores de las apps llevan la plata al mostrador en el día (confirmado por el cliente).
5. **Egresos pagados con efectivo del turno** se restan del esperado. Egresos pagados con otra cuenta (Galicia, MP) no afectan la caja física.
6. **Existencia inicial** se suma al esperado solo en el turno mañana (porque arranca con el efectivo que dejó la noche anterior). En el turno tarde, la existencia inicial es lo que físicamente quedó al cierre del turno mañana — pero el cierre tarde se calcula sin acumular el cierre mañana en sus números.

### 3.7 Conciliación y proyección de cuentas a cobrar

#### 3.7.1 Conciliación — flujos por tipo

| Cuenta a cobrar | Cómo se concilia |
|-|-|
| Tarjeta (débito o crédito) | Cuando llega liquidación al banco vinculado, vía Belvo (saldo en vivo) o vía importación de extracto manual. El sistema cruza por monto + fecha esperada. |
| DELIVERATE | Cuando DELIVERATE entrega al local plata + comprobante. La encargada carga la liquidación en el sistema (monto entregado, comisión retenida, fechas que cubre). El sistema cierra las liquidaciones pendientes de DELIVERATE hasta esa fecha. |
| RAPPI / Pedidos YA / MELI | Cuando llega liquidación al banco asociado (vía Belvo o extracto manual), conciliación automática por monto y fecha. Las plataformas con API se concilian directo (Sección 10). |
| MercadoPago | API directa de MP confirma instantáneamente. Sin conciliación manual — automático. |

> Aclaración importante: el **efectivo** que cobran los repartidores de RAPPI / Pedidos YA / MELI lo entregan al local **en el momento** (confirmado). Por eso ese efectivo entra directo a `Caja física`, no a una cuenta a cobrar. Las únicas cuentas a cobrar que estas apps generan son las **tarjetas** (cuando el cliente paga con tarjeta a través de la plataforma) y la **comisión de servicio** que cobra cada app (que se ve en la liquidación). DELIVERATE es la única que retiene también el efectivo.

#### 3.7.2 Próximos depósitos — proyección de ingresos

El sistema mantiene una vista de "**plata que va a entrar y cuándo**", calculada en vivo desde `LiquidacionPendiente`. Sirve para que el dueño y la encargada planifiquen pagos sabiendo qué plata va a tener disponible en los próximos días.

Tres niveles de proyección:

**Nivel 1: Próximo depósito por cuenta a cobrar**

Para cada cuenta a cobrar (cada tarjeta por banco, cada plataforma, DELIVERATE), muestra:
- Monto del próximo depósito esperado
- Fecha esperada
- Cantidad de operaciones que se acumulan en ese depósito

Ejemplo:
```
Tarjeta Débito Santander
  Próximo depósito: $ 145.230 — 28/04/2026 (12 operaciones)

Pedidos YA
  Próximo depósito: $ 387.500 — 02/05/2026 (45 pedidos)

DELIVERATE
  Próximo depósito: $ 78.900 — fecha tentativa 30/04/2026 (6 envíos)
```

**Nivel 2: Total a 20 días por cuenta a cobrar**

Para cada cuenta a cobrar, agrega todo lo pendiente que se va a acreditar en los próximos 20 días (incluido el próximo depósito):

```
Próximos 20 días — totales por fuente:

  Tarjeta Débito Santander       $ 320.450  (28 operaciones)
  Tarjeta Débito Galicia         $ 180.290  (15 operaciones)
  Tarjeta Crédito Santander      $ 1.245.700  (88 operaciones)
  Tarjeta Crédito Galicia        $ 890.500  (62 operaciones)
  Pedidos YA                     $ 1.450.300  (165 pedidos)
  RAPPI                          $ 980.500  (102 pedidos)
  Mercado Libre                  $ 220.180  (18 pedidos)
  DELIVERATE                     $ 312.000  (24 envíos — fechas tentativas)
  ──────────────────────────────────────
  TOTAL A INGRESAR EN 20 DÍAS    $ 5.599.920
```

**Nivel 3: Próximos depósitos por cuenta destino (banco)**

Para cada cuenta bancaria (Santander, Galicia, Provincia, MP), muestra el calendario de depósitos esperados que van a caer ahí desde todas las cuentas a cobrar vinculadas:

```
SANTANDER — próximos depósitos:
  28/04 (mañana)    $ 145.230   ← Tarjeta Débito Santander
  02/05             $ 320.180   ← Tarjeta Crédito Santander
  04/05             $ 87.000    ← Pedidos YA (liquida a Santander)
  ...
  Total 20 días:    $ 2.145.300

GALICIA — próximos depósitos:
  29/04 (pasado mañana) $ 92.500   ← Tarjeta Débito Galicia
  ...

CUENTA DNI (BAPRO) — próximos depósitos:
  ...

MERCADOPAGO — próximos depósitos:
  Hoy (instantáneo)   $ X    ← cobros con MP QR del día
  Liquidación MELI    [fecha] $ X
  ...
```

#### 3.7.3 Modelo de datos para soportar la proyección

No se agregan tablas nuevas — todo se calcula con queries sobre `LiquidacionPendiente`. La cuenta destino de cada liquidación viene del posnet (campo `Posnet.cuenta_destino_id` para tarjetas) o de la configuración de la cuenta a cobrar (`CuentaACobrar.cuenta_destino_id` para plataformas).

Vistas necesarias:

```sql
-- Próximo depósito por cuenta a cobrar
SELECT
  cuenta_a_cobrar_id,
  MIN(fecha_acreditacion_esperada) AS proxima_fecha,
  SUM(monto_neto_esperado) FILTER (WHERE fecha_acreditacion_esperada = proxima_fecha) AS proximo_monto,
  COUNT(*) FILTER (WHERE fecha_acreditacion_esperada = proxima_fecha) AS cantidad_operaciones
FROM liquidaciones_pendientes
WHERE estado = 'PENDIENTE'
GROUP BY cuenta_a_cobrar_id;

-- Total 20 días por cuenta a cobrar
SELECT
  cuenta_a_cobrar_id,
  SUM(monto_neto_esperado) AS total_20_dias,
  COUNT(*) AS cantidad
FROM liquidaciones_pendientes
WHERE estado = 'PENDIENTE'
  AND fecha_acreditacion_esperada BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '20 days'
GROUP BY cuenta_a_cobrar_id;

-- Calendario de depósitos por cuenta destino (banco)
SELECT
  c.id AS cuenta_destino_id,
  c.nombre AS cuenta_destino_nombre,
  lp.fecha_acreditacion_esperada,
  cac.nombre AS fuente,
  SUM(lp.monto_neto_esperado) AS monto
FROM liquidaciones_pendientes lp
JOIN cuentas_a_cobrar cac ON cac.id = lp.cuenta_a_cobrar_id
JOIN cuentas c ON c.id = cac.cuenta_destino_id
WHERE lp.estado = 'PENDIENTE'
  AND lp.fecha_acreditacion_esperada BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '20 days'
GROUP BY c.id, c.nombre, lp.fecha_acreditacion_esperada, cac.nombre
ORDER BY c.nombre, lp.fecha_acreditacion_esperada;
```

Estas vistas son baratas en Postgres con índices en `(cuenta_a_cobrar_id, fecha_acreditacion_esperada, estado)` — milisegundos para los volúmenes esperados.

#### 3.7.4 UI donde aparece la proyección

- En el **dashboard del admin** (Sección 7): widget "Próximos depósitos" con los 3 niveles, drill-down al detalle.
- En la **vista de cada cuenta a cobrar**: el calendario de sus liquidaciones pendientes con estado.
- En la **vista de cada cuenta bancaria**: el calendario de qué va a entrar a esa cuenta y cuándo.
- En el **email de cierre de sesión**: opcionalmente se incluye una sección "Próximos depósitos esperados" con el total a 20 días por fuente.

### 3.8 Diferencias de caja

Cuando al cierre `existencia_final ≠ existencia_esperada`, se genera automáticamente un movimiento de "Diferencia de caja" con la diferencia exacta y la sesión asociada. El admin puede:
- **Aprobar** la diferencia (asume la pérdida o el sobrante como hecho).
- **Investigar** y registrar observaciones (quizás falta un movimiento sin cargar).
- **Anular y volver a cerrar** si encuentra el movimiento que faltaba cargar.

Las diferencias quedan visibles en un reporte agregado para detectar patrones (un cajero específico que tiene diferencias recurrentes, un turno que sistemáticamente tiene faltantes, etc.).

### 3.9 Reportes que se desprenden del modelo

El modelo de cuentas + movimientos + sesiones permite los siguientes reportes (todos exportables a Excel):

- **Saldos al instante de las 5 cuentas + cuentas a cobrar.**
- **Flujo de fondos** (cashflow): por categoría, por período (día / semana / mes / año), comparativo entre períodos.
- **Cierres de caja**: histórico de cada sesión con su diferencia, búsqueda por fecha / turno / usuario.
- **Movimientos por entidad**: histórico completo por empleado / proveedor / categoría.
- **Liquidaciones esperadas vs reales**: análisis de diferencias entre comisión estimada y real.
- **Diferencias de caja**: ranking por usuario / turno / período.
- **Retiros del propietario** (Retiro Julio): histórico aparte del flujo operativo.
- **Saldo pendiente con DELIVERATE / plataformas**: cuánto te deben hoy y desde cuándo.

### 3.10 Pendientes y supuestos de esta sección

| # | Pendiente | A confirmar con |
|-|-|-|
| 3.10.1 | Diseño contable detallado del dueño (cómo separa mentalmente el uso de las 4 cuentas) | Dueño |
| 3.10.2 | Plazo y comisión típica de DELIVERATE | Encargada |
| 3.10.3 | Plazo y comisión exacta de RAPPI / Pedidos YA / MELI | Cuando lleguen credenciales partner |
| 3.10.4 | Modelo y adquirente de cada posnet activo | Encargada (foto de cada posnet) |
| 3.10.5 | ~~Lista de mails que reciben el resumen de cierre de caja~~ | ✅ Resuelto: dueño + encargada |
| 3.10.6 | Comisión mensual de mantenimiento de cada cuenta | Encargada (revisando extractos) |
| 3.10.7 | ~~¿Las apps de plataforma (RAPPI/PYA/MELI) tienen alguna que NO entregue efectivo al local en el día?~~ | ✅ Resuelto: todas las apps entregan efectivo en el momento. Solo DELIVERATE retiene (servicio de moto-entrega tercerizado). |

---

## Sección 4 — Modelo de ventas (items, pagos, estados, ciclo de vida)

> **Premisa que enmarca esta sección**: la venta es la unidad operativa central del sistema. Es lo que el cajero usa el 90% del tiempo. Tiene que ser **rápida de cargar, fácil de modificar mientras está abierta, imposible de modificar una vez cerrada, y completamente trazable**. El flujo lo definimos en Sección 1.6 (estados) y en la corrección que hiciste sobre el flujo del pedido (cliente carga → comanda a cocina si aplica → venta queda abierta para edición → cliente paga → finalización + ticket cliente).

### 4.1 Entidad `Venta`

```
Venta
  ├── id                    uuid
  ├── numero                int (correlativo único, generado al crear — Sección 4.4)
  ├── numero_orden_turno    int (correlativo dentro del turno, 3 dígitos, para llamar al cliente — Sección 4.4)
  ├── canal                 enum: MOSTRADOR | TELEFONO | WHATSAPP | WEB | RAPPI | PEDIDOS_YA | MERCADO_LIBRE | DELIVERATE
  ├── modalidad             enum: TAKE_AWAY | DELIVERY_PROPIO | DELIVERY_PLATAFORMA | DELIVERY_DELIVERATE
  ├── estado                enum: PROCESADA | FINALIZADA | ANULADA
  ├── cliente_id            FK Cliente nullable (null = "Cliente Casual")
  ├── lista_precios_id      FK ListaPrecios (la que aplica al canal)
  │
  ├── subtotal              decimal (suma de items antes de descuentos/recargos)
  ├── descuento_total       decimal (descuentos aplicados a la venta entera, ej. 10% efectivo)
  ├── recargo_canal         decimal (recargo automático del canal — RAPPI %, PYA %)
  ├── total                 decimal (subtotal − descuento_total + recargo_canal)
  ├── total_pagado          decimal (suma de pagos confirmados)
  ├── resto                 decimal (total − total_pagado, debería ser 0 al finalizar)
  │
  ├── pc_origen             string (qué PC cargó la venta — PC1, PC2, etc.)
  ├── usuario_apertura_id   FK Usuario (quién la abrió — siempre será "Vendedor" salvo casos)
  ├── usuario_cierre_id     FK Usuario nullable (quién la finalizó)
  ├── usuario_anulacion_id  FK Usuario nullable
  ├── motivo_anulacion      text nullable (obligatorio si estado = ANULADA)
  │
  ├── sesion_caja_id        FK SesionCaja (mañana o tarde del día)
  ├── fecha_apertura        timestamp
  ├── fecha_finalizacion    timestamp nullable
  ├── fecha_anulacion       timestamp nullable
  │
  ├── observaciones         text nullable (notas del cajero — "sin cebolla", "para retirar 13:30")
  │
  ├── delivery_info_id      FK DeliveryInfo nullable (si modalidad incluye delivery)
  ├── id_externo_canal      string nullable (ID del pedido en RAPPI / PYA / MELI cuando viene de plataforma)
  ├── payload_externo       jsonb nullable (payload crudo del webhook de la plataforma, para audit y debug)
  │
  ├── tiene_cocina          bool (calculado: true si algún item tiene cocina_interviene)
  ├── comanda_impresa       bool default false (true cuando se imprimió la comanda)
  ├── ticket_cliente_impreso bool default false (true cuando se imprimió el ticket cliente)
```

### 4.2 Items de venta (`ItemVenta`)

Cada línea del ticket es un `ItemVenta`. Pueden ser productos individuales o componentes de un combo.

```
ItemVenta
  ├── id                    uuid
  ├── venta_id              FK Venta
  ├── producto_id           FK Producto
  ├── nombre_snapshot       string (nombre del producto al momento de la venta — congelado para que cambios futuros no afecten el histórico)
  ├── cantidad              decimal (puede ser fraccional si forma_venta = GRAMO)
  ├── unidad                enum: UNIDAD | GRAMO | PLANCHA | PORCION (heredado del producto)
  ├── precio_unitario       decimal (snapshot del precio al momento de la venta, según lista_precios_id de la venta)
  ├── modificadores_aplicados  jsonb (array con los modificadores elegidos: grupo, opción, delta)
  ├── delta_modificadores   decimal (suma de los deltas — ya sumada al precio_unitario)
  ├── subtotal              decimal (cantidad × precio_unitario × factor según unidad)
  ├── descuento_linea       decimal default 0 (descuento aplicado solo a esta línea)
  ├── total_linea           decimal (subtotal − descuento_linea)
  ├── observacion           text nullable ("sin sal", "extra queso", "punto 3 cocción")
  ├── parte_de_combo_id     FK Combo nullable (si esta línea es parte de un combo)
  ├── parte_de_combo_instancia uuid nullable (agrupa los items que componen UNA aplicación específica del combo en la venta)
  ├── orden                 int (para mantener el orden en el ticket)
  ├── cocina_interviene     bool (snapshot del producto)
  ├── creado_at             timestamp
  ├── editado_at            timestamp nullable
  ├── editado_por_id        FK Usuario nullable
```

#### 4.2.1 Snapshot del precio

Cada `ItemVenta` guarda el `precio_unitario` y `nombre_snapshot` al momento de cargarlo. Esto evita que un cambio de precio posterior altere ventas históricas. Si alguien revisa la venta del 10 de marzo, ve los precios de ese día, no los de hoy.

#### 4.2.2 Combos en la venta

Cuando el cajero agrega un combo, el sistema genera **N items de venta** (uno por cada componente) más una marca de "estos N items son la instancia X del combo Y":

- Cada item tiene `parte_de_combo_id` apuntando al `Combo` y `parte_de_combo_instancia` con un UUID que agrupa esa aplicación específica.
- El precio del combo se distribuye proporcionalmente entre los items o se aplica como descuento agrupado (decisión técnica de cómo se ve en el ticket — Sección 8).

Si el cliente arma 2 veces el mismo combo en la misma venta, son 2 instancias distintas (`parte_de_combo_instancia` distinto), aunque sean el mismo combo.

### 4.3 Estados y ciclo de vida

```
                                  ┌─────────────┐
                                  │  CREACIÓN   │ (cajero abre venta nueva)
                                  └──────┬──────┘
                                         │
                                         ▼
                              ┌───────────────────────┐
                              │      PROCESADA        │
                              │  (abierta, editable)  │
              ┌───────────────│                       │───────────────┐
              │               │  - se imprimió comanda│               │
              │               │    si tiene_cocina    │               │
              │               │  - se pueden agregar  │               │
              │               │    quitar, modificar  │               │
              │               │    items              │               │
              │               │  - se puede asignar   │               │
              │               │    cliente, repartidor│               │
              │               └───────────────────────┘               │
              │                          │                            │
              │  cliente paga            │                            │ admin anula
              │  total = total_pagado    │                            │ (con motivo)
              │                          ▼                            │
              │               ┌───────────────────────┐               │
              │               │     FINALIZADA        │               │
              └──────────────▶│  (cerrada, inmutable) │               │
                              │                       │               │
                              │  - ticket cliente     │               │
                              │    impreso            │               │
                              │  - cobro confirmado   │               │
                              │  - movimientos         │               │
                              │    contables generados│               │
                              └───────────┬───────────┘               │
                                          │                            │
                                          │ admin anula con motivo     │
                                          │ (revierte movimientos)     │
                                          ▼                            ▼
                              ┌───────────────────────────────────────┐
                              │              ANULADA                  │
                              │  (registro queda — auditable)         │
                              └───────────────────────────────────────┘
```

#### 4.3.1 Reglas de transición

| De → A | Quién | Requisitos |
|-|-|-|
| (nada) → PROCESADA | Vendedor o Admin | Apertura de venta. Si tiene_cocina=true, se imprime comanda inmediatamente. |
| PROCESADA → FINALIZADA | Vendedor o Admin | `total_pagado >= total`. Se imprime ticket cliente. Se generan movimientos en cuentas correspondientes. |
| PROCESADA → ANULADA | Admin (encargada o dueño) | Motivo obligatorio. Si la comanda ya se imprimió, se imprime una segunda comanda con marca grande "CANCELADA" para que cocina lo sepa. |
| FINALIZADA → ANULADA | Admin (encargada o dueño) | Motivo obligatorio. Se revierten todos los movimientos contables (ingresos y pagos). Si pasó tiempo y el cierre de caja del turno ya fue aprobado, requiere nota explícita "anulada después del cierre". |

#### 4.3.2 Reglas de edición

- En `PROCESADA`: cualquier campo se puede editar. Cada cambio queda en audit log con valor anterior y nuevo.
- En `FINALIZADA`: **inmutable** por diseño. Si el cajero se equivocó, el flujo correcto es anular y crear venta nueva.
- En `ANULADA`: inmutable, solo lectura.

### 4.4 Numeración de ventas

Dos numeraciones independientes:

#### 4.4.1 `numero` — correlativo único global

- Una sola serie monótona creciente, compartida entre todos los canales y modalidades.
- Replica la lógica de Innovo (vimos 459959 delivery, 459980 mostrador, 460079 mostrador, todos correlativos).
- Generado por una secuencia Postgres global (`venta_numero_seq`).
- Sirve para reportes, búsquedas, referencia interna.

#### 4.4.2 `numero_orden_turno` — número corto para llamar al cliente

- Se reinicia en cada `SesionCaja` (cada turno).
- Empieza en 1, llega hasta donde se llegue (típicamente 100–500 según volumen del turno).
- Sirve para que cocina y mostrador coordinen ("¡Pedido número 47, listo!"). Aparece grande en el ticket cliente y en la comanda.
- No es único globalmente — el #47 de hoy mañana es otro pedido.

### 4.5 Cliente asociado a la venta

```
Cliente
  ├── id                    uuid
  ├── tipo                  enum: CASUAL | REGISTRADO | CORPORATIVO | PLATAFORMA
  ├── nombre                string ("Cliente Casual" para casuales)
  ├── apellido              string nullable
  ├── telefono              string nullable
  ├── email                 string nullable
  ├── cuit_cuil             string nullable (para corporativos / facturación)
  ├── direccion_default_id  FK Direccion nullable
  ├── fecha_nacimiento      date nullable (para módulo aniversarios)
  ├── observaciones         text nullable
  ├── activo                bool
```

#### 4.5.1 Cliente Casual (default)

Toda venta arranca con `cliente_id = null` o apuntando a un Cliente especial "Casual" pre-cargado. Esto cubre el ~95% de las ventas (consumidor final que no se identifica).

#### 4.5.2 Cliente identificado

Se asocia un cliente real cuando:
- El cliente pide factura y deja sus datos.
- Es un repetidor que la encargada quiere registrar (por marketing, por preferencias).
- Es delivery: se necesita nombre, teléfono y dirección.
- Viene de plataforma: se crea automáticamente un Cliente especial con `tipo = PLATAFORMA` y nombre = nombre de la plataforma ("Pedidos YA", "RAPPI", etc.). Replica la lógica de Innovo (vimos cliente "Pedidos YA" en el ticket de mostrador).

#### 4.5.3 Direcciones del cliente

Un cliente puede tener N direcciones (casa, trabajo, etc.):

```
Direccion
  ├── id                    uuid
  ├── cliente_id            FK Cliente
  ├── etiqueta              string ("Casa", "Trabajo")
  ├── calle                 string
  ├── numero                string
  ├── piso                  string nullable
  ├── depto                 string nullable
  ├── entre_calles          string nullable
  ├── localidad             string default "La Plata"
  ├── codigo_postal         string nullable
  ├── indicaciones          text nullable ("timbre roto", "perro", "dejar en portería")
  ├── es_default            bool
```

### 4.6 DeliveryInfo

Datos específicos del delivery, separados de la venta para no engordarla:

```
DeliveryInfo
  ├── id                    uuid
  ├── venta_id              FK Venta
  ├── direccion_id          FK Direccion nullable (si el cliente tiene direcciones registradas)
  ├── direccion_snapshot    jsonb (snapshot de la dirección al momento de la entrega — independiente del cliente)
  ├── repartidor_id         FK Usuario nullable (si es delivery propio)
  ├── empresa_externa       string nullable ("DELIVERATE", "RAPPI", etc. — para tracking)
  ├── hora_prometida        timestamp nullable (cuándo prometieron entregar)
  ├── hora_salida           timestamp nullable (cuándo salió del local)
  ├── hora_entrega          timestamp nullable (cuándo se entregó al cliente)
  ├── estado                enum: PENDIENTE | EN_RUTA | ENTREGADO | NO_ENTREGADO | DEVUELTO
  ├── motivo_no_entrega     text nullable
  ├── observaciones         text nullable
```

> Métrica útil que se desprende: `hora_entrega − hora_prometida` para análisis de cumplimiento de tiempos. `hora_entrega − hora_apertura_venta` para tiempo total desde el pedido hasta la entrega.

### 4.7 Pagos / Cobros de la venta

Una venta puede pagarse con uno o varios pagos (split):

```
Pago (ya definido en Sección 3.3)
  ├── venta_id              FK Venta
  ├── método                enum (efectivo / débito / crédito / MP QR / transferencia / etc.)
  ├── cuenta_id             FK Cuenta (a dónde entra el efectivo)
  ├── cuenta_a_cobrar_id    FK CuentaACobrar nullable (si genera una a cobrar)
  ├── monto, etc.
```

#### 4.7.1 Reglas de cobro

- Una venta no puede pasar a `FINALIZADA` con `total_pagado < total`. El cajero ve "te falta cobrar $X" hasta que cuadre.
- Si `total_pagado > total` (cliente pagó de más), el sobrante se registra como `cambio_dado` en el último pago. Si pagó con tarjeta y no se puede dar cambio, el sistema bloquea y obliga a anular el pago y rehacerlo.
- Si el cajero quiere descuentos al confirmar el cobro (típicamente el 10% efectivo), se aplica en este paso (Sección 4.8).

### 4.8 Recargos y descuentos

Tres tipos:

#### 4.8.1 Recargo automático por canal

Cuando una venta entra por un canal con recargo configurado (ej. Pedidos YA tiene un recargo definido en la lista de precios), el sistema:
- Aplica el precio efectivo según `ListaPrecios` del canal a cada item (los items ya salen con el precio aumentado, no como línea separada).
- Alternativamente, si quieren ver el recargo como línea separada en el ticket (visibilidad para el cliente final), se agrega una línea especial "Recargo Pedidos YA". **Decisión propuesta**: el recargo va incluido en el precio de cada item (no como línea separada), siguiendo la lógica de la lista de precios. Si querés que aparezca como línea, lo cambio.

#### 4.8.2 Descuento del 10% efectivo en mostrador

Regla de negocio: cuando el cliente paga 100% en efectivo en el mostrador, **se puede** aplicar un descuento del 10% al subtotal de la venta. Vimos esto en el ticket: "Descuento 10% (-10,00%) -$3.013". El descuento es **opcional y explícito**, no automático — algunos clientes no lo piden, o el cajero quiere mostrar primero el total normal.

**Flujo en la UI** (decisión cerrada):

1. El cajero termina de cargar los items. La pantalla muestra el **total normal** (sin descuento).
2. Pasa a la sección de método de pago. Ve los métodos disponibles como botones grandes:
   ```
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │  EFECTIVO   │  │   DÉBITO    │  │   CRÉDITO   │
   └─────────────┘  └─────────────┘  └─────────────┘
   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
   │   MP / QR   │  │ TRANSFER.   │  │   OTROS     │
   └─────────────┘  └─────────────┘  └─────────────┘

   ─────────────────────────────────────────────
   ┌─────────────────────────────────────────────┐
   │  💰 EFECTIVO con 10% DE DESCUENTO            │
   │     Total con descuento: $ X (ahorra $ Y)   │
   └─────────────────────────────────────────────┘
   ```
3. Si el cajero clickea **"Efectivo"** sin descuento, se confirma con el total normal.
4. Si clickea **"Efectivo con 10%"**, el sistema recalcula y muestra el total con descuento. El cajero le dice al cliente "te queda en $X". El cliente puede aceptar o decir "ah no, mejor pago con débito".
5. Si el cliente cambia de opinión, el cajero clickea **"Volver"** o elige otro método. El descuento se quita automáticamente.

**Reglas técnicas**:
- El descuento se aplica solo si **todos** los pagos finales son `EFECTIVO` Y el canal es `MOSTRADOR`. Si el cliente paga 50% efectivo + 50% débito, **no aplica** descuento (se bloquea el botón de descuento).
- Queda como `descuento_total` con motivo "10% efectivo mostrador".
- La regla del 10% es **configurable** desde el admin (porcentaje + canales aplicables), por si cambia.
- El botón de descuento aparece **solo si** el canal habilita el descuento (Mostrador habilita; Pedidos YA, RAPPI, etc. no).

#### 4.8.2bis Posnet integrado vs manual

Cuando el cajero elige Débito o Crédito, el comportamiento depende de si el posnet seleccionado tiene `soporta_integracion = true` (Sección 3.3.1):

**Caso A — Posnet integrado** (modelos modernos: Mercado Pago Point, Ualá Bis, Modo, Geopagos, Pomelo, Naranja X y similares):

1. Cajero clickea "Débito" o "Crédito" en el sistema.
2. El sistema le envía automáticamente al posnet el **monto exacto** del total de la venta.
3. El posnet se "despierta" mostrando ese monto, listo para que el cliente acerque la tarjeta o NFC.
4. Cuando el posnet aprueba la operación, devuelve la confirmación al sistema (autorización + últimos 4 dígitos + tipo de tarjeta + cuotas si aplica).
5. El sistema confirma el `Pago` automáticamente y la venta puede pasar a Finalizada.
6. **El cajero no tipea ningún monto** — eliminación total de la doble carga y de errores de tipeo.

**Caso B — Posnet manual** (modelos legacy: Lapos clásico, Visa Posnet, Cabal autónomo y similares):

1. Cajero clickea "Débito" o "Crédito" en el sistema.
2. El sistema le **muestra al cajero** el monto que tiene que tipear en el posnet ("Cobrar $X en posnet [nombre]").
3. Cajero tipea ese monto en el posnet, el cliente paga, el posnet imprime su ticket.
4. Cajero **confirma manualmente** en el sistema que el pago se realizó (clickea "Confirmar pago").
5. Opcional: el cajero ingresa los últimos 4 dígitos y/o el código de autorización del ticket del posnet, para tener trazabilidad cuando llegue la liquidación al banco.

**Configuración**:
- Cada `Posnet` tiene su flag `soporta_integracion`.
- Cuando llegue el dato del modelo y adquirente exactos (pendiente 3.10.4), el admin marca cuáles soportan integración y cuáles no, y el sistema se comporta acorde.
- Mientras tanto se asume `soporta_integracion = false` en todos (modo conservador). Cuando confirmes los modelos, los activamos uno por uno.

#### 4.8.3 Descuentos manuales

El admin (encargada o dueño) puede aplicar descuentos manuales por:
- Línea (a un item específico)
- Venta total (descuento porcentual o monto fijo)

Cada descuento manual requiere:
- Motivo (texto libre o lista de motivos pre-cargada)
- Usuario que lo aplica (queda en audit log)

El admin puede definir un **máximo de descuento** que el rol Vendedor puede aplicar sin pedir aprobación (ej. hasta 5%). Para descuentos mayores, se necesita PIN del admin.

### 4.9 Anulación de ventas

Caso A: anular venta `PROCESADA` (todavía no finalizada)
- Solo admin.
- Pide motivo (cliente se arrepintió, pedido duplicado, error de carga, etc.).
- Si la comanda ya se imprimió y el item tenía `cocina_interviene = true`, se imprime una segunda comanda con leyenda grande **"CANCELADA — ORDEN #X"** para que cocina detenga la preparación si todavía no la entregó.
- Si la comanda no se había impreso (ej. todos los items son productos ya listos), no se imprime nada.

Caso B: anular venta `FINALIZADA`
- Solo admin.
- Pide motivo.
- Revierte automáticamente todos los pagos asociados (genera movimientos compensatorios en las cuentas).
- Si el cierre de caja del turno ya fue aprobado, queda nota "anulada después del cierre del [turno]" — para auditoría.
- Si era venta cobrada con tarjeta, no se devuelve la plata al cliente automáticamente (eso es proceso bancario — el encargado tiene que hacer la devolución por homebanking). El sistema solo registra que la venta quedó anulada y la plata cobrada queda como "saldo a devolver al cliente".

### 4.10 Ciclo de vida vinculado a impresión y movimientos

Resumen de qué se dispara automáticamente en cada transición:

| Transición | Acciones automáticas |
|-|-|
| (nada) → `PROCESADA` | • Asignar `numero` y `numero_orden_turno`<br>• Asociar a `SesionCaja` actual<br>• Si `tiene_cocina` y modalidad ≠ DELIVERY (con tickets unificados): **imprimir comanda en cocina** (Sección 8)<br>• Si modalidad = DELIVERY_PROPIO o DELIVERY_DELIVERATE: imprimir ticket delivery completo |
| `PROCESADA` → `FINALIZADA` | • Validar `total_pagado >= total`<br>• Confirmar todos los `Pago` asociados<br>• Generar `Movimiento` ingreso por canal<br>• Si hay tarjetas → generar `LiquidacionPendiente` para la cuenta a cobrar correspondiente<br>• Si modalidad = TAKE_AWAY: **imprimir ticket cliente** (Sección 8)<br>• Marcar timestamps |
| `PROCESADA` → `ANULADA` | • Si la comanda se imprimió y `tiene_cocina`: **imprimir comanda CANCELADA**<br>• Liberar `numero_orden_turno` (queda en histórico pero no se reusa)<br>• Marcar timestamps y motivo |
| `FINALIZADA` → `ANULADA` | • Anular todos los `Pago`<br>• Generar `Movimiento` compensatorios (egreso por monto cobrado)<br>• Si había `LiquidacionPendiente`: anularlas<br>• Notificar al admin si la sesión de caja del turno ya fue aprobada |

### 4.11 Reportes basados en ventas

El modelo soporta los siguientes reportes (todos exportables a Excel, con filtros por fecha / canal / vendedor / categoría / cliente):

- **Ventas finalizadas** — por turno, día, semana, mes, año.
- **Ventas anuladas** — con motivo y usuario, ranking de motivos.
- **Detalle de ventas** — drill-down: lista → click en venta → detalle de items y pagos.
- **Top productos vendidos** — por categoría, por canal, por período. Replica el "Top 3" del Miro (últimos 30 días, fijo).
- **Cantidad de ventas por hora** — para entender picos del día (replica de Innovo "Distribución por horas").
- **Ventas promedio** — ticket promedio (total / cantidad de ventas).
- **Ventas por canal** — desagregado mostrador / delivery propio / RAPPI / etc.
- **Ventas por vendedor** — útil cuando empiecen a usar usuarios diferenciados.
- **Tiempo de preparación / entrega** — para deliveries, comparando hora prometida vs hora de entrega real.
- **Ventas con descuentos** — quién aplicó qué descuento, cuándo, por qué motivo.
- **Adicionales de ventas** — combos y promos más vendidos.
- **Ventas con anulación post-cierre** — alerta para auditoría.

### 4.12 Pendientes y supuestos de esta sección

| # | Pendiente | A confirmar con |
|-|-|-|
| 4.12.1 | ¿El recargo por canal aparece como **línea separada** en el ticket o **incluido** en el precio de cada item? | Cliente — propuesta es incluido. |
| 4.12.2 | ¿Cuál es el % máximo de descuento que un Vendedor puede aplicar sin pedir aprobación? | Dueño / encargada |
| 4.12.3 | Lista de motivos de anulación pre-cargados (para no escribirlos a mano cada vez) | Encargada |
| 4.12.4 | ¿En delivery propio, se asigna repartidor en el momento del pedido o al salir? ¿Hay más de un motoquero o solo Damián? | Encargada |
| 4.12.5 | ¿Se quiere registrar el tiempo prometido (ej. "30 min para retirar") en pedidos take-away también, no solo en delivery? | Encargada — afecta UX del ticket cliente |

---

## Sección 5 — Modelo de insumos, proveedores y facturas

> **Premisa que enmarca esta sección**: la carga de facturas de proveedores **no la hace el programa**. La hace un flujo paralelo de N8N + bot de Telegram + Drive + Excels (Sección 1.5, decisión cerrada). El programa **lee** las facturas, **muestra** saldos por proveedor, **registra los pagos** que la encargada emite desde el sistema, y **alimenta** los reportes de cashflow y deudas. Hay también una vía **secundaria** desde el programa para casos puntuales (la encargada está en el local sin Telegram a mano y quiere cargar una factura desde la PC). Ambas vías terminan en el mismo modelo de datos.

### 5.1 Topología del flujo de facturas

```
┌────────────────────── VÍA PRIMARIA (default) ──────────────────────┐
│                                                                     │
│   Encargada ── foto factura ──▶ Bot de Telegram                     │
│                                       │                             │
│                                       ▼                             │
│                                    N8N                              │
│                                       │                             │
│         ┌─────────────────────────────┼──────────────────────────┐  │
│         ▼                             ▼                          ▼  │
│    LLM con visión           Excel "Proveedores 2026"       API Programa
│    (extrae datos)              en Google Drive             (sync a DB)│
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌────────────────────── VÍA SECUNDARIA (puntual) ────────────────────┐
│                                                                     │
│   Encargada en el local ── form en programa ──▶ DB del programa     │
│   (foto subida o tipeo manual)                       │              │
│                                                       ▼              │
│                                              Excel "Proveedores"     │
│                                              actualizado por programa│
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Las dos vías escriben en la misma tabla `Factura` y mantienen el mismo Excel sincronizado. El detalle del flujo de sync con Drive y aprobación de cambios se especifica en Sección 9.

### 5.2 Proveedores

```
Proveedor
  ├── id                    uuid
  ├── nombre                string ("Lingotes", "Vacalin", "Free Vegetales", etc.)
  ├── razon_social          string nullable
  ├── cuit                  string nullable
  ├── condicion_iva         enum: RESPONSABLE_INSCRIPTO | MONOTRIBUTO | EXENTO | CONSUMIDOR_FINAL | nullable
  ├── direccion             string nullable
  ├── localidad             string nullable
  ├── telefono              string nullable
  ├── email                 string nullable
  ├── persona_contacto      string nullable
  ├── categoria_principal   string ("Lácteos", "Verdulería", "Envases", "Carnes", etc. — para reportes)
  ├── plazo_pago_dias       int default 0 (días que tarda en vencer una factura desde la fecha de emisión)
  ├── observaciones         text nullable
  ├── activo                bool
  ├── creado_at             timestamp
  ├── creado_por_id         FK Usuario
  └── ultimo_movimiento_at  timestamp nullable (calculado — última factura o pago)
```

**Proveedores históricos identificados** del Excel `Proveedores 2026.xlsx` (hoja "Deudas"), pre-cargados en la migración inicial:

Lácteos / Quesos: Lingotes, Vacalin, Cosenza, Milkaut, Corycor.
Verduras / Especias / Insumos: Free Vegetales, Navacerrada, Maprisa, Condiriko, Prod. Silvia, Roca Food.
Carnes / Pollos / Huevos / Pescado: Carnicería Fca., Carnicería Julio Felipe, Pollos, Huevos, Campodonico.
Sin TACC: Grupo DF Sin TACC, La Pastelera Sin TACC.
Envases / Papelería: Grafipack (Blanco y Negro), Polibol, Ave Fenix (Blanco y Negro).
Fiambres: Marcelo Dist., Fiambres Cibum-Agri, Fiambre del Sur.
Otros: Luis Gourmet, Rama, Cervezas, Vinos, Limpieza.

> Algunos nombres son genéricos ("Pollos", "Huevos", "Cervezas", "Vinos") — la encargada al cargar la primera factura va a poder asignar un nombre y CUIT específico al proveedor, o mantener el genérico si compra a varios sin distinguir.

### 5.3 Insumos (catálogo de qué se compra)

Diferente de `Producto` (que es lo que se vende). `Insumo` es la materia prima o producto comprado.

```
Insumo
  ├── id                    uuid
  ├── nombre                string ("Mozzarella", "Harina 000", "Pimentón", "Bandeja 105", etc.)
  ├── categoria             enum: VERDULERIA | LACTEOS | CARNES | POLLO | HUEVOS | HARINAS | CONDIMENTOS | ENVASES | LIMPIEZA | BEBIDAS | OTROS
  ├── unidad_compra         enum: KG | GRAMOS | UNIDAD | LITRO | CAJA | BOLSA | PAQUETE | DOCENA | etc.
  ├── presentacion          string ("bolsa de 25kg", "caja de 600 unidades", "lata 1L") — descripción libre
  ├── proveedor_principal_id  FK Proveedor nullable (proveedor habitual; uno solo aunque pueda comprarse a varios)
  ├── activo                bool
  ├── stock_actual          decimal default 0 (no se actualiza en fase 1, pero queda el campo)
  ├── stock_minimo          decimal nullable (alerta cuando baja)
  ├── observaciones         text nullable
```

**InsumoProveedor** (tabla muchos-a-muchos):

```
InsumoProveedor
  ├── insumo_id             FK
  ├── proveedor_id          FK
  ├── precio_ultimo         decimal (último precio conocido)
  ├── fecha_ultimo_precio   date
  ├── es_principal          bool (uno por insumo es el principal)
```

Esto permite ver "este insumo lo compramos a 3 proveedores, los precios están así" y el reporte "evolución del precio de la mozzarella en los últimos 12 meses por proveedor".

### 5.4 Factura recibida

```
FacturaRecibida
  ├── id                    uuid
  ├── proveedor_id          FK Proveedor
  ├── tipo_comprobante      enum: FACTURA_A | FACTURA_B | FACTURA_C | FACTURA_X | NOTA_CREDITO | NOTA_DEBITO | TICKET | REMITO | OTRO
  ├── punto_venta           string nullable
  ├── numero                string ("00001-00012345")
  ├── cuit_emisor           string (cacheado del proveedor para audit)
  ├── razon_social_emisor   string (cacheada)
  │
  ├── fecha_emision         date
  ├── fecha_computo         date (cuándo lo cuenta el negocio — puede no ser el de emisión)
  ├── fecha_vencimiento     date nullable (fecha hasta cuándo se puede pagar sin recargo)
  │
  ├── neto_gravado          decimal
  ├── neto_no_gravado       decimal default 0
  ├── iva_21                decimal default 0
  ├── iva_10_5              decimal default 0
  ├── iva_27                decimal default 0
  ├── otros_impuestos       decimal default 0
  ├── total                 decimal
  │
  ├── total_pagado          decimal default 0
  ├── saldo                 decimal (calculado: total − total_pagado)
  │
  ├── estado                enum: PENDIENTE_VALIDACION | PENDIENTE_PAGO | PAGADA_PARCIAL | PAGADA | ANULADA
  │
  ├── origen                enum: TELEGRAM_OCR | PROGRAMA_FOTO | PROGRAMA_MANUAL | EXCEL_LEGACY (carga inicial)
  ├── adjunto_url           string nullable (URL al archivo de la foto/PDF — en S3-compatible o Drive)
  ├── adjunto_hash          string nullable (SHA-256 del adjunto, para detectar duplicados)
  │
  ├── ocr_payload           jsonb nullable (lo que extrajo el LLM — para auditar la calidad del OCR)
  ├── ocr_confianza         decimal nullable (score de 0-1 de qué tan seguro está el OCR)
  │
  ├── observaciones         text nullable
  ├── usuario_carga_id      FK Usuario nullable (null si vino de Telegram-N8N)
  ├── usuario_validacion_id FK Usuario nullable (admin que la validó)
  ├── creado_at             timestamp
  ├── validada_at           timestamp nullable
  └── pagada_at             timestamp nullable
```

#### 5.4.1 Detalle de la factura (líneas)

```
FacturaItemRecibida
  ├── id                    uuid
  ├── factura_id            FK FacturaRecibida
  ├── insumo_id             FK Insumo nullable (si se pudo matchear con un insumo del catálogo)
  ├── descripcion           string (lo que dice la factura — texto crudo)
  ├── cantidad              decimal
  ├── unidad                string
  ├── precio_unitario       decimal
  ├── alicuota_iva          decimal (21, 10.5, 0, etc.)
  ├── subtotal              decimal
  ├── orden                 int
```

Si el OCR puede matchear la línea con un `Insumo` del catálogo, se asocia automáticamente. Si no, queda como descripción libre y la encargada puede vincularla manualmente a un Insumo después (eso alimenta el aprendizaje del OCR).

### 5.5 Estados y ciclo de vida de la factura

```
                ┌──────────────────────────────┐
                │   PENDIENTE_VALIDACION       │
                │  (cargada por OCR, sin       │
                │   revisar por admin)         │
                └──────────────┬───────────────┘
                               │
                  admin valida (corrige datos si hace falta)
                               │
                               ▼
                ┌──────────────────────────────┐
                │     PENDIENTE_PAGO           │
                │  (datos confirmados,         │
                │   saldo > 0)                 │
                └──────────────┬───────────────┘
                               │
                  se carga un pago parcial
                               │
                               ▼
                ┌──────────────────────────────┐
                │     PAGADA_PARCIAL           │
                │  (saldo > 0 pero < total)    │
                └──────────────┬───────────────┘
                               │
                  saldo = 0
                               ▼
                ┌──────────────────────────────┐
                │       PAGADA                 │
                │  (saldo = 0)                 │
                └──────────────────────────────┘

                Cualquier estado → ANULADA (con motivo, solo admin)
```

#### 5.5.1 Validación admin

Cuando una factura entra vía Telegram-OCR (origen = `TELEGRAM_OCR`), arranca en `PENDIENTE_VALIDACION`. La razón: el OCR puede equivocarse — puede confundir un dígito, leer mal el CUIT, errar el total. El admin abre la factura, ve la foto al lado de los datos extraídos, y:
- Si está bien, clickea "Validar" → pasa a `PENDIENTE_PAGO`.
- Si hay errores, los corrige y luego valida → pasa a `PENDIENTE_PAGO`.
- Si la factura es duplicada (ya estaba cargada), la marca como tal y se anula automáticamente con motivo "Duplicada de factura #X".

Las facturas cargadas desde el programa (`PROGRAMA_FOTO` o `PROGRAMA_MANUAL`) pueden saltarse el estado de validación (van directo a `PENDIENTE_PAGO`) porque el cajero está cargando con los datos a la vista.

### 5.6 Pagos a proveedores

Un pago a proveedor es un `Movimiento` (Sección 3.2) con:
- `tipo = EGRESO`
- `categoria = "Insumos (compras a proveedores)"`
- `entidad_id` = FK al `Proveedor`
- `factura_id` = FK a una o varias `FacturaRecibida` que está pagando

El flujo de pago a proveedores soporta **dos dimensiones de "uno a varios"** que se combinan libremente:

#### 5.6.1 Una transacción de pago puede cubrir varias facturas

La encargada puede pagar 5 facturas distintas del mismo proveedor con un solo movimiento. Tabla intermedia:

```
PagoFactura
  ├── id                    uuid
  ├── pago_id               FK Pago (Sección 3.3)
  ├── factura_id            FK FacturaRecibida
  ├── monto_aplicado        decimal (cuánto del pago se aplica a esa factura)
  ├── orden                 int
```

Suma de `monto_aplicado` por factura debe ser ≤ saldo de la factura.

#### 5.6.2 Una transacción de pago puede dividirse en varias cuentas (split)

Caso real del negocio: la encargada paga $1.000.000 a Vacalin con **$300.000 efectivo de caja + $400.000 transferencia desde Santander + $300.000 transferencia desde Galicia**. Esto se modela como **un solo `Movimiento` con varios `Pago` asociados**, cada uno desde una cuenta distinta:

```
Movimiento (egreso, total $1.000.000, proveedor=Vacalin)
  cuenta_origen_id: NULL  ← null cuando hay múltiples cuentas
  
  Pago A: $300.000  cuenta=Caja física    método=EFECTIVO
  Pago B: $400.000  cuenta=Santander      método=TRANSFERENCIA   numero_referencia="OP-12345"
  Pago C: $300.000  cuenta=Galicia        método=TRANSFERENCIA   numero_referencia="OP-67890"
```

Cuando un `Movimiento` tiene un solo `Pago`, `cuenta_origen_id` se setea con esa cuenta para conveniencia de queries. Cuando tiene múltiples, queda en `NULL` y la cuenta se infiere de los Pagos.

#### 5.6.3 Combinación de las dos dimensiones

El caso más complejo (real, lo hacen así) combina ambas: **pagar varias facturas con varias cuentas, repartiendo libremente**.

Ejemplo: pagar 3 facturas (F1=$200k, F2=$500k, F3=$300k, total $1M) usando $400k efectivo + $600k Santander.

```
Movimiento (egreso $1M, proveedor=Vacalin)
  cuenta_origen_id: NULL
  
  Pago A: $400.000  cuenta=Caja física   método=EFECTIVO
    PagoFactura A1: factura=F1  monto_aplicado=$200k
    PagoFactura A2: factura=F2  monto_aplicado=$200k
  
  Pago B: $600.000  cuenta=Santander     método=TRANSFERENCIA
    PagoFactura B1: factura=F2  monto_aplicado=$300k    (queda saldo F2 = 0 con A2 + B1)
    PagoFactura B2: factura=F3  monto_aplicado=$300k    (queda saldo F3 = 0)
```

Reglas de validación:
- Suma de `Pago.monto` debe ser igual a `Movimiento.monto` (la transacción cuadra).
- Suma de `PagoFactura.monto_aplicado` por `Pago` debe ser igual a `Pago.monto`.
- Suma de `PagoFactura.monto_aplicado` por `Factura` debe ser ≤ `Factura.saldo`.

#### 5.6.4 UI propuesta para el flujo de pago

Pantalla "Pagar facturas":

1. **Paso 1 — Seleccionar facturas**: la encargada elige una o varias facturas pendientes de un proveedor (o de varios proveedores en una misma transacción si así lo desea — TBD si se permite cross-proveedor en una sola transacción). Total a pagar = $X.

2. **Paso 2 — Distribuir entre cuentas**: aparece un panel donde puede agregar líneas, una por cuenta:
   ```
   ┌────────────────────────────────────────────────────┐
   │ Total a pagar: $ 1.000.000                         │
   │ ─────────────────────────────────────────          │
   │ Cuentas seleccionadas:                             │
   │                                                    │
   │ [ Caja física        ▼ ]  [ EFECTIVO    ▼ ]  $ 300.000  [✕] │
   │ [ Santander          ▼ ]  [ TRANSFER.   ▼ ]  $ 400.000  [✕] │
   │ [ Galicia            ▼ ]  [ TRANSFER.   ▼ ]  $ 300.000  [✕] │
   │                                                    │
   │ [ + Agregar otra cuenta ]                          │
   │                                                    │
   │ Suma asignada:    $ 1.000.000   ✓                  │
   │ Diferencia:       $ 0                              │
   │                                                    │
   │ [ Confirmar pago ]                                 │
   └────────────────────────────────────────────────────┘
   ```

3. **Paso 3 — Distribuir entre facturas (cuando hay varias facturas + varias cuentas)**: si las facturas y cuentas son varias, el sistema propone una distribución automática (ej. cubrir las facturas más viejas primero), pero la encargada puede ajustar manualmente cuánto de cada `Pago` se aplica a cada `Factura`.

4. **Paso 4 — Confirmación**: revisa el resumen y confirma. Se generan el `Movimiento`, los `Pago` (uno por cuenta), las `PagoFactura` (cuántos $ van a cada factura), y los saldos de las cuentas y de las facturas se actualizan al instante.

#### 5.6.5 Programación de pagos (futuro)

El modelo soporta marcar facturas como "programadas para pagar el día X" sin pagarlas todavía. Útil para que la encargada planifique:
- Lista "facturas vencidas" (saldo > 0 y fecha_vencimiento < hoy).
- Lista "vencen en los próximos 7 días".
- Lista "programadas para pagar mañana / esta semana".

Campo adicional en `FacturaRecibida`:
```
fecha_pago_programada     date nullable
```

Esta funcionalidad está en el roadmap pero **no es bloqueante para fase 1** — fase 1 solo necesita ver el saldo, fase 2 agrega programación.

### 5.7 Saldos y deudas por proveedor

Calculados al instante:

```
-- Saldo total con cada proveedor
SELECT
  p.id,
  p.nombre,
  COALESCE(SUM(f.saldo) FILTER (WHERE f.estado IN ('PENDIENTE_PAGO', 'PAGADA_PARCIAL')), 0) AS saldo_adeudado,
  COUNT(f.id) FILTER (WHERE f.estado = 'PENDIENTE_PAGO' OR f.estado = 'PAGADA_PARCIAL') AS facturas_pendientes,
  MAX(f.fecha_vencimiento) FILTER (WHERE f.estado = 'PENDIENTE_PAGO' OR f.estado = 'PAGADA_PARCIAL') AS prox_vencimiento
FROM proveedores p
LEFT JOIN facturas_recibidas f ON f.proveedor_id = p.id
GROUP BY p.id, p.nombre
ORDER BY saldo_adeudado DESC;
```

**Vista en el programa** (replica el flujo de Innovo "Movimientos por entidad"):
- Listado de proveedores con saldo total.
- Click en un proveedor → ficha con datos + historial de facturas + historial de pagos.
- Filtros: facturas pagadas / pendientes / vencidas / del último mes / del año.
- Botón "Pagar facturas seleccionadas" → genera un `Pago` que cancela las marcadas, con cuenta origen elegida.

### 5.8 Facturas emitidas (mayoristas — caso especial)

Replica de la decisión cerrada: el programa permite **emitir facturas a clientes mayoristas** como registro interno. La validez fiscal la maneja la encargada por afuera (ARCA), no se persigue en este sistema.

```
FacturaEmitida
  ├── id                    uuid
  ├── cliente_id            FK Cliente (debe tener CUIT y razón social cargados)
  ├── tipo_comprobante      enum: FACTURA_A | FACTURA_B | FACTURA_C
  ├── numero_interno        string (correlativo del programa)
  ├── numero_fiscal         string nullable (si la encargada después lo carga manualmente, queda referencia)
  │
  ├── fecha_emision         date
  ├── neto_gravado          decimal
  ├── iva                   decimal
  ├── total                 decimal
  │
  ├── ventas_asociadas      array FK Venta (si la factura cubre una o varias ventas del sistema)
  │
  ├── pdf_generado_url      string nullable (PDF generado por el sistema, sin validez fiscal)
  ├── observaciones         text nullable
  ├── creado_at             timestamp
  ├── creado_por_id         FK Usuario
```

El sistema genera un PDF con el formato típico de factura para que el mayorista tenga su comprobante. **No** se conecta a ARCA — eso lo hace la encargada en paralelo si corresponde.

### 5.9 Vinculación con cashflow y reportes

Las facturas alimentan automáticamente:

- **Cashflow**: cada `Pago` a proveedor genera un movimiento egreso categorizado, que aparece en el flujo de fondos por categoría / día / mes / año.
- **Deudas**: el saldo total por proveedor se ve en un dashboard agregado.
- **Consumo de insumos**: si las líneas de factura están matcheadas con `Insumo`, se puede reportar "cuántos kg de mozzarella compramos en el último mes / a qué precio promedio / a qué proveedor".
- **Compras por categoría**: agrupado (Lácteos / Verdulería / Carnes / etc.) — útil para detectar desvíos vs. presupuesto.

### 5.10 Reportes basados en proveedores y facturas

(Todos exportables a Excel)

- **Saldos por proveedor** (lo que se debe a cada uno hoy).
- **Antigüedad de la deuda** (cuánto se debe distribuido por días vencidos: 0–30 / 30–60 / 60+).
- **Vencimientos próximos** (facturas que vencen en los próximos N días).
- **Compras por proveedor** — totales mensuales / anuales por proveedor.
- **Compras por categoría de insumo** — para análisis de costos.
- **Evolución de precios de insumos** — replica la utilidad del Excel "Compras" actual donde se ve el precio semana a semana.
- **Pagos realizados** — listado de pagos con cuenta origen, fecha, factura cancelada.
- **Facturas pendientes de validación** — alerta para el admin cuando OCR cargó facturas que falta confirmar.
- **Top 10 proveedores por monto** — quién absorbe la mayor parte de las compras del negocio.

### 5.11 Pendientes y supuestos de esta sección

| # | Pendiente | A confirmar con |
|-|-|-|
| 5.11.1 | Confirmar el catálogo final de **categorías de insumos** (la lista que propuse es la mínima — ¿agregar "Sin TACC", "Bebidas alcohólicas", "Postres / Helados", etc.?) | Encargada |
| 5.11.2 | ¿La emisión de facturas a mayoristas requiere PDF con formato estándar AFIP, o uno simple alcanza? | Encargada |
| 5.11.3 | ¿Cuántas facturas mayoristas se emiten al mes en promedio? Para dimensionar la criticidad del módulo | Encargada |
| 5.11.4 | Lista de plazos de pago por proveedor (algunos te dan 30 días, otros 7, otros contado) | Encargada — puede salir de los Excels |
| 5.11.5 | ¿Los proveedores tienen alguna referencia bancaria pre-cargada (CBU/alias) para facilitar transferencias? | Encargada |
| 5.11.6 | ¿Querés que el programa marque automáticamente como **vencida** una factura que pasó su `fecha_vencimiento`, con alerta visual en el dashboard? | Decisión propuesta: sí |

---

## Sección 6 — Roles, permisos y autenticación

> **Premisa que enmarca esta sección**: el sistema tiene **2 roles operativos** (Vendedor y Admin) y autentica con **PIN de 4 dígitos** (Sección 1.5, decisión cerrada). El rol Vendedor lo comparten todos los cajeros con un mismo PIN; el rol Admin lo usan la encargada y el dueño con PINs distintos para trazabilidad. El diseño prioriza **velocidad operativa** (sesiones largas, sin tener que loguearse cada vez) **sin perder trazabilidad** (audit log de cada acción + aprobaciones admin in-line registradas).

### 6.1 Roles del sistema

#### 6.1.1 Vendedor (rol "Normal")

- **Quién lo usa**: todos los empleados que atienden ventas.
- **PIN**: uno solo, compartido entre todos los cajeros.
- **Razón del PIN compartido**: la encargada explicitó que los empleados rotan en las computadoras y querer un PIN por persona genera fricción operativa que ellos no quieren tolerar (Sección 1.5, decisión cerrada). Se acepta el trade-off de no poder identificar a la persona física dentro del turno; el audit log registra dispositivo + hora + rol.
- **Alcance**: solo la sección **Venta** (Sección 7). No accede a Movimientos / Productos / Administración.

#### 6.1.2 Admin

- **Quién lo usa**: encargada (siempre) y dueño Julio (cuando entra remoto).
- **PIN**: uno por persona. La encargada tiene su PIN, el dueño tiene el suyo. **Mismos permisos** entre ambos.
- **Razón de PINs distintos**: trazabilidad. Si un día hay sospecha sobre alguna acción admin, el log dice "lo hizo el PIN de Julio el 15/04 a las 22:30 desde la PC remota" o "lo hizo la encargada el 14/04 a las 11:15 desde su PC".
- **Alcance**: todo el sistema. Las 4 secciones del Miro (Venta + Movimientos + Productos + Administración).

#### 6.1.3 No hay otros roles

Roles que **no existen** en este sistema (importante explicitarlo para evitar confusiones futuras):
- ❌ "Cajero personal" (uno por persona) — descartado
- ❌ "Contador" / "Solo lectura" — descartado, el contador trabaja con los Excels exportados, no entra al programa
- ❌ "Motoquero / Repartidor" — descartado, los repartidores no usan el programa, solo la encargada o el cajero les da el ticket
- ❌ "Súper-admin" / "Owner" — la encargada y el dueño son ambos Admin con los mismos permisos

Si en el futuro hace falta diferenciar (ej. el dueño quiere un permiso extra que la encargada no tenga), el modelo lo soporta agregando un campo `nivel` o sub-rol — pero hoy no aplica.

### 6.2 Autenticación con PIN de 4 dígitos

#### 6.2.1 Modelo

```
Usuario
  ├── id                    uuid
  ├── nombre                string ("Vendedor", "Encargada", "Julio")
  ├── rol                   enum: VENDEDOR | ADMIN
  ├── pin_hash              string (bcrypt — el PIN nunca se guarda en texto plano)
  ├── pin_ultimo_cambio_at  timestamp
  ├── intentos_fallidos     int default 0
  ├── bloqueado_hasta       timestamp nullable
  ├── activo                bool
  ├── creado_at             timestamp
  └── creado_por_id         FK Usuario nullable (admin que lo creó)
```

#### 6.2.2 Reglas

- PIN de **exactamente 4 dígitos numéricos**.
- Se **hashea con bcrypt** al guardarse (cost factor 10 — suficiente para 4 dígitos).
- Validación: el sistema rechaza PINs débiles obvios al cambiar (`0000`, `1234`, `1111`, etc. — lista corta de ~20 PINs prohibidos).
- **Bloqueo por intentos fallidos**: tras 5 intentos fallidos seguidos, el usuario queda bloqueado por 10 minutos (configurable). El otro admin puede desbloquearlo manualmente desde su sesión.
- **No hay "olvidé mi PIN"** automatizado. Si un admin olvida su PIN, el otro admin se lo resetea desde la UI de Empleados.
- El PIN del Vendedor compartido lo cambia cualquier admin desde Configuración → Usuarios.

### 6.3 Sesiones por dispositivo

El comportamiento de sesión depende del tipo de dispositivo donde corre la app:

| Tipo de dispositivo | Sesión por defecto | Expiración por inactividad |
|-|-|-|
| **PCs del local** (mostrador PC1–PC4, PC encargada en su oficina) | Vendedor (siempre logueado al arrancar) | No expira |
| **PC del dueño Julio** (remota) | Admin (con su PIN) | Expira a los 15 min de inactividad (configurable) |

#### 6.3.1 PCs del local — sesión Vendedor permanente

- Cuando arranca el dispositivo, la app entra automáticamente en sesión Vendedor.
- El Vendedor no necesita tipear PIN para empezar a trabajar — la sesión está abierta.
- Solo se pide PIN cuando se requiere una **acción admin** (Sección 6.4) o cuando alguien quiere **cambiar de sesión a Admin** explícitamente.

#### 6.3.2 PC encargada en su oficina del local

- Es una PC que está físicamente en el local pero en otra habitación, donde la encargada hace tareas administrativas.
- Por defecto arranca con sesión Vendedor (igual que las del mostrador), pero la encargada **inicia sesión Admin** con su PIN al sentarse a trabajar.
- Mientras está en sesión Admin, ve las 4 secciones del programa y puede operar libremente.
- Si se levanta y se aleja, la sesión Admin **se bloquea por inactividad** después de 15 minutos. Para volver a entrar, tipea su PIN nuevamente.
- Si quiere volver a sesión Vendedor explícitamente (ej. otro empleado va a usar esa PC mientras tanto), clickea "Cerrar sesión Admin" y vuelve a Vendedor.

#### 6.3.3 PC del dueño Julio (remota)

- Vive fuera del local, accede vía internet al panel admin de la VPS.
- Login con su PIN admin al entrar.
- Sesión expira a los 15 minutos de inactividad.
- Solo puede ver las secciones admin (Movimientos / Productos / Administración + dashboard de estadísticas). No carga ventas (no tiene impresora ni atiende clientes).

### 6.4 Aprobación admin in-line

Cuando un Vendedor intenta una acción que requiere aprobación admin, en lugar de obligarlo a "cerrar sesión y entrar como admin", aparece un modal:

```
┌────────────────────────────────────────────┐
│  ACCIÓN REQUIERE APROBACIÓN ADMIN          │
│                                            │
│  Acción: Anular venta finalizada #459980   │
│  Motivo: [el cajero escribe el motivo]     │
│                                            │
│  Ingresá PIN admin:                        │
│  ┌─┐ ┌─┐ ┌─┐ ┌─┐                          │
│  └─┘ └─┘ └─┘ └─┘                          │
│                                            │
│  [ Cancelar ]    [ Confirmar ]            │
└────────────────────────────────────────────┘
```

- Si el admin tipea su PIN correcto: la acción se ejecuta y queda en el audit log con quién aprobó.
- Si el PIN es incorrecto: queda registrado el intento fallido (asociado al usuario que tipeó, si se identifica).
- La sesión **sigue siendo Vendedor** después de aprobar — el admin no "queda logueado". Esto evita que se quede una sesión admin abierta sin que nadie se dé cuenta.

### 6.5 Permisos por acción (matriz)

✅ = puede hacerlo • ⚠️ = puede hacerlo con aprobación admin in-line • ❌ = no puede

| Acción | Vendedor | Admin |
|-|:-:|:-:|
| **Sección Venta** | | |
| Crear venta nueva | ✅ | ✅ |
| Editar venta abierta (Procesada) | ✅ | ✅ |
| Cobrar y finalizar venta | ✅ | ✅ |
| Aplicar descuento 10% efectivo | ✅ | ✅ |
| Aplicar descuento manual ≤ X% (configurable, default 5%) | ✅ | ✅ |
| Aplicar descuento manual > X% | ⚠️ | ✅ |
| Anular venta Procesada (sin pago) | ✅ | ✅ |
| Anular venta Finalizada | ⚠️ | ✅ |
| Imprimir tickets (cocina, cliente, delivery) | ✅ | ✅ |
| Reimprimir tickets de ventas pasadas | ⚠️ | ✅ |
| Ver historial de la sesión actual | ✅ | ✅ |
| Ver historial completo (otras sesiones, otros días) | ❌ | ✅ |
| **Sección Caja** | | |
| Abrir sesión de caja | ✅ | ✅ |
| Cerrar sesión de caja (cuenta efectivo) | ✅ | ✅ |
| Aprobar cierre de caja | ❌ | ✅ |
| Cargar otros ingresos / egresos en sesión actual | ⚠️ | ✅ |
| Registrar diferencia de caja > Y monto (configurable) | ⚠️ | ✅ |
| **Sección Productos** | | |
| Ver listado / buscar / Top 3 | ✅ (en sección Venta) | ✅ |
| Crear producto / modificador / combo | ❌ | ✅ |
| Editar producto / modificador / combo | ❌ | ✅ |
| Cambiar precio | ❌ | ✅ |
| Activar / desactivar producto | ❌ | ✅ |
| Aprobar cambios masivos de precios desde Excel | ❌ | ✅ |
| **Sección Movimientos** | | |
| Ver movimientos | ❌ | ✅ |
| Cargar ingreso / egreso | ❌ | ✅ |
| Cargar transferencia interna | ❌ | ✅ |
| Anular movimiento | ❌ | ✅ |
| Crear categoría nueva | ❌ | ✅ |
| **Sección Administración / Insumos y Proveedores** | | |
| Ver / editar proveedores e insumos | ❌ | ✅ |
| Cargar factura manual o por foto | ❌ | ✅ |
| Validar factura cargada por OCR | ❌ | ✅ |
| Pagar factura (con multi-cuenta) | ❌ | ✅ |
| Emitir factura a mayorista | ❌ | ✅ |
| **Sección Administración / Empleados** | | |
| Ver listado | ❌ | ✅ |
| Crear / editar empleado | ❌ | ✅ |
| Cargar pago de sueldo / adelanto | ❌ | ✅ |
| **Sección Administración / Clientes** | | |
| Ver listado | ⚠️ | ✅ |
| Crear / editar cliente | ✅ (en contexto de venta) | ✅ |
| Editar cumpleaños / aniversarios | ❌ | ✅ |
| **Sección Administración / Estadísticas** | | |
| Ver estadísticas básicas (ventas del turno) | ✅ (en sección Venta) | ✅ |
| Ver estadísticas detalladas (todos los reportes) | ❌ | ✅ |
| Exportar a Excel | ❌ | ✅ |
| Ver Logins (auditoría) | ❌ | ✅ |
| Ver audit log completo | ❌ | ✅ |
| **Configuración del sistema** | | |
| Configurar cuentas / posnets / listas de precios | ❌ | ✅ |
| Configurar % de descuento efectivo y otros parámetros | ❌ | ✅ |
| Crear / editar PINs de otros usuarios | ❌ | ✅ |
| Resetear PIN de otro admin | ❌ | ✅ |
| Configurar emails destinatarios de cierre | ❌ | ✅ |

#### 6.5.1 Parámetros configurables

Los siguientes valores son configurables desde la UI de admin (Configuración):
- `descuento_efectivo_pct` — default 10%
- `descuento_manual_max_vendedor_pct` — default 5%
- `diferencia_caja_max_sin_aprobacion` — default $1.000 (montos mayores requieren admin)
- `sesion_admin_inactividad_min` — default 15 minutos
- `intentos_fallidos_max` — default 5
- `bloqueo_pin_minutos` — default 10

### 6.6 Cambio de PIN

- Cualquier usuario puede cambiar **su propio** PIN ingresando el PIN actual + el nuevo (2 veces).
- Un admin puede **resetear** el PIN de cualquier otro usuario (incluido el otro admin) — el reseteo no requiere conocer el PIN viejo. Útil cuando alguien se olvida.
- Cada cambio de PIN queda en el audit log: quién lo cambió (uno mismo o un admin reseteando), cuándo, qué dispositivo.
- El PIN del Vendedor (compartido) se cambia desde Configuración → Usuarios → Vendedor → "Cambiar PIN". Cuando se cambia, todos los cajeros tienen que enterarse del nuevo (es responsabilidad operativa del admin notificarlos — no se notifica automáticamente).

### 6.7 Bloqueo de sesión

- **Inactividad** (en sesiones admin): la app monitorea actividad de teclado/mouse/touch. Tras `sesion_admin_inactividad_min`, la sesión se bloquea y muestra pantalla de PIN.
- **Cierre manual**: botón "Cerrar sesión" en menú de usuario.
- **Cierre forzado por otro admin**: en futuro (Sección 12 — pendiente). Hoy no se modela.
- **Apagado / reinicio del dispositivo**: la sesión persiste solo en PCs del local con rol Vendedor (al arrancar vuelve a entrar automáticamente). Las sesiones admin requieren tipear PIN otra vez al arrancar.

### 6.8 Audit log de logins (replica de Innovo "Logins")

Cada evento de autenticación queda registrado en una tabla específica:

```
LoginAudit
  ├── id                    uuid
  ├── usuario_id            FK Usuario nullable (null si el PIN fue inválido y no se identificó usuario)
  ├── tipo                  enum: LOGIN_EXITOSO | LOGIN_FALLIDO | APROBACION_ADMIN_INLINE | CAMBIO_PIN | RESET_PIN | BLOQUEO_INACTIVIDAD | DESBLOQUEO | LOGOUT_MANUAL
  ├── pc_origen             string ("PC1", "PC2", "PC encargada", "PC dueño Julio")
  ├── ip_origen             string nullable (relevante para PC del dueño remota)
  ├── timestamp             timestamp
  ├── accion_aprobada       string nullable (si tipo = APROBACION_ADMIN_INLINE: qué acción se aprobó)
  ├── accion_contexto       jsonb nullable (contexto de la aprobación: venta_id, monto, etc.)
  ├── usuario_solicitante_id  FK Usuario nullable (en aprobación admin: quién pidió la aprobación)
  └── observaciones         text nullable
```

Vista admin:
- "Logins" — listado filtrable por usuario / fecha / tipo / dispositivo.
- "Aprobaciones admin del último mes" — todas las acciones que requirieron PIN admin in-line.
- Alertas: ráfaga de intentos fallidos del mismo PIN en pocos minutos → posible intento de adivinar PIN.

### 6.9 Pendientes y supuestos de esta sección

| # | Pendiente | A confirmar con |
|-|-|-|
| 6.9.1 | ¿% máximo de descuento manual sin aprobación admin? | Dueño / encargada — propuesta default 5% |
| 6.9.2 | ¿Monto máximo de diferencia de caja sin aprobación admin? | Dueño / encargada — propuesta default $1.000 |
| 6.9.3 | ¿La encargada tiene autoridad para resetear el PIN del dueño Julio? | Dueño |
| 6.9.4 | ¿En sesiones del local (Vendedor permanente), querés que haya algún tipo de "cambio de turno" formal donde el cajero entrante "se identifique" con un sub-PIN? Hoy: no — el rol Vendedor lo comparten todos sin distinción. | Dueño / encargada |

---

## Sección 7 — Estructura de UI por rol (Vendedor / Admin)

> **Premisa que enmarca esta sección**: el sistema tiene **dos experiencias distintas** con prioridades opuestas. La sesión Vendedor (desktop-only) prioriza **velocidad** — el cajero tiene que cargar un pedido en menos de 30 segundos. La sesión Admin (desktop + mobile) prioriza **claridad** — la encargada y el dueño necesitan leer dashboards densos sin perderse. Esta sección define el lenguaje visual, el sistema de tokens, la estrategia responsive y el diseño de las pantallas core de cada sesión.
>
> Esta sección aplica las siguientes skills de diseño del usuario: `design-systems:design-token`, `ui-design:responsive-design`, `ui-design:design-screen`, `ui-design:visual-hierarchy`, `ui-design:layout-grid`, `ui-design:color-system`, `ui-design:typography-scale`, `ui-design:spacing-system`, `interaction-design:design-interaction`, `interaction-design:loading-states`, `interaction-design:feedback-patterns`, `interaction-design:error-handling-ux`, `interaction-design:micro-interaction-spec`, `prototyping-testing:wireframe-spec`, `prototyping-testing:user-flow-diagram`, `design-systems:component-spec`, `design-systems:icon-system`, `frontend-design:frontend-design`.

### 7.1 Visión de UI y aesthetic direction

**Decisión cerrada**: dirección estética **"Trattoria refinada"** — POS moderno con carácter italiano sutil. No clichés (sin manteles a cuadros, sin Comic Sans, sin tomates en logo). El alma viene del **detalle** (tipografía display con personalidad, color verde profundo de los tickets actuales, fondos color papel cremoso) no del **disfraz**.

Tres principios estéticos cerrados:

1. **Restraint with character** — Densidad funcional alta donde hace falta (Vendedor cargando pedidos, listados de movimientos), respiración generosa donde se lee (dashboards). Un display serif con personalidad, un sans neutral para todo lo demás. Animaciones mínimas — el cajero no quiere ver una animación cada vez que toca un botón.
2. **Verde Teresita es protagonista** — el verde profundo de los tickets actuales (#1F4D3C aprox.) es el color de marca. Domina los CTAs, los headers y los acentos. No se mezcla con otros verdes ni se diluye con violetas o azules genéricos. Ese verde + el cremoso del papel de impresión = la identidad.
3. **Numbers belong in tabular figures** — todo lo que sea plata se renderiza en una mono cuidada (JetBrains Mono o similar) con tabular figures. En un POS los números son los actores principales — alineados, legibles, predecibles.

### 7.2 Sistema de tokens

Arquitectura en 3 tiers (siguiendo metodología `design-systems:design-token`):
- **Globales**: valores raw (colores hex, sizes raw)
- **Alias**: semánticos, referencian globales (`color-action-primary`, `color-text-default`)
- **Componente**: scope específico (`button-primary-bg`, `card-border`)

Aquí defino solo los globales y alias principales. Los componente quedan como output de la fase de implementación.

#### 7.2.1 Color — globales

```css
/* Marca */
--green-teresita-50:  #F0F7F2;   /* fondos sutiles, hover backgrounds */
--green-teresita-100: #DCEAE0;   /* bordes activos, badges suaves */
--green-teresita-300: #6FA086;   /* secundarios */
--green-teresita-500: #2E7053;   /* hover de acción */
--green-teresita-700: #1F4D3C;   /* PRIMARY — verde de los tickets */
--green-teresita-900: #0F2D22;   /* hover de primary, texto sobre verde claro */

/* Crema (fondos warm) */
--cream-50:  #FDFBF7;            /* fondo dashboard admin */
--cream-100: #FAF6EE;            /* fondo principal del cajero */
--cream-200: #F0E9DC;            /* divisores sutiles, surfaces secundarias */
--cream-300: #E2DDD0;            /* bordes default */

/* Tinta (texto) */
--ink-900: #0F0F0E;              /* títulos, números importantes */
--ink-700: #2A2A28;              /* body */
--ink-500: #5C5C58;              /* secundario */
--ink-300: #9C9A93;              /* placeholder, deshabilitado */

/* Acentos funcionales */
--pomodoro-600: #B91C1C;         /* anular, error, destructivo */
--pomodoro-100: #FEE2E2;         /* fondo de error suave */
--basil-600:    #15803D;         /* éxito, confirmaciones */
--basil-100:    #DCFCE7;         /* fondo de éxito suave */
--saffron-600:  #C2410C;         /* warning, vencimientos próximos */
--saffron-100:  #FFEDD5;         /* fondo de warning suave */
--ocean-600:    #0369A1;         /* info, links secundarios */
--ocean-100:    #DBEAFE;         /* fondo de info suave */
```

#### 7.2.2 Color — alias (semánticos)

```css
/* Surfaces */
--surface-app:        var(--cream-50);    /* fondo de toda la app admin */
--surface-app-vendedor: var(--cream-100); /* fondo del cajero — un toque más warm */
--surface-card:       white;              /* tarjetas, modales */
--surface-elevated:   white;              /* elementos elevados con shadow */
--surface-sunken:     var(--cream-100);   /* inputs, surfaces hundidas */

/* Texto */
--text-default:       var(--ink-700);
--text-strong:        var(--ink-900);
--text-muted:         var(--ink-500);
--text-disabled:      var(--ink-300);
--text-on-primary:    var(--cream-50);    /* sobre verde primary */
--text-on-pomodoro:   white;              /* sobre rojo */

/* Bordes */
--border-default:     var(--cream-300);
--border-strong:      var(--ink-300);
--border-focus:       var(--green-teresita-500);

/* Acciones */
--action-primary-bg:        var(--green-teresita-700);
--action-primary-bg-hover:  var(--green-teresita-900);
--action-primary-bg-active: var(--green-teresita-900);
--action-primary-fg:        var(--cream-50);

--action-secondary-bg:        var(--cream-200);
--action-secondary-bg-hover:  var(--cream-300);
--action-secondary-fg:        var(--ink-900);

--action-destructive-bg:        var(--pomodoro-600);
--action-destructive-bg-hover:  #991616;
--action-destructive-fg:        white;

/* Estados */
--status-error-bg:    var(--pomodoro-100);
--status-error-fg:    var(--pomodoro-600);
--status-success-bg:  var(--basil-100);
--status-success-fg:  var(--basil-600);
--status-warning-bg:  var(--saffron-100);
--status-warning-fg:  var(--saffron-600);
--status-info-bg:     var(--ocean-100);
--status-info-fg:     var(--ocean-600);
```

#### 7.2.3 Tipografía

Tres familias (decisión cerrada):

```css
/* Display — para headers, números grandes en dashboards */
--font-display: 'Fraunces', 'Newsreader', Georgia, serif;
/* Fraunces es variable, free (Google Fonts), tiene SOFT ITALIC y opciones de optical size — perfecto para mezclar headers y números grandes */

/* Body — para todo el UI */
--font-body: 'Geist', 'General Sans', -apple-system, BlinkMacSystemFont, sans-serif;
/* Geist es moderno, neutral pero con personalidad sutil, free (Vercel) */

/* Mono — para números, IDs, códigos */
--font-mono: 'JetBrains Mono', 'IBM Plex Mono', Menlo, monospace;
/* Tabular figures por default, números alineados en columnas */
```

**Escala de tipografía** (modular ratio 1.25):

```css
--text-2xs:  11px / 16px;    /* footnotes, caption, table small */
--text-xs:   12px / 18px;    /* meta info, secondary labels */
--text-sm:   14px / 20px;    /* body small, dense tables */
--text-base: 16px / 24px;    /* body default */
--text-md:   18px / 26px;    /* body large, cards */
--text-lg:   22px / 30px;    /* section headers */
--text-xl:   28px / 36px;    /* page titles */
--text-2xl:  36px / 44px;    /* dashboard hero numbers */
--text-3xl:  48px / 56px;    /* máximos numéricos (Total Caja del turno) */
--text-4xl:  60px / 68px;    /* solo en pantallas hero del cajero (#orden cuando se llama) */

/* Pesos */
--weight-regular: 400;
--weight-medium: 500;
--weight-semibold: 600;
--weight-bold:    700;

/* Tabular figures activado para mono y para .num */
font-feature-settings: 'tnum' 1, 'lnum' 1;
```

#### 7.2.4 Espaciado (base 4px)

```css
--space-0:    0;
--space-1:    4px;
--space-2:    8px;
--space-3:    12px;
--space-4:    16px;
--space-5:    20px;
--space-6:    24px;
--space-8:    32px;
--space-10:   40px;
--space-12:   48px;
--space-16:   64px;
--space-20:   80px;
--space-24:   96px;
```

Uso semántico:
- `space-2` — inset interno de chips, badges
- `space-3` — gap entre elementos relacionados (label + input)
- `space-4` — padding default de cards, gap entre secciones cercanas
- `space-6` — padding de páginas, gap entre secciones
- `space-8`+ — separación entre bloques mayores

#### 7.2.5 Border radius

```css
--radius-sm:   4px;    /* badges, tags */
--radius-md:   8px;    /* botones, inputs default */
--radius-lg:   12px;   /* cards */
--radius-xl:   16px;   /* modales, hero cards */
--radius-2xl:  24px;   /* contenedores grandes */
--radius-full: 9999px; /* pills, avatars */
```

#### 7.2.6 Sombras

```css
--shadow-sm:   0 1px 2px 0 rgba(15, 15, 14, 0.05);
--shadow-md:   0 2px 4px -1px rgba(15, 15, 14, 0.06), 0 4px 8px -2px rgba(15, 15, 14, 0.05);
--shadow-lg:   0 4px 8px -2px rgba(15, 15, 14, 0.08), 0 12px 24px -4px rgba(15, 15, 14, 0.08);
--shadow-xl:   0 8px 16px -4px rgba(15, 15, 14, 0.1), 0 24px 48px -8px rgba(15, 15, 14, 0.1);
--shadow-modal: 0 24px 64px -12px rgba(15, 15, 14, 0.25);

--shadow-focus-ring: 0 0 0 3px rgba(31, 77, 60, 0.25);  /* verde con alpha */
```

#### 7.2.7 Motion (mínima y funcional)

```css
--duration-instant: 80ms;    /* hovers, focus rings */
--duration-fast:    150ms;   /* drawers cortos, tooltips */
--duration-base:    250ms;   /* modales, transiciones de página */
--duration-slow:    400ms;   /* solo confirmaciones grandes (cierre exitoso) */

--ease-out:      cubic-bezier(0.16, 1, 0.3, 1);   /* default — feels snappy */
--ease-in-out:   cubic-bezier(0.65, 0, 0.35, 1);
--ease-spring:   cubic-bezier(0.34, 1.56, 0.64, 1); /* solo para confirmaciones positivas */
```

**Regla**: nada se mueve sin razón. El cajero no quiere ver fade-ins cada vez que abre un modal. Animación = cuando comunica algo (estado nuevo, éxito, error).

### 7.3 Estrategia responsive

#### 7.3.1 Breakpoints (decisión cerrada)

```css
--bp-sm:   640px;    /* phones grandes (iPhone Pro, Android grandes) */
--bp-md:   768px;    /* tablets verticales */
--bp-lg:   1024px;   /* tablets horizontales, laptops chicas */
--bp-xl:   1280px;   /* desktops y laptops standard */
--bp-2xl:  1536px;   /* desktops grandes */
```

#### 7.3.2 Qué adaptación se aplica a cada sesión

| Sesión | Mobile (<768px) | Tablet (768–1023px) | Desktop (≥1024px) |
|-|-|-|-|
| **Vendedor** | ❌ **No disponible** — pantalla de bloqueo "Esta sesión solo está disponible en computadoras del local" | ❌ Idem | ✅ Layout completo, optimizado para 1366×768+ |
| **Admin** | ✅ Layout móvil (drawer nav, dashboards condensados, formularios apilados) | ✅ Layout intermedio | ✅ Layout completo con sidebar permanente |

**Razón de bloquear Vendedor en mobile** (decisión cerrada):
- Cargar pedidos en un teléfono es lento e introduce errores. El cajero vive en una PC del local.
- Si un día se cae una PC y un cajero tiene que improvisar con un celular, el bloqueo se podría destrabar en una pantalla de "modo emergencia" (Sección 12 — pendiente).

#### 7.3.3 Patrones responsive del Admin

| Patrón | Mobile | Tablet | Desktop |
|-|-|-|-|
| **Navegación entre secciones** | Bottom tab bar (5 íconos: Inicio / Mov / Prod / Admin / Yo) | Top tabs | Sidebar persistente a la izquierda |
| **Tablas (movimientos, facturas)** | Cards apiladas con info clave + botón "ver más" | Tabla compacta con scroll horizontal | Tabla completa con todas las columnas |
| **Dashboards** | KPIs apilados en columna 1, gráficos full-width | KPIs en grid 2 col, gráficos full-width | KPIs en grid 4 col, gráficos en grid 2 col |
| **Formularios largos** | Multi-step wizard | Layout de una columna | Layout de dos columnas (form + preview) |
| **Modales** | Bottom sheet o full-screen | Centered modal con padding | Centered modal default |
| **Filtros** | Botón "Filtros" → drawer | Top bar de filtros | Sidebar de filtros + top bar |
| **Acciones por fila** | Swipe right/left para anular/editar | Botón overflow (•••) | Botones inline visibles |
| **Drill-down** | Push navigation (slide-in) | Modal | Sidebar drill-down o modal |

#### 7.3.4 Lo que NO está disponible en mobile (decisión cerrada)

Para mantener mobile usable y enfocado, ciertas operaciones complejas se restringen a desktop:

- ❌ Edición masiva de productos (>10 a la vez)
- ❌ Importación de Excel
- ❌ Configuración del sistema (cuentas, posnets, listas de precios)
- ❌ Generación de facturas emitidas a mayoristas (porque requiere muchos campos)
- ❌ Carga manual de facturas de proveedores con OCR (en mobile sí se puede tomar la foto y subir, pero la validación se hace después en desktop)

Estas se bloquean con mensaje "Esta operación está disponible solo en escritorio" + botón "Recordatorio cuando vuelva a desktop".

#### 7.3.5 Mobile patterns específicos

- **Bottom navigation** con 5 ítems máximo. El 5º es "Más" / "Yo" (perfil + opciones).
- **Pull to refresh** en listados y dashboards.
- **Touch targets mínimos 44×44px** (estándar Apple HIG / Material).
- **Gestos**: swipe lateral en filas para acciones rápidas (anular venta, marcar factura como pagada).
- **Sin hover** — todo basado en tap y long-press. Tooltips se vuelven sheets contextuales.
- **Inputs numéricos** disparan teclado numérico (`inputmode="decimal"`, `inputmode="numeric"`).

### 7.4 Sesión Vendedor — diseño detallado

> **Optimizada para velocidad operativa.** El cajero tiene que poder cargar un pedido típico de 3 items en menos de 30 segundos. Cada click cuesta. Cada milisegundo de loading se siente. El layout es denso y fijo (no scroll para acciones primarias).

#### 7.4.1 Layout principal

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ HEADER (56px)                                                                │
│  🍝 SANTA TERESITA  Sesión: TARDE 27/04   Vendedor: PC2   |  Pedido nuevo +  │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                          │                   │
│   CATÁLOGO (50% del ancho)                               │  CARRITO (35%)    │
│  ┌────────────────────────────────────────────────────┐ │ ┌───────────────┐ │
│  │  [🔥 TOP 3 — categoría actual]                     │ │ │ PEDIDO #047   │ │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐    │ │ │ Hora: 19:42   │ │
│  │  │ Sorrentinos│ │ Fideos al  │ │ Ñoquis     │    │ │ │ Mostrador     │ │
│  │  │   Ricot.MJ │ │   huevo    │ │   Papa     │    │ │ ├───────────────┤ │
│  │  │   $X.XXX   │ │   $X.XXX   │ │   $X.XXX   │    │ │ │ Items:        │ │
│  │  └────────────┘ └────────────┘ └────────────┘    │ │ │               │ │
│  │                                                    │ │ │ Sorrent. RMJ  │ │
│  │  CATEGORÍAS                                       │ │ │  6 u  $X.XXX  │ │
│  │  ┌─────────────────────────────────────────────┐  │ │ │  [ ✕ editar ] │ │
│  │  │ Pastas frescas │ Porc. calientes │ Pizzas  │  │ │ │               │ │
│  │  │ Tartas │ Salsas │ Empanadas │ Otros        │  │ │ │ Salsa Fileto  │ │
│  │  └─────────────────────────────────────────────┘  │ │ │  1 u  $6.000  │ │
│  │                                                    │ │ │  [ ✕ editar ] │ │
│  │  PRODUCTOS DE LA CATEGORÍA SELECCIONADA            │ │ │               │ │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │ │ ├───────────────┤ │
│  │  │ Rav. │ │ Sorr.│ │ Fid. │ │ Ñoq. │ │ Tort.│    │ │ │ Subtotal:     │ │
│  │  │ $X   │ │ $X   │ │ $X   │ │ $X   │ │ $X   │    │ │ │     $X.XXX    │ │
│  │  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘    │ │ │               │ │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐    │ │ │ TOTAL:        │ │
│  │  │ Las. │ │ Rond.│ │ Cane.│ │ Crepe│ │ Combo│    │ │ │   $XX.XXX     │ │
│  │  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘    │ │ │               │ │
│  │                                                    │ │ │ ┌───────────┐ │ │
│  │  [ 🔍 Buscar producto / código rápido ]            │ │ │ │ COBRAR    │ │ │
│  └────────────────────────────────────────────────────┘ │ │ │  $XX.XXX  │ │ │
│                                                          │ │ └───────────┘ │ │
│                                                          │ └───────────────┘ │
├──────────────────────────────────────────────────────────────────────────────┤
│ FOOTER FIJO (48px)                                                           │
│  📋 Pedidos abiertos: 4   ✓ Cerrados hoy: 23   |   ⚙ Config (PIN admin)     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Decisiones cerradas del layout**:

- **Header de 56px**: solo info de contexto + botón "Pedido nuevo +". Si el cajero necesita ver más, el footer y el carrito tienen el resto.
- **División 50/35/15** del espacio disponible (catálogo / carrito / margen). El carrito es **siempre visible** — no es modal ni colapsable. El cajero ve el pedido construyéndose en tiempo real.
- **Top 3 contextual** arriba del catálogo, dentro de la categoría actual. Al cambiar de categoría, cambia el Top 3.
- **Categorías como tabs horizontales**, no dropdown. Click directo, sin subniveles ocultos.
- **Productos como cards 96×96px mínimo**, con nombre + precio. Tap para agregar al carrito (si el producto no tiene modificadores) o abrir modal de modificadores (si los tiene).
- **Footer con stats** del turno actual, sin scroll. Acceso a config con PIN admin in-line.

#### 7.4.2 Carga de un producto con modificadores

Modal centrado, no full-screen. Optimizado para clicks rápidos:

```
┌──────────────────────────────────────────────────┐
│  Sorrentinos                              [ ✕ ]  │
│  ────────────────────────────────────────────    │
│                                                   │
│  Cantidad:                                        │
│  ┌───┐  ┌───┐  ┌───┐  ┌───┐  ┌─────────┐        │
│  │ 6 │  │ 12│  │ 24│  │ 48│  │ Otra ▾  │        │
│  └───┘  └───┘  └───┘  └───┘  └─────────┘        │
│                                                   │
│  Relleno:                       (obligatorio)    │
│  ◉ Ricotta, Mozzarella y Jamón                  │
│  ○ Calabaza y Mozzarella                        │
│  ○ Caprese                                       │
│  ○ Cipollino                                     │
│  ○ Verdura, Jamón y Mozz                        │
│  ○ Roquefort, Mozz, Ricota y Nuez               │
│  ○ Mozzarella, Ricota y Nuez                    │
│                                                   │
│  Observaciones (opcional):                        │
│  ┌────────────────────────────────────────┐      │
│  │ ej. sin sal, extra queso...            │      │
│  └────────────────────────────────────────┘      │
│                                                   │
│  ─────────────────────────────────────────       │
│                          Subtotal:  $X.XXX        │
│                                                   │
│  [ Cancelar ]              [ Agregar al pedido ]  │
└──────────────────────────────────────────────────┘
```

- **Cantidades preset** (6, 12, 24, 48 según el producto) + opción "Otra". Click directo sin tipear.
- **Modificadores como radio buttons** verticales, grandes, con espacio para tap.
- **Subtotal en vivo** abajo — cambia al elegir variantes con `delta_precio` distinto de cero.
- **Atajos de teclado**: Enter = "Agregar al pedido", Esc = "Cancelar", flechas para navegar opciones.

#### 7.4.3 Cobro — pantalla principal

Click en "COBRAR $XX.XXX" del carrito → pantalla de cobro:

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Volver al pedido                                              │
│                                                                  │
│  PEDIDO #047  —  TOTAL A COBRAR                                  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                                                            │ │
│  │                $ 27.117                                    │ │
│  │                                                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  MÉTODO DE PAGO                                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │   EFECTIVO   │ │    DÉBITO    │ │   CRÉDITO    │            │
│  │      💵      │ │      💳      │ │      💳      │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │   MP / QR    │ │ TRANSFER.    │ │   DIVIDIR    │            │
│  │      📱      │ │      🏦      │ │      ⚖️      │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
│                                                                  │
│  ─────────────────────────────────────────────                   │
│  💚 EFECTIVO con 10% DE DESCUENTO                                │
│     Total con descuento:  $ 24.405   (ahorrás $ 2.712)           │
│  ─────────────────────────────────────────────                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

- **Total en hero** — número grande, mono, alineado al centro. Es el dato más importante de la pantalla.
- **Métodos en grid 3×2** + opción "Dividir" para pago split.
- **Botón de descuento 10% efectivo** SEPARADO debajo, con visual distinto (línea divisora arriba). Solo aparece si canal = mostrador.
- Al clickear un método: si es Efectivo, pasa a la pantalla de "Recibí $X" para calcular cambio. Si es tarjeta, pasa a confirmar con posnet (integrado o manual según Sección 4.8.2bis). Si es Dividir, abre el flujo de split.

#### 7.4.4 Cobro — pago dividido (split)

Click en "DIVIDIR" → pantalla de split:

```
┌──────────────────────────────────────────────────────────────────┐
│  ← Volver                            PEDIDO #047  —  $ 27.117    │
│                                                                  │
│  DIVIDIR EL PAGO                                                 │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ EFECTIVO              [ 10.000  ▾ ]   [ ✕ ]               │ │
│  │ DÉBITO     Posnet Santander  [ 17.117  ▾ ]   [ ✕ ]        │ │
│  │                                                            │ │
│  │ [ + Agregar otro método ]                                  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Asignado:    $ 27.117                                           │
│  Falta:       $     0       ✓                                    │
│                                                                  │
│                                  [ Confirmar y cobrar ]          │
└──────────────────────────────────────────────────────────────────┘
```

#### 7.4.5 Historial de la sesión actual

Botón en el footer del cajero → drawer lateral derecho:

```
┌─────────────────────────────────────────────┐
│  HISTORIAL — TARDE 27/04        [ ✕ ]       │
│  ──────────────────────────────────────     │
│                                              │
│  ABIERTOS (4)                                │
│  ┌─────────────────────────────────────────┐│
│  │ #047  19:42  Mostrador  $ 27.117  →    ││
│  │ #048  19:46  Pedidos YA  $ 19.000  →   ││
│  │ #049  19:51  Mostrador  $ 8.200  →     ││
│  │ #050  19:54  Mostrador  $ 31.700  →    ││
│  └─────────────────────────────────────────┘│
│                                              │
│  CERRADOS HOY (23)                           │
│  ┌─────────────────────────────────────────┐│
│  │ #046  19:28  Mostrador  ✓  $ 12.400    ││
│  │ #045  19:15  Delivery   ✓  $ 22.800    ││
│  │ #044  19:08  Mostrador  ✓  $ 8.500     ││
│  │ ...                                     ││
│  └─────────────────────────────────────────┘│
│                                              │
│  ANULADOS HOY (1)                            │
│  ┌─────────────────────────────────────────┐│
│  │ #042  18:45  Mostrador  ✕  $ 5.600     ││
│  │      Motivo: cliente se arrepintió     ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

- Click en una venta → ver detalle (no editable si está finalizada o anulada).
- Click en una abierta → reabre el pedido para editar/cobrar.
- Filtros simples: por canal, por monto, por hora.

#### 7.4.6 Atajos de teclado (decisión cerrada)

Para que el cajero rápido pueda cargar sin mouse:

| Atajo | Acción |
|-|-|
| `F1` | Pedido nuevo |
| `F2` | Buscar producto |
| `F3` | Top 3 |
| `F4` | Abrir carrito (cuando no está visible) |
| `F9` | Cobrar |
| `F10` | Historial |
| `Esc` | Cerrar modal / cancelar |
| `Enter` | Confirmar acción primaria |
| `Ctrl+Z` | Deshacer último item agregado al carrito |
| `Ctrl+Backspace` | Vaciar carrito (con confirmación) |
| `Ctrl+P` | Reimprimir último ticket (requiere PIN admin) |

### 7.5 Sesión Admin — diseño detallado

> **Optimizada para claridad y profundidad.** La encargada y el dueño leen dashboards densos, drill-down a detalle, y operan acciones administrativas. Más respiración, jerarquía visual fuerte, datos primero.

#### 7.5.1 Layout principal (desktop)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  🍝 Santa Teresita Pastas                          Encargada  ⚙  🔔 (3)   ▾ │
├────────────┬─────────────────────────────────────────────────────────────────┤
│ NAVEGACIÓN │  CONTENIDO                                                      │
│ (240px)    │                                                                 │
│            │                                                                 │
│ ▾ Inicio   │  [contenido de la sección actual]                               │
│   📊 Dash  │                                                                 │
│            │                                                                 │
│ ▾ Movim.   │                                                                 │
│   💸 Egres │                                                                 │
│   💰 Ingres│                                                                 │
│            │                                                                 │
│ ▾ Productos│                                                                 │
│   📋 Listad│                                                                 │
│   🏷 Precios│                                                                │
│            │                                                                 │
│ ▾ Admin.   │                                                                 │
│   👥 Emple │                                                                 │
│   🤝 Clien │                                                                 │
│   📦 Insum │                                                                 │
│   📈 Estad │                                                                 │
│   ⚙  Config │                                                                 │
│            │                                                                 │
│ ▾ Caja     │                                                                 │
│   📅 Sesión │                                                                │
│   💵 Cierr.│                                                                 │
│            │                                                                 │
└────────────┴─────────────────────────────────────────────────────────────────┘
```

- **Sidebar 240px** persistente, colapsable a 64px (solo iconos).
- **Header 56px** con identidad + nombre de usuario activo + notificaciones + menú perfil.
- **Notificaciones** (🔔) — badge con contador. Lista de items pendientes (cambios de Excel sin aprobar, facturas sin validar, sesiones de caja sin aprobar, vencimientos próximos).

#### 7.5.2 Dashboard inicial (KPI hero + drill-down)

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Inicio                                                       Hoy ▾  ⟳    │
│  ────────────────────────────────────────────────────────────              │
│                                                                            │
│  KPIs PRINCIPALES (grid 4 col)                                             │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌──────────┐ │
│  │ Ventas hoy      │ │ Cobrado en caja │ │ Por cobrar      │ │ Egresos  │ │
│  │                 │ │                 │ │                 │ │          │ │
│  │  $ 487.230      │ │  $ 312.450      │ │  $ 174.780      │ │ $ 38.100 │ │
│  │                 │ │                 │ │ ─────────────── │ │          │ │
│  │  ↑ 12% vs ayer  │ │  103 ventas     │ │ Tarjetas $ 130k │ │ 4 movs   │ │
│  │                 │ │                 │ │ Plataformas $44k│ │          │ │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘ └──────────┘ │
│                                                                            │
│  PRÓXIMOS DEPÓSITOS (próximos 20 días)                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ Mañana 28/04        $ 145.230   ← Tarjeta Débito Santander           │ │
│  │ 02/05               $ 320.180   ← Tarjeta Crédito Santander          │ │
│  │ 02/05               $ 387.500   ← Pedidos YA                         │ │
│  │ 04/05               $ 87.000    ← RAPPI                              │ │
│  │ ...                                                                  │ │
│  │ Total 20 días:     $ 5.599.920                                       │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  PENDIENTES                                                                │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ ⚠ 3 cambios de Excel pendientes de aprobar    →                      │ │
│  │ ⚠ 5 facturas cargadas por OCR sin validar     →                      │ │
│  │ ⚠ Sesión caja TARDE de ayer sin aprobar       →                      │ │
│  │ ⚠ 2 facturas vencen en los próximos 3 días    →                      │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  GRÁFICOS (grid 2 col)                                                     │
│  ┌─────────────────────────────────────┐ ┌────────────────────────────┐  │
│  │ Ventas por hora hoy                 │ │ Top 10 productos del mes   │  │
│  │ [gráfico de barras]                 │ │ [gráfico de barras horiz.] │  │
│  └─────────────────────────────────────┘ └────────────────────────────┘  │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

- **KPIs como cards** con hero number en `--font-display` + comparativo dinámico vs período anterior.
- **Próximos depósitos** (Sección 3.7.2) — el dato más útil para planificar, lo ponemos visible.
- **Pendientes** — todas las acciones que requieren la atención del admin, en un panel siempre presente.
- **Gráficos** — Recharts o Apache ECharts. Estilo Verde Teresita para líneas/barras principales, neutro para fondos.

#### 7.5.3 Pago de facturas multi-cuenta (replicando Sección 5.6.4)

Pantalla "Pagar facturas seleccionadas":

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ← Volver       Pagar facturas                                           │
│                                                                          │
│  PROVEEDOR: Vacalin                                                      │
│                                                                          │
│  FACTURAS SELECCIONADAS (3)                                              │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ ☑ FB 0003-00012345  Vence 28/04  $ 200.000   Aplicar: [200.000]   │ │
│  │ ☑ FB 0003-00012398  Vence 30/04  $ 500.000   Aplicar: [500.000]   │ │
│  │ ☑ FB 0003-00012420  Vence 02/05  $ 300.000   Aplicar: [300.000]   │ │
│  │                                                                    │ │
│  │ Total facturas:                                  $ 1.000.000      │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  CUENTAS DESDE LAS QUE PAGAR                                             │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ Caja física    EFECTIVO        $ [ 300.000  ]    [✕]              │ │
│  │ Santander      TRANSFERENCIA   $ [ 400.000  ]    Ref: [_______]   │ │
│  │ Galicia        TRANSFERENCIA   $ [ 300.000  ]    Ref: [_______]   │ │
│  │                                                                    │ │
│  │ [ + Agregar otra cuenta ]                                          │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  Suma asignada: $ 1.000.000        ✓                                     │
│  Diferencia:    $        0                                               │
│                                                                          │
│                                            [ Confirmar pago ]            │
└──────────────────────────────────────────────────────────────────────────┘
```

#### 7.5.4 Aprobación de cambios pendientes de Excel (Sección 9)

Modal que aparece al entrar el admin si hay cambios detectados:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CAMBIOS DETECTADOS EN EXCEL DE PRECIOS                            [ ✕ ] │
│  Detectado: hace 2 horas                                                 │
│                                                                          │
│  RESUMEN                                                                 │
│  • 137 productos con cambio de precio                                    │
│  • 4 productos no encontrados en el sistema (filas nuevas o tipos)      │
│  • 2 filas con errores (precio negativo o vacío)                        │
│                                                                          │
│  CAMBIOS DE PRECIO                                                       │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ ☑ Sorrentinos              $ 23.500  →  $ 24.205   (+3,0%)        │ │
│  │ ☑ Sorrentinos de Salmón    $ 45.000  →  $ 46.350   (+3,0%)        │ │
│  │ ☑ Fideos al huevo (kg)     $ 13.000  →  $ 13.390   (+3,0%)        │ │
│  │ ☑ Ñoquis (kg)              $ 13.900  →  $ 14.317   (+3,0%)        │ │
│  │ ☑ ...                                                              │ │
│  │                                                                    │ │
│  │ [ ✓ Aprobar todos los marcados ]   [ Aprobar selección ]          │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ERRORES (no se aplican)                                                 │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ ⚠ "Pizza Rúcula y panceta": precio negativo (-$ 100)              │ │
│  │ ⚠ "Tarta Vigilia chica": fila vacía en Excel                       │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  [ Posponer ]                          [ Rechazar todo ]   [ Aprobar ]   │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Diff visible**: precio viejo → precio nuevo + variación porcentual.
- **Aprobación granular** (selección por checkbox) o en bloque.
- **Errores se muestran pero no se aplican** — el admin sabe que hay basura en el Excel y puede ir a corregirla.

### 7.6 Sesión Admin — móvil

#### 7.6.1 Layout móvil

```
┌─────────────────────┐
│ ☰  Santa Teresita 🔔│  Header 48px
├─────────────────────┤
│                     │
│  CONTENIDO          │
│                     │
│  KPI hoy            │
│  ┌───────────────┐  │
│  │ $ 487.230     │  │
│  │ Ventas hoy    │  │
│  └───────────────┘  │
│  ┌───────────────┐  │
│  │ $ 312.450     │  │
│  │ Caja          │  │
│  └───────────────┘  │
│                     │
│  Pendientes (3)     │
│  ┌───────────────┐  │
│  │ → Cambios Exc.│  │
│  │ → 5 facturas  │  │
│  │ → Cierre tard │  │
│  └───────────────┘  │
│                     │
│  Próx. depósitos    │
│  ┌───────────────┐  │
│  │ Mañana        │  │
│  │ $ 145.230     │  │
│  │ T.Déb.Sant.   │  │
│  └───────────────┘  │
│                     │
├─────────────────────┤
│ 🏠   💸   📋   ⚙   │  Bottom tabs
│Inicio Mov Prod Más  │
└─────────────────────┘
```

- Bottom tabs con 4 secciones (Inicio / Movimientos / Productos / Más).
- Cards apilados verticalmente, full-width.
- Header con drawer (☰) para navegación secundaria + notificaciones.

#### 7.6.2 Pantallas adaptadas en mobile

| Pantalla | Mobile |
|-|-|
| Dashboard inicial | KPIs apilados, gráficos full-width, drill-down a detalle por push navigation |
| Movimientos | Cards por movimiento (no tabla); filtros en drawer |
| Productos (listado) | Cards con foto + nombre + precio; modal full-screen para edit |
| Pagar facturas | Multi-step wizard: paso 1 elegir facturas, paso 2 distribuir cuentas, paso 3 confirmar |
| Cierre de caja | Vista resumen apilada; "aprobar cierre" como CTA grande al final |
| Aprobación cambios Excel | Lista con diff por fila; tap = ver detalle; bulk approve abajo |

### 7.7 Componentes core del sistema de diseño

Inventario inicial (no exhaustivo) — se irá refinando durante implementación:

| Componente | Variantes | Uso |
|-|-|-|
| `Button` | primary, secondary, destructive, ghost, link | CTAs |
| `IconButton` | sm, md, lg | acciones secundarias en cards |
| `Input` | text, number, currency, date, time | formularios |
| `Select` | single, multi, search | dropdowns |
| `Checkbox` / `Radio` | default, disabled | formularios |
| `Card` | default, elevated, sunken | contenedores |
| `Badge` | success, warning, error, info, neutral | estados |
| `Pill` | filter, removable | tags |
| `Modal` | sm, md, lg, full | overlays |
| `Drawer` | left, right, bottom | navegación secundaria, mobile menu |
| `Toast` | success, error, info, warning | feedback efímero |
| `Banner` | info, warning, error | feedback persistente |
| `Tabs` | underline, pills | navegación de secciones |
| `Table` | default, dense, sticky-header | listados |
| `DataCard` (mobile) | row de tabla representada como card | mobile |
| `KPI` | hero, compact, comparative | dashboards |
| `Chart` | bar, line, area, pie, donut | dashboards |
| `Skeleton` | text, card, table-row | loading state |
| `EmptyState` | con ilustración o icono | listados sin datos |
| `Pagination` | numeric, infinite scroll | tablas largas |
| `Tooltip` (desktop) / `Popover` (mobile) | | ayudas contextuales |
| `NumPad` (mobile) | numeric input grande | montos en mobile |
| `PinInput` | 4 dígitos | autenticación |
| `ProductCard` | grid item, list item | catálogo del cajero |
| `OrderCard` | row del historial | historial |
| `MoneyAmount` | sm, md, lg, xl, hero | display de plata, mono + tabular |

### 7.8 Iconografía

**Sistema de iconos**: **Lucide** (open source, mantenido, 1500+ iconos consistentes).

- Tamaño base: 20px.
- Stroke width: 2px (default Lucide).
- Color: hereda del texto `currentColor`.
- Iconos custom (logo, productos específicos): SVG individuales en `/assets/icons/`.

**Reglas**:
- Un icono por concepto (no usar 3 iconos distintos para "edit").
- Iconos de acción siempre acompañados de label en pantallas grandes (excepto en móviles donde el espacio aprieta).
- Sin emojis en producción (los uso solo para los wireframes ASCII).

### 7.9 Patrones de interacción

#### 7.9.1 Loading states

Estrategia (siguiendo metodología `interaction-design:loading-states`):

- **<200ms**: nada. No mostrar nada porque el usuario apenas lo nota.
- **200ms–1s**: spinner inline o skeleton muy sutil. No bloquear UI.
- **1s–4s**: skeleton del componente que se está cargando (lista, card, dashboard).
- **>4s**: progress bar con descripción ("Sincronizando con Drive — 60%").

**Reglas**:
- El cajero **nunca** debería ver un loading >1s en operaciones de carga de pedido (todo es local-first, instantáneo).
- Los dashboards admin pueden tolerar 1–2s de loading inicial con skeletons.
- Operaciones largas (importar Excel, sync masivo) van con progress bar + opción de "minimizar" a notificación.

#### 7.9.2 Feedback patterns

- **Toast** (efímero, 4s, esquina inferior derecha en desktop / bottom en mobile):
  - Verde Basil: éxito ("Pedido finalizado #047")
  - Rojo Pomodoro: error ("Error al imprimir — reintentar")
  - Amarillo Saffron: warning ("Cierre de caja pendiente")
  - Azul Ocean: info ("3 cambios de Excel detectados")
- **Banner** (persistente, hasta cerrar manualmente, ancho completo arriba): para info crítica que requiere atención sostenida (ej. "Se cayó la conexión con la VPS — operando en modo local").
- **Inline error** (debajo del input): validación de formularios.
- **Modal de confirmación**: solo para acciones destructivas o irreversibles (anular venta finalizada, eliminar producto). Siempre con motivo opcional o obligatorio según corresponda.

#### 7.9.3 Errores y recuperación

Cuatro categorías:

| Tipo | Ejemplo | Comunicación |
|-|-|-|
| Validación (input) | "Precio no puede ser negativo" | Inline error, no bloquea, foco vuelve al input |
| Operacional (recuperable) | "No se pudo imprimir el ticket" | Toast con botón "Reintentar" + opción "Imprimir después" |
| Sistema (recuperable) | "Sin conexión con la nube" | Banner persistente, sigue operando en local |
| Sistema (no recuperable) | "Error fatal — reportá a soporte" | Modal con mensaje claro + ID de error + opción de copiar al portapapeles |

**Regla**: nunca mostrar stack traces o mensajes técnicos al usuario. Cada error tiene un mensaje en lenguaje humano + acción recomendada.

#### 7.9.4 Confirmaciones

- **Acciones reversibles** (agregar item, cambiar precio): no piden confirmación. Hay undo.
- **Acciones irreversibles** (anular venta finalizada, eliminar producto): modal de confirmación con motivo + escribir el nombre del producto/venta para confirmar (en operaciones críticas).
- **Acciones masivas** (aplicar 137 cambios de precio): confirmación con resumen ("vas a aplicar 137 cambios — esto afecta el catálogo activo, ¿confirmás?").

#### 7.9.5 Aprobación admin in-line (Sección 6.4)

Componente `AdminApprovalModal`:

```
┌────────────────────────────────────────────┐
│  ACCIÓN REQUIERE APROBACIÓN ADMIN          │
│                                            │
│  📋 Acción:                                 │
│  Anular venta finalizada #459980           │
│                                            │
│  💬 Motivo (obligatorio):                  │
│  ┌──────────────────────────────────────┐ │
│  │                                      │ │
│  └──────────────────────────────────────┘ │
│                                            │
│  🔢 PIN admin:                             │
│  ┌─┐ ┌─┐ ┌─┐ ┌─┐                          │
│  │ │ │ │ │ │ │ │                          │
│  └─┘ └─┘ └─┘ └─┘                          │
│                                            │
│  [ Cancelar ]              [ Confirmar ]   │
└────────────────────────────────────────────┘
```

- Modal centrado en desktop, bottom sheet en mobile.
- PIN input con 4 cuadrados grandes, foco automático, avance al siguiente al tipear.
- Auto-submit cuando se completa el 4° dígito (configurable).

### 7.10 Skills aplicadas — checklist de fase de diseño

Esta sección define la spec. La implementación visual concreta (Figma, Sketch, código) se hará en una fase de diseño separada que invocará explícitamente las siguientes skills, ya sea de forma manual o automatizada:

| Skill | Uso en fase de diseño |
|-|-|
| `frontend-design:frontend-design` | Generar la implementación inicial del lenguaje visual definido (componentes core como código React + Tailwind) |
| `ui-design:design-screen` (orquestador) | Para cada una de las pantallas listadas en 7.4 y 7.5, generar mockup detallado |
| `ui-design:visual-hierarchy` | Validar la jerarquía visual de cada pantalla (qué se mira primero) |
| `ui-design:layout-grid` | Definir el grid de 12 columnas para desktop, 4 para mobile |
| `ui-design:color-system` | Refinar la paleta y validar contraste WCAG AA |
| `ui-design:typography-scale` | Validar la escala tipográfica con texto real del sistema |
| `ui-design:spacing-system` | Validar consistencia de espaciado |
| `ui-design:responsive-design` | Specs detalladas de cada pantalla en cada breakpoint |
| `ui-design:data-visualization` | Diseño de gráficos del dashboard admin (Top productos, ventas por hora, etc.) |
| `interaction-design:design-interaction` | Specs detalladas para los flujos críticos (carga venta, cobro split, aprobación Excel) |
| `interaction-design:state-machine` | Modelar estados visuales de la venta, factura, sesión de caja |
| `interaction-design:loading-states` | Diseño de skeletons y progress bars |
| `interaction-design:feedback-patterns` | Diseño de toasts, banners, badges de estado |
| `interaction-design:error-handling-ux` | Diseño de cada categoría de error con su mensaje y recuperación |
| `interaction-design:micro-interaction-spec` | Definir las pocas micro-animaciones permitidas (success de cobro, badge de notificación) |
| `prototyping-testing:wireframe-spec` | Wireframes en alta fidelidad para validación con cliente antes de codear |
| `prototyping-testing:user-flow-diagram` | Diagrama del flujo del cajero de pedido nuevo a cerrado |
| `design-systems:component-spec` | Spec de cada componente del inventario 7.7 (props, estados, variantes, accesibilidad) |
| `design-systems:icon-system` | Selección final de iconos Lucide + iconos custom |
| `design-systems:naming-convention` | Convención final para nombres de tokens, componentes, archivos |

### 7.11 Pendientes y supuestos de esta sección

| # | Pendiente | A confirmar con |
|-|-|-|
| 7.11.1 | Logo / wordmark de la marca (hoy se usa el text-only) | Dueño — ¿hay logo existente? |
| 7.11.2 | ¿Se quiere modo oscuro? | Dueño / encargada — propuesta: no en fase 1, evaluamos en fase 2 |
| 7.11.3 | ¿Idioma principal del sistema? Asumo español argentino | Dueño |
| 7.11.4 | ¿Foto en cada producto del catálogo (cajero) o solo nombre + precio? | Encargada — propuesta: opcional, solo en algunos productos |
| 7.11.5 | ¿Permitir cambio rápido de PC entre cajeros (handoff de turno) o cada cajero arranca su sesión? | Encargada |
| 7.11.6 | "Modo emergencia" del Vendedor en mobile (cuando se cae una PC del local) | Decisión a futuro |
| 7.11.7 | Validar la paleta de color con el dueño (verde + cremoso) — ¿se identifica con la marca? | Dueño |

---

## Sección 8 — Tickets (cocina / cliente / delivery)

> **Premisa que enmarca esta sección**: hay **3 tipos de ticket** con propósitos distintos y reglas de impresión específicas (Sección 4.10). El ticket de cocina ("comanda") solo se imprime cuando algún item de la venta requiere preparación. El ticket cliente solo al cobrar. El ticket delivery es uno solo que cumple los dos roles. Esta sección define el contenido, formato y stack técnico de impresión.

### 8.1 Visión general

Tres tipos de ticket × tres impresoras potenciales:

| Tipo | Cuándo se imprime | Quién lo recibe | Impresora | Formato |
|-|-|-|-|-|
| **Comanda (cocina)** | Al pasar la venta a `PROCESADA`, si algún item tiene `cocina_interviene=true` | Cocina | EPSON TM-T20II térmica (cocina) | 80mm térmica, sin precios |
| **Ticket cliente** | Al pasar la venta a `FINALIZADA` (modalidad TAKE_AWAY) | Cliente | EPSON TM-T20II térmica (mostrador) | 80mm térmica, con precios |
| **Ticket delivery** | Al pasar la venta a `PROCESADA` (modalidad DELIVERY_*) | Cocina + repartidor + cliente | Lexmark E460 láser (oficina delivery) | Tamaño compacto (TBD — más chico que A5), todo en uno |
| **Comanda CANCELADA** | Al anular una venta `PROCESADA` o `FINALIZADA` cuya comanda ya se imprimió | Cocina | EPSON TM-T20II térmica (cocina) | 80mm térmica, leyenda grande de CANCELADA |

#### 8.1.1 Setup físico de las impresoras

```
┌──────────────────────────────────────────────────────────┐
│                    LOCAL                                 │
│                                                          │
│   MOSTRADOR                          COCINA              │
│   ┌────────┐                         ┌────────┐          │
│   │ PC1-4  │                         │        │          │
│   │ 🖨 EPS  │ ─── LAN ─────────────── │ 🖨 EPS │          │
│   │ TM-T20 │                         │ TM-T20 │          │
│   └────────┘                         └────────┘          │
│   imprime ticket cliente             imprime comandas    │
│                                                          │
│                    OFICINA DELIVERY                      │
│                    ┌────────┐                            │
│                    │        │                            │
│                    │ 🖨 Lex │                            │
│                    │ E460   │                            │
│                    └────────┘                            │
│                    imprime tickets delivery               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

- 2 impresoras térmicas EPSON TM-T20II (mostrador + cocina) **idénticas en modelo**, ambas conectadas vía LAN al servidor local. Los ESC/POS commands son iguales — solo cambia la IP de destino.
- 1 impresora láser Lexmark E460 (oficina delivery) — conectada vía LAN. Recibe tickets delivery en formato HTML/PDF.
- El **agente local** (Sección 1.4) es quien dispara la impresión, recibiendo el evento desde la VPS o desde el server local.

> Configuración real de impresoras y direcciones IP: pendiente cuando se haga el deploy en el local (Sección 12).

### 8.2 Ticket de comanda (cocina)

#### 8.2.1 Contenido

- Logo / nombre del local (chico, no es el protagonista)
- **Número de orden del turno** (gigante — esto es lo que cocina lee primero)
- Hora del pedido + hora prometida (si delivery)
- **Canal** (mostrador / delivery local / RAPPI / Pedidos YA / etc.) en banner grande
- Lista de items con:
  - Cantidad (gigante)
  - Nombre del producto
  - Modificadores aplicados (sabor, forma, etc.)
  - **Observaciones** del cliente en negrita y destacadas ("sin sal", "extra queso")
  - Si forma parte de un combo, marca "[COMBO: nombre del combo]"
- Sin precios, sin descuentos, sin métodos de pago — cocina no necesita esa info
- Footer: PC origen + cajero (rol "Vendedor" siempre — contexto para audit)

#### 8.2.2 Formato (térmica 80mm, ~42 caracteres por línea)

```
==========================================
        SANTA TERESITA PASTAS
==========================================

         ╔════════════════╗
         ║   COMANDA      ║
         ║                ║
         ║    # 047       ║
         ║                ║
         ╚════════════════╝

  Hora pedido: 19:42
  Canal:       MOSTRADOR

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

**Reglas de formato**:

- Cantidad en doble alto (`ESC ! 0x10` ESC/POS).
- Número de orden en alto y ancho doble (`ESC ! 0x30`), centrado, dentro de un box de caracteres.
- Observaciones en negrita (`ESC E 1`).
- Combos identificados con un `[COMBO: ...]` en cada línea para que cocina sepa que pertenecen a una promo.
- Corte automático al final (`GS V 0`).

#### 8.2.3 Comanda CANCELADA

Cuando se anula una venta cuya comanda ya se imprimió:

```
==========================================
       ╔══════════════════════════╗
       ║                          ║
       ║       *** CANCELADA ***  ║
       ║                          ║
       ║         ORDEN # 047      ║
       ║                          ║
       ╚══════════════════════════╝

  Hora cancelación: 19:48
  Cancelada por:    Encargada

  Motivo: Cliente se arrepintió

==========================================
```

Negro sobre fondo invertido (`GS B 1`) para máximo contraste visual. Sale automáticamente cuando un admin anula.

### 8.3 Ticket cliente (mostrador)

#### 8.3.1 Contenido

- Header: nombre + dirección del local
- Número de venta (ID interno) + número de orden del turno
- Cliente (Casual / Cliente, o nombre si está identificado)
- Vendedor (rol siempre, "Vendedor")
- Tabla de items: Cant | Descripción | Unitario | Monto
- Subtotal
- Recargo (si hay, pero no se imprime si es 0)
- Descuento (si hay)
- **TOTAL** en grande
- Método de pago (vimos en el ticket actual de Innovo que NO sale — yo lo agregaría como mejora)
- Cambio (si pagó con efectivo y dieron vuelto)
- "Ticket no fiscal" (legal — tiene que estar)
- Fecha y hora
- **Footer configurable**: redes sociales, próxima promo, agradecimiento — espacio para marketing

#### 8.3.2 Formato (térmica 80mm)

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

**Mejoras sobre el ticket actual de Innovo**:

| Aspecto | Innovo actual | Sistema nuevo |
|-|-|-|
| Método de pago | No aparece | ✅ Aparece |
| Cambio dado | No aparece | ✅ Aparece si efectivo |
| Número de orden del turno | No existe | ✅ "Orden # 047" para que el cliente lo identifique al retirar |
| Recargo / descuento desglosado | Solo descuento | ✅ Ambos visibles |
| Footer marketing | No hay | ✅ Configurable (redes, promo, link) |

### 8.4 Ticket delivery

Único ticket que cubre comanda + cliente + repartidor. Se imprime en láser (formato A5 o A4).

#### 8.4.1 Contenido

**Sección 1 — Cabecera**:
- Logo + nombre del local
- Número de delivery + número de orden del turno
- Canal (DELIVERY PROPIO / RAPPI / Pedidos YA / DELIVERATE / etc.)
- ID externo si vino de plataforma (ej. Pedidos YA #PY-12345)

**Sección 2 — Cliente y entrega** (info crítica para repartidor):
- Nombre del cliente
- Teléfono (con icono telefónico, fácil de tipear)
- Dirección completa (calle, número, piso, depto)
- Indicaciones (timbre roto, perro, dejar en portería, llamar al llegar, etc.) en banner destacado
- Hora prometida de entrega

**Sección 3 — Items** (igual que comanda + igual que ticket cliente):
- Tabla con cantidad, descripción, modificadores, observaciones, precio unitario y monto
- Subtotal, recargo, descuento, total

**Sección 4 — Pago**:
- Método de pago
- Si paga el cliente al recibir (efectivo): monto exacto a cobrar destacado
- Si ya pagó (tarjeta o plataforma): leyenda "PAGADO" grande

**Sección 5 — Footer**:
- Cajero / usuario
- Hora de impresión
- Repartidor asignado (si delivery propio)

#### 8.4.2 Formato (láser A5 o A4)

```
┌──────────────────────────────────────────────────────────────────────┐
│  🍝 SANTA TERESITA PASTAS                                            │
│     Av. 44 e. 12 y Plaza Paso  ·  La Plata, Bs. As.                 │
│                                                                      │
│  ═══════════════════════════════════════════════════════════════════ │
│                                                                      │
│              DELIVERY # 459959              ORDEN # 047              │
│                                                                      │
│              Canal:  PEDIDOS YA   ·   ID externo: PY-12345           │
│                                                                      │
│  ═══════════════════════════════════════════════════════════════════ │
│                                                                      │
│  📍 ENTREGA                                                          │
│                                                                      │
│      Cliente:    CRISTINA                                            │
│      Teléfono:   📞 2216124035                                       │
│      Dirección:  50 4 Y 5 481 depto D 4° piso                        │
│      Localidad:  La Plata                                            │
│                                                                      │
│      ⚠ Indicaciones:                                                 │
│         Tocar timbre fuerte, no funciona el portero                  │
│                                                                      │
│      Hora prometida:  13:30 hs                                       │
│                                                                      │
│  ═══════════════════════════════════════════════════════════════════ │
│                                                                      │
│  📋 ITEMS                                                            │
│                                                                      │
│     ┌───┬──────────────────────────────────┬─────────┬──────────┐   │
│     │ 1 │ ENVIO                            │  3.800  │   3.800  │   │
│     │ 1 │ PROMO 1 Kg Fideos + 2 Salsas + 1 │ 27.900  │  27.900  │   │
│     │   │ Queso                            │         │          │   │
│     │   │   • Fideos: Cinta media           │         │          │   │
│     │   │   • Salsa 1: Fileto               │         │          │   │
│     │   │   • Salsa 2: Bolognesa            │         │          │   │
│     │   │   • Queso: Reggianito             │         │          │   │
│     └───┴──────────────────────────────────┴─────────┴──────────┘   │
│                                                                      │
│                                            Subtotal:    $ 31.700     │
│                                                                      │
│                                          ╔══════════════════════╗    │
│                                          ║  TOTAL:    $ 31.700  ║    │
│                                          ╚══════════════════════╝    │
│                                                                      │
│  ═══════════════════════════════════════════════════════════════════ │
│                                                                      │
│  💳 PAGO                                                             │
│                                                                      │
│      Método:        EFECTIVO  (cobrar al entregar)                   │
│      Monto a cobrar:    $ 31.700                                     │
│                                                                      │
│  ═══════════════════════════════════════════════════════════════════ │
│                                                                      │
│  Repartidor:  Damián                                                 │
│  Cajero:      Vendedor (PC4)                                         │
│  Impreso:     22/04/2026  13:31:42                                   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**Si el cliente ya pagó** (tarjeta o por la plataforma), reemplaza la sección 💳 PAGO por:

```
  💳 PAGO
      Método:    PEDIDOS YA  (online)
      Estado:    ╔════════════╗
                 ║   PAGADO   ║
                 ╚════════════╝
```

### 8.5 Reimpresión de tickets

#### 8.5.1 Reimpresión de comanda

- Cualquier admin puede reimprimir desde el detalle de la venta.
- En la reimpresión sale un banner pequeño "REIMPRESIÓN — original a las 19:42" para que cocina sepa que no es un duplicado de orden.

#### 8.5.2 Reimpresión de ticket cliente

- Si el cliente perdió el ticket o necesita otro, el cajero pide PIN admin (Sección 6.4).
- La reimpresión sale con leyenda "DUPLICADO" en el header.

#### 8.5.3 Reimpresión de ticket delivery

- Igual que cliente, requiere PIN admin.
- Útil cuando se cae la impresora láser y hay que reimprimir desde otra impresora del local.

### 8.6 Configuración de tickets

Configurable desde Admin → Configuración → Tickets:

```
Configuración de Tickets
────────────────────────

[ Header ]
  Nombre del local:        Santa Teresita Pastas
  Dirección línea 1:       Av. 44 e. 12 y Plaza Paso
  Dirección línea 2:       La Plata, Bs. As.
  Logo (térmica):          [ subir BMP/PNG monocromo ]
  Logo (láser):            [ subir PNG/JPG color ]

[ Footer cliente — térmica ]
  Mensaje principal:       ¡Gracias por su compra!
  Redes sociales (1):      📷 @santateresitapastas
  Redes sociales (2):      🌐 santateresitapastas.com.ar
  Teléfono:                📞 (221) 123-4567
  Mensaje promocional:     [opcional, ej. "Pedí por WhatsApp..."]

[ Comanda — cocina ]
  Mostrar precios:         ❌ (decisión cerrada — nunca)
  Mostrar canal:           ✅
  Mostrar observaciones:   ✅ en negrita
  Tamaño de cantidades:    Doble (default) / Normal

[ Delivery ]
  Tamaño de papel:         TBD (compacto — más chico que A5, a definir con la encargada)
  Mostrar logo color:      ✅
  Mostrar mapa de ubicac.: ❌ (futuro)
```

### 8.7 Stack técnico de impresión

#### 8.7.1 Arquitectura

```
Sistema (DB)                     Agente local (Node)
   │                                  │
   │  Evento "imprimir ticket X"      │
   ├─────────────────────────────────▶│
   │                                  │
   │                                  ├──▶  Render del ticket
   │                                  │     (template → bytes ESC/POS o PDF)
   │                                  │
   │                                  ├──▶  Cola de impresión Redis
   │                                  │     (con reintentos exponenciales)
   │                                  │
   │                                  ├──▶  Envío a impresora
   │                                  │     - Térmica: TCP a IP:9100, ESC/POS
   │                                  │     - Láser: lp / cups / driver windows
   │                                  │
   │  Ack o error                     │
   │◀─────────────────────────────────┤
   │                                  │
```

#### 8.7.2 Librerías

- **Térmica ESC/POS**: `node-thermal-printer` (Node.js). Soporta EPSON TM-T20II nativo, comandos: text, alignment, font size, bold, image, qr, cut, drawer.
- **Láser**: render del ticket como HTML → PDF (Puppeteer) → enviar a la cola de impresión del SO (Windows Print Spooler vía driver, Linux CUPS).

#### 8.7.3 Templating

- Templates en Handlebars o Eta (rápidos, simples) con variables del ticket.
- Templates separados por tipo: `comanda.template`, `ticket-cliente.template`, `ticket-delivery.template`.
- Templates editables desde código en fase 1; versión que la encargada los edite desde UI viene en fase 2.

#### 8.7.4 Reintentos y fallos

- **Cola Redis con BullMQ** para tickets pendientes de imprimir.
- **Reintentos**: exponencial (1s, 5s, 30s, 2min, 10min).
- **Después de 5 reintentos fallidos**: el ticket pasa a estado "fallido" y aparece alerta visible en la UI del cajero ("⚠ Ticket #047 no se pudo imprimir — clickear para reintentar manualmente").
- **Modo offline**: si el agente local no llega al servidor (caída de internet pero LAN OK), igual imprime — los datos del ticket están en la base local.

#### 8.7.5 Detección de impresora caída

- Cada agente hace ping cada 30s a sus impresoras configuradas.
- Si una impresora no responde, aparece un banner persistente en todas las PCs del local: "⚠ Impresora COCINA caída — los pedidos no salen a cocina".
- El cajero puede continuar operando, pero los items que requieren cocina quedan en una cola visible para imprimirse cuando vuelva.

### 8.8 Pendientes y supuestos de esta sección

| # | Pendiente | A confirmar con |
|-|-|-|
| 8.8.1 | Confirmar setup físico exacto: ¿2 EPSON TM-T20II o 1 sola compartida entre mostrador y cocina? | Encargada / dueño |
| 8.8.2 | Logo del local (versión monocroma para térmica + versión color para láser) | Dueño |
| 8.8.3 | Mensaje del footer del ticket cliente (texto definitivo, redes sociales reales) | Dueño / encargada |
| 8.8.4 | ¿Imprimir ticket de cocina cuando el item es "media porción" o cualquier modificador especial sin cocción? El flag `cocina_interviene` lo decide a nivel TipoProducto, pero algunos casos borde pueden necesitar override por venta | Encargada |
| 8.8.5 | ¿Querés un mensaje de "feliz cumpleaños" o algo similar que el ticket detecte automáticamente cuando el cliente cumple años? (Conecta con módulo Aniversarios) | Decisión a futuro |
| 8.8.6 | ¿Imprimir QR en el ticket que lleve a una encuesta de satisfacción / reseña? | Decisión a futuro |
| 8.8.7 | ¿Lexmark E460 sigue operativa o vamos a comprar otra impresora? Es un modelo de 2009, puede ser problemático en 2026 | Encargada — verificar estado |
| 8.8.8 | **Tamaño exacto del ticket de delivery** — el A5 que propuse es muy grande, en realidad es compacto (probablemente media A5 o un formato custom). Confirmar dimensiones reales | Encargada — pasar foto del ticket actual de delivery |

---

## Sección 9 — Sync Excel ↔ programa (con aprobación admin)

> **Premisa que enmarca esta sección**: los Excels existentes (CASHFLOW 2026, Ventas x día 2026, Proveedores 2026, Lista de Precios) **siguen vivos** (Sección 1.5, decisión cerrada). El programa los **mantiene actualizados** automáticamente con datos operativos, y a su vez los **lee** cuando el dueño o la encargada hacen ediciones masivas (típicamente aumentos de precios). Cualquier cambio que entra desde Excel **no se aplica silenciosamente** — queda como "cambio pendiente" hasta que el admin lo aprueba al ingresar al sistema. Esta sección define la dirección de sync por archivo, el patrón de aprobación, la resolución de conflictos y el stack técnico.

### 9.1 Visión general por archivo

| Archivo en Drive | Dirección | Quién escribe | Quién lee | Frecuencia |
|-|-|-|-|-|
| **CASHFLOW 2026.xlsx** | Programa → Excel | Programa | Dueño + contador (ven el archivo en Drive) | Al cierre de cada turno + bajo demanda |
| **Ventas x día 2026.xlsx** | Programa → Excel | Programa | Dueño + contador | Al cierre de cada turno + bajo demanda |
| **Proveedores 2026.xlsx** | N8N → Excel + Programa lee | Flujo N8N (Telegram + OCR) | Programa | Sync en cada operación de N8N (continuo) |
| **Lista de Precios.xlsx** | **Bidireccional con aprobación** | Programa Y dueño/encargada | Programa | Cambios pull-on-demand con aprobación admin |

**Tres patrones distintos**:

1. **Programa → Excel** (cashflow, ventas x día): el programa empuja datos automáticamente. El Excel es una **vista de salida** — nadie lo edita a mano para que se refleje en el sistema. Si el dueño lo edita por error o intencionalmente, los cambios **no vuelven al programa**, y el próximo push del programa los va a sobrescribir.
2. **N8N → Excel + Programa lee** (proveedores): el flujo de carga de facturas lo maneja N8N (Sección 5.1). El programa lee periódicamente para estar al día.
3. **Bidireccional con aprobación** (lista de precios): el caso más sensible. El dueño puede editar precios masivamente con fórmulas Excel. El programa detecta los cambios y le pide al admin que los apruebe antes de aplicarlos.

### 9.2 Sync programa → Excel (datos operativos)

#### 9.2.1 Qué se exporta

**A `CASHFLOW 2026.xlsx`** (replica la estructura mensual existente):

- Hoja del mes corriente (ej. "ABR 26"):
  - Columna del día: ventas mañana, ventas tarde, ventas con tarjeta mañana, ventas con tarjeta tarde, reparto, bonos, fiambres, cada categoría de egreso operativo, ingresos extraordinarios, egresos extraordinarios, retiros del propietario, diferencias de caja.
- Hojas resumen (`VENTAS POR MES`, `VENTAS X DIA 2`, `% RENTAB`, `MEDIA X DIA`, `UT. OP.`): se actualizan automáticamente vía las fórmulas del Excel — el programa solo escribe los datos en las hojas mensuales y deja que las fórmulas hagan el cálculo.

**A `Ventas x día 2026.xlsx`** (replica la estructura existente):

- Hoja del mes corriente: por cada día, las cantidades vendidas de cada producto / categoría, separadas por L–V y S y D, totales semanales y mensuales.
- Hoja `Delivery`: separación por canal (PEDIDOS YA, RAPPI, MERCADO PAGO, DELIVERATE, DAMIAN).

#### 9.2.2 Cuándo se exporta

Tres triggers:

- **Al cerrar y aprobar una sesión de caja** (Sección 3.5.3): el sistema empuja al Excel los movimientos del turno cerrado. Las celdas del día de hoy se actualizan.
- **Trigger manual desde admin** ("Sincronizar ahora con Drive"): para casos donde la encargada quiere ver el Excel actualizado al instante sin esperar al cierre.
- **Job programado nocturno** (3 AM): garantiza que aunque haya algún error puntual durante el día, todo queda consolidado al día siguiente.

#### 9.2.3 Cómo se evitan conflictos

- El programa solo escribe **celdas con valores** (no fórmulas).
- Las fórmulas de los Excel (ej. acumulados, % rentabilidad) quedan intactas — el programa las respeta.
- Si el archivo está abierto por alguien (lock de Drive / Excel), el programa **espera** y reintenta hasta que se libere. Si no se libera en X minutos, queda en cola y notifica.
- El programa mantiene un **hash del último estado escrito**. Si detecta que el Excel cambió desde la última escritura (alguien lo editó a mano), antes de sobrescribir genera un **backup automático** del archivo y avisa al admin: "Detecté ediciones manuales en Cashflow desde la última sync — guardé un respaldo en `/Backups/cashflow-2026-04-27-13h.xlsx`. ¿Continuar con la actualización del programa?"

### 9.3 Sync Excel → programa (cambios masivos con aprobación)

Este es el flujo crítico: el dueño o la encargada edita el `Lista de Precios.xlsx` en Drive (típicamente un aumento del 3% con fórmula), y el programa lo detecta y aplica con aprobación.

#### 9.3.1 Trigger de detección

Dos modos coexisten:

- **Pull on-admin-login**: cuando un admin entra al programa, se dispara una comprobación contra Drive: "¿el archivo `Lista de Precios.xlsx` cambió desde la última sync?". Si sí, el sistema parsea los cambios y muestra el modal de aprobación (Sección 7.5.4).
- **Botón manual "Buscar cambios ahora"** en la sección Configuración → Sync. Sirve para forzar la detección sin esperar al próximo login.

> **Nota**: rechazado el polling continuo (cada N minutos) por el principio del usuario: "no es que tengas que estar todo el tiempo llamando al Google Drive para ver si hubo una modificación".

#### 9.3.2 Cómo se detectan los cambios

Algoritmo:

1. **Hash del archivo**: el sistema descarga el archivo y compara su `revision_id` (Drive API) o su `modified_time` con el último que conoce.
2. **Si cambió**: parsea el archivo completo (hojas relevantes — para Lista de Precios son `Hoja 1` y `Pedidos YA`).
3. **Diff celda por celda**: compara el contenido nuevo contra el snapshot del último estado conocido. Identifica:
   - **Cambios de precio** (mismo producto, precio distinto)
   - **Productos nuevos** (filas que no existían antes)
   - **Productos eliminados** (filas que estaban y ya no están)
   - **Errores de formato** (fórmulas rotas, celdas con `#REF!`, valores no numéricos donde deberían serlo, precios negativos)
4. **Categoriza** los cambios en 3 grupos:
   - **Aplicables**: el sistema puede ejecutarlos sin riesgo.
   - **Sospechosos**: el sistema puede ejecutarlos, pero quiere confirmación explícita (ej. variación >50% en un precio, posible typo).
   - **Inválidos**: rechazados — no se aplican aunque el admin apruebe.
5. **Guarda** el snapshot procesado como `pending_changes` en la base, vinculado al archivo Excel.

#### 9.3.3 Modelo de datos

```
ExcelSyncSnapshot
  ├── id                    uuid
  ├── archivo               string ("Lista de Precios.xlsx")
  ├── drive_revision_id     string (de Drive API)
  ├── drive_modified_time   timestamp
  ├── descargado_at         timestamp
  ├── hash_contenido        string (SHA-256 del archivo)
  ├── estado                enum: PENDIENTE_APROBACION | APROBADA | RECHAZADA | EXPIRADA
  └── usuario_aprobacion_id  FK Usuario nullable

PendingChange
  ├── id                    uuid
  ├── snapshot_id           FK ExcelSyncSnapshot
  ├── tipo                  enum: PRECIO_CAMBIO | PRODUCTO_NUEVO | PRODUCTO_BORRADO | ERROR_FORMATO
  ├── categoria             enum: APLICABLE | SOSPECHOSO | INVALIDO
  ├── entidad_target_id     uuid nullable (producto al que afecta)
  ├── celda_excel           string ("Hoja 1!B5")
  ├── valor_anterior        jsonb (lo que tenía el sistema)
  ├── valor_nuevo           jsonb (lo que dice el Excel)
  ├── delta_descripcion     string (ej. "$23.500 → $24.205 (+3,0%)")
  ├── razon_categoria       string nullable (ej. "Variación >50%, posible typo")
  ├── aplicado              bool default false
  ├── aplicado_at           timestamp nullable
  └── orden                 int
```

#### 9.3.4 UI de aprobación

(Diseño detallado en Sección 7.5.4 — modal con lista de cambios, diff visible, aprobación granular o en bloque, errores listados aparte sin aplicarse).

#### 9.3.5 Tras la aprobación

- Cada cambio aprobado genera el `Movimiento` correspondiente (en la base) — para precios, eso es un update con `HistorialPrecio` (Sección 2.5.3) que registra precio anterior, nuevo, fecha y usuario que aprobó.
- El snapshot pasa a estado `APROBADA`.
- Los `pending_changes` rechazados quedan en histórico (no se aplican ahora, pero se ven en el log).
- Si el dueño vuelve a editar el Excel **antes de aprobar el snapshot anterior**, el sistema pregunta: "Hay cambios pendientes desde [fecha] sin aprobar. ¿Querés revisarlos primero o reemplazarlos por los nuevos?"

### 9.4 Resolución de conflictos

Casos posibles:

#### 9.4.1 El admin cambió un precio en el programa, después el dueño lo cambió en Excel

- Sistema actual del producto: $24.205 (cambio en programa hace 2 horas).
- Excel viejo conocido: $23.500.
- Excel actual: $24.205 (mismo valor) → **no hay cambio que aplicar**, sync silenciosa.
- Excel actual: $24.000 (otro valor) → aparece como `pending_change` con info "última edición en programa: hace 2hs por encargada → $24.205. Excel ahora dice $24.000. ¿Querés sobreescribir?".

#### 9.4.2 El dueño cambió un precio en Excel, después el admin lo cambió en programa antes de aprobar

- El admin tipeó el cambio en programa antes de ver el modal de aprobación de Excel.
- Cuando se detecta el snapshot de Excel, el sistema ve que el valor "anterior" del Excel ($23.500) coincide con lo que el sistema tenía hace tiempo, pero el sistema actual dice otra cosa ($24.500).
- El cambio aparece como `SOSPECHOSO` con info "edición simultánea — programa: $24.500 (hace 1h), Excel: $24.000". El admin decide cuál aplicar.

#### 9.4.3 Producto fue eliminado en programa, sigue en Excel

- Si el producto está marcado `activo = false` en el sistema, el cambio del Excel se categoriza como `SOSPECHOSO` con leyenda "este producto está desactivado en el sistema, ¿reactivarlo y cambiar precio?".

#### 9.4.4 Producto nuevo agregado en Excel

- Aparece como `PRODUCTO_NUEVO` en el modal de aprobación.
- Si el admin acepta, se crea un producto **borrador** que requiere completar más datos (categoría, modificadores aplicables, forma de venta) en una pantalla de edición antes de quedar activo.

### 9.5 Errores y validación

Los siguientes casos quedan como `INVALIDO` y no se aplican aunque el admin los marque:

- Precio negativo o cero
- Fórmula rota: `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`
- Celda con texto donde debería ir número
- Producto referenciado que no existe en el sistema (en columnas de "código" o "ID")
- Cambio que dejaría el sistema en un estado inconsistente (ej. eliminar todos los productos de una categoría)

Para cada error, el modal muestra:
- Celda exacta del Excel donde está el error (ej. "Hoja 1!B27").
- Descripción del problema en lenguaje humano.
- Sugerencia de cómo arreglarlo (ej. "Corregí la celda en el Excel y volvé a presionar 'Buscar cambios'").

### 9.6 Stack técnico

#### 9.6.1 Acceso a Drive

- **Google Drive API v3** con **service account credentials**.
- El service account tiene acceso a una carpeta específica de Drive ("Santa Teresita - Sistema") donde el dueño guarda los Excel relevantes.
- Permisos: lectura/escritura en esa carpeta. El service account es invitado por el dueño.

#### 9.6.2 Lectura y parseo

- **Lectura**: `googleapis` Node SDK → descarga del archivo como buffer.
- **Parseo**: `exceljs` (lee xlsx, soporta fórmulas, mejor que `xlsx` para cell-level diff).
- Snapshot del contenido se guarda en Postgres como JSONB para permitir diff eficiente.

#### 9.6.3 Escritura

- Para los archivos donde el programa escribe (cashflow, ventas x día):
  - Descarga el xlsx actual.
  - Modifica solo las celdas necesarias usando `exceljs`.
  - Sube el archivo modificado de vuelta a Drive (`Files.update`).
  - **Backup automático antes de sobrescribir**: copia el archivo actual a una subcarpeta `/Backups/` con timestamp en el nombre.

#### 9.6.4 Locking

- Drive no tiene locking nativo por archivo, pero soporta detección de concurrent updates vía `revision_id`.
- Antes de escribir, el programa lee el `revision_id` actual. Si cambió desde la última lectura, hubo edición externa — el programa pausa y avisa al admin.
- El sistema mantiene un **lock interno** por archivo: dos jobs del programa no pueden escribir el mismo Excel simultáneamente.

#### 9.6.5 Cola de jobs

- Cada operación de sync (export, import, detección) es un job en la cola Redis/BullMQ (Sección 1.4).
- Los jobs tienen prioridad: detección de cambios al login del admin > export de cashflow al cierre > export nocturno > sync continuo de proveedores.
- Reintentos con backoff exponencial. Después de 5 fallos, el job queda en estado "fallido" con notificación al admin.

#### 9.6.6 Configuración por archivo

```
SyncConfig
  ├── id                    uuid
  ├── archivo_drive_id      string (ID en Drive del archivo)
  ├── archivo_nombre        string ("Lista de Precios.xlsx")
  ├── direccion             enum: PROGRAMA_A_EXCEL | EXCEL_A_PROGRAMA | BIDIRECCIONAL_APROBACION
  ├── trigger               enum: AL_CERRAR_TURNO | AL_LOGIN_ADMIN | MANUAL | NOCTURNO_3AM | CONTINUO
  ├── hojas_relevantes      array string (qué hojas leer/escribir)
  ├── activa                bool
  ├── ultima_sync_at        timestamp nullable
  ├── ultimo_revision_id    string nullable
  └── notas                 text nullable
```

Configurable desde Admin → Configuración → Sync. Por default vienen las 4 configuraciones de los archivos actuales pre-cargadas.

### 9.7 Audit log de sync

Cada sync queda registrado con:

```
SyncAudit
  ├── id                    uuid
  ├── archivo               string
  ├── direccion             enum
  ├── timestamp             timestamp
  ├── usuario_id            FK Usuario nullable (null si fue automático)
  ├── tipo_evento           enum: SYNC_EXITOSO | SYNC_FALLIDO | CAMBIOS_DETECTADOS | CAMBIOS_APROBADOS | CAMBIOS_RECHAZADOS | CONFLICTO_DETECTADO | BACKUP_CREADO | LOCK_TIMEOUT
  ├── cantidad_cambios      int (cambios procesados)
  ├── cantidad_errores      int
  ├── duracion_ms           int
  ├── error_descripcion     text nullable
  └── snapshot_id           FK ExcelSyncSnapshot nullable
```

Vista admin: histórico de sync con filtros por archivo / fecha / tipo / usuario. Útil para diagnosticar problemas ("¿por qué la encargada no ve los precios actualizados?").

### 9.8 Pendientes y supuestos de esta sección

| # | Pendiente | A confirmar con |
|-|-|-|
| 9.8.1 | Confirmar la carpeta de Drive donde viven los Excels (URL) y dar acceso al service account | Dueño / encargada |
| 9.8.2 | ¿Hora exacta del job nocturno automático? Asumo 3 AM. ¿Querés otra? | Encargada |
| 9.8.3 | Umbral de "variación sospechosa" en precios — propuesta default 50%. ¿Cambiar? | Dueño |
| 9.8.4 | ¿Se quiere que el contador reciba un mail con el Excel actualizado al cierre del mes? | Dueño |
| 9.8.5 | ¿Hay otros Excels críticos del negocio que también querés vincular? (más allá de los 4 de hoy) | Dueño / encargada |
| 9.8.6 | ¿La encargada va a poder editar las hojas del Excel `Lista de Precios.xlsx` o solo el dueño? | Dueño |
| 9.8.7 | Política de retención de backups automáticos: ¿cuántos días/semanas se conservan? Propuesta: 90 días | Dueño |

---

## Sección 10 — Integraciones externas

> **Premisa que enmarca esta sección**: el sistema se conecta a 7 servicios externos (RAPPI, Pedidos YA, Mercado Libre, DELIVERATE, MercadoPago, Belvo, N8N) más posnets integrables. Cada integración tiene un patrón distinto pero comparte 5 reglas: (1) **idempotency keys** para evitar duplicados, (2) **verificación de firma** del webhook, (3) **reconciliación periódica** para webhooks perdidos, (4) **credenciales cifradas** en la base, (5) **observabilidad por integración** para detectar caídas. Las integraciones viven todas en la VPS — el servidor local no recibe webhooks externos directamente.

### 10.1 Visión general

```
┌──────────────────── INTEGRACIONES ──────────────────────┐
│                                                          │
│  Plataformas de pedidos                                  │
│  ├─ RAPPI               webhooks + API REST              │
│  ├─ Pedidos YA          webhooks + API REST              │
│  ├─ Mercado Libre       notifications + API REST         │
│  └─ DELIVERATE          ¿API? Confirmar (Sección 10.3)   │
│                                                          │
│  Pagos                                                   │
│  ├─ MercadoPago         API + webhooks (gratuito)        │
│  └─ Posnets modernos    SDK por modelo (Sección 4.8.2bis)│
│                                                          │
│  Bancos                                                  │
│  └─ Belvo (aggregator)  API REST + OAuth                 │
│                                                          │
│  Orquestación                                            │
│  └─ N8N                 webhooks bidireccionales         │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

#### 10.1.1 Modelo común de integración

```
Integracion
  ├── id                    uuid
  ├── tipo                  enum: PLATAFORMA | PAGO | BANCO | ORQUESTACION | POSNET
  ├── nombre                string ("RAPPI", "Pedidos YA", "MercadoPago", etc.)
  ├── estado                enum: ACTIVA | PAUSADA | NO_CONFIGURADA | ERROR
  ├── credenciales_cifradas text (cifrado con AES-256, key en .env)
  ├── webhook_secret        string nullable (para verificar firmas)
  ├── webhook_url           string nullable (URL pública en la VPS)
  ├── canal_id              FK Canal nullable (a qué canal de venta corresponde)
  ├── configuracion         jsonb (parámetros específicos por integración)
  ├── ultima_actividad_at   timestamp nullable
  ├── ultima_sync_ok_at     timestamp nullable
  └── activa                bool
```

Cada integración tiene su `webhook_url` único y tokens propios. La VPS expone un endpoint por integración, con su middleware de verificación de firma específico.

### 10.2 Plataformas de delivery (RAPPI / Pedidos YA / Mercado Libre)

#### 10.2.1 Patrón común

Las tres plataformas siguen el mismo flujo base (con detalles específicos que se documentan al integrarlas):

```
1. Plataforma → POST webhook a la VPS
   └─ Headers: signature de la plataforma + content-type
   └─ Body: payload del pedido (JSON con cliente, items, dirección, total, ID externo)

2. VPS verifica la firma (HMAC con webhook_secret)
   └─ Si firma inválida → 401, log del intento

3. VPS valida idempotency key (orden_id externo)
   └─ Si ya existe en la base → ACK 200 sin reprocesar

4. VPS crea Venta nueva en estado PROCESADA
   ├─ canal = RAPPI / PEDIDOS_YA / MELI
   ├─ modalidad = DELIVERY_PLATAFORMA
   ├─ id_externo_canal = orden ID de la plataforma
   ├─ payload_externo = body completo (jsonb, para audit)
   ├─ cliente_id = cliente de plataforma (auto-creado si no existe)
   ├─ items mapeados desde el catálogo
   └─ total = el total que mandó la plataforma (con recargo de canal incluido)

5. VPS responde 200 OK a la plataforma

6. VPS encola job:
   ├─ Imprimir ticket delivery (Sección 8.4)
   └─ Sincronizar venta al servidor local

7. Reconciliación: cada 5 min, job que pulla "órdenes activas" de la plataforma
   y compara con lo que tiene la base (detecta webhooks perdidos)
```

#### 10.2.2 Mapeo del catálogo

Cada plataforma tiene su catálogo propio (con SKUs distintos al sistema). Hay una tabla de **mapeo** por plataforma:

```
MapeoProductoCanal
  ├── id                    uuid
  ├── canal_id              FK Canal (RAPPI, PYA, MELI, etc.)
  ├── producto_id           FK Producto (del catálogo interno)
  ├── sku_externo           string (ID o SKU en la plataforma)
  ├── nombre_externo        string (nombre en la plataforma)
  └── activo                bool
```

Cuando llega un webhook con `sku_externo`, el sistema busca el producto interno. Si no encuentra mapeo:
- El item entra como "PRODUCTO_NO_MAPEADO" con su descripción cruda.
- La venta se crea igual (no se rechaza) — la cocina recibe la comanda con el nombre del producto en texto.
- El admin recibe alerta "Producto sin mapeo en RAPPI: '...'" para que lo asocie post-hoc.

#### 10.2.3 Manejo de cambios de estado

Las plataformas envían eventos posteriores: pedido aceptado / rechazado / preparado / en camino / entregado / cancelado. Mapeo:

| Evento de plataforma | Acción en el sistema |
|-|-|
| `accepted` / `confirmed` | Sin cambio (la venta ya está en PROCESADA) |
| `cancelled by customer` | Anular venta + comanda CANCELADA si ya se imprimió |
| `cancelled by store` | Anular venta + comanda CANCELADA |
| `ready` / `prepared` | Marca interna en `DeliveryInfo.estado = LISTO` (no afecta estado de venta) |
| `picked up` / `out for delivery` | Marca interna `DeliveryInfo.estado = EN_RUTA`, registra `hora_salida` |
| `delivered` | Marca `DeliveryInfo.estado = ENTREGADO`, registra `hora_entrega`. **Pasa la venta a FINALIZADA** automáticamente |
| `not delivered` / `returned` | Marca como NO_ENTREGADO con motivo. Genera alerta para admin (decidir reembolso o anular) |

#### 10.2.4 Manejo de errores

| Error | Comportamiento |
|-|-|
| **Plataforma cae** (timeout, 5xx) | El sistema sigue operando. Los pedidos pendientes de webhook se recuperan en el próximo job de reconciliación. |
| **VPS recibe webhook pero falla en procesamiento** | Postgres rollback, devolver 500 a la plataforma → la plataforma reintenta. |
| **Webhook duplicado** (plataforma reintenta) | Idempotency key (`id_externo_canal`) detecta y devuelve 200 sin reprocesar. |
| **Webhook con firma inválida** | 401 Unauthorized + log del intento + alerta si pasa N veces seguidas (posible ataque o secret rotado). |
| **Producto no mapeado** | Venta se crea igual con nombre crudo, alerta al admin. |
| **Cliente sin dirección completa** | Venta se crea, alerta visible al cajero / repartidor para confirmar dirección antes de salir. |
| **Sin acceso al catálogo de la plataforma para subir cambios** | Cambios manuales por el dueño; lo coordinamos en fase 2. |

#### 10.2.5 Alta de partner — pendiente operativo

Para integrar oficialmente, hace falta:
- **RAPPI**: alta como Partner. El proceso lo gestiona el cliente (tienen cuenta activa). Esperando credenciales API.
- **Pedidos YA**: idem, alta como integration partner.
- **Mercado Libre**: app registrada en MELI Developers (OAuth flow).

Mientras no estén las credenciales, el sistema queda **stub-ready**: las rutas de webhook existen, el código de procesamiento está, pero `Integracion.estado = NO_CONFIGURADA`.

### 10.3 DELIVERATE

Empresa tercera de moto-entrega. Caso especial — **no necesariamente tiene API moderna**:

#### 10.3.1 Modos posibles (a confirmar con DELIVERATE)

**Modo A — DELIVERATE tiene API**: integramos como una plataforma de delivery más (Sección 10.2). Los pedidos llegan por webhook, se procesan igual.

**Modo B — DELIVERATE solo manda emails / WhatsApp**: la encargada los recibe y los carga manualmente en el sistema marcando canal = DELIVERATE.

**Modo C — DELIVERATE tiene un panel propio donde el local los ve**: el cajero los toma y los carga manualmente como una venta canal = DELIVERATE.

> **Decisión propuesta**: arrancamos con Modo B/C (manual) y, si aparece API documentada de DELIVERATE, migramos a Modo A. Pendiente confirmar con la empresa.

#### 10.3.2 Liquidación de DELIVERATE

Independientemente del modo de carga del pedido, la liquidación funciona como definida en Sección 3.7.1: la encargada carga la liquidación cuando DELIVERATE entrega la plata + comprobante, y el sistema cierra las `LiquidacionPendiente` correspondientes.

### 10.4 MercadoPago

API completa, gratuita, oficial. Integramos directamente sin agregadores.

#### 10.4.1 Funcionalidades

- **Saldo en vivo** (cuenta MercadoPago).
- **Movimientos de cuenta** (cobros, transferencias).
- **Cobro con QR estático/dinámico**: generar QR al momento del cobro, el cliente lo escanea, paga, MP notifica al sistema, se confirma la venta.
- **Cobro con link de pago**: para casos donde el cliente no está físicamente (delivery propio, WhatsApp): se genera link, se le manda al cliente, paga, sistema notifica.
- **Refunds** (devoluciones): si una venta se anula, se puede ejecutar refund vía API.

#### 10.4.2 QR dinámico (preferido)

Flujo:
1. Cajero finaliza el pedido y elige "MP / QR" como método.
2. Sistema genera un QR específico para esa venta vía MP API (`/orders` endpoint), por el monto exacto, con `external_reference = venta_id`.
3. QR aparece en la pantalla del cajero. Cliente lo escanea con su app MP.
4. Cliente paga.
5. MP envía webhook a la VPS confirmando el pago.
6. VPS verifica el webhook (firma + monto + external_reference), confirma el `Pago` en la venta, dispara la transición a FINALIZADA, imprime el ticket cliente.
7. Si el cliente NO paga en X minutos (configurable, default 5), el sistema cancela la orden de MP y vuelve la venta al estado anterior para reintentar.

#### 10.4.3 Reconciliación

- Cada hora, job que llama `/v1/payments/search?store_id=X&date_from=...` y compara con los Pagos confirmados en el sistema.
- Si MP tiene un pago que el sistema no registró (raro, pero posible si se perdió un webhook): alerta al admin para reconciliar.
- Comisiones reales por operación se traen del payload de MP — actualizan `LiquidacionPendiente.monto_liquidado_real`.

#### 10.4.4 Credenciales

- Access Token de aplicación de MP (creada por el dueño en su Panel MP).
- Webhook secret para verificar firmas.
- Public Key (para integraciones en frontend si las hay en futuro).

### 10.5 Belvo (aggregator bancario)

Para conexión con Santander, Galicia, Cuenta DNI (BAPRO).

#### 10.5.1 Cobertura

| Banco | Cobertura Belvo (a verificar) | Plan B |
|-|-|-|
| Santander | ✅ Probable | Import manual de extracto |
| Galicia | ✅ Probable | Import manual |
| Cuenta DNI / BAPRO | ⚠️ A confirmar — wallet/cuenta digital, cobertura puede ser parcial | Import manual |

Confirmamos con Belvo antes de pagar la suscripción.

#### 10.5.2 Flujo de conexión (OAuth-like consent)

1. Encargada (o dueño) entra a Configuración → Cuentas → Conectar con Belvo.
2. Sistema genera un `link_token` con Belvo API.
3. Encargada selecciona el banco a conectar (Santander/Galicia/etc.).
4. Belvo abre flujo de credenciales (homebanking) — la encargada tipea su usuario y contraseña del homebanking dentro del widget Belvo.
5. Si exitoso, Belvo devuelve un `link_id` que se guarda cifrado en el sistema, asociado a la `Cuenta` correspondiente.
6. A partir de ahí, sistema puede consultar saldo y movimientos de esa cuenta vía Belvo.

> **Importante**: las credenciales del homebanking nunca pasan por nuestro servidor — viven en el widget de Belvo. Nosotros solo guardamos el `link_id` que Belvo nos da después.

#### 10.5.3 Sincronización

- **Saldo**: cada 6 horas, job pulla saldo de cada cuenta conectada.
- **Movimientos**: cada hora, job pulla movimientos nuevos. Cada movimiento se compara con `LiquidacionPendiente` para conciliar (Sección 3.7.1).
- **Trigger manual**: botón "Actualizar ahora" en la sección de cuentas para forzar refresh.

#### 10.5.4 Costo y configuración

- Belvo cobra por cuenta conectada activa, ~USD 1–3/mes/cuenta.
- 4 cuentas (3 bancos + MP, aunque MP probablemente no necesite Belvo) → ~USD 5–10/mes.
- Configurable: si el dueño decide no pagar Belvo, el sistema cae a import manual de extracto (Sección 3.7.1).

### 10.6 N8N (orquestación)

N8N corre en la misma VPS que el sistema (mismo Docker Compose) y se comunica vía API.

#### 10.6.1 Carga de facturas (Telegram + OCR — fase 1)

Flujo (especificado en Sección 5.1):

```
Encargada → foto factura → Bot Telegram
                              │
                              ▼
                            N8N
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
          LLM con visión   Drive (Excel)   Programa API
                            actualizado    (POST factura)
```

N8N llama al endpoint `POST /api/v1/integraciones/n8n/factura-recibida` con el JSON estructurado que extrajo el LLM. La factura entra en estado `PENDIENTE_VALIDACION` (Sección 5.5) hasta que el admin la valida.

#### 10.6.2 Bot WhatsApp (fase 2 — preparado desde fase 1)

Flujo planeado:

```
Cliente → WhatsApp → Bot IA (en N8N con LangGraph/Mastra)
                       │
                       ├─ Conversación: tomar pedido
                       ├─ Confirmar dirección
                       ├─ Confirmar método de pago
                       ▼
                    POST /api/v1/integraciones/n8n/pedido-wsp
                       │
                       ▼
                    Sistema crea Venta canal=WHATSAPP, estado=PROCESADA
                    + dispara impresión de ticket delivery
```

Aunque el bot se construye en fase 2, el endpoint de la API está disponible desde fase 1, así N8N puede empezar a usarlo cuando se prenda.

#### 10.6.3 Otros workflows de N8N (potenciales — no en scope inicial)

- Saludo automático de cumpleaños (cuando se aclare el módulo Aniversarios).
- Reportes diarios por mail al dueño (resumen al cierre del día).
- Detección de patrones anómalos (alerta cuando un día las ventas bajan >30% vs el promedio).

#### 10.6.4 Endpoints expuestos al N8N

```
POST /api/v1/integraciones/n8n/factura-recibida    (carga factura proveedor)
POST /api/v1/integraciones/n8n/pedido-wsp          (carga venta WhatsApp)
GET  /api/v1/integraciones/n8n/ventas-del-dia      (consulta para reportes)
GET  /api/v1/integraciones/n8n/cierre-caja-resumen (consulta resumen para mail)
```

Autenticación: API key compartida (cifrada en variables de entorno de N8N).

### 10.7 Posnets integrados

Para los modelos modernos (Sección 4.8.2bis):

#### 10.7.1 SDKs probables

| Posnet | SDK / API |
|-|-|
| **Mercado Pago Point** | API de MP Point (REST) — devuelve eventos por webhook |
| **Ualá Bis** | SDK móvil + API REST |
| **Modo** | API REST con OAuth |
| **Geopagos / Pomelo** | SDK + API REST |
| **Naranja X** | SDK + API |

> Detalles específicos: pendiente saber el modelo exacto que tienen.

#### 10.7.2 Patrón de integración

```
Sistema → "Cobrar $X en Posnet [nombre]" → Posnet API
                                              │
                                              ▼
                                          Posnet despierta
                                          con monto exacto
                                              │
                                              ▼
                                          Cliente paga
                                              │
                                              ▼
                                          Posnet → webhook a VPS
                                          (autorización + tarjeta + cuotas)
                                              │
                                              ▼
                                          Sistema confirma Pago
                                          → Venta a FINALIZADA
```

#### 10.7.3 Fallback a manual

Si la integración del posnet falla en una operación específica (timeout, conexión con la red bancaria caída), el sistema cae a modo manual: muestra al cajero "Cobrar $X manualmente en posnet, después confirmar acá". Garantiza que la venta no se traba aunque el posnet tenga problema.

### 10.8 Stack común y arquitectura

#### 10.8.1 Endpoint de webhooks

Cada integración tiene su URL en la VPS:

```
POST /api/v1/webhooks/rappi
POST /api/v1/webhooks/pedidos-ya
POST /api/v1/webhooks/mercado-libre
POST /api/v1/webhooks/deliverate          (si tienen API)
POST /api/v1/webhooks/mercadopago
POST /api/v1/webhooks/belvo
POST /api/v1/webhooks/posnet/{nombre}
POST /api/v1/integraciones/n8n/...        (varios endpoints)
```

Middleware estándar para todos:
1. Verificar firma (HMAC con secret específico de cada integración).
2. Idempotency check (cabecera `Idempotency-Key` o key derivada del payload).
3. Logging del payload completo (para audit y debug).
4. Procesamiento síncrono rápido o encolado en BullMQ si es lento.
5. Devolver 200 OK lo antes posible (la plataforma puede tener timeout corto).

#### 10.8.2 Tabla de eventos de webhook

```
WebhookEvent
  ├── id                    uuid
  ├── integracion_id        FK Integracion
  ├── timestamp_recibido    timestamp
  ├── headers               jsonb
  ├── payload               jsonb (body completo)
  ├── firma_valida          bool
  ├── idempotency_key       string
  ├── procesado             bool default false
  ├── procesado_at          timestamp nullable
  ├── resultado             enum: EXITOSO | DUPLICADO | ERROR | RECHAZADO_FIRMA
  ├── error_descripcion     text nullable
  └── venta_id              FK Venta nullable (si generó una venta)
```

Vista admin: log de webhooks por integración + filtros + reintento manual de fallidos.

#### 10.8.3 Cola de jobs

Cada integración tiene su queue separada en Redis/BullMQ:
- `queue:webhook:rappi`
- `queue:webhook:pedidos-ya`
- `queue:webhook:mp`
- etc.

Esto permite priorizar (impresión de tickets de mostrador antes que reconciliación bancaria) y aislar caídas (si una integración falla, no afecta a las otras).

#### 10.8.4 Reconciliación periódica

Cada integración tiene su job de reconciliación (cron):

| Integración | Frecuencia |
|-|-|
| RAPPI / PYA / MELI | Cada 5 min — pulla órdenes activas, compara con base |
| MercadoPago | Cada 1 hora — payments/search |
| Belvo | Cada 6 hs (saldos), cada 1 hora (movimientos) |
| DELIVERATE | Si tiene API: cada 5 min. Manual: no aplica |
| Posnets | Si soporta: cada 10 min |

#### 10.8.5 Health checks

- Endpoint `GET /health/integraciones` que devuelve estado de cada una: última actividad, último éxito, errores recientes.
- Dashboard admin con semáforo verde/amarillo/rojo por integración.
- Alertas: si una integración no recibe actividad en >X horas (configurable), notifica al admin.

### 10.9 Errores y observabilidad

#### 10.9.1 Logs estructurados

Cada operación de integración logea:
- `integracion_nombre`
- `evento` (webhook_recibido / api_call / reconciliacion)
- `external_id` (orden / pago / cliente externo)
- `interno_id` (venta / pago / cliente interno)
- `duracion_ms`
- `resultado` (ok / error con detalle)

Logs van a Pino → Better Stack o similar. Facilita debug cuando algo sale mal ("¿por qué este pedido de RAPPI no entró?").

#### 10.9.2 Alertas

- **Crítico** (notifica al admin instantáneo): integración critical caída (RAPPI sin webhooks por 1 hora, MP API errores 5xx repetidos).
- **Warning** (acumulado, mail diario): >5% de webhooks con error, productos sin mapeo, liquidaciones con diferencia >X%.
- **Info** (panel admin): estado de cada integración.

### 10.10 Pendientes y supuestos de esta sección

| # | Pendiente | A confirmar con |
|-|-|-|
| 10.10.1 | Credenciales de partner en RAPPI / Pedidos YA / Mercado Libre | Cliente — gestión de alta |
| 10.10.2 | ¿DELIVERATE tiene API? | Cliente — preguntarle a DELIVERATE |
| 10.10.3 | Access token + webhook secret de MercadoPago (cuenta MP del negocio) | Encargada |
| 10.10.4 | Cobertura real de Belvo para los 3 bancos | A verificar con Belvo |
| 10.10.5 | Modelos exactos de los posnets actuales (foto, marca, adquirente) | Encargada |
| 10.10.6 | URL pública / dominio para los webhooks (ej. `api.santateresita.com`) | Cliente — DNS |
| 10.10.7 | Plan de catálogo en plataformas: ¿el sistema empuja cambios a las plataformas o se cargan manualmente desde el panel de cada una? | Decisión a futuro |

---

## Sección 11 — Audit log y trazabilidad ("caja negra")

> **Premisa que enmarca esta sección**: el sistema actúa como **caja negra forense** del negocio. Cada acción que afecta plata, stock o configuración queda registrada de forma **inmutable y verificable**, con quién la hizo, cuándo, desde qué dispositivo, qué valor había antes y qué valor quedó después. La motivación original del cliente fue precisamente "saber si hubo malversación de fondos" (Sección 1 del proyecto). Esta sección define los modelos de audit, la integridad criptográfica que detecta tampering, y los reportes que el dueño puede consultar para investigar cualquier sospecha.

### 11.1 Principios

Cuatro principios cerrados (Sección 1.2, principio 4 de diseño):

1. **Append-only** — los registros de audit nunca se modifican ni se borran. Triggers de Postgres bloquean cualquier `UPDATE` o `DELETE` sobre las tablas de audit, incluso para superusuarios del DB.
2. **Hash chain** — cada registro contiene el hash del anterior. Cualquier alteración posterior rompe la cadena y queda detectable. Es la idea de blockchain sin el blockchain — un mecanismo barato, sin distribución, pero criptográficamente verificable.
3. **Cobertura total de operaciones críticas** — todas las CREATE/UPDATE/DELETE en tablas que tocan plata, stock o configuración generan audit. No hay "ventanas" donde algo pase sin registrarse.
4. **Retención sin caducidad** — los audit logs no se purgan automáticamente. Quedan para siempre. El sistema escala porque los volúmenes son razonables (ver Sección 11.10).

### 11.2 Modelos de audit

El sistema tiene 4 tablas de audit complementarias:

| Tabla | Captura | Especificada en |
|-|-|-|
| `AuditLog` | Cambios de datos (CRUD) sobre entidades del negocio | Esta sección |
| `LoginAudit` | Eventos de autenticación, aprobaciones admin in-line, cambios de PIN | Sección 6.8 |
| `SyncAudit` | Operaciones de sync con Drive | Sección 9.7 |
| `WebhookEvent` | Webhooks recibidos de integraciones externas | Sección 10.8.2 |

#### 11.2.1 `AuditLog` — el log principal

```
AuditLog
  ├── id                    bigserial  (autoincremental para preservar orden)
  ├── timestamp             timestamp with time zone  (con microsegundos)
  ├── usuario_id            FK Usuario nullable  (null si fue acción del sistema, p.ej. job nocturno)
  ├── pc_origen             string  ("PC1", "PC2", ..., "PC encargada", "PC dueño Julio", "VPS-job")
  ├── ip_origen             string nullable
  ├── session_id            uuid nullable  (sesión de UI que originó la acción)
  │
  ├── accion                enum: CREATE | UPDATE | DELETE | APPROVE | ANULAR | LOGIN_AS_ADMIN | EXECUTE
  ├── entidad_tipo          string  (nombre de la tabla afectada: "Venta", "Movimiento", "Producto", etc.)
  ├── entidad_id            uuid  (PK de la fila afectada)
  │
  ├── valores_antes         jsonb nullable  (snapshot completo de la fila antes de la operación, NULL si CREATE)
  ├── valores_despues       jsonb nullable  (snapshot completo de la fila después, NULL si DELETE)
  ├── campos_modificados    text[]  (lista de campos que cambiaron, calculado al guardar)
  │
  ├── contexto              jsonb  (info adicional: motivo, monto, etc. — clave para acciones críticas)
  │
  ├── hash_anterior         string  (SHA-256 del registro inmediatamente anterior — encadena la lista)
  ├── hash_actual           string  (SHA-256 de TODOS los campos de este registro + hash_anterior)
```

#### 11.2.2 Cómo se calcula el hash

```python
hash_actual = sha256(
    timestamp_iso8601
  + str(usuario_id)
  + pc_origen
  + accion
  + entidad_tipo
  + str(entidad_id)
  + json.dumps(valores_antes, sort_keys=True)
  + json.dumps(valores_despues, sort_keys=True)
  + json.dumps(contexto, sort_keys=True)
  + hash_anterior
)
```

- El **primer registro** del log tiene `hash_anterior = sha256("genesis-santa-teresita-2026")`.
- Cada nuevo registro toma el hash del último registro existente como `hash_anterior`.
- El hash se calcula al insertar (en un trigger o en aplicación con lock).

#### 11.2.3 Verificación de integridad

Job programado **diario a las 4 AM**:

1. Recorre el `AuditLog` desde el último punto verificado.
2. Para cada registro, recalcula `hash_actual` y lo compara con el guardado.
3. Compara `hash_anterior` con el `hash_actual` del registro previo.
4. Si encuentra inconsistencia → alerta crítica al admin con:
   - ID del registro inconsistente
   - Diferencia entre hash esperado y hash real
   - Posibles causas (tampering, bug, restore parcial)

> **Tampering scenarios cubiertos**: alguien con acceso al DB modifica un registro, borra un registro intermedio, inserta un registro entre dos existentes, o cambia el orden. Todos rompen la cadena de hashes.

### 11.3 Qué se audita (cobertura completa)

#### 11.3.1 Acciones automáticas (triggers Postgres)

Las siguientes tablas tienen trigger `AFTER INSERT/UPDATE/DELETE` que pobla `AuditLog` automáticamente:

| Tabla | INSERT | UPDATE | DELETE |
|-|-|-|-|
| `Venta` | ✅ | ✅ | ❌ (no se borran, solo se anulan) |
| `ItemVenta` | ✅ | ✅ | ❌ |
| `Pago` | ✅ | ✅ | ❌ |
| `Movimiento` | ✅ | ✅ | ❌ |
| `PagoFactura` | ✅ | ✅ | ❌ |
| `FacturaRecibida` | ✅ | ✅ | ❌ |
| `FacturaEmitida` | ✅ | ✅ | ❌ |
| `Producto` | ✅ | ✅ | ❌ (soft-delete vía `activo=false`) |
| `OpcionModificador` | ✅ | ✅ | ❌ |
| `Combo` | ✅ | ✅ | ❌ |
| `PrecioPorLista` | ✅ | ✅ | ❌ |
| `HistorialPrecio` | ✅ | ❌ (inmutable por naturaleza) | ❌ |
| `Cuenta` | ✅ | ✅ | ❌ |
| `CuentaACobrar` | ✅ | ✅ | ❌ |
| `LiquidacionPendiente` | ✅ | ✅ | ❌ |
| `Posnet` | ✅ | ✅ | ❌ |
| `ListaPrecios` | ✅ | ✅ | ❌ |
| `CategoriaMovimiento` | ✅ | ✅ | ❌ |
| `Proveedor` | ✅ | ✅ | ❌ |
| `Insumo` | ✅ | ✅ | ❌ |
| `Cliente` | ✅ | ✅ | ❌ |
| `Usuario` | ✅ | ✅ | ❌ (soft-delete vía `activo=false`) |
| `SesionCaja` | ✅ | ✅ | ❌ |
| `Integracion` | ✅ | ✅ | ❌ |

#### 11.3.2 Acciones explícitas a nivel aplicación

Estas requieren contexto que los triggers no capturan, así que se logean explícitamente desde el código:

- **Aprobación admin in-line** → audit `accion = APPROVE`, `contexto = { accion_aprobada, monto, etc. }` (Sección 6.4).
- **Aprobación de cierre de sesión de caja** → `accion = APPROVE`, `entidad = SesionCaja`, `contexto = { diferencia_caja, observaciones }`.
- **Aprobación de cambios de Excel** → `accion = APPROVE`, `entidad = ExcelSyncSnapshot`, `contexto = { cantidad_aplicados, cantidad_rechazados }`.
- **Anulación de venta finalizada** → `accion = ANULAR`, `contexto = { motivo_obligatorio, sesion_caja_id, post_cierre_aprobado: true|false }`.
- **Aplicación de descuento manual >X%** → `accion = UPDATE` sobre Venta, `contexto = { descuento_pct, motivo, autorizado_por }`.
- **Cambio de PIN** → cubierto en `LoginAudit` (Sección 6.8).
- **Ejecución de jobs sensibles** → `accion = EXECUTE`, `entidad_tipo = "Job"`, `contexto = { nombre_job, parametros, resultado }`.

#### 11.3.3 Lo que NO se audita (y por qué)

- **Lecturas / queries** — no se loggean en `AuditLog`. El volumen sería gigantesco y rara vez aporta a una investigación. Si se necesita auditoría de lecturas en el futuro (caso GDPR-like), Postgres tiene `pgaudit` que se puede activar puntualmente.
- **Navegación de UI** — clicks que no cambian estado.
- **Loading de componentes / queries de datos** — pertenece a observabilidad (Pino logs), no audit.
- **Métricas de performance** — Prometheus, no audit.
- **Eventos efímeros** — toasts mostrados, drawers abiertos, etc.

### 11.4 Trazabilidad: ¿quién hizo qué cuándo?

#### 11.4.1 Vista admin: "Buscar acciones"

Pantalla en Admin → Estadísticas → Audit log:

```
┌────────────────────────────────────────────────────────────────────┐
│ AUDIT LOG — Buscar acciones                                        │
│ ────────────────────────────────────────────────────────────────  │
│                                                                    │
│  Filtros:                                                          │
│    Período:    [ Última semana ▾ ]  ó  [ Desde ___ Hasta ___ ]    │
│    Usuario:    [ Cualquiera ▾ ]                                   │
│    Acción:     [ Cualquiera ▾ ]                                   │
│    Entidad:    [ Cualquiera ▾ ]  (Venta, Movimiento, Producto…)   │
│    PC:         [ Cualquiera ▾ ]                                   │
│    Búsqueda:   [_____________________]  (busca en contexto/IDs)   │
│                                                                    │
│  ─────────────────────────────────────────────────────────────    │
│                                                                    │
│  Resultados (137):                                                 │
│                                                                    │
│  ⏰ 27/04 19:42:05  PC2  Vendedor       CREATE Venta #460079       │
│  ⏰ 27/04 19:42:08  PC2  Vendedor       CREATE ItemVenta (×3)      │
│  ⏰ 27/04 19:42:14  PC2  Vendedor       UPDATE Venta #460079       │
│                       Estado: PROCESADA → FINALIZADA               │
│  ⏰ 27/04 19:42:14  PC2  Vendedor       CREATE Pago $27.117 EFECT  │
│                                                                    │
│  ⏰ 27/04 19:48:30  PC encargada Encargada  ANULAR Venta #460079   │
│                       Motivo: Cliente se arrepintió                │
│                       Diferencia generada en caja: -$ 27.117      │
│                                                                    │
│  ⏰ 27/04 22:10:00  PC encargada Encargada  APPROVE SesionCaja #X  │
│                       Diferencia caja: +$ 250                      │
│                       Observaciones: "diferencia menor — aprobada" │
│                                                                    │
│  [ Exportar a Excel ]                                              │
└────────────────────────────────────────────────────────────────────┘
```

Click en cada registro → modal con detalle completo:
- Valores antes / después en formato side-by-side
- Contexto JSONB legible
- Hash actual y hash anterior (para verificar cadena manualmente si hace falta)
- Link a la entidad (si todavía existe)

#### 11.4.2 Reportes pre-armados (acceso rápido)

| Reporte | Descripción | Útil cuando |
|-|-|-|
| **Acciones admin del último mes** | Todas las acciones con `accion = APPROVE` o `ANULAR` | Auditoría general de gestión |
| **Anulaciones por usuario** | Ranking de quién anula más, agrupado por motivo | Detectar patrones sospechosos (un usuario que anula muchas ventas) |
| **Diferencias de caja por usuario / turno** | Diferencias acumuladas con tendencia | Detectar faltantes recurrentes |
| **Cambios de precio del último período** | Lista de productos con precios modificados, quién los cambió | Verificar pricing |
| **Cambios de configuración del sistema** | Cambios en cuentas, posnets, listas de precios, PINs, parámetros | Para cuando algo deja de funcionar y hay que rastrear qué cambió |
| **Pagos a proveedores con descuentos atípicos** | Pagos donde `monto_aplicado` difiere significativamente del esperado | Detectar pagos parciales no autorizados |
| **Aprobaciones admin in-line por usuario** | Cuántas veces cada admin aprobó acciones puntuales | Volumen de aprobaciones — si crece desmedido, algo está mal en los permisos default |

#### 11.4.3 Limitaciones de identificación

Como decisión cerrada (Sección 6.1.1), el rol Vendedor es compartido entre todos los cajeros. Esto implica:

- **El audit log puede atribuir a "Vendedor desde PC2 a las 19:42"**, pero **no puede identificar qué persona física** estaba en PC2 en ese momento.
- Para acciones críticas que requieren PIN admin in-line (anular venta finalizada, descuento >X%, etc.), el audit sí identifica al admin específico (encargada o dueño), aunque el cajero que la solicitó queda anónimo dentro del rol Vendedor.

Esto es un trade-off conocido y aceptado por velocidad operativa. Si en el futuro hace falta más granularidad, el modelo permite agregar sub-PINs por persona sin rehacer auditoría.

### 11.5 Detección de patrones sospechosos (alertas)

Jobs programados que corren cada hora y revisan el audit log:

| Patrón | Alerta |
|-|-|
| **>10 anulaciones en una sesión** por mismo usuario | Warning al admin: "Vendedor en PC3 anuló 12 ventas hoy — revisar" |
| **Diferencias de caja recurrentes** del mismo PC en >3 turnos seguidos | Crítico: "PC2 acumula 4 turnos consecutivos con diferencia >$500" |
| **Aprobación de descuentos grandes fuera de horario habitual** (3 AM, etc.) | Warning |
| **Cambios masivos de precios sin pasar por el flujo de Excel** | Warning |
| **Anulaciones de ventas finalizadas mucho tiempo después del cierre del turno** | Warning |
| **Login admin desde IP nueva** | Info |
| **Múltiples logins fallidos seguidos** (Sección 6) | Crítico |
| **Hash chain rota** | Crítico — inmediato |

Las alertas se canalizan según severidad:
- **Crítico** → push notification al dueño + encargada + email + banner persistente en UI admin.
- **Warning** → email diario consolidado + entrada en "Alertas" del dashboard admin.
- **Info** → solo entrada en "Alertas".

### 11.6 Backup local descargable ("caja negra portátil")

El cliente original pidió: "el dueño quiere descargar toda la data por las dudas y tenerla también localmente" (Sección 1 del proyecto). Lo modelamos así:

#### 11.6.1 Backup automático diario

- Cada noche a las 2 AM (configurable), el sistema genera:
  - **Dump completo de la base** (`pg_dump` formato custom comprimido).
  - **Audit log exportado** como CSV separado (para fácil consulta sin tener que correr Postgres).
  - **Excels de Drive descargados** y consolidados (snapshot del estado).
- Todo se cifra con AES-256 usando una **passphrase configurada por el dueño** (no la conocemos nosotros, no la conoce ningún empleado).
- El archivo cifrado se sube a:
  - **Drive del dueño** (carpeta privada, solo él tiene acceso).
  - **Disco local del local** (USB conectado al servidor local, opcional pero recomendado).

#### 11.6.2 Política de retención de backups

- Daily: 30 días (uno por día).
- Weekly: 52 semanas (uno por semana).
- Monthly: indefinido (uno por mes, todos guardados).

Eso da: ~30 backups daily + 52 weekly + N monthly. Cada uno de ~50–500 MB en este volumen → manejable.

#### 11.6.3 Restauración

Si el dueño quiere volver a un punto en el tiempo (porque se sospecha tampering, porque hubo un bug, etc.):
1. Trae el backup cifrado (de Drive o del USB).
2. Tipea su passphrase.
3. El sistema descifra y permite ver el contenido en una **vista de solo lectura** sin tocar la base productiva.
4. Si decide restaurar (acción crítica), requiere PIN admin + confirmación adicional, y queda registrada como evento masivo en el audit log con todos los detalles.

### 11.7 Seguridad del audit log

El audit log es el último recurso forense. Hay que blindarlo más que cualquier otra tabla:

#### 11.7.1 Reglas a nivel base de datos

- `AuditLog` y las otras 3 tablas de audit tienen **trigger BEFORE UPDATE/DELETE** que lanza excepción "audit log is append-only".
- Solo el rol DB del sistema puede insertar (no el rol "admin app", no el rol "lectura").
- El rol DB del sistema **no puede ejecutar UPDATE/DELETE** sobre tablas de audit (incluso si el código lo intenta — el DB lo bloquea).
- `pgaudit` extension activada para registrar **eventos del DB mismo** (intentos de modificar tabla audit, cambios de schema, conexiones de superuser, etc.).

#### 11.7.2 Acceso al servidor

- Solo el desarrollador (yo) tiene SSH al VPS, con clave pública. Sin password.
- El dueño no tiene acceso SSH ni al DB. Si quiere ver datos crudos de la base, los obtiene del backup descargable (Sección 11.6) — que no le permite borrar nada.
- Las credenciales de DB (Postgres password) se rotan cada vez que un colaborador deja el equipo (futuro: cuando haya equipo).

#### 11.7.3 Verificación independiente

El backup descifrado (Sección 11.6) incluye un script de verificación de hash chain que el dueño puede correr localmente para comprobar que su copia local es íntegra.

```bash
$ ./verify-audit.sh backup-2026-04-27.encrypted

Descifrando backup... OK
Verificando hash chain de AuditLog (137,452 registros)... OK
Verificando hash chain de LoginAudit (12,837 registros)... OK
Última verificación: registro #137,452 timestamp 2026-04-27 23:58:42
Cadena íntegra. Sin tampering detectado.
```

### 11.8 Performance y volumen

#### 11.8.1 Estimación de volumen

Con los volúmenes esperados (Sección 1.7, 200–2.500 ventas/día):

- Por venta promedio se generan ~10 registros de audit (CREATE Venta + 3 ItemVenta + 1–2 Pago + UPDATE Venta a FINALIZADA + sync events).
- Por movimiento de caja: ~3 registros.
- Por aprobación admin / cambio de configuración: ~1–5 registros.

Estimación día normal (200 ventas, 30 movimientos, 20 aprobaciones): ~2.500 registros/día.
Estimación día fuerte (2.500 ventas): ~25.000 registros/día.

Anualizado: 1–10 millones de registros/año.

Postgres con índices apropiados maneja 100M+ registros sin problema. **No es preocupación de performance**.

#### 11.8.2 Índices necesarios

```sql
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_usuario_timestamp ON audit_log(usuario_id, timestamp DESC);
CREATE INDEX idx_audit_entidad ON audit_log(entidad_tipo, entidad_id);
CREATE INDEX idx_audit_pc ON audit_log(pc_origen, timestamp DESC);
CREATE INDEX idx_audit_accion ON audit_log(accion, timestamp DESC) WHERE accion IN ('ANULAR', 'APPROVE');
```

#### 11.8.3 Particionado

A partir de ~5 millones de registros (estimado año 2 o 3), conviene particionar `AuditLog` por mes (`PARTITION BY RANGE (timestamp)`) para que las queries por período se mantengan rápidas y los respaldos sean por partición.

> Esto se implementa cuando haga falta — fase 1 no necesita particionado.

### 11.9 Pendientes y supuestos de esta sección

| # | Pendiente | A confirmar con |
|-|-|-|
| 11.9.1 | ¿Querés que el dueño reciba un **resumen semanal de actividad sospechosa** por mail (ranking de anulaciones, diferencias de caja, etc.)? Propuesta: sí | Dueño |
| 11.9.2 | Passphrase para cifrado de backups: ¿la define el dueño en la primera config? ¿Cómo se recupera si se olvida (no hay forma — eso es el punto)? | Dueño — proceso de gestión |
| 11.9.3 | ¿Querés un USB conectado al servidor local para backup adicional, o alcanza con Drive? | Dueño |
| 11.9.4 | Umbral de "diferencia de caja recurrente" para alertas: ¿$500/turno + 3 turnos seguidos? | Encargada |
| 11.9.5 | ¿Quiénes reciben las alertas críticas? Solo el dueño, o también la encargada? | Dueño |
| 11.9.6 | ¿Hay personas adicionales con interés en ver el audit log (contador, abogado, etc.)? Hoy no contemplado, pero el modelo lo soporta | Dueño |

---

## Sección 12 — Pendientes (TBD) y supuestos

> **Premisa que enmarca esta sección**: este documento tiene ~70 puntos de información pendientes distribuidos en las secciones anteriores. Esta sección los **consolida en una sola tabla** ordenada por prioridad y owner, con referencia a la sección de origen. También documenta las **asunciones cerradas que tomé sin validar explícitamente** — para que las revises y confirmes o corrijas antes de implementar. Y los **items diferidos a fase 2** que están fuera del scope actual pero ya están considerados en el modelo.

### 12.1 Cómo usar esta sección

- **Si vas a coordinar con el cliente**: filtrá la tabla 12.3 por owner = "Dueño Julio" o "Encargada" → tenés la lista exacta de qué preguntar.
- **Si vas a implementar**: filtrá por prioridad = "🔴 Bloqueante fase 1" → eso es lo que tiene que estar resuelto antes del kickoff. Lo demás se puede ir resolviendo durante la implementación sin frenar el avance.
- **Si querés validar mis asunciones**: revisá 12.4 — ahí tenés todas las decisiones que tomé asumiendo que estaban bien, marcadas para que las confirmes antes de codear.
- **Para entender qué queda fuera de fase 1**: 12.5 te muestra todo lo que dejamos para más adelante.

### 12.2 Leyenda

**Prioridad**:
- 🔴 **Bloqueante fase 1** — sin esto no podemos arrancar el desarrollo de esa pieza
- 🟠 **Crítico fase 1** — necesario antes de salir a producción, pero se puede arrancar implementación sin esto
- 🟡 **Importante** — afecta calidad/UX pero no bloquea
- 🟢 **Nice to have** — se puede resolver durante operación normal

**Owner**:
- 👨‍💼 **Dueño Julio** — decisiones de negocio, presupuesto, estética, fiscal
- 👩‍💻 **Encargada** — operación día a día, datos del negocio, reglas operativas
- 🧑 **Alejo** — coordinación, gestión, decisiones de scope con el cliente
- 🛠️ **Developer** — decisiones técnicas a tomar durante implementación
- 🤝 **Conjunto** — requiere acuerdo entre múltiples partes

### 12.3 Tabla consolidada de pendientes

#### 12.3.1 🔴 Bloqueantes para arrancar fase 1

Sin estos, la implementación no puede avanzar significativamente.

| # | Pendiente | Owner | Sección |
|-|-|-|-|
| B1 | Acceso al servidor del local: hardware existente, OS, capacidad o decisión de comprar nuevo | 👩‍💻 Encargada / 🧑 Alejo | 1.8 |
| B2 | Stack confirmado de internet del local: ISP, IP pública o NAT, ancho de banda, conexión de respaldo | 👩‍💻 Encargada / 🧑 Alejo | 1.8 |
| B3 | URL pública / dominio para los webhooks de la VPS (ej. `api.santateresita.com.ar`) | 👨‍💼 Dueño / 🧑 Alejo | 10.10.6 |
| B4 | Catálogo de productos: validación final con encargada del Excel "RESTO SIMPLE" + qué precios son por kilo / docena / unidad | 👩‍💻 Encargada | 2.10.1 a 2.10.4 |

#### 12.3.2 🟠 Críticos antes de producción

Necesarios para salir a vivo, pero la implementación puede arrancar sin estos.

| # | Pendiente | Owner | Sección |
|-|-|-|-|
| C1 | Modelo y adquirente exacto de cada posnet activo (foto + ticket de muestra) | 👩‍💻 Encargada | 3.10.4 / 4.8.2bis |
| C2 | Plazo y comisión típica de DELIVERATE | 👩‍💻 Encargada | 3.10.2 |
| C3 | Comisión mensual de mantenimiento de cada cuenta bancaria | 👩‍💻 Encargada (revisar extractos) | 3.10.6 |
| C4 | Diseño contable detallado del dueño (cómo separa mentalmente las 4 cuentas) | 👨‍💼 Dueño | 3.10.1 |
| C5 | Lista de combos / promos vigentes hoy con sus componentes y precios | 👩‍💻 Encargada | 2.10.8 |
| C6 | Sabores de pizza con precio TBD (Napolitana, Fugazzetta, Caprese, Rúcula y panceta) | 👩‍💻 Encargada | 2.10.6 |
| C7 | Diferencia exacta entre porciones "Simple" y "Especial" (cantidad, salsa, presentación) | 👩‍💻 Encargada | 2.10.4 |
| C8 | Credenciales de partner en RAPPI / Pedidos YA / Mercado Libre | 🧑 Alejo (coordinar) | 10.10.1 |
| C9 | ¿DELIVERATE tiene API documentada? | 🧑 Alejo (preguntar a DELIVERATE) | 10.10.2 |
| C10 | Access token + webhook secret de MercadoPago | 👩‍💻 Encargada | 10.10.3 |
| C11 | Cobertura real de Belvo para los 3 bancos (Santander, Galicia, BAPRO) | 🛠️ Developer | 10.10.4 |
| C12 | URL de la carpeta Drive con los Excels + acceso al service account | 👨‍💼 Dueño + 👩‍💻 Encargada | 9.8.1 |
| C13 | Lista de proveedores con CUIT, condición IVA, plazo de pago y CBU/alias | 👩‍💻 Encargada | 5.11.4 / 5.11.5 |
| C14 | Lista de empleados con datos básicos para alta inicial | 👩‍💻 Encargada | — |
| C15 | Formato visual del ticket de delivery (tamaño exacto, no es A5) | 👩‍💻 Encargada (foto del ticket actual) | 8.8.8 |
| C16 | Logo del local en monocromo (térmica) y color (láser) | 👨‍💼 Dueño | 8.8.2 |
| C17 | Mensaje del footer del ticket cliente (texto, redes, teléfono) | 👨‍💼 Dueño | 8.8.3 |

#### 12.3.3 🟡 Importantes (no bloquean, definir durante implementación)

| # | Pendiente | Owner | Sección |
|-|-|-|-|
| I1 | Categorías finales de insumos (¿agregar Sin TACC, Bebidas alcohólicas, etc.?) | 👩‍💻 Encargada | 5.11.1 |
| I2 | Volumen de facturas mayoristas emitidas por mes | 👩‍💻 Encargada | 5.11.3 |
| I3 | % máximo de descuento manual sin aprobación admin (propuesta default 5%) | 👨‍💼 Dueño | 4.12.2 / 6.9.1 |
| I4 | Monto máximo de diferencia de caja sin aprobación admin (default $1.000) | 👨‍💼 Dueño | 6.9.2 |
| I5 | Lista de motivos de anulación pre-cargados | 👩‍💻 Encargada | 4.12.3 |
| I6 | ¿Asignación de repartidor en delivery propio: al cargar o al salir? | 👩‍💻 Encargada | 4.12.4 |
| I7 | ¿La encargada puede resetear el PIN del dueño? | 👨‍💼 Dueño | 6.9.3 |
| I8 | Lista de mails que reciben resúmenes (encargada confirmada, dueño confirmado, ¿contador?) | 👨‍💼 Dueño | 9.8.4 |
| I9 | Hora del job nocturno de sync (default 3 AM) | 👩‍💻 Encargada | 9.8.2 |
| I10 | Umbral de "variación sospechosa" en cambios de precio Excel (default 50%) | 👨‍💼 Dueño | 9.8.3 |
| I11 | ¿Querés un mensaje de cumpleaños automático que el ticket detecte? | 👨‍💼 Dueño | 8.8.5 |
| I12 | ¿La encargada puede editar Lista de Precios o solo el dueño? | 👨‍💼 Dueño | 9.8.6 |
| I13 | Política de retención de backups automáticos (propuesta 90 días + weekly + monthly) | 👨‍💼 Dueño | 9.8.7 / 11.6.2 |
| I14 | Passphrase para cifrado de backups (define el dueño en setup inicial) | 👨‍💼 Dueño | 11.9.2 |
| I15 | ¿USB conectado al servidor local para backup adicional? | 👨‍💼 Dueño | 11.9.3 |
| I16 | Quiénes reciben alertas críticas del audit log | 👨‍💼 Dueño | 11.9.5 |
| I17 | Umbral exacto de "diferencia de caja recurrente" para alertas (propuesta $500/turno × 3 turnos) | 👩‍💻 Encargada | 11.9.4 |
| I18 | Idioma del sistema (asumo es-AR, español argentino) | 👨‍💼 Dueño | 7.11.3 |

#### 12.3.4 🟢 Nice to have (se pueden resolver durante operación)

| # | Pendiente | Owner | Sección |
|-|-|-|-|
| N1 | Logo / wordmark de la marca | 👨‍💼 Dueño | 7.11.1 |
| N2 | ¿Foto en cada producto del catálogo (cajero) o solo nombre + precio? | 👩‍💻 Encargada | 7.11.4 |
| N3 | Validar la paleta de color (verde + cremoso) con el dueño | 👨‍💼 Dueño | 7.11.7 |
| N4 | "Mensaje promocional" rotativo en footer del ticket | 👨‍💼 Dueño | 8.6 |
| N5 | ¿Tiempo prometido en pedidos take-away (no solo delivery)? | 👩‍💻 Encargada | 4.12.5 |
| N6 | Personas adicionales con interés en ver audit log (contador, abogado) | 👨‍💼 Dueño | 11.9.6 |
| N7 | ¿Otros Excels críticos del negocio que hoy no estamos vinculando? | 👨‍💼 Dueño / 👩‍💻 Encargada | 9.8.5 |
| N8 | Resumen semanal de actividad sospechosa por mail al dueño | 👨‍💼 Dueño | 11.9.1 |
| N9 | ¿Se manda mail al contador con Excel del cierre del mes? | 👨‍💼 Dueño | 9.8.4 |
| N10 | Aniversarios de clientes — qué hace ese módulo exactamente | 👩‍💻 Encargada | (mencionado en sesión, no en sección específica) |
| N11 | ¿Reasignación de repartidor mid-trip? | 🛠️ Developer / 👩‍💻 Encargada | — |

### 12.4 Asunciones cerradas (sin validación explícita)

Estas son decisiones que tomé en el spec asumiendo que estaban bien. **Por favor confirmá** o decime que cambie alguna antes de implementar.

| # | Asunción | Sección |
|-|-|-|
| A1 | El servidor local va a ser una mini-PC (NUC, Raspberry Pi 5, o similar) que voy a especificar y vos comprás | 1.3 |
| A2 | Stack tecnológico cerrado: TypeScript + Node + Postgres 16 + Next.js + PWA + Redis + BullMQ + Docker + Caddy | 1.4 |
| A3 | El servidor local sincroniza con la VPS por replicación lógica nativa de Postgres (no usamos PowerSync ni ElectricSQL) | 1.4 |
| A4 | Bot de WhatsApp se hace con WhatsApp Cloud API oficial de Meta (no Twilio ni 360dialog) | 1.4 / 10.6.2 |
| A5 | OCR de facturas con LLM con visión (Claude Haiku o GPT-4o-mini) corriendo dentro de N8N | 1.4 / 5.1 |
| A6 | Modelo Categoría → TipoProducto → Producto → Modificadores (no SKUs aplanados) | 2.1 |
| A7 | Sorrentinos de Salmón = producto separado (no modificador con delta_precio) por la diferencia grande de precio | 2.3 / 2.4.4 |
| A8 | "Recargo Pedidos YA" se modela como precio en lista de precios del canal, no como producto | 4.8.1 / 5.6 |
| A9 | El descuento del 10% efectivo es **opcional y explícito** (botón aparte) — no automático | 4.8.2 |
| A10 | Los recargos de canal van **incluidos en el precio del item**, no como línea separada | 4.8.1 / 4.12.1 |
| A11 | Numeración doble: correlativa única global + número corto por turno (1–3 dígitos) | 4.4 |
| A12 | "Cliente Casual" como default; clientes de plataforma (Pedidos YA, RAPPI) se autocrean | 4.5 |
| A13 | Solo 2 roles: Vendedor (compartido, 1 PIN) + Admin (encargada y dueño con PINs distintos pero mismos permisos) | 6.1 |
| A14 | Sesión Vendedor permanente en PCs del local; sesión Admin con expiración por inactividad (15 min) | 6.3 |
| A15 | Aprobación admin in-line: el admin tipea PIN sin "loguearse"; la sesión sigue siendo Vendedor | 6.4 |
| A16 | Aesthetic direction "Trattoria refinada": verde profundo + crema + serif Fraunces + sans Geist + mono JetBrains | 7.1 / 7.2 |
| A17 | Vendedor desktop-only (bloqueado en mobile) | 7.3.4 |
| A18 | Iconografía Lucide | 7.8 |
| A19 | 2 EPSON TM-T20II (mostrador + cocina) + 1 Lexmark E460 (delivery) — confirmar si comprar otra para reemplazar la Lexmark | 8.1.1 |
| A20 | El programa **escribe** en CASHFLOW y Ventas x día Excels al cierre de cada turno; **lee** Lista de Precios con aprobación; Proveedores 2026.xlsx lo mantiene N8N | 9.1 |
| A21 | Detección de cambios de Excel: pull-on-admin-login + botón manual (no polling continuo) | 9.3.1 |
| A22 | Stack de impresión: `node-thermal-printer` para ESC/POS térmica + Puppeteer para láser | 8.7 |
| A23 | Belvo como aggregator bancario (en pausa hasta confirmar cobertura BAPRO) | 10.5 |
| A24 | Audit log con hash chain SHA-256 para detección de tampering | 11.2.2 |
| A25 | Backup nocturno cifrado a Drive del dueño + opcional USB local | 11.6 |
| A26 | El historial de Innovo NO se migra (no hay acceso a su DB); arranca el sistema desde cero con solo el catálogo | 1.7 |
| A27 | Innovo se mantiene en paralelo durante 2–4 semanas, después se da de baja (ahorro USD 180/mes) | 1.8 |

### 12.5 Items diferidos a fase 2 (fuera de scope actual)

Lo siguiente está modelado pero **no implementado en fase 1**. El modelo de datos lo soporta para no requerir migración cuando se prenda.

| # | Funcionalidad | Razón del diferimiento | Sección |
|-|-|-|-|
| F1 | Bot WhatsApp con IA para pedidos | Complejidad alta + requiere catálogo estable + WhatsApp API alta | 10.6.2 |
| F2 | Control de stock (insumos y productos terminados) | No es prioritario operativamente, requiere recetas y mucho input | 2.8 |
| F3 | Programación de pagos (calendario de "pagar el día X") | No es bloqueante, fase 1 muestra saldo + vencimientos | 5.6.5 |
| F4 | Helados, embutidos, vinos, fiambres en catálogo | Catálogo no entregado por encargada todavía | 2.1 |
| F5 | Modo oscuro | No prioritario | 7.11.2 |
| F6 | Tema personalizable / multi-tenant | No aplica para este negocio único | — |
| F7 | App nativa iOS/Android | PWA cubre el caso del admin | 7.3.2 |
| F8 | Saldo bancario en vivo via Belvo (queda como import manual de extractos hasta que se active) | Costo + cobertura BAPRO incierta | 10.5.4 |
| F9 | Convenios directos con APIs bancarias (Santander Empresas, Galicia Empresas) | Requiere convenio formal, semanas de gestión | 10.5 |
| F10 | Mensajes automáticos de cumpleaños a clientes | Requiere definir qué hace el módulo Aniversarios primero | I11 / N10 |
| F11 | Reportes diarios automáticos por mail al dueño | No prioritario, se puede generar manualmente | 10.6.3 |
| F12 | Detección de anomalías de ventas (alertas cuando bajan >30% vs promedio) | No prioritario | 10.6.3 |
| F13 | Encuesta de satisfacción / QR en ticket | No prioritario | 8.8.6 |
| F14 | "Modo emergencia" del Vendedor en mobile (cuando se cae una PC) | Decisión a futuro | 7.11.6 |
| F15 | Edición de templates de tickets desde UI | Fase 1 los edita en código | 8.7.3 |
| F16 | Multi-sucursal (campo `local_id` ya está en el modelo, solo no se usa) | No hay planes de expansión en 12 meses | 1.7 |
| F17 | Sub-PINs por persona dentro del rol Vendedor (granularidad de audit) | El cliente prefirió velocidad por sobre granularidad | 6.1.1 |
| F18 | Particionado de AuditLog por mes | A partir de ~5M registros (año 2 o 3) | 11.8.3 |
| F19 | Mapa de ubicación en ticket delivery | No prioritario | 8.6 |
| F20 | Push del catálogo a las plataformas (vs cargarlo manual desde el panel de cada una) | Decisión a futuro | 10.10.7 |

### 12.6 Glosario de owners

Para que quede claro a quién corresponde resolver cada pendiente:

| Owner | Quién es | Qué define típicamente |
|-|-|-|
| 👨‍💼 **Dueño Julio** | Propietario del negocio | Decisiones de presupuesto, identidad de marca, integraciones, contratos con plataformas, scope, fiscal, configuración de cuentas bancarias |
| 👩‍💻 **Encargada** | Responsable operativa del local | Reglas operativas, datos de productos / proveedores / empleados, formato de tickets, flujo del cajero, configuración del día a día |
| 🧑 **Alejo** | Vos — gestor del proyecto | Coordinación entre cliente y desarrollo, scope con el cliente, arquitectura de sistema, decisiones técnicas que requieren contexto del negocio |
| 🛠️ **Developer** | Quien implementa (vos o quien contrates) | Decisiones técnicas internas, configuraciones por defecto, optimizaciones, libraries específicas |

### 12.7 Frecuencia de revisión recomendada

Esta sección no se mira una vez y listo. Recomiendo:

- **Antes del kickoff de fase 1**: revisar todos los 🔴 Bloqueantes y resolverlos.
- **En cada reunión semanal con el cliente**: ir cerrando los 🟠 Críticos según prioridad operativa.
- **Mensualmente**: revisar 🟡 Importantes y 🟢 Nice-to-have, consolidar lo que ya se decidió.
- **Al cierre de fase 1**: validar que todos los 🟠 Críticos están resueltos antes de salir a producción.
- **Antes de empezar fase 2**: revisar 12.5 (items diferidos) y priorizar cuáles entran.

---

## Sección 13 — Roadmap y fases

> **Premisa que enmarca esta sección**: el sistema se construye en **3 fases** con objetivos operativos específicos. La **fase 1 (MVP operativo)** es 12–14 semanas de desarrollo + 2–4 semanas de corrida en paralelo con Innovo + cutover. La **fase 2 (extensiones)** suma el bot de WhatsApp, control de stock y refinamientos. La **fase 3 (optimizaciones)** llega cuando el negocio esté operando estable y aparezcan nuevas necesidades. Este roadmap define sprints, entregables, riesgos, costos operativos y métricas de éxito por fase.

### 13.1 Vista general

```
┌──────────────────────────── ROADMAP ────────────────────────────┐
│                                                                  │
│  Semana 0          Pre-arranque (resolución de bloqueantes)     │
│  ────────────                                                    │
│                                                                  │
│  Semanas 1–14      🔵 FASE 1 — MVP OPERATIVO                    │
│  ───────────                                                     │
│  Semanas 15–18     Corrida en paralelo con Innovo + cutover     │
│                                                                  │
│  Semanas 19+       🟢 FASE 2 — Bot WhatsApp + extensiones        │
│  ──────────                                                      │
│                                                                  │
│  Mes 9+            🟣 FASE 3 — Optimizaciones                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Objetivos operativos por fase**:

| Fase | Objetivo principal | Cuándo se cumple |
|-|-|-|
| **Pre-arranque** | Resolver bloqueantes (Sección 12.3.1) | Cuando los 4 bloqueantes están cerrados |
| **Fase 1** | Reemplazar Innovo y operar el negocio sin él | Cuando se da de baja Innovo y el negocio funciona estable con el sistema nuevo |
| **Fase 2** | Reducir / reemplazar el personal de atención de WhatsApp con bot IA + sumar stock y otras extensiones | Cuando el bot atiende ≥70% de mensajes WSP sin intervención humana |
| **Fase 3** | Optimizar y agregar features según uso real | Continuo |

### 13.2 Pre-arranque (semana 0)

**Objetivo**: dejar todo listo para arrancar el desarrollo. No es código, es coordinación.

**Tareas**:

| # | Tarea | Owner | Crítico |
|-|-|-|-|
| P1 | Resolver los 4 bloqueantes (B1–B4 de Sección 12.3.1) | 🧑 Alejo + 👩‍💻 Encargada + 👨‍💼 Dueño | ✅ |
| P2 | Confirmar VPS proveedor y dimensionamiento (4 vCPU / 8 GB) | 🧑 Alejo / 🛠️ Developer | ✅ |
| P3 | Comprar / configurar servidor local (NUC o Raspberry Pi 5) | 🧑 Alejo | ✅ |
| P4 | Comprar dominio (`santateresita.com.ar` o similar) | 👨‍💼 Dueño | ✅ |
| P5 | Solicitar alta como partner en RAPPI / Pedidos YA / MELI | 🧑 Alejo (con datos del negocio) | 🟠 (se puede iniciar en paralelo al desarrollo) |
| P6 | Crear cuenta de servicio de Google con acceso a la carpeta Drive | 🧑 Alejo + 👨‍💼 Dueño | ✅ |
| P7 | Crear app en Mercado Pago (Panel MP del dueño) → obtener access token | 👩‍💻 Encargada | 🟠 |
| P8 | Setup repo Git con estructura WAT (Sección 1.3 del CLAUDE.md) + CI básico | 🛠️ Developer | ✅ |
| P9 | Catálogo de productos consolidado en Excel "RESTO SIMPLE" + validado con encargada | 👩‍💻 Encargada | ✅ |
| P10 | Foto de cada posnet activo con su modelo + adquirente legible | 👩‍💻 Encargada | 🟠 (no bloquea fase 1, pero acelera 4.8.2bis) |

**Definition of Done de pre-arranque**:
- Bloqueantes B1–B4 cerrados con respuesta confirmada del cliente
- VPS funcionando con Docker Compose básico
- Repo creado y accesible
- Catálogo entregado por la encargada en formato listo para parsear

### 13.3 Fase 1 — MVP operativo (semanas 1–14)

> **Sprints de 1 semana**. Cada sprint termina con un entregable demostrable. Al final de cada sprint, sesión de revisión con vos (Alejo) para validar antes de avanzar.

#### Sprint 1 — Setup infraestructura

**Objetivo**: dejar el ambiente listo para empezar a codear features.

- VPS con Docker Compose: Postgres 16, Redis 7, Caddy con HTTPS automático.
- Servidor local con Postgres + Redis + agente de impresión stub.
- Replicación lógica Postgres VPS ↔ local funcionando con tabla de prueba.
- Repo TypeScript + Fastify + Prisma + Zod base.
- Repo Next.js base (admin) con estructura de rutas.
- CI/CD básico (GitHub Actions): lint, build, deploy a staging.
- Variables de entorno cifradas, secrets management.

**Entregable**: "hola mundo" desplegado a staging accesible vía dominio.

#### Sprint 2 — Modelo de datos + autenticación

**Objetivo**: tabla por tabla del modelo + sistema de roles funcionando.

- Schema Prisma con todas las entidades de Secciones 2–11 (incluso las que no se llenan en fase 1, ya están las tablas).
- Migraciones iniciales corriendo en local + VPS.
- Seeds básicos: roles, categorías de movimiento iniciales, cuenta general provisoria, cuentas a cobrar para débito/crédito de cada banco.
- `Usuario` + auth con PIN bcrypt.
- Sesión persistente Vendedor + sesión Admin con expiración por inactividad.
- Aprobación admin in-line (modal funcional).
- `LoginAudit` poblándose en cada evento.

**Entregable**: el cajero puede entrar a una pantalla en blanco con su PIN; el admin entra al panel admin (también vacío) con su PIN.

#### Sprint 3 — Catálogo de productos

**Objetivo**: catálogo completo cargado y editable.

- Parser del Excel "Lista de Precios.xlsx" → seed de Categorias / TipoProducto / Producto / Modificadores / Combos.
- UI Admin → Productos: listado, búsqueda, categorías, edición, alta nueva.
- Listas de precios + canales con %.
- Historial de precios poblándose en cada cambio.
- `MapeoProductoCanal` (vacío al inicio, se llena cuando se integren plataformas).

**Entregable**: el admin puede ver todos los productos, editarlos, cambiar precios, y los cambios quedan auditados.

#### Sprint 4 — Sesión Vendedor (carga de pedido)

**Objetivo**: el cajero puede cargar un pedido completo (sin cobrar todavía).

- Layout principal del Vendedor (Sección 7.4.1).
- Catálogo en grid con categorías + Top 3 contextual.
- Modal de modificadores y combos (Sección 7.4.2).
- Carrito en vivo con edición / eliminación de items.
- Búsqueda de productos por código rápido.
- Atajos de teclado (Sección 7.4.6).
- Estado `PROCESADA` de la venta + persistencia.
- Historial de la sesión actual (drawer).

**Entregable**: el cajero carga un pedido típico de 3 items en menos de 30 segundos.

#### Sprint 5 — Cobro y pagos

**Objetivo**: el cajero puede cerrar una venta con cobro.

- Pantalla de cobro (Sección 7.4.3).
- Métodos de pago: efectivo, débito, crédito, MP QR (sin integración aún), transferencia.
- Pago split / dividido (Sección 7.4.4).
- Botón opcional "Efectivo con 10% descuento" (Sección 4.8.2).
- Cálculo de cambio si efectivo.
- Transición `PROCESADA → FINALIZADA` con generación de movimientos contables.
- Anulación de venta `PROCESADA` (vendedor) y `FINALIZADA` (admin con PIN in-line).

**Entregable**: el cajero cobra con cualquier método y la venta queda finalizada con sus movimientos en cuentas.

#### Sprint 6 — Tickets e impresión

**Objetivo**: los tickets salen correctamente por las impresoras.

- Agente local con `node-thermal-printer` para EPSON TM-T20II (LAN).
- Templates de comanda, ticket cliente y ticket delivery (Sección 8).
- Cola Redis/BullMQ con reintentos exponenciales.
- Detección de impresora caída + banner de alerta.
- Reimpresión con marca "REIMPRESIÓN" / "DUPLICADO" + PIN admin.
- Comanda CANCELADA cuando se anula venta procesada con comanda impresa.
- Render de ticket delivery vía Puppeteer → PDF → impresora láser.

**Entregable**: una venta de mostrador imprime ticket cliente; una venta con cocina imprime comanda + ticket cliente; un delivery imprime ticket delivery completo.

#### Sprint 7 — Cuentas, movimientos y cierre de caja

**Objetivo**: el ciclo de caja completo funciona.

- UI Movimientos (admin): listado, filtros, alta de ingreso / egreso / transferencia interna.
- Categorías de movimientos abiertas (la encargada puede crear nuevas).
- Apertura de sesión de caja (manual y automática al primer login del turno).
- Cierre de sesión con cálculo de recaudación esperada.
- Diferencia de caja generada automáticamente.
- Aprobación admin del cierre.
- Email del resumen al dueño + encargada (Sección 3.6).
- "Retiro Julio" como categoría especial separada.

**Entregable**: la encargada cierra un turno, valida la diferencia, lo aprueba y se manda el mail.

#### Sprint 8 — Sesión Admin + dashboards

**Objetivo**: el admin tiene su panel completo con dashboards interactivos.

- Layout principal del admin (Sección 7.5.1).
- Dashboard inicial con KPIs + próximos depósitos + pendientes (Sección 7.5.2).
- Sección Movimientos con todos los filtros.
- Sección Productos completa (ya empezada en Sprint 3).
- Sección Administración con sub-secciones Empleados, Clientes, Insumos y Proveedores, Estadísticas.
- Pantallas de Insumos y Proveedores con CRUD básico.
- Registro de facturas recibidas (manual, sin OCR aún).
- Pago de facturas con multi-cuenta (Sección 5.6.4 + 7.5.3).
- Estadísticas básicas con drill-down (al estilo Innovo + pestañas Diaria/Semanal/Mensual/Anual).

**Entregable**: el admin opera todas las áreas del negocio desde el panel.

#### Sprint 9 — Sync Excel + Drive

**Objetivo**: los Excels se mantienen actualizados automáticamente y la aprobación de cambios funciona.

- Conexión Drive API + service account.
- Push automático: CASHFLOW + Ventas x día se actualizan al cierre de turno.
- Pull con aprobación: Lista de Precios detecta cambios y muestra el modal de aprobación al admin (Sección 7.5.4).
- Diff celda por celda + categorización (aplicable / sospechoso / inválido).
- Backup automático antes de sobrescribir.
- Vista de pendientes de aprobación.
- Audit log de cada sync.

**Entregable**: el dueño edita el Excel de precios en Drive, entra al sistema, ve los cambios pendientes, los aprueba, y el catálogo queda actualizado.

#### Sprint 10 — Integraciones primarias (MP + plataforma básica)

**Objetivo**: arrancar con las integraciones más críticas.

- API directa de Mercado Pago: saldo en vivo, QR dinámico para cobro, webhook de confirmación, reconciliación.
- Conexión con la primera plataforma disponible (la que tenga credenciales primero — probablemente Pedidos YA o RAPPI según gestión).
- Webhook endpoint con verificación de firma + idempotency.
- Auto-creación de venta desde webhook con cliente "Pedidos YA" / "RAPPI".
- Mapeo de productos (UI de gestión).
- Job de reconciliación cada 5 min.
- Manejo de eventos posteriores (accepted, ready, picked_up, delivered, cancelled).

**Entregable**: un pedido entra por la primera plataforma integrada, se carga automático en el sistema, se imprime el ticket delivery, se entrega y queda finalizado.

#### Sprint 11 — Integraciones secundarias + Belvo

**Objetivo**: completar las integraciones restantes.

- Las otras 2 plataformas de delivery (de las 3: RAPPI, Pedidos YA, MELI).
- DELIVERATE en modo manual (pendiente confirmación de API).
- Belvo conectado para Santander y Galicia.
- Reconciliación automática de tarjetas con liquidación bancaria.
- Conexión con N8N: endpoint para que cargue facturas (preparado, aunque N8N todavía no esté en producción).

**Entregable**: las 4+ integraciones operan + Belvo trae saldos en vivo.

#### Sprint 12 — Audit log + backups + alertas

**Objetivo**: la "caja negra" forense queda blindada.

- Triggers de Postgres en las 24 tablas auditadas (Sección 11.3.1).
- Hash chain implementado y verificable.
- Job diario de verificación de integridad a las 4 AM.
- Backup automático diario cifrado a Drive del dueño + opcional USB local.
- Script `verify-audit.sh` distribuido al dueño.
- Vistas admin de búsqueda de audit + 7 reportes pre-armados (Sección 11.4.2).
- Detección automática de patrones sospechosos (Sección 11.5).
- Sistema de alertas (crítico → push + email; warning → digest diario).

**Entregable**: el dueño puede investigar cualquier acción del sistema; recibe alertas si pasa algo raro; se baja el backup cifrado a su Drive cada noche.

#### Sprint 13 — Mobile admin + polish

**Objetivo**: el admin funciona en celular y la UI está pulida.

- Layout responsive para mobile (Sección 7.6).
- Bottom tabs + pull-to-refresh + gestos.
- Adaptación de pantallas críticas: dashboard, pago de facturas (multi-step), aprobación de cambios Excel, cierre de caja.
- Pantalla de bloqueo "Vendedor desktop-only" en mobile.
- Polish del diseño: aplicación final del aesthetic direction (Sección 7), micro-interacciones, loading states refinados, empty states, error states.
- Performance: queries optimizadas, índices verificados, lazy loading donde corresponde.

**Entregable**: la encargada y el dueño Julio pueden operar desde el celular en su casa; la app se ve y se siente terminada.

#### Sprint 14 — QA + seguridad + corrida en paralelo (preparación)

**Objetivo**: validar el sistema completo antes de salir a producción.

- QA exhaustivo de todos los flujos.
- Pruebas de carga (~3 ventas/segundo, 50 webhooks/min) con datos simulados.
- Pen test básico: SQL injection, XSS, CSRF, exposición de tokens.
- Verificación final del audit log con tampering simulado.
- Configuración de monitoreo (Pino + Better Stack o similar).
- Documentación operativa para la encargada (manual del usuario).
- Capacitación de la encargada y un cajero piloto.

**Entregable**: el sistema está listo para correr en paralelo con Innovo. Se acuerda fecha de inicio de paralelo.

#### Semanas 15–18 — Corrida en paralelo + cutover

**Semanas 15–17**: Innovo y el sistema nuevo operan **en paralelo** durante 2–3 semanas.
- El cajero carga las ventas en **ambos** (Innovo + nuevo).
- Al final de cada turno, se compara: ¿coinciden los totales? ¿Las recaudaciones por método coinciden? ¿Las ventas por canal coinciden?
- Lo que difiere se investiga y se arregla.
- El sistema nuevo es **lectura para el dueño**, Innovo sigue siendo la fuente de verdad operativa hasta que se valide.

**Semana 18**: cutover.
- Última extracción de datos relevantes de Innovo (vía scraping visual si hace falta).
- El sistema nuevo pasa a ser **fuente de verdad operativa**.
- Innovo se da de baja del flujo de carga (los empleados dejan de cargar ahí).
- Innovo queda **encendido en modo solo-lectura** durante 30 días por las dudas.
- Al día 31 sin incidentes: cancelar el contrato con Innovo (ahorro USD 180/mes confirmado).

**Definition of Done de fase 1**:
- ✅ Todos los 🟠 críticos de Sección 12.3.2 resueltos
- ✅ Sistema operativo 30 días sin incidentes graves
- ✅ Innovo dado de baja
- ✅ Audit log con cadena íntegra desde día 1
- ✅ Backup nocturno descargable funcionando
- ✅ Performance dentro de targets (Sección 13.9)

### 13.4 Fase 2 — Bot WhatsApp + extensiones (semanas 19+)

**Objetivo principal**: reemplazar al personal de atención de WhatsApp con bot IA. Ahorro objetivo: **USD 270–300/mes**.

**Sprints estimados** (1 semana cada uno):

| Sprint | Foco |
|-|-|
| F2.1 | Setup WhatsApp Business API (Cloud API de Meta) — alta + dominios verificados |
| F2.2 | Bot básico con menú guiado: saludo, ver carta, tomar pedido, confirmar dirección |
| F2.3 | Integración con catálogo y carrito virtual del cliente |
| F2.4 | Bot con LLM para conversación natural (entender variantes, sugerir, manejar dudas) |
| F2.5 | Confirmación de pedido + envío de link de pago MP |
| F2.6 | Carga automática del pedido al sistema → ticket delivery imprime solo |
| F2.7 | Detección de casos que el bot no resuelve → escalar a humano (la encargada o pasar al canal de WhatsApp tradicional) |
| F2.8 | QA + tuning + soft-launch (50% mensajes vía bot, 50% humano) |
| F2.9 | Full launch del bot |

**Otras extensiones de fase 2** (en paralelo o después del bot):

- Control de stock (insumos + productos terminados, con recetas)
- Programación de pagos a proveedores (calendario)
- Mensajes automáticos de cumpleaños a clientes (cuando se aclare el módulo Aniversarios)
- Reportes diarios automáticos por mail al dueño
- Detección de anomalías de ventas
- Carga del catálogo de helados / embutidos / vinos / fiambres
- Integración del posnet con SDK (cuando se confirme modelo)

**Duración estimada fase 2**: 2–3 meses.

### 13.5 Fase 3 — Optimizaciones y nuevas features (mes 9+)

A definir según uso real. Candidatos potenciales:

- App nativa iOS/Android (si la PWA queda corta)
- Modo oscuro
- Multi-sucursal (si el negocio expande)
- Belvo conexión bancaria empresarial directa (si vale el costo)
- Integración con sistema fiscal (si el dueño cambia de criterio sobre ARCA)
- Convertir el sistema en producto multi-cliente (otras pasterías)
- Encuestas de satisfacción / programa de fidelización
- Marketing automation (campañas por WhatsApp)
- Analytics avanzado (cohortes, lifetime value de cliente, etc.)

### 13.6 Estimaciones de tiempo y esfuerzo

#### 13.6.1 Tiempo total fase 1

| Item | Duración |
|-|-|
| Pre-arranque (semana 0) | 1–2 semanas (depende de cuán rápido se resuelvan bloqueantes) |
| Desarrollo fase 1 | **14 semanas** (sprints 1–14) |
| Corrida en paralelo + cutover | **3–4 semanas** |
| **Total fase 1** | **~18–20 semanas (4–5 meses)** |

#### 13.6.2 Esfuerzo de desarrollo

Asumiendo 1 desarrollador full-time + soporte ocasional para QA y diseño:

- ~40h/semana × 14 semanas = **560 horas de desarrollo**
- + ~20h de soporte de Alejo durante toda la fase
- + ~10h de la encargada para QA y feedback

Si se contratan más manos (2 devs en paralelo), la duración baja a ~9–10 semanas pero el costo no baja proporcionalmente (overhead de coordinación).

### 13.7 Costos operativos (running costs)

#### 13.7.1 Mensual recurrente

**Fase 1 — desde el día 1**:

| Item | Costo USD/mes |
|-|-|
| VPS (Hetzner / DigitalOcean / Contabo, 4 vCPU / 8 GB) | 15–40 |
| Dominio (anualizado) | ~1 |
| Backups en Drive del dueño | 0 (incluido en Drive personal o Workspace) |
| LLM OCR para facturas (~50–200 facturas/mes × USD 0.01) | 1–5 |
| Email transactional (Resend, 100 mails/mes free) | 0 |
| Monitoreo (Better Stack / Axiom, free tier) | 0 |
| **Total fase 1 inicial** | **~17–46 USD/mes** |

**Fase 1 — cuando se prendan integraciones bancarias**:

| Item | Costo USD/mes |
|-|-|
| Belvo (3 cuentas bancarias) | 5–10 |
| **Total con Belvo** | **~22–56 USD/mes** |

**Fase 2 — cuando se prenda el bot WSP**:

| Item | Costo USD/mes |
|-|-|
| WhatsApp Business API (Meta Cloud, ~10k mensajes/mes) | 30–80 |
| LLM para bot WSP (~5k turnos/mes × USD 0.01) | 30–80 |
| **Total fase 2 inicial** | **~22–56 + 60–160 = 80–215 USD/mes** |

#### 13.7.2 Comparación con costos actuales del negocio

| Item | Hoy (Innovo + WSP humano) | Después fase 2 (sistema nuevo + bot) | Ahorro mensual |
|-|-:|-:|-:|
| Innovo soporte | USD 180 | 0 | +180 |
| Personal WhatsApp (1 turno) | USD 270–300 | ~USD 80–100 (queda 1 persona part-time para escalado) | +170–220 |
| Sistema nuevo (running costs) | 0 | USD 80–215 | -80–215 |
| **Neto** | | | **~+200–300 USD/mes ahorro** |

**Punto de equilibrio**: si el desarrollo cuesta USD 6.000–10.000, se paga en **20–50 meses** (1.5–4 años).

### 13.8 Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|-|-|-|-|
| Cambios de scope durante fase 1 (el cliente quiere features extra) | Alta | Medio | Sección 12 documenta el scope; cambios entran a "backlog fase 2" salvo que sean bloqueantes |
| Demora en alta de partners RAPPI / Pedidos YA | Media | Medio | Iniciar gestión en pre-arranque, no en sprint 10 |
| Posnets son legacy (no modernos) | Alta | Bajo | Sistema soporta modo manual desde el día 1 (Sección 4.8.2bis) |
| Resistencia operativa de los empleados al cambio | Media | Alto | Capacitación + corrida en paralelo + UI optimizada para velocidad (sub-30s pedido) |
| Internet inestable durante corrida en paralelo | Alta | Bajo | Local-first ya cubre el escenario; la corrida en paralelo expone el problema antes |
| OCR de facturas tiene errores | Media | Bajo | Estado `PENDIENTE_VALIDACION` obliga a admin a validar antes de aplicar |
| Catálogo final tiene productos que no calzan en el modelo Categoría → Tipo → Modificadores | Baja | Medio | Modelo es flexible; si aparece un caso raro, se agrega como producto especial. Validar con encargada en pre-arranque |
| El dueño cambia de opinión sobre ARCA y quiere facturación fiscal en el sistema | Baja | Alto | Es scope de fase 3, claramente fuera de fase 1. Si insiste, se cotiza aparte |
| La VPS se cae | Baja | Alto | Local-first sigue operando; backup en otro proveedor; alertas inmediatas |
| Tampering del audit log | Muy baja | Crítico | Hash chain + verificación diaria + backup cifrado independiente |
| Pérdida de credenciales (PIN admin olvidado, access tokens vencidos) | Media | Medio | Documentación de procesos de recuperación; el otro admin puede resetear PINs |
| Lexmark E460 deja de funcionar (modelo de 2009) | Media | Medio | Tener impresora de respaldo; el ticket delivery se puede mandar a la térmica si pasa |
| Banda ancha del local insuficiente para sync continuo | Baja | Medio | Sync es lightweight; medirlo en pre-arranque |
| Belvo no cubre BAPRO bien | Media | Bajo | Fallback a import manual de extracto |

### 13.9 Métricas de éxito (KPIs del proyecto)

#### 13.9.1 Operativas

| Métrica | Target fase 1 | Cómo se mide |
|-|-|-|
| Tiempo de carga de pedido (3 items) | <30 segundos | Audit log: timestamp creación venta → finalización |
| Tasa de cierres de caja con diferencia >$1.000 | <5% | Reporte diferencias de caja |
| Webhooks de plataformas perdidos | <0.1% | Reconciliación: webhooks recibidos vs API pull |
| Latencia de impresión de comanda (cocina) | <3 segundos desde estado PROCESADA | Logs del agente local |
| Uptime del sistema (VPS + local) | >99.5% mensual | Better Stack uptime monitor |
| Cantidad de aprobaciones admin in-line por turno | <5 promedio | Si crece, los permisos default están mal calibrados |
| Tasa de éxito de OCR de facturas (sin corrección admin) | >70% | Si admin tuvo que corregir, se cuenta como fail |

#### 13.9.2 De negocio

| Métrica | Target fase 1 | Cómo se mide |
|-|-|-|
| Ahorro real al dar de baja Innovo | USD 180/mes | Confirmado en factura del mes posterior al cutover |
| Reducción de tiempo del cierre de caja | -50% vs hoy | Encargada cronometra antes/después |
| Reducción de diferencias de caja | -50% vs el promedio histórico | Reporte mensual |
| % de ventas con audit log completo | 100% | Audit log diario |

#### 13.9.3 De fase 2

| Métrica | Target fase 2 | Cómo se mide |
|-|-|-|
| % de mensajes WhatsApp atendidos por bot sin humano | >70% | Logs del bot |
| Reducción de personal WSP | 1 turno completo eliminado | Confirmado en planilla de sueldos |
| Pedidos por WSP creados automáticamente | >80% del total WSP | Audit log del programa |
| Tiempo de respuesta promedio del bot | <5 segundos | Logs del bot |

### 13.10 Definition of Done por fase

**Fase 1 — DoD**:
- ✅ Los 14 sprints completados con DoD específico cumplido
- ✅ Corrida en paralelo de 2–3 semanas sin discrepancias mayores
- ✅ Cutover ejecutado y 30 días estables después
- ✅ Innovo dado de baja, ahorro confirmado
- ✅ KPIs operativos en target
- ✅ Audit log con cadena íntegra
- ✅ Documentación de operación entregada a la encargada
- ✅ Capacitación realizada
- ✅ Cliente firma aceptación

**Fase 2 — DoD**:
- ✅ Bot WSP atendiendo >70% de mensajes
- ✅ Reducción de personal WSP confirmada
- ✅ Stock funcional (si se incluyó)
- ✅ Otras extensiones según scope acordado
- ✅ KPIs de fase 2 en target
- ✅ Cliente firma aceptación

### 13.11 Coordinación y comunicación

**Cadencia recomendada durante fase 1**:

- **Daily** (durante sprints activos): standup de 10 min entre Alejo y desarrollador.
- **Semanal**: review de fin de sprint + demo + planning del siguiente. Participan Alejo + Encargada (si tiene tiempo).
- **Mensual**: revisión con el Dueño Julio. Estado del proyecto + decisiones pendientes (Sección 12) + ajustes de scope si los hay.
- **Ad-hoc**: cuando un bloqueante se destraba, se coordina sesión inmediata para no perder ritmo.

**Canales sugeridos**:
- WhatsApp grupo "Santa Teresita Sistema" para coordinación rápida
- Audit log compartido en GitHub Issues (un issue por bloqueante / pendiente crítico)
- Documento vivo (este SPEC) actualizado cuando se cierran pendientes

---

## Cierre del documento

Este SPEC.md (v1) tiene **13 secciones** que cubren la totalidad del scope acordado. Es la base sobre la cual se construye el sistema. Las decisiones cerradas están marcadas como tales; los pendientes están consolidados en la Sección 12; el plan de ejecución está en la Sección 13.

**Próximo paso operativo**: revisar este documento con el cliente (Encargada y Dueño Julio), cerrar los 4 bloqueantes de Sección 12.3.1, y arrancar el Sprint 1 de pre-arranque.

| Versión | Fecha | Cambios |
|-|-|-|
| 1.0 | 2026-04-27 | Versión inicial completa, 13 secciones |
