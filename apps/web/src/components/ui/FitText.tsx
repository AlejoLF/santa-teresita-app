'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';

// useLayoutEffect avisa en SSR; en cliente lo queremos para medir antes de pintar
// (evita el "flash" del número desbordado). En server cae a useEffect (no corre).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface FitTextProps {
  children: ReactNode;
  /** Clases del texto medido (tamaño, color, font). Ej: "text-2xl hero-number". */
  className?: string;
  /** Piso de legibilidad en px — no encoge por debajo de esto. */
  min?: number;
  align?: 'left' | 'right' | 'center';
}

/**
 * Achica el texto para que SIEMPRE entre en el ancho de su caja, sin importar
 * cuántos dígitos tenga el número. Pensado para montos y contadores grandes en
 * tarjetas/KPIs angostos (sobre todo en mobile), donde un número largo como
 * "$ 11.519.482" se salía del recuadro.
 *
 * Cómo: mide el ancho natural del texto (nowrap) contra el ancho disponible de
 * la caja y, si no entra, baja el font-size proporcionalmente (con un par de
 * correcciones por las métricas no lineales de la tipografía). Se recalcula ante
 * cualquier cambio de tamaño vía ResizeObserver, así que también responde al
 * rotar el teléfono o cambiar de breakpoint.
 */
export function FitText({ children, className, min = 11, align = 'left' }: FitTextProps) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useIsoLayoutEffect(() => {
    const box = boxRef.current;
    const text = textRef.current;
    if (!box || !text) return;

    const fit = () => {
      // Partir siempre del tamaño de la clase (por si la caja se agrandó).
      text.style.fontSize = '';
      const avail = box.clientWidth;
      if (avail <= 0) return;
      const base = parseFloat(getComputedStyle(text).fontSize) || 16;
      if (text.scrollWidth <= avail) return; // ya entra

      // Estimación proporcional + hasta 4 ajustes finos de 1px.
      let size = Math.max(min, Math.floor((base * avail) / text.scrollWidth));
      text.style.fontSize = `${size}px`;
      let guard = 4;
      while (text.scrollWidth > avail && size > min && guard-- > 0) {
        size -= 1;
        text.style.fontSize = `${size}px`;
      }
    };

    fit();
    // ResizeObserver capta cambios del contenedor (contenido vecino que lo
    // empuja); window.resize cubre rotar el teléfono y cambios de breakpoint
    // (redundante a propósito: algunos entornos no entregan callbacks de RO).
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    window.addEventListener('resize', fit);
    // Reajuste diferido: el layout puede no estar asentado en el mismo frame del
    // montaje, y la tipografía serif (Fraunces) cambia el ancho al terminar de
    // cargar. Re-medimos tras el primer frame y cuando las fuentes están listas.
    const raf = requestAnimationFrame(fit);
    document.fonts?.ready.then(fit).catch(() => {});
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
      cancelAnimationFrame(raf);
    };
  }, [children, className, min]);

  return (
    <span
      ref={boxRef}
      className={cn('block min-w-0 overflow-hidden', className && 'leading-tight')}
      style={{ textAlign: align }}
    >
      <span ref={textRef} className={cn('inline-block max-w-full whitespace-nowrap', className)}>
        {children}
      </span>
    </span>
  );
}
