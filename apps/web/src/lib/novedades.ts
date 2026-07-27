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
