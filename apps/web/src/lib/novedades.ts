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
