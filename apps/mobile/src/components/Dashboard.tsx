'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { TabBar, type TabId } from './TabBar';
import { TabResumen } from './TabResumen';
import { TabVentas } from './TabVentas';
import { TabAnalytics } from './TabAnalytics';
import { TabProductos } from './TabProductos';
import { TabMapa } from './TabMapa';

export function Dashboard({ nombre, rol }: { nombre: string; rol?: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>('resumen');

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <div className="min-h-screen flex flex-col bg-cream-100 safe-top">
      <header className="bg-teresita-700 text-cream-50 px-4 py-3 flex items-center justify-between sticky top-0 z-10">
        <div>
          <p className="font-display text-md leading-tight">Santa Teresita</p>
          <p className="text-2xs text-cream-100/80">
            Hola, {nombre}
            {rol ? ` · ${rol}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
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

      <main className="flex-1 overflow-y-auto pb-20 safe-bottom">
        {tab === 'resumen' && <TabResumen />}
        {tab === 'ventas' && <TabVentas />}
        {tab === 'analytics' && <TabAnalytics />}
        {tab === 'productos' && <TabProductos />}
        {tab === 'mapa' && <TabMapa />}
      </main>

      <TabBar activo={tab} onChange={setTab} />
    </div>
  );
}
