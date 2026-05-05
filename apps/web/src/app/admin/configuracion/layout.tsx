'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const TABS = [
  { href: '/admin/configuracion', label: 'Inicio', icon: '🏠' },
  { href: '/admin/configuracion/usuarios', label: 'Usuarios y PINs', icon: '👤' },
  { href: '/admin/configuracion/cuentas', label: 'Cuentas y posnets', icon: '💰' },
  { href: '/admin/configuracion/parametros', label: 'Parámetros', icon: '🛠️' },
  { href: '/admin/configuracion/local', label: 'Datos del local', icon: '🏪' },
];

export default function ConfiguracionLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-4">
        <h1 className="font-display text-xl text-ink-900">Configuración del sistema</h1>
        <p className="text-sm text-ink-500">
          Cambios en estos valores se registran en el audit log.
        </p>
      </header>

      <nav className="flex gap-1 border-b border-cream-300 mb-6 overflow-x-auto">
        {TABS.map((t) => {
          const active =
            t.href === '/admin/configuracion'
              ? pathname === t.href
              : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                'px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap',
                active
                  ? 'text-teresita-700 border-b-2 border-teresita-700 -mb-px'
                  : 'text-ink-500 hover:text-ink-900',
              )}
            >
              <span className="mr-1">{t.icon}</span>
              {t.label}
            </Link>
          );
        })}
      </nav>

      <div>{children}</div>
    </div>
  );
}
