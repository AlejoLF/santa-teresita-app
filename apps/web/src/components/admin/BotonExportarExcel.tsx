'use client';

import { useState } from 'react';
import { descargarArchivo } from '@/lib/api';

/**
 * "Exportar a Excel" para las tablas con buscador.
 *
 * Le pasás la MISMA ruta con los MISMOS filtros que estás mostrando y el
 * componente le agrega `formato=xlsx`. El server responde el resultado completo
 * (sin paginar) con los totales arriba.
 *
 * Que reciba la ruta ya armada es a propósito: si el botón construyera los
 * filtros por su cuenta, tarde o temprano exportaría algo distinto de lo que
 * hay en pantalla, que es el peor resultado posible para un export.
 */
export function BotonExportarExcel({
  path,
  nombre,
  deshabilitado,
  className = '',
}: {
  /** Ruta con los filtros actuales, ej. `/admin/movimientos?periodo=hoy&q=luz`. */
  path: string;
  /** Nombre por defecto si el server no manda Content-Disposition. */
  nombre: string;
  /** Normalmente: sin resultados que exportar. */
  deshabilitado?: boolean;
  className?: string;
}) {
  const [bajando, setBajando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportar() {
    setBajando(true);
    setError(null);
    try {
      const sep = path.includes('?') ? '&' : '?';
      await descargarArchivo(`${path}${sep}formato=xlsx`, nombre);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo exportar');
    } finally {
      setBajando(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void exportar()}
        disabled={bajando || deshabilitado}
        title={
          deshabilitado
            ? 'No hay resultados para exportar'
            : 'Baja un Excel con todos los resultados de esta búsqueda y los totales'
        }
        className={
          'inline-flex items-center gap-2 rounded-lg border border-teresita-700/30 bg-white ' +
          'px-3 py-2 text-sm font-medium text-teresita-800 transition hover:bg-teresita-50 ' +
          'disabled:cursor-not-allowed disabled:opacity-50 ' +
          className
        }
      >
        {bajando ? (
          <>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-teresita-700/30 border-t-teresita-700" />
            Generando…
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M10 2.5v9m0 0 3.5-3.5M10 11.5 6.5 8M3.5 13.5v2a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-2"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Exportar a Excel
          </>
        )}
      </button>
      {error && <span className="text-2xs text-red-600">{error}</span>}
    </div>
  );
}
