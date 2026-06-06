'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TabBar, ALL_TABS, type TabId } from './TabBar';
import { TabResumen } from './TabResumen';
import { TabCaja } from './TabCaja';
import { TabVentas } from './TabVentas';
import { TabAnalytics } from './TabAnalytics';
import { TabProductos } from './TabProductos';
import { TabMapa } from './TabMapa';
import { TabClientes } from './TabClientes';
import { TabInsumos } from './TabInsumos';
import { TabEmpleados } from './TabEmpleados';
import { TabMayoristas } from './TabMayoristas';

export function Dashboard({ nombre, rol }: { nombre: string; rol?: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>('resumen');

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <div className="min-h-screen bg-cream-100 lg:flex">
      {/* Sidebar — solo desktop/notebook (lg+) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-60 lg:shrink-0 bg-teresita-700 text-cream-50 min-h-screen sticky top-0">
        <div className="px-5 py-5 border-b border-cream-50/15">
          <p className="font-display text-xl leading-tight">Santa Teresita</p>
          <p className="text-2xs text-cream-100/80 mt-0.5">
            {nombre}
            {rol ? ` · ${rol}` : ''}
          </p>
        </div>
        <nav className="flex-1 py-3 overflow-y-auto">
          {ALL_TABS.map((t) => {
            const sel = t.id === tab;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={
                  sel
                    ? 'w-full flex items-center gap-3 px-5 py-3 text-sm font-semibold bg-cream-50/15 border-l-4 border-cream-50'
                    : 'w-full flex items-center gap-3 px-5 py-3 text-sm text-cream-100/85 border-l-4 border-transparent hover:bg-cream-50/10'
                }
              >
                <span className="text-lg leading-none">{t.icon}</span>
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="p-4 space-y-2 border-t border-cream-50/15">
          <button
            onClick={() => router.push('/cargar-pedido')}
            className="w-full py-2 rounded-md bg-cream-50 text-teresita-700 text-sm font-semibold"
          >
            + Cargar pedido
          </button>
          <button
            onClick={() => window.dispatchEvent(new Event('sta:install-open'))}
            className="w-full py-2 rounded-md text-cream-100/85 text-xs hover:bg-cream-50/10"
          >
            📱 Usar como app
          </button>
          <button
            onClick={logout}
            className="w-full py-2 rounded-md bg-teresita-900/40 text-cream-50 text-sm"
          >
            Salir
          </button>
        </div>
      </aside>

      {/* Columna principal */}
      <div className="flex-1 flex flex-col min-w-0 safe-top">
        {/* Header — solo mobile/tablet angosto (lg- oculta) */}
        <header className="lg:hidden bg-teresita-700 text-cream-50 px-4 py-3 flex items-center justify-between sticky top-0 z-10">
          <div>
            <p className="font-display text-md leading-tight">Santa Teresita</p>
            <p className="text-2xs text-cream-100/80">
              Hola, {nombre}
              {rol ? ` · ${rol}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.dispatchEvent(new Event('sta:install-open'))}
              className="text-sm px-2 py-1 rounded bg-teresita-900/30 text-cream-50"
              title="Usar como app (agregar a inicio)"
              aria-label="Usar como app"
            >
              📱
            </button>
            <button
              onClick={() => router.push('/cargar-pedido')}
              className="text-2xs px-2 py-1 rounded bg-cream-50 text-teresita-700 font-semibold"
              title="Cargar pedido (modo vendedor)"
            >
              + Pedido
            </button>
            <button
              onClick={logout}
              className="text-2xs px-2 py-1 rounded bg-teresita-900/30 text-cream-50"
            >
              Salir
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto pb-20 lg:pb-8 safe-bottom">
          <div className="mx-auto w-full max-w-3xl lg:max-w-5xl">
            {tab === 'resumen' && <TabResumen />}
            {tab === 'caja' && <TabCaja />}
            {tab === 'ventas' && <TabVentas />}
            {tab === 'analytics' && <TabAnalytics />}
            {tab === 'mapa' && <TabMapa />}
            {tab === 'productos' && <TabProductos />}
            {tab === 'clientes' && <TabClientes />}
            {tab === 'insumos' && <TabInsumos />}
            {tab === 'empleados' && <TabEmpleados />}
            {tab === 'mayoristas' && <TabMayoristas />}
          </div>
        </main>
      </div>

      {/* Barra inferior — solo mobile/tablet angosto */}
      <TabBar activo={tab} onChange={setTab} />
    </div>
  );
}
