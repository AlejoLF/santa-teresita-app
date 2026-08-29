'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';

/**
 * Configuración → Exportación.
 *
 * Dos cosas distintas que la encargada vivía como una sola ("no encuentro los
 * Excels"):
 *
 *  1. **Dónde se guardan.** Sólo se puede fijar desde el `.exe`: es una carpeta
 *     de Windows y una página web no tiene manera de elegir dónde baja los
 *     archivos el navegador. Adentro del .exe el puente es `window.staDesktop`
 *     (apps/desktop/preload.js). El diálogo de guardar SIGUE apareciendo — se
 *     pidió expresamente no sacarlo — pero ya parado en la carpeta elegida.
 *
 *  2. **Cómo se llaman.** Eso ya está arreglado del lado del server y aplica
 *     igual en el navegador: los archivos salen con el nombre de la tabla y el
 *     período exportado en vez de "Excel".
 */

/** Lo que expone el preload del .exe. En un navegador común no existe. */
interface PuenteDesktop {
  esDesktop: true;
  getCarpetaExports: () => Promise<string | null>;
  elegirCarpetaExports: () => Promise<string | null>;
  setCarpetaExports: (carpeta: string | null) => Promise<string | null>;
  abrirCarpetaExports: () => Promise<string>;
}

function puente(): PuenteDesktop | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { staDesktop?: PuenteDesktop }).staDesktop ?? null;
}

const EJEMPLOS = [
  ['Movimientos de un rango', 'movimientos-2026-08-01-a-2026-08-29.xlsx'],
  ['Facturas filtradas por estado', 'facturas-2026-08-01-a-2026-08-29-estado-pendiente-pago.xlsx'],
  ['Ventas de hoy con una búsqueda', 'ventas-2026-08-29-hoy-busqueda-empanadas.xlsx'],
  ['Empleados (sin filtro de fechas)', 'empleados-2026-08-29.xlsx'],
];

export default function ExportacionPage() {
  const [enDesktop, setEnDesktop] = useState<boolean | null>(null);
  const [carpeta, setCarpeta] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = puente();
    setEnDesktop(!!p);
    if (!p) return;
    p.getCarpetaExports()
      .then(setCarpeta)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'No se pudo leer la carpeta configurada'),
      );
  }, []);

  async function elegir() {
    const p = puente();
    if (!p) return;
    setOcupado(true);
    setError(null);
    try {
      setCarpeta(await p.elegirCarpetaExports());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo abrir el selector de carpetas');
    } finally {
      setOcupado(false);
    }
  }

  async function volverAlDefault() {
    const p = puente();
    if (!p) return;
    setOcupado(true);
    setError(null);
    try {
      setCarpeta(await p.setCarpetaExports(null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo restablecer');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <section className="card p-5">
        <h2 className="font-display text-lg text-teresita-700 mb-1">
          Dónde se guardan los Excels
        </h2>
        <p className="text-sm text-ink-500 mb-4">
          Al exportar una tabla, Windows sigue preguntando dónde guardar. Lo que se elige acá es
          la carpeta en la que se para esa ventana, para no tener que buscarla cada vez.
        </p>

        {enDesktop === null && <p className="text-sm text-ink-500">Cargando…</p>}

        {enDesktop === false && (
          <div className="rounded-lg border border-cream-300 bg-cream-100 p-4 text-sm text-ink-700">
            <p className="font-medium mb-1">Esto se configura desde la app instalada.</p>
            <p className="text-ink-500">
              Estás entrando desde el navegador, y la carpeta de descargas la decide el navegador
              (en Chrome: los tres puntitos → Configuración → Descargas). Abriendo Santa Teresita
              desde el ícono del escritorio vas a poder fijarla acá.
            </p>
          </div>
        )}

        {enDesktop === true && (
          <div className="space-y-3">
            <div className="rounded-lg border border-cream-300 bg-cream-50 px-4 py-3">
              <p className="text-2xs uppercase tracking-wider text-ink-500 mb-1">Carpeta actual</p>
              <p className="font-mono text-sm text-ink-900 break-all">
                {carpeta ?? 'Descargas (la que trae Windows)'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void elegir()} disabled={ocupado}>
                {carpeta ? 'Cambiar carpeta' : 'Elegir carpeta'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void puente()?.abrirCarpetaExports()}
                disabled={ocupado}
              >
                Abrir carpeta
              </Button>
              {carpeta && (
                <Button variant="secondary" onClick={() => void volverAlDefault()} disabled={ocupado}>
                  Volver a Descargas
                </Button>
              )}
            </div>
            {error && <p className="text-sm text-pomodoro-600">{error}</p>}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="font-display text-lg text-teresita-700 mb-1">Nombre de los archivos</h2>
        <p className="text-sm text-ink-500 mb-4">
          Los Excels ya no salen todos llamados igual: el nombre dice qué tabla es y de qué
          período, así se entienden sin abrirlos y no se pisan entre ellos. No hay nada que
          configurar acá — es sólo para que sepas qué esperar.
        </p>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-cream-200">
            {EJEMPLOS.map(([que, nombre]) => (
              <tr key={nombre}>
                <td className="py-2 pr-4 text-ink-700 align-top">{que}</td>
                <td className="py-2 font-mono text-2xs text-ink-900 break-all">{nombre}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
