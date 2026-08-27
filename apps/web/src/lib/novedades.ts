/**
 * NOVEDADES — el "qué cambió" que ve el personal al abrir la app después de
 * una actualización.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  CÓMO AGREGAR NOVEDADES EN CADA RELEASE  (hacelo SIEMPRE, es el punto)
 * ────────────────────────────────────────────────────────────────────────
 *  1. Agregá una entrada NUEVA arriba de todo del array (la primera es la
 *     que se muestra).
 *  2. `version` tiene que coincidir con la versión que va a publicar el
 *     workflow *Release Desktop* (hoy bumpea alpha.N → alpha.N+1).
 *  3. Escribí `cambios` para la encargada y las empleadas, NO para
 *     programadores: qué van a notar ellas usando el sistema. Nada de
 *     nombres de archivos, endpoints ni jerga.
 *
 * El cartel se muestra una sola vez por versión: se compara `version` de la
 * primera entrada contra lo guardado en localStorage. Deliberadamente NO
 * usamos el endpoint /version del API: en la nube (Railway) devuelve 'dev'
 * porque STA_DESKTOP_VERSION sólo existe dentro del .exe, así que el aviso
 * no volvería a aparecer nunca en la web. Atarlo al changelog del bundle
 * hace que funcione igual en las cajas y en el celular.
 */

export interface Novedad {
  /** Debe coincidir con la versión publicada (ej. '2.0.0-alpha.57'). */
  version: string;
  /** Fecha legible que se muestra bajo el título (ej. '27 de julio'). */
  fecha: string;
  /** Titular corto y humano. */
  titulo: string;
  /** Qué van a notar. Una línea por cambio, en criollo. */
  cambios: string[];
}

export const NOVEDADES: Novedad[] = [
  {
    version: '2.0.0-alpha.68',
    fecha: '27 de agosto',
    titulo: 'Las facturas que el sistema no puede leer ya no se pierden',
    cambios: [
      'Cuando mandás por Telegram una factura donde el nombre del proveedor está como logo (no como letra), el sistema no lo puede leer. Hasta ahora te contestaba "no pude leer la factura" y había que cargarla entera a mano.',
      'Ahora entra igual. Queda guardada con todo lo demás —el monto, la fecha, los productos— y en Facturas aparece en rojo con el cartel "no pude leer de quién es".',
      'Le tocás "asignar proveedor", lo elegís de la lista y listo. Recién ahí se le suma la deuda a ese proveedor.',
      'Mientras no le asignes el proveedor, esa factura no aparece para pagar en ningún lado. Así no se paga por error una factura de la que todavía no se sabe de quién es.',
      'Si en la factura se llega a leer el CUIT, no hace falta hacer nada: va sola al proveedor correcto.',
    ],
  },
  {
    version: '2.0.0-alpha.67',
    fecha: '26 de agosto',
    titulo: 'Se arreglaron las cuentas de mayoristas y de proveedores',
    cambios: [
      'Mayoristas: el saldo que debía cada empresa estaba mal. Cuando un remito se marcaba con "Marcar cobrado", el sistema lo dejaba en verde pero seguía contándolo entero como deuda — por eso en La Juanita el saldo daba igual que el total remitado. Ahora el saldo baja como corresponde.',
      'Y si algún remito quedó marcado cobrado sin que se haya cargado el cobro, la ficha de esa empresa te lo avisa arriba con el monto y el número de remito: esa plata no está en ninguna cuenta. Si el cliente pagó, cargás el cobro; si fue un error, volvés el remito a pendiente.',
      'Al usar "Marcar cobrado" sin tener un cobro cargado que lo cubra, ahora avisa antes de hacerlo. Se puede seguir haciendo, pero ya no pasa de largo sin que nadie se entere.',
      'Proveedores: cuando pagabas desde Aportes y egresos, la plata salía de la caja pero las facturas seguían figurando impagas. Había que ir a marcarlas a mano desde Insumos.',
      'Ahora, al cargar un egreso a un proveedor, aparece la lista de sus facturas impagas y tildás de cuáles se descuenta. Si le pagás sólo una parte a una, escribís cuánto en el casillero de al lado y esa factura queda como pago parcial, con lo que falta a la vista.',
      'Podés tildar varias de una: el botón "Las más viejas primero" las llena solo, dejando las viejas saldadas del todo y la última como parcial si el monto no alcanza.',
      'Si no tildás ninguna sigue funcionando como antes: pago a cuenta, que baja el total que se le debe al proveedor sin tocar ninguna factura en particular.',
      'Las facturas y los saldos de proveedores quedaron puestos al día con todos los pagos que ya estaban cargados.',
      'Aportes y egresos: un pago que se cargó todo en una cuenta ahora se puede repartir después. Abrís el movimiento, "Editar", y con "Dividir entre cuentas" lo dejás por ejemplo 70% en efectivo y 30% por transferencia. Antes había que anularlo y cargarlo de nuevo.',
      'Se sacó del panel de Julio el cartel de "pedidos abiertos en el cajero": contaba todos los pedidos sin terminar desde que arrancó el sistema, no los del turno, así que el número no quería decir nada.',
    ],
  },
  {
    version: '2.0.0-alpha.65',
    fecha: '24 de agosto',
    titulo: 'Cargar las horas y pagarlas en el mismo paso',
    cambios: [
      'Al cargar las horas de alguien ahora aparece "Pagarle ahora". Si lo tildás, en el mismo paso se le paga: no hace falta cargar las horas y después ir a liquidar. Antes de confirmar te muestra la cuenta hecha, así ves exactamente cuánto va a salir.',
      'Los préstamos ya NO se descuentan solos. Si alguien debe $100.000 y trabaja un día, cobra su día completo y el préstamo queda igual — antes se le comía todo el sueldo hasta cubrirlo. Cuando le quieras descontar, ponés cuánto en el casillero "Va contra el préstamo": esta vez $10.000, la próxima lo que decidas, o nada.',
      'También podés pagarle sólo una parte de lo que trabajó y dejar el resto para otro día: lo que queda sin cobrar sigue guardado en HORAS, así que si sube el valor de la hora, sube también lo que le falta cobrar.',
      'Y si alguien trabaja un día entero para bajar el préstamo, se puede: ponés 0 en "se le paga" y el monto en "va contra el préstamo". No sale plata de la caja.',
      'Si en vez de trabajarlo devuelven la plata, ahora se puede cargar: botón "Devolvió plata" en su ficha del banco de horas, o desde Aportes y egresos eligiendo la categoría "Devolución de préstamo" y a quién corresponde. La plata entra a la caja del turno y la deuda baja sola — si cubre todo, el préstamo queda cancelado.',
      'En las dos formas, el sistema no te deja cargar más de lo que la persona debe, así que no queda una deuda en negativo.',
      'Ese pago tiene las mismas opciones que el pago de sueldo de siempre: elegís el concepto (Sueldo, Jornada, Horas extra…) y podés repartirlo entre dos cuentas, una parte en efectivo y otra por transferencia.',
      'Al cargar las horas podés cambiar la categoría SÓLO POR ESE DÍA. Sirve para cuando alguien de mostrador cubre cocina y ese día cobra distinto: se le paga a la tarifa de cocina y su categoría de siempre no cambia. En el listado, esos días quedan marcados con la categoría entre paréntesis para que se vean de un vistazo.',
      'Al dar de alta a un empleado ahora se le elige la categoría ahí mismo. Y en la lista de empleados, el que no tenga ninguna aparece avisado: sin categoría, las horas que le cargues valen $0.',
      'En la ficha de cada persona podés cambiar de dónde sale su valor hora (por categoría o un valor propio) con el botón "cambiar", al lado del nombre.',
    ],
  },
  {
    version: '2.0.0-alpha.64',
    fecha: '22 de agosto',
    titulo: 'Banco de horas: llevá la cuenta de lo que se le debe a cada uno',
    cambios: [
      'Nueva pestaña "Banco de horas": cargás las horas que trabajó cada persona y el sistema te dice cuánto se le debe, en horas y en plata.',
      'Los adelantos se cargan desde ahí: salen de la caja como siempre y además se descuentan solos del saldo de esa persona.',
      'Para pagarle, el botón "Liquidar" hace la cuenta completa —horas menos adelantos— y descuenta de la cuenta que elijas.',
      'El valor de la hora se configura por categoría (Cocina, Mostrador…): la cambiás una vez y vale para todos los de esa categoría, sin tocar empleado por empleado.',
      'Si aumentás una categoría, antes de confirmar te muestra cuánto sube la deuda que ya tenías acumulada.',
      'En Empleados ahora hay buscador con filtro por período y botón para bajar todo a Excel.',
      'Las pantallas que leen y escriben los Excels ahora los agarran directo del Drive. Antes andaban sólo desde las computadoras del local; ahora funcionan también desde el celular y desde cualquier lado.',
      'Cuando el sistema escribe en un Excel, Drive te guarda la versión anterior: si algo sale mal, se puede volver atrás desde el propio Drive.',
    ],
  },
  {
    version: '2.0.0-alpha.63',
    fecha: '20 de agosto',
    titulo: 'Se arregló el error al mandar porciones calientes',
    cambios: [
      'Ya se pueden mandar de nuevo las porciones calientes con aceite, aceite de oliva, manteca, mixta o rosa. Desde la actualización anterior, elegir cualquiera de ésas hacía que el pedido no saliera y apareciera "error interno del servidor". Los pedidos que no llevaban ninguna de esas opciones nunca tuvieron problema — por eso fallaba a veces sí y a veces no.',
      'Los precios no cambian: esas opciones siguen sin costar nada y se siguen imprimiendo en la comanda igual que siempre.',
      'De ahora en adelante, cuando algo falle el cartel te va a dar un código, tipo "STA-DB-7K4M2P". Anotalo o sacale una foto y pasalo — con ese código se puede ver exactamente qué pasó, en vez de tener que adivinar.',
      'El cartel también dice mejor qué pasó. Antes, muchas cosas salían como "error interno del servidor"; ahora, si el problema es que falta un producto o que no hay lista de precios, lo dice con esas palabras.',
      'Julio: en Administración hay una pantalla nueva, "Errores". Pegás ahí el código que te pasaron y aparece qué falló, en qué pantalla, quién lo hizo y a qué hora.',
    ],
  },
  {
    version: '2.0.0-alpha.62',
    fecha: '16 de agosto',
    titulo: 'Exportar a Excel, precios por sabor y remitos que se cobran solos',
    cambios: [
      'Botón "Exportar a Excel" en Ventas, Movimientos, Encargos y Facturas: baja TODO lo que buscaste (no sólo la página que estás viendo), con los totales arriba y bien grandes. Los importes bajan como números, así que podés sumarlos y filtrarlos en el Excel.',
      'En las listas de precios ahora se ven los sabores que cambian el precio del producto (las pizzas, por ejemplo) y cuánto queda cada uno. En una lista de mayorista le podés poner precio propio a un sabor, y volverlo al precio general cuando quieras.',
      'Al armar un remito ya podés elegir el sabor, igual que cuando cargás un pedido. El precio sale bien y los sabores salen impresos debajo de cada producto.',
      'Al crear un remito podés marcar "Lo paga ahora": queda cobrado y pagado de una, sin tener que volver a la ficha del cliente a cargar el cobro.',
      'Los cobros de mayoristas aceptan varios medios de pago a la vez (una parte en efectivo y otra por transferencia, por ejemplo). Cada parte entra a la cuenta que corresponde.',
      'El remito de un mayorista sólo ofrece los productos que están en la lista de ese cliente, no todo el catálogo.',
      'El cobro a un mayorista ahora entra en la caja del turno, así que aparece en el cierre.',
      'En el ticket de una venta cancelada, el cartel "CANCELADA" se ve mucho más grande y en negativo — no se pasa por alto.',
      'Aviso de aumentos: cuando llega una factura con un producto más caro que la última vez, el sistema te avisa en vez de cambiar el precio solo. Lo ves en Insumos y proveedores → Avisos de precio, con el precio de antes, el de ahora y cuánto subió, y ahí decidís si lo aprobás o no. Si lo aprobás, se actualiza el precio del programa y también el del Excel.',
      'En Insumos y proveedores hay una pestaña nueva "Excel" para pasar al archivo de Drive lo que el sistema ya sabe: lo que llegó y lo que se pagó de cada proveedor en la semana, y las cantidades compradas de cada producto. Siempre te muestra primero qué va a escribir, y recién si estás de acuerdo lo escribe.',
      'Nunca pisa lo que vos hayas escrito a mano: si una celda no coincide con lo que calculó, te la marca y la deja como está.',
      'Al entrar a cada proveedor hay una pestaña "Insumos" con todos sus productos, la presentación, la unidad y el precio, y los podés editar ahí mismo.',
    ],
  },
  {
    version: '2.0.0-alpha.61',
    fecha: '11 de agosto',
    titulo: 'Las aclaraciones de los movimientos ahora se ven en la tabla',
    cambios: [
      'En Movimientos hay una columna nueva "Aclaración" con el comentario que escribiste al cargar el aporte o el egreso.',
      'Aparecen también las aclaraciones de TODOS los movimientos viejos: siempre se guardaron, lo que faltaba era mostrarlas.',
      'En la caja del turno, cada egreso muestra su aclaración debajo de la categoría. Sirve para distinguir dos pagos de la misma categoría.',
      'Si la aclaración es larga se corta para que la fila no se desarme; pasando el mouse por encima se ve completa.',
    ],
  },
  {
    version: '2.0.0-alpha.60',
    fecha: '7 de agosto',
    titulo: 'Elegís si el remito se imprime al guardarlo',
    cambios: [
      'Al cargar o editar un remito hay una casilla "Imprimir al guardar", arriba del botón. Viene marcada.',
      'Si la destildás, el remito se guarda y no sale por la comandera. Después lo podés imprimir cuando quieras desde la ficha del cliente.',
      'El botón te avisa qué va a hacer: dice "Guardar remito e imprimir" o solo "Guardar remito".',
    ],
  },
  {
    version: '2.0.0-alpha.59',
    fecha: '7 de agosto',
    titulo: 'El remito ahora sale por la comandera, y el descuento vale con cualquier pago',
    cambios: [
      'Los remitos de mayorista se imprimen como ticket en la comandera del mostrador, igual que una venta. Antes salía una hoja A4 desde el navegador.',
      'En el ticket del remito va el nombre de la empresa donde iría el cliente, y queda un espacio para la firma de quien recibe.',
      'El resumen de cuenta del período no cambió: sigue siendo la hoja grande de siempre, con todos los remitos juntos.',
      'Si querés que los remitos salgan por otra comandera, se elige en Configuración → Impresoras (cada comandera tiene un check 🧾).',
      'El descuento al cobrar ya no es solo para efectivo: se puede aplicar con débito, crédito, transferencia o QR. Sirve para los días que hay promo con tarjeta.',
      'En el pago dividido el descuento se aplica sobre todo lo cobrado, no solo sobre la parte en efectivo.',
    ],
  },
  {
    version: '2.0.0-alpha.58',
    fecha: '5 de agosto',
    titulo: 'Remitos: imprimirlos de a uno, ver qué tienen adentro y marcarlos cobrados',
    cambios: [
      'En la lista de remitos de cada empresa hay una columna nueva con el dibujito de la impresora. Imprime ESE remito solo, con el título "Remito #N" y la fecha en que se emitió, en vez del resumen de cuenta entero.',
      'El resumen de cuenta de todo el período sigue estando igual que siempre, con su botón "Imprimir resumen".',
      'Ahora podés tocar un remito para abrirlo y ver qué productos se le cargaron, con las cantidades y los precios.',
      'Desde ahí también podés editarlo si te equivocaste al cargarlo (mientras no esté cobrado ni anulado).',
      'Los remitos ya no quedan todos en "pendiente" para siempre: podés marcarlos como cobrados. Cuando registrás un cobro, el sistema te deja tildar qué remitos se están pagando y te va sumando el monto solo.',
      'El saldo de la cuenta corriente sigue calculándose igual — marcar un remito como cobrado no le cambia la deuda al cliente, sólo te deja saber cuáles ya se pagaron.',
    ],
  },
  {
    version: '2.0.0-alpha.57',
    fecha: '27 de julio',
    titulo: 'Arreglamos el envío del cierre por email',
    cambios: [
      'Cuando mandabas el cierre de caja por email, la pantalla se quedaba cargando un montón de tiempo y terminaba en error, sin decir por qué. Eso ya está arreglado.',
      'Ahora, si el email no puede salir, el sistema avisa en pocos segundos y explica el motivo en castellano (por ejemplo, si el problema es la conexión o la contraseña de la casilla).',
      'Desde ahora vas a ver este cartel cada vez que el sistema se actualice, contando qué se cambió.',
    ],
  },
];

/** Versión de la novedad más reciente — es la que se compara con lo visto. */
export const VERSION_NOVEDADES: string = NOVEDADES[0]?.version ?? '';

/** Clave de localStorage donde se recuerda la última novedad ya leída. */
export const NOVEDADES_STORAGE_KEY = 'sta_novedades_vistas_v1';
