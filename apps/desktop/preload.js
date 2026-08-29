// Puente entre el .exe y la web que corre adentro.
//
// Se mantiene al mínimo a propósito: todo lo que se expone acá queda al alcance
// de cualquier JS de la página, así que sólo van cosas que la web NO puede
// hacer sola y que son inofensivas si alguien las llama de más.
//
// Hoy es sólo la carpeta de descargas: dónde se paran los Excels que exporta la
// encargada. Es config de ESTA máquina (una ruta de Windows), así que no puede
// vivir en la base ni decidirla la nube.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('staDesktop', {
  /** La web lo usa para saber si está adentro del .exe o en un navegador. */
  esDesktop: true,

  /** Carpeta configurada, o null si nunca se eligió (default de Windows). */
  getCarpetaExports: () => ipcRenderer.invoke('exports:getCarpeta'),

  /** Abre el selector de carpetas de Windows. Devuelve la elegida (o la que ya había si cancelan). */
  elegirCarpetaExports: () => ipcRenderer.invoke('exports:elegirCarpeta'),

  /** Pasar null vuelve al default de Windows (Descargas). */
  setCarpetaExports: (carpeta) => ipcRenderer.invoke('exports:setCarpeta', carpeta),

  /** Abre la carpeta en el explorador, para chequear que los archivos estén ahí. */
  abrirCarpetaExports: () => ipcRenderer.invoke('exports:abrirCarpeta'),
});
