'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { SolapasPrincipales } from '@/components/nav/SolapasPrincipales';

/**
 * Layout de la pestaña ENCARGOS. Identidad MARRÓN MADERA (no el verde teresita)
 * para que los empleados no la confundan con el POS normal. Solapa superior con
 * el título "ENCARGOS". Accesible por vendedor y admin.
 */
export default function EncargosLayout({ children }: { children: ReactNode }) {
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
    <div className="min-h-screen bg-surface-app-encargos text-ink-700">
      <SolapasPrincipales activa="encargos" />
      {/* El header de área queda con el nombre del usuario y el logout; la
          navegación entre áreas ahora vive en las solapas de arriba. */}
      <header className="bg-wood-700 text-wood-50 px-3 lg:px-6 py-2.5 flex items-center justify-between gap-3 sticky top-0 z-30 shadow-md">
        <Link href="/encargos" className="flex items-center gap-2 min-w-0">
          <span className="text-xl">📦</span>
          <span className="font-display text-lg tracking-tight">ENCARGOS</span>
        </Link>
        <div className="flex items-center gap-4 text-sm">
          {rol === 'ADMIN' && (
            <button
              onClick={() => router.push('/admin')}
              className="text-wood-100 hover:text-white transition-colors"
            >
              Panel admin
            </button>
          )}
        </div>
      </header>
      {children}
    </div>
  );
}
