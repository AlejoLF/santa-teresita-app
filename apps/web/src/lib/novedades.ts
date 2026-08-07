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
