'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

export type AreaPrincipal = 'admin' | 'pedidos' | 'encargos';

/**
 * Solapas superiores estilo navegador — la navegación principal entre las tres
 * áreas del programa. Cada una tiene su color (el mismo que su pantalla) para
 * que el personal sepa dónde está de un vistazo:
 *
 *   ADMIN (celeste acero) · PEDIDOS (verde teresita) · ENCARGOS (marrón madera)
 *
 * La solapa ADMIN sólo aparece para usuarios ADMIN. En el login (401) no se
 * renderiza nada: `visible` queda en false y la barra no ocupa alto.
 */
const SOLAPAS: Array<{
  area: AreaPrincipal;
  label: string;
  icono: string;
  href: string;
  soloAdmin?: boolean;
  activa: string;
  inactiva: string;
}> = [
  {
    area: 'admin',
    label: 'ADMIN',
    icono: '📊',
    href: '/admin',
    soloAdmin: true,
    activa: 'bg-steel-700 text-white shadow-md',
    inactiva: 'bg-steel-100 text-steel-700 hover:bg-steel-200',
  },
  {
    area: 'pedidos',
    label: 'PEDIDOS',
    icono: '🍝',
    href: '/cargar-pedido',
    activa: 'bg-teresita-700 text-cream-50 shadow-md',
    inactiva: 'bg-teresita-100 text-teresita-700 hover:bg-teresita-300/60',
  },
  {
    area: 'encargos',
    label: 'ENCARGOS',
    icono: '📦',
    href: '/encargos',
    activa: 'bg-wood-700 text-wood-50 shadow-md',
    inactiva: 'bg-wood-100 text-wood-700 hover:bg-wood-200',
  },
];

export function SolapasPrincipales({ activa }: { activa: AreaPrincipal }) {
  const pathname = usePathname();
  const [rol, setRol] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  // El login está dentro del segmento (vendedor): ahí no hay áreas que ofrecer.
  // (En modo demo /auth/me responde igual, así que no alcanza con el 401.)
  const esLogin = pathname === '/login';

  useEffect(() => {
    if (esLogin) return;
    api
      .getCached<{ usuario: { rol: string } }>('/auth/me', 5 * 60_000)
      .then((me) => {
        setRol(me.usuario.rol);
        setVisible(true);
      })
      .catch(() => setVisible(false));
  }, [esLogin]);

  if (esLogin || !visible) return null;

  const solapas = SOLAPAS.filter((s) => !s.soloAdmin || rol === 'ADMIN');

  return (
    <nav
      // h-solapas: los layouts a pantalla completa restan este alto (ver
      // --solapas-h en globals.css). No cambiar el alto sin ajustar esa var.
      className="h-solapas shrink-0 flex items-end gap-1 px-2 bg-cream-200 border-b border-cream-300"
      aria-label="Áreas del programa"
    >
      {solapas.map((s) => {
        const esActiva = s.area === activa;
        return (
          <Link
            key={s.area}
            href={s.href}
            aria-current={esActiva ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-t-lg font-display tracking-wide',
              'transition-colors select-none',
              esActiva
                ? cn('px-4 lg:px-6 pt-1.5 pb-2 text-sm lg:text-md', s.activa)
                : cn('px-3 lg:px-5 pt-1 pb-1.5 text-xs lg:text-sm opacity-90', s.inactiva),
            )}
          >
            <span aria-hidden>{s.icono}</span>
            <span>{s.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
