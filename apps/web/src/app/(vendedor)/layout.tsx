'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Layout del segmento Vendedor — fondo crema warm, full-screen, sin scroll.
 * Bloquea pantallas realmente chicas (<640px) — Sección 7.3.2 del SPEC.
 * Permite forzar modo escritorio con localStorage.sta_force_desktop = '1' (útil para testing).
 */
export default function VendedorLayout({ children }: { children: ReactNode }) {
  const [forzado, setForzado] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && localStorage.getItem('sta_force_desktop') === '1') {
      setForzado(true);
    }
  }, []);

  if (forzado) {
    return (
      <div className="min-h-screen bg-surface-app-vendedor text-ink-700 overflow-hidden">
        {children}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-app-vendedor text-ink-700 overflow-hidden">
      <div className="hidden sm:block">{children}</div>
      <div className="sm:hidden p-8 flex min-h-screen items-center justify-center text-center">
        <div>
          <div className="text-3xl mb-4">🖥️</div>
          <h1 className="text-xl font-display text-teresita-700 mb-2">
            Sesión Vendedor solo en escritorio
          </h1>
          <p className="text-base text-ink-500 mb-4">
            Esta sesión solo está disponible en las computadoras del local. Ingresá desde una PC
            con teclado y mouse.
          </p>
          <button
            onClick={() => {
              localStorage.setItem('sta_force_desktop', '1');
              setForzado(true);
            }}
            className="text-xs text-teresita-700 hover:underline"
          >
            Forzar modo escritorio (testing)
          </button>
        </div>
      </div>
    </div>
  );
}
