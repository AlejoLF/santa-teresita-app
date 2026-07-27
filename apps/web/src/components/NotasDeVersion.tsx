'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  NOVEDADES,
  NOVEDADES_STORAGE_KEY,
  VERSION_NOVEDADES,
} from '@/lib/novedades';

/**
 * "Novedades de esta actualización" — cartel que se abre UNA vez cuando el
 * sistema se actualizó, para que la encargada y las empleadas se enteren de
 * qué cambió sin que nadie tenga que avisarles.
 *
 * Cuándo aparece:
 *   - La versión de la última entrada de `novedades.ts` no coincide con la
 *     guardada en localStorage → se muestra y se guarda al cerrar.
 *   - Nunca en /login: primero que entren, después les contamos.
 *   - Si localStorage está bloqueado, se muestra igual (mejor repetirlo que
 *     que no se entere nadie), pero no rompe.
 *
 * Se puede reabrir a mano desde cualquier botón:
 *   onClick={() => window.dispatchEvent(new Event('sta:novedades-open'))}
 *
 * Para agregar las novedades del próximo release, ver `lib/novedades.ts`.
 */
export function NotasDeVersion() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const novedad = NOVEDADES[0];

  // Auto-abrir si la versión cambió desde la última vez que la leyeron.
  useEffect(() => {
    if (!novedad || !VERSION_NOVEDADES) return;
    if (pathname === '/login') return;
    let vista: string | null = null;
    try {
      vista = localStorage.getItem(NOVEDADES_STORAGE_KEY);
    } catch {
      // localStorage bloqueado: seguimos y mostramos.
    }
    if (vista === VERSION_NOVEDADES) return;
    // Pequeño delay para no aparecer encima de la transición de entrada.
    const t = setTimeout(() => setOpen(true), 900);
    return () => clearTimeout(t);
  }, [pathname, novedad]);

  // Reabrir bajo demanda (ej. desde un ítem de menú "Novedades").
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('sta:novedades-open', onOpen);
    return () => window.removeEventListener('sta:novedades-open', onOpen);
  }, []);

  const cerrar = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(NOVEDADES_STORAGE_KEY, VERSION_NOVEDADES);
    } catch {}
  }, []);

  // Cerrar con Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cerrar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, cerrar]);

  if (!open || !novedad) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4"
      onClick={cerrar}
      role="dialog"
      aria-modal="true"
      aria-label="Novedades de la actualización"
    >
      <div
        className="bg-white w-full max-w-md rounded-2xl p-5 shadow-xl safe-bottom max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-1">
          <div className="shrink-0 w-11 h-11 rounded-xl bg-teresita-50 flex items-center justify-center text-2xl">
            ✨
          </div>
          <div className="flex-1 pt-0.5">
            <p className="text-xs font-semibold text-teresita-700 uppercase tracking-wide">
              El sistema se actualizó
            </p>
            <h2 className="font-display text-lg text-ink-900 leading-snug">
              {novedad.titulo}
            </h2>
          </div>
          <button
            onClick={cerrar}
            aria-label="Cerrar"
            className="text-ink-500 text-2xl leading-none -mt-1"
          >
            ×
          </button>
        </div>

        <p className="text-xs text-ink-500 mb-4 pl-14">
          {novedad.fecha} · versión {novedad.version}
        </p>

        <ul className="space-y-2.5 mb-5">
          {novedad.cambios.map((cambio, i) => (
            <li key={i} className="bg-cream-100 rounded-lg p-3 flex gap-2.5">
              <span className="text-teresita-700 shrink-0 leading-snug" aria-hidden>
                •
              </span>
              <span className="text-sm text-ink-700 leading-snug">{cambio}</span>
            </li>
          ))}
        </ul>

        <button
          onClick={cerrar}
          className="w-full bg-teresita-700 text-cream-50 px-4 py-3 rounded-md font-semibold active:bg-teresita-900"
        >
          Entendido
        </button>
      </div>
    </div>
  );
}
