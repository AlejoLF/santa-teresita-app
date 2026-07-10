import { type ReactNode } from 'react';
import { SolapasPrincipales } from '@/components/nav/SolapasPrincipales';

/**
 * Layout del segmento Vendedor — fondo crema warm + solapa PEDIDOS activa.
 *
 * Antes bloqueaba pantallas <640px con un cartel "Sesión Vendedor solo en
 * escritorio". Se removió para poder usar la app también desde celular/tablet
 * (versión web FULL del dueño). En desktop mantiene el full-screen sin scroll
 * externo; en mobile deja scrollear la página.
 *
 * Las solapas no se renderizan en /login (ahí /auth/me devuelve 401), así que
 * la barra no ocupa alto en la pantalla de PIN.
 */
export default function VendedorLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-app-vendedor text-ink-700 sm:overflow-hidden">
      <SolapasPrincipales activa="pedidos" />
      {children}
    </div>
  );
}
