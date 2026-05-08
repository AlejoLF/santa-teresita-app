'use client';

import { useState, useRef, useEffect } from 'react';

/**
 * Tooltip con explicación académica para una métrica.
 * Click muestra/oculta. Click afuera lo cierra.
 *
 * IMPORTANTE: Este componente es block-level (renderiza <div> + <button>).
 * NO lo metas dentro de un <p> — HTML no permite <div> dentro de <p>, el
 * browser hace "tag rescue" y mueve los nodos, rompiendo la hidratación de
 * React 19 con un client-side exception. Usá <div className="flex"> o <span>
 * como contenedor cuando lo combines con texto + tooltip.
 *
 * Uso correcto:
 *   <div className="flex items-center">
 *     <span>Mi métrica</span>
 *     <InfoTooltip>...</InfoTooltip>
 *   </div>
 */
export function InfoTooltip({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-cream-300 text-ink-500 text-2xs font-bold hover:bg-teresita-500 hover:text-white transition-colors"
        aria-label="Más información"
      >
        i
      </button>
      {open && (
        <div className="absolute z-30 left-1/2 -translate-x-1/2 top-full mt-1 w-72 p-3 bg-white border border-cream-300 rounded-md shadow-lg text-xs text-ink-700 leading-relaxed">
          {children}
        </div>
      )}
    </div>
  );
}
