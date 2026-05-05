'use client';

import { useState, useEffect } from 'react';
import { resetDemoState } from '@/lib/demo/mocks';

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

export function DemoBanner() {
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!DEMO_MODE || !mounted) return null;

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="fixed bottom-3 right-3 z-[60] bg-saffron-600 text-white text-2xs font-semibold uppercase tracking-widest rounded-full px-3 py-1.5 shadow-lg hover:bg-saffron-600/90"
        title="Mostrar info de la demo"
      >
        ⓘ Demo
      </button>
    );
  }

  return (
    <div className="fixed top-0 inset-x-0 z-[60] bg-saffron-600 text-white shadow-md">
      <div className="max-w-6xl mx-auto px-3 py-1.5 flex items-center justify-between gap-3 text-2xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-bold uppercase tracking-widest whitespace-nowrap">Only demonstration</span>
          <span className="opacity-80 hidden sm:inline truncate">
            Datos ficticios · sin backend · se reinician al cerrar pestaña
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => {
              if (confirm('¿Reiniciar todos los datos de la demo?')) {
                resetDemoState();
                window.location.href = '/login';
              }
            }}
            className="hover:underline opacity-90"
          >
            Reiniciar
          </button>
          <button
            onClick={() => setCollapsed(true)}
            className="text-white/90 hover:text-white text-base leading-none px-1"
            aria-label="Cerrar banner"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
