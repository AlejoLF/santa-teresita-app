'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { SolapasPrincipales } from '@/components/nav/SolapasPrincipales';

/**
 * Layout de la pestaña APPS: los pedidos que entran por las aplicaciones
 * (RAPPI hoy; PedidosYa y MELI cuando se conecten). Identidad NARANJA
 * AZAFRÁN para que no se confunda con el POS ni con Encargos. Accesible por
 * vendedor y admin.
 */
export default function AplicacionesLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [rol, setRol] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const me = await api.getCached<{ usuario: { rol: string } }>('/auth/me', 5 * 60_000);
        setRol(me.usuario.rol);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
      }
    })();
  }, [router]);

  return (
    <div className="min-h-screen bg-cream-100 text-ink-700">
      <SolapasPrincipales activa="aplicaciones" />
      <header className="bg-saffron-600 text-white px-3 lg:px-6 py-2.5 flex items-center justify-between gap-3 sticky top-0 z-30 shadow-md">
        <Link href="/aplicaciones" className="flex items-center gap-2 min-w-0">
          <span className="text-xl">📱</span>
          <span className="font-display text-lg tracking-tight">APPS</span>
          <span className="text-xs opacity-80 hidden sm:inline">pedidos de RAPPI y las otras aplicaciones</span>
        </Link>
        <div className="flex items-center gap-4 text-sm">
          {rol === 'ADMIN' && (
            <button onClick={() => router.push('/admin/configuracion/integraciones')} className="text-white/80 hover:text-white transition-colors">
              Integraciones
            </button>
          )}
        </div>
      </header>
      {children}
    </div>
  );
}
