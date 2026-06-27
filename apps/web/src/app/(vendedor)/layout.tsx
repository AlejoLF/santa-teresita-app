import { type ReactNode } from 'react';

/**
 * Layout del segmento Vendedor — fondo crema warm.
 *
 * Antes bloqueaba pantallas <640px con un cartel "Sesión Vendedor solo en
 * escritorio". Se removió para poder usar la app también desde celular/tablet
 * (versión web FULL del dueño). En desktop mantiene el full-screen sin scroll
 * externo; en mobile deja scrollear la página.
 */
export default function VendedorLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-app-vendedor text-ink-700 sm:overflow-hidden">
      {children}
    </div>
  );
}
