# Preguntas pendientes para completar el sistema Santa Teresita

> Este documento existe para que **vos (Alejo)** coordines con el dueño y la encargada y obtengas la información que falta. Cada sección está dirigida a una persona específica. Podés copiarla y mandarla por WhatsApp / mail tal cual.
>
> Las preguntas están **ordenadas por urgencia**: las primeras frenan el desarrollo, las últimas son refinamientos.
>
> **Última actualización**: 2026-04-27 (al cierre del SPEC.md v1.0)

---

## Cómo usar este documento

1. **Para el Dueño Julio**: copiá la sección "📩 Para el Dueño" y mandásela.
2. **Para la Encargada**: copiá la sección "📩 Para la Encargada" y mandásela.
3. **Para vos (Alejo)**: la sección "🧑 Tareas tuyas (gestión)" tiene cosas que tenés que coordinar con terceros (proveedores de delivery, Belvo, etc.).
4. A medida que llegan respuestas, marcá ✅ en cada item para llevar control.

Tres niveles de urgencia:

- 🔴 **URGENTE — bloquea desarrollo**: sin esto no se puede arrancar
- 🟠 **CRÍTICO — antes de salir a producción**: necesario antes del cutover, pero el desarrollo ya puede arrancar
- 🟡 **IMPORTANTE — durante implementación**: refinamientos que se resuelven en el camino

---

## 📩 Para el Dueño Julio

> Hola Julio, te paso las preguntas que necesito para construir el sistema. Algunas son para ya, otras pueden esperar — están marcadas por urgencia. Si alguna no la sabés vos, decime y lo veo con la encargada o con quien corresponda.

### 🔴 URGENTE

#### J-U1. Internet del local: cómo llega y cómo es

- ¿Qué proveedor de internet tenés en el local? (Fibertel, Telecentro, Movistar, otro)
- ¿Es fibra óptica, cable, ADSL, satelital, 4G?
- ¿Sabés si tenés **IP pública** o estás detrás del NAT del proveedor?
- ¿Tenés conexión de respaldo (4G, otro proveedor) por si se cae la principal?
- ¿Tenés UPS (batería de respaldo) para los cortes de luz cortos?

**Por qué te lo pregunto**: el sistema corre en parte en el local y en parte en la nube. Si el internet del local es muy inestable, hay decisiones técnicas que cambian.

**Tu respuesta**:
```
Proveedor:
Tipo de conexión:
IP pública o NAT:
Conexión de respaldo:
UPS:
```

#### J-U2. Dominio del sistema

- ¿Querés que el sistema viva en un dominio propio (ej. `santateresita.com.ar`, `pastassantateresita.com.ar`, otro)? ¿O usás uno que ya tenés?
- Si no tenés ninguno, lo registro yo a tu nombre.

**Por qué te lo pregunto**: necesito una URL pública para que las plataformas (RAPPI, Pedidos YA, MELI) manden los pedidos al sistema.

**Tu respuesta**:
```
Dominio preferido:
¿Lo registro yo a tu nombre? (sí/no):
```

#### J-U3. Acceso al Drive donde viven los Excels actuales

- ¿En qué cuenta de Google viven los Excels de `CASHFLOW 2026`, `Ventas x día 2026`, `Proveedores 2026`, `Lista de Precios`?
- ¿Me podés dar el link de la **carpeta compartida** donde están?
- Voy a generar una "cuenta de servicio" del sistema que necesita tener permisos de lectura/escritura en esa carpeta. Te paso el mail de la cuenta y la sumás como editora.

**Por qué te lo pregunto**: el sistema mantiene los Excels actualizados automáticamente.

**Tu respuesta**:
```
Cuenta Google donde viven los Excels:
Link a la carpeta compartida:
```

### 🟠 CRÍTICO antes de producción

#### J-C1. Identidad visual de la marca

- ¿Tenés un **logo** del local? Si sí, mandámelo en versiones:
  - Color (PNG con fondo transparente, alta resolución) → para el panel admin y el ticket de delivery
  - Monocromo / blanco y negro (BMP o PNG) → para los tickets térmicos
- Si no tenés logo, podemos hacer uno simple en texto o coordinar diseño aparte.
- El sistema va a usar **verde profundo (parecido al color de los tickets actuales) + crema/papel** como paleta. ¿Te identificás con eso o querés cambiar la dirección estética?

**Tu respuesta**:
```
Logo color (link o adjuntar):
Logo monocromo (link o adjuntar):
¿Confirmás paleta verde + crema?:
```

#### J-C2. Footer del ticket cliente (oportunidad de marketing)

Hoy el ticket actual de Innovo no tiene footer. Yo te recomiendo agregar info al final del ticket para que el cliente lo recuerde.

¿Qué querés que aparezca?
- ¿Mensaje principal? (ej. "¡Gracias por su compra!" o algo más distintivo)
- ¿Instagram? (handle exacto)
- ¿Web?
- ¿Teléfono / WhatsApp del local?
- ¿Algún mensaje promocional rotativo? (ej. "Pedí los miércoles con 10% off")

**Tu respuesta**:
```
Mensaje principal:
Instagram:
Web:
Teléfono / WhatsApp:
Mensaje promocional (opcional):
```

#### J-C3. Cómo se manejan las 4 cuentas bancarias

Tenés Santander, Galicia, Cuenta DNI (BAPRO) y MercadoPago. La encargada me dijo que se usan indistintamente para pagar proveedores y sueldos. Pero quiero saber si vos tenés alguna preferencia o regla mental que querés reflejar:

- ¿Hay alguna cuenta que es "para sueldos" exclusivamente?
- ¿Alguna que es "para Julio" (tus retiros)?
- ¿Alguna que es "para impuestos / mantenimiento"?
- ¿O todas son indistintas?

Esto afecta cómo se ven los saldos en el dashboard. Si todas son indistintas, el sistema te muestra "saldo total disponible" como suma de las 4. Si hay separaciones, las puedo mostrar agrupadas.

**Tu respuesta**:
```
Santander se usa para:
Galicia se usa para:
Cuenta DNI se usa para:
MercadoPago se usa para:
```

#### J-C4. Quién recibe los emails del sistema

- **Resúmenes de cierre de turno** (mañana y tarde): yo asumo que llegan al mail tuyo y de la encargada. ¿Confirmás los mails exactos? ¿Querés sumar al contador?
- **Alertas críticas** (diferencias de caja recurrentes, audit log roto, integración caída): solo a vos? ¿También encargada?
- **Resumen semanal de actividad sospechosa** (anulaciones, descuentos grandes, etc.): te lo recomiendo, pero ¿lo querés?

**Tu respuesta**:
```
Mail Julio:
Mail Encargada:
Mail Contador (si querés sumarlo):
¿Sumar resumen semanal?:
¿Quién recibe alertas críticas? (Julio / Encargada / ambos):
```

#### J-C5. Backups del sistema

El sistema genera un backup encriptado todas las noches con toda la info del negocio. Lo subo a tu Drive privado para que vos lo tengas.

- ¿Qué cuenta de Google querés que sea la del backup? (puede ser la misma de los Excels o una privada)
- Necesito una **passphrase** (clave secreta) que solo vos sepas, para encriptar los backups. Si la perdés, no se puede recuperar — ese es el punto. ¿Cómo la querés gestionar? (contraseña que solo vos guardás, escrita en algún lado seguro, etc.)
- ¿Querés además un USB conectado al servidor del local con copia adicional? Cuesta ~USD 30 una vez.

**Tu respuesta**:
```
Cuenta de Drive para backups:
Passphrase (NO me la mandes a mí, solo confirmame que la tenés):
¿USB local de backup?:
```

#### J-C6. Cuenta de partner en RAPPI / Pedidos YA / Mercado Libre

¿Tenés cuenta de partner / restaurant en cada plataforma? Si no, hay que iniciar el alta (puede tardar días o semanas).

- **RAPPI**: si tenés cuenta, en el panel de RAPPI hay una sección de "Integración" o "Webhooks" — necesito acceso a las credenciales (API key + webhook secret).
- **Pedidos YA**: idem.
- **Mercado Libre Envíos**: idem (en MELI Developers).

**Tu respuesta**:
```
RAPPI: tengo cuenta partner / falta gestionar / no quiero integrar
Pedidos YA: tengo cuenta partner / falta gestionar / no quiero integrar
MELI: tengo cuenta partner / falta gestionar / no quiero integrar
```

### 🟡 IMPORTANTE durante implementación

#### J-I1. Permisos y descuentos máximos

- ¿Cuál es el **% máximo de descuento** que un cajero (rol Vendedor) puede aplicar sin pedirte autorización? Yo te recomiendo **5%**. Sobre eso requiere PIN admin.
- ¿Cuál es el **monto máximo de diferencia de caja** que se aprueba sin admin? Yo te recomiendo **$1.000**. Sobre eso, requiere que vos o la encargada autoricen.

**Tu respuesta**:
```
% máximo descuento sin admin:
$ máximo diferencia de caja sin admin:
```

#### J-I2. ¿Encargada puede resetear tu PIN?

Si te olvidás del PIN admin, la encargada puede resetearlo desde su sesión (ella necesita su propio PIN admin para hacerlo). ¿Estás de acuerdo? ¿O preferís que solo vos puedas resetearlo (y si lo olvidás, hay que llamarme)?

**Tu respuesta**:
```
¿Encargada puede resetear PIN del dueño?: sí / no
```

#### J-I3. ¿Se quiere modo oscuro?

¿La pantalla del admin se ve mejor en modo oscuro o claro? Por default es claro. El modo oscuro es +20% de tiempo de desarrollo.

**Tu respuesta**:
```
Modo oscuro: sí / no / fase 2
```

---

## 📩 Para la Encargada

> Hola, te paso una serie de preguntas que necesito para terminar de armar el sistema nuevo. La mayoría son cosas operativas que vos sabés mejor que nadie. Algunas son urgentes, otras pueden esperar.

### 🔴 URGENTE

#### E-U1. Catálogo de productos — confirmar el Excel

El Excel `Lista de Precios.xlsx` que me pasaste tiene la hoja `RESTO SIMPLE` con los productos organizados por categoría. La estructura me parece bien, pero tengo dudas:

- En la hoja **`Hoja 1`** (que tiene los precios actualizados), algunos productos tienen valores que no entiendo bien:
  - **Sorrentinos** dice $23.500. ¿Este precio es por **kilo**, por **docena**, por **unidad**? En el ticket vi "380 sorrentinos × 23,5", lo que sugiere que es $23,5 por sorrentino. Pero entonces $23.500 sería 1.000 sorrentinos, lo cual no tiene sentido. ¿Cómo se carga hoy en Innovo?
  - **Ravioles**: ¿se venden por **plancha** (48 ravioles) o también por **unidad**?
  - **Lasagna / Rondelli / Canelones**: ¿se venden por unidad, por porción individual, por bandeja?
  - **Tortelettis**: ¿unidad de venta?

- En la sección **"Porciones calientes"** vi versiones "Simple" y "Especial" de cada pasta. ¿Qué cambia entre Simple y Especial? ¿Cantidad de pasta? ¿Salsa incluida? ¿Presentación?

**Tu respuesta**:
```
Sorrentinos: precio es por (kilo / docena / unidad / otro):
Ravioles: se venden por (plancha de 48 / unidad / porción / otros):
Lasagna / Rondelli / Canelones: unidad de venta:
Tortelettis: unidad de venta:
Diferencia entre porción Simple y Especial:
```

#### E-U2. Combos / Promos vigentes

Te pido la lista completa de los **combos y promos** que ofrecen hoy con:
- Nombre exacto del combo
- Componentes (qué incluye)
- Precio del combo
- Si se publican en delivery, RAPPI, Pedidos YA, etc., o solo mostrador

Ejemplos que vi en tickets / Excel: "Promo 4 canelones + salsa + postre", "Promo Pizza + 8 empanadas", "Promo 24 sorrentinos + postre", "Promo 1 Kg fideos + 2 salsas + queso".

**Tu respuesta** (escribí cada combo en una línea):
```
1. Nombre / componentes / precio / canales:
2. ...
3. ...
```

#### E-U3. Servidor del local

- ¿Cuál es la PC que actúa de servidor (la que tiene la IP `192.168.1.100`)?
- ¿Qué características tiene? (procesador, RAM, disco)
- ¿Está enchufada a UPS?
- ¿Está físicamente en el mostrador, en tu oficina, o en otro lugar?

Si la PC actual es muy vieja o tiene problemas, vamos a tener que cambiarla por una mini-PC nueva (NUC) o una Raspberry Pi 5. Cuesta entre USD 100 y USD 400 según el modelo.

**Tu respuesta**:
```
Procesador / RAM / disco aproximado:
Está enchufada a UPS:
Ubicación física en el local:
```

### 🟠 CRÍTICO antes de producción

#### E-C1. Posnets actuales

Necesito **foto** de cada posnet activo en el local + foto de **un ticket** que imprima cada uno (los datos del ticket me dicen qué adquirente es).

Si los posnets son modelos modernos (Mercado Pago Point, Ualá Bis, Modo, Geopagos, Naranja X), se pueden integrar al sistema y ya no necesitás tipear el monto en el posnet — se manda solo. Si son modelos viejos (Lapos clásico, Visa Posnet legacy), funcionan en modo manual.

**Tu respuesta** (foto adjunta de cada uno):
```
Posnet 1 (mostrador): marca / modelo / banco vinculado:
Posnet 2 (delivery): marca / modelo / banco vinculado:
Posnet 3 (...): ...
```

#### E-C2. DELIVERATE

- ¿DELIVERATE tiene **API** para recibir pedidos automáticos, o los pedidos llegan por mail / WhatsApp y vos los cargás manual?
- ¿Cuál es el **plazo típico** de liquidación? (cuántos días pasan desde la entrega hasta que te pasan la plata)
- ¿Cuál es la **comisión** que cobran? ¿Es % o monto fijo?
- ¿Pasan la plata en transferencia o en efectivo?

**Tu respuesta**:
```
¿API o manual?:
Plazo de liquidación (días):
Comisión:
Forma de pago:
```

#### E-C3. Comisión mensual de mantenimiento de cada cuenta

Mirando los extractos de los últimos 2 meses de cada cuenta:
- Santander — comisión mensual:
- Galicia — comisión mensual:
- Cuenta DNI (BAPRO) — comisión mensual:
- MercadoPago — comisión mensual (si hay):

Esto es para que el sistema sepa cuánto descontar mes a mes y el dashboard del dueño muestre el costo financiero correcto.

**Tu respuesta**:
```
Santander: $
Galicia: $
Cuenta DNI: $
MercadoPago: $
```

#### E-C4. Lista de proveedores con datos

Te paso un Excel para completar (o copiame esto) con cada proveedor:

| Proveedor | CUIT | Condición IVA | Plazo de pago | CBU/Alias |
|-|-|-|-|-|
| Lingotes | | | | |
| Vacalin | | | | |
| Free Vegetales | | | | |
| Navacerrada | | | | |
| Luis Gourmet | | | | |
| Grafipack (Blanco) | | | | |
| Grafipack (Negro) | | | | |
| Polibol | | | | |
| Condiriko | | | | |
| Maprisa | | | | |
| Grupo DF Sin TACC | | | | |
| La Pastelera Sin TACC | | | | |
| Campodonico | | | | |
| Rama | | | | |
| Prod. Silvia | | | | |
| Roca Food | | | | |
| Ave Fenix (Blanco) | | | | |
| Ave Fenix (Negro) | | | | |
| Milkaut | | | | |
| Corycor | | | | |
| Carnicería Fca. | | | | |
| Carnicería Julio Felipe | | | | |
| Cosenza | | | | |
| Fiambre del Sur | | | | |
| Marcelo Dist. | | | | |
| Fiambres Cibum-Agri | | | | |
| Vinos | | | | |
| Cervezas | | | | |
| Limpieza | | | | |
| Huevos | | | | |
| Pollos | | | | |

#### E-C5. Lista de empleados

Para dar de alta a los empleados en el sistema:

| Nombre | Apellido | DNI | Tipo (cocina/cajero/repartidor/admin) | Sueldo aprox. | Frecuencia (semanal/quincenal/mensual) |
|-|-|-|-|-|-|
| | | | | | |

#### E-C6. Tickets actuales

Necesito **foto** de cada ticket actual:
- Ticket de mostrador (térmico) — lo tengo, ya me lo pasaste
- Ticket de delivery (más chico que A5) — no me lo pasaste, te lo pido
- Comanda de cocina (si existe hoy) — preguntar

¿Cuál es el **tamaño exacto** del papel que usa la impresora láser de delivery? ¿Es media A5 (74×210mm), un formato custom...?

**Tu respuesta**:
```
Tamaño del papel del ticket delivery:
Foto adjunta del ticket delivery actual:
¿Hay comanda de cocina hoy o se imprime un solo ticket?:
```

#### E-C7. Lexmark E460 (impresora láser de delivery)

La impresora actual es modelo de 2009 (Lexmark E460). ¿Funciona bien? ¿Sin problemas de drivers ni atascos frecuentes?

Si está vieja, hay que considerar reemplazarla. Una impresora láser nueva mono cuesta entre USD 200 y USD 400.

**Tu respuesta**:
```
Lexmark E460 funciona bien: sí / no
Si no, ¿con qué problemas?:
```

### 🟡 IMPORTANTE durante implementación

#### E-I1. Aniversarios de clientes

Cuando hablamos del módulo, dijiste que querías consultar bien qué hace. ¿Lo charlaste con el dueño? ¿Sabés qué quieren?

- ¿Es un **mensaje automático de cumpleaños** al cliente por mail?
- ¿O un descuento especial?
- ¿Cómo se identifica al cliente (cumpleaños cargado en su ficha)?

**Tu respuesta**:
```
Qué quieren del módulo Aniversarios:
```

#### E-I2. Asignación de delivery propio

Cuando un pedido sale por delivery propio (Damián), ¿se asigna repartidor al cargar el pedido o al momento de salir?

- Si hay solo un repartidor (Damián), siempre es él.
- Si hay más, ¿quién decide quién va? ¿Vos? ¿Los repartidores eligen?

**Tu respuesta**:
```
¿Cuántos repartidores propios hay?:
¿Cómo se asigna quién lleva qué?:
```

#### E-I3. Motivos de anulación (lista pre-cargada)

Para no escribir motivos a mano cada vez que se anula una venta, te propongo una lista pre-cargada. ¿Cuáles son los motivos típicos?

Sugerencias:
- Cliente se arrepintió
- Pedido duplicado
- Error de carga del cajero
- Producto no disponible
- Tiempo de preparación excedido
- (otros...)

**Tu respuesta**:
```
Motivos típicos:
```

#### E-I4. Tiempo prometido en pedidos take-away

Cuando un cliente carga un pedido para retirar (no delivery), ¿se le da un **tiempo prometido** ("vení a buscarlo en 30 min")?

Si sí, eso aparece en el ticket cliente y la cocina se organiza por eso.

**Tu respuesta**:
```
¿Hay tiempo prometido en take-away?: sí / no
Cómo se calcula (fijo X min, según items, etc.):
```

#### E-I5. Foto en cada producto del catálogo del cajero

Para que el cajero vea las opciones más rápido, los productos pueden tener foto. Pero hay que tener foto de cada uno.

- ¿Tenés fotos de los productos? (mismo o similar a las que usás en Pedidos YA)
- ¿Querés que el cajero vea fotos o alcanza con el nombre + precio?

**Tu respuesta**:
```
¿Hay banco de fotos?:
¿Querés foto en el cajero?: sí / solo en algunos / no
```

#### E-I6. Categorías de movimientos

Te propuse una lista de categorías base (Empleados, Sueldos, Servicios, Mantenimiento, Impuestos, etc.). ¿Hay alguna categoría adicional que uses hoy y que falte?

¿Te suena raro alguno de estos nombres? ¿Preferís otros?

**Tu respuesta**:
```
Categorías que faltan:
Categorías que querés renombrar:
```

#### E-I7. Hora del job nocturno automático de sync

El sistema corre un job a las **3 AM** para asegurar que todo quede consolidado al día siguiente. ¿Te molesta esa hora? ¿Hay alguna otra mejor?

**Tu respuesta**:
```
Hora del job nocturno:
```

---

## 🧑 Tareas tuyas (Alejo) — gestión externa

### 🔴 URGENTE

#### A-U1. Comprar VPS

Necesitás contratar un VPS en Hetzner o DigitalOcean. Sugerencia:

- **Hetzner CX31**: 2 vCPU / 8 GB RAM / 80 GB SSD / EUR 5.83/mes (USD ~6)
- **Hetzner CCX13**: 4 vCPU dedicado / 16 GB RAM / 80 GB SSD / EUR 14.10/mes (USD ~16)
- **DigitalOcean** equivalentes a USD ~24/mes

Yo te recomiendo arrancar con **CCX13 de Hetzner** porque tiene CPU dedicado (mejor para Postgres) y margen para crecer.

**Acción**: registrar cuenta en Hetzner, crear el server, pasarme las credenciales SSH para configurarlo.

#### A-U2. Comprar / definir servidor local

Si la PC actual del local (la del IP `192.168.1.100`) es vieja, hay que reemplazarla.

Opciones recomendadas:
- **Intel NUC 13** (mini-PC): USD 350–450 — la más confiable
- **ASUS PN64**: USD 300–400
- **Raspberry Pi 5 8GB**: USD 100–140 — más barata pero menos potente

Para el volumen de Santa Teresita, la **Raspberry Pi 5** alcanza. Pero un NUC tiene más margen y es más confiable a largo plazo.

**Acción**: confirmar con la encargada el estado del servidor actual. Si hay que cambiar, comprar.

### 🟠 CRÍTICO antes de producción

#### A-C1. Verificar cobertura de Belvo

Antes de comprometerte con Belvo (USD 5–10/mes), verificá:
- ¿Belvo cubre Banco Provincia / Cuenta DNI / BAPRO en Argentina?
- ¿Cubre la cuenta empresarial de Santander y Galicia que tiene el negocio (no solo cuentas personales)?

Si no cubren BAPRO, tendrás que importar extractos manuales para esa cuenta.

**Acción**: pedirle a Belvo una demo / consulta.

#### A-C2. Coordinar alta de partner con plataformas

Las altas en RAPPI, Pedidos YA y Mercado Libre pueden tardar **semanas**. Iniciar el proceso lo antes posible:

- Te paso documentación / requisitos de cada una a medida que vamos a integrar.
- Necesitás los datos del negocio (CUIT, cuenta bancaria para liquidación, etc.).

#### A-C3. Coordinar con DELIVERATE

Hablar con DELIVERATE para saber:
- ¿Tienen API documentada para integración con sistemas de partners?
- Si no, ¿cuál es el flujo actual que tienen? (mail, panel web, WhatsApp, etc.)

---

## 🛠️ Decisiones técnicas (Developer — solo para tu info)

Estas se resuelven durante implementación, no necesitás coordinar con nadie.

- Particionado de AuditLog: en fase 2/3, cuando supere 5M registros
- Implementación de hash chain: validar performance del trigger, fallback a job async si pesa
- Escalado de Redis si hace falta (probable con 1 instancia para fase 1)
- Estrategia de reintentos para webhooks: backoff exponencial
- Locking distribuido para sync con Drive: SETNX en Redis con TTL
- Encriptación de credenciales de integraciones: AES-256-GCM con key en variables de entorno
- Estrategia de logging estructurado: Pino + Better Stack o Axiom (decidir según costo)

---

## ✅ Checklist de seguimiento

Marcá ✅ cuando se resuelva cada item:

### Bloqueantes (URGENTE)
- [ ] J-U1. Internet del local
- [ ] J-U2. Dominio
- [ ] J-U3. Acceso a Drive
- [ ] E-U1. Catálogo confirmado
- [ ] E-U2. Combos vigentes
- [ ] E-U3. Servidor del local
- [ ] A-U1. VPS comprado
- [ ] A-U2. Servidor local definido

### Críticos antes de producción
- [ ] J-C1. Logo + paleta
- [ ] J-C2. Footer ticket
- [ ] J-C3. Uso de cuentas bancarias
- [ ] J-C4. Mails destinatarios
- [ ] J-C5. Backups + passphrase
- [ ] J-C6. Partner platforms
- [ ] E-C1. Posnets (fotos)
- [ ] E-C2. DELIVERATE
- [ ] E-C3. Comisiones mensuales
- [ ] E-C4. Lista proveedores con CUIT
- [ ] E-C5. Lista empleados
- [ ] E-C6. Tickets actuales (fotos)
- [ ] E-C7. Lexmark E460 status
- [ ] A-C1. Cobertura Belvo
- [ ] A-C2. Alta plataformas
- [ ] A-C3. DELIVERATE API

### Importantes
- [ ] J-I1. % máximo descuento
- [ ] J-I2. Reset PIN admin
- [ ] J-I3. Modo oscuro
- [ ] E-I1. Aniversarios
- [ ] E-I2. Asignación delivery
- [ ] E-I3. Motivos anulación
- [ ] E-I4. Tiempo prometido take-away
- [ ] E-I5. Fotos productos
- [ ] E-I6. Categorías movimientos
- [ ] E-I7. Hora job nocturno

---

## Glosario de términos (por si te preguntan)

- **VPS**: servidor en la nube (Virtual Private Server). Es donde corre la "parte central" del sistema, accesible por internet.
- **Servidor local**: una mini-PC dentro del local que coordina las computadoras del mostrador y maneja la impresión. Se sincroniza con la VPS pero puede operar sola si se cae internet.
- **Webhook**: una notificación automática que una plataforma externa (RAPPI, MercadoPago, etc.) le manda al sistema cuando pasa algo (un pedido nuevo, un pago confirmado).
- **API**: la forma técnica de que dos sistemas se hablen automáticamente.
- **Posnet integrable**: posnet moderno que se conecta al sistema y recibe el monto a cobrar automáticamente, sin que el cajero tipee.
- **Belvo**: empresa que conecta cuentas bancarias con sistemas externos (parecido a Plaid en EEUU). Permite ver el saldo del banco en vivo desde el sistema.
- **N8N**: herramienta de automatización tipo Zapier, que corre en el servidor y maneja los flujos del bot de Telegram para facturas y, en fase 2, el bot de WhatsApp.
- **Audit log**: el registro inmutable de todas las acciones del sistema. Sirve como "caja negra" para investigar cualquier sospecha.
- **Hash chain**: técnica criptográfica donde cada registro de auditoría contiene el hash del anterior. Si alguien manipula un registro, la cadena se rompe y queda detectable. Es como blockchain sin blockchain.
- **PIN admin in-line**: cuando un cajero intenta hacer algo que requiere autorización del admin, aparece un popup pidiendo el PIN del admin. Si el admin lo tipea, la acción se ejecuta. La sesión sigue siendo del cajero, no se "loguea" como admin.

---

**Cualquier duda mientras la mando, me preguntás. A medida que llegan respuestas, actualizamos el SPEC.md (Sección 12 está enlazada con cada pregunta acá).**
