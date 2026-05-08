'use client';

export type TabId = 'resumen' | 'ventas' | 'analytics' | 'productos' | 'mapa';

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: 'resumen', label: 'Resumen', icon: '📊' },
  { id: 'ventas', label: 'Ventas', icon: '🧾' },
  { id: 'analytics', label: 'Analytics', icon: '📈' },
  { id: 'productos', label: 'Productos', icon: '🍝' },
  { id: 'mapa', label: 'Mapa', icon: '🗺️' },
];

export function TabBar({ activo, onChange }: { activo: TabId; onChange: (t: TabId) => void }) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 bg-white border-t border-cream-300 flex justify-around safe-bottom"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {TABS.map((t) => {
        const sel = t.id === activo;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={
              sel
                ? 'flex-1 py-2 flex flex-col items-center gap-0.5 text-teresita-700'
                : 'flex-1 py-2 flex flex-col items-center gap-0.5 text-ink-500'
            }
          >
            <span className="text-xl leading-none">{t.icon}</span>
            <span
              className={sel ? 'text-2xs font-semibold' : 'text-2xs'}
              style={{ fontSize: 10 }}
            >
              {t.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
