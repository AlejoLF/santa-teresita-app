'use client';

import { useState } from 'react';

export type TabId =
  | 'resumen'
  | 'caja'
  | 'ventas'
  | 'analytics'
  | 'mapa'
  | 'productos'
  | 'clientes'
  | 'insumos'
  | 'empleados'
  | 'mayoristas';

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

/** Tabs en la barra inferior (mobile). */
export const PRIMARY_TABS: TabDef[] = [
  { id: 'resumen', label: 'Resumen', icon: '📊' },
  { id: 'caja', label: 'Caja', icon: '💰' },
  { id: 'ventas', label: 'Ventas', icon: '🧾' },
  { id: 'analytics', label: 'Analytics', icon: '📈' },
  { id: 'mapa', label: 'Mapa', icon: '🗺️' },
];

/** Tabs detrás del botón "Más" (mobile) — en desktop van todas en el sidebar. */
export const SECONDARY_TABS: TabDef[] = [
  { id: 'productos', label: 'Productos', icon: '🍝' },
  { id: 'clientes', label: 'Clientes', icon: '👥' },
  { id: 'insumos', label: 'Insumos y gastos', icon: '📦' },
  { id: 'empleados', label: 'Empleados', icon: '🧑‍🍳' },
  { id: 'mayoristas', label: 'Mayoristas', icon: '🏪' },
];

export const ALL_TABS: TabDef[] = [...PRIMARY_TABS, ...SECONDARY_TABS];

/**
 * Barra inferior — solo mobile/tablet angosto (en lg+ se usa el sidebar).
 * 5 tabs primarias + botón "Más" que abre una hoja con las secundarias.
 */
export function TabBar({ activo, onChange }: { activo: TabId; onChange: (t: TabId) => void }) {
  const [masOpen, setMasOpen] = useState(false);
  const enMas = SECONDARY_TABS.some((t) => t.id === activo);

  return (
    <>
      {masOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setMasOpen(false)}
        >
          <div
            className="absolute inset-x-0 bottom-0 bg-white rounded-t-xl p-4"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 5rem)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-lg text-teresita-700">Más secciones</h2>
              <button
                onClick={() => setMasOpen(false)}
                className="text-ink-500 text-2xl leading-none"
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {SECONDARY_TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    onChange(t.id);
                    setMasOpen(false);
                  }}
                  className={
                    t.id === activo
                      ? 'flex flex-col items-center gap-1 py-3 px-1 rounded-lg bg-teresita-700 text-cream-50'
                      : 'flex flex-col items-center gap-1 py-3 px-1 rounded-lg bg-cream-100 text-ink-700 active:bg-cream-200'
                  }
                >
                  <span className="text-2xl leading-none">{t.icon}</span>
                  <span className="text-2xs text-center leading-tight">{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav
        className="fixed bottom-0 left-0 right-0 bg-white border-t border-cream-300 flex justify-around safe-bottom lg:hidden z-40"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {PRIMARY_TABS.map((t) => {
          const sel = t.id === activo;
          return (
            <button
              key={t.id}
              onClick={() => {
                onChange(t.id);
                setMasOpen(false);
              }}
              className={
                sel
                  ? 'flex-1 py-2 flex flex-col items-center gap-0.5 text-teresita-700'
                  : 'flex-1 py-2 flex flex-col items-center gap-0.5 text-ink-500'
              }
            >
              <span className="text-xl leading-none">{t.icon}</span>
              <span className={sel ? 'text-2xs font-semibold' : 'text-2xs'} style={{ fontSize: 10 }}>
                {t.label}
              </span>
            </button>
          );
        })}
        <button
          onClick={() => setMasOpen((v) => !v)}
          className={
            enMas || masOpen
              ? 'flex-1 py-2 flex flex-col items-center gap-0.5 text-teresita-700'
              : 'flex-1 py-2 flex flex-col items-center gap-0.5 text-ink-500'
          }
          aria-label="Más secciones"
        >
          <span className="text-xl leading-none">⋯</span>
          <span
            className={enMas || masOpen ? 'text-2xs font-semibold' : 'text-2xs'}
            style={{ fontSize: 10 }}
          >
            Más
          </span>
        </button>
      </nav>
    </>
  );
}
