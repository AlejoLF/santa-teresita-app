'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

interface NavItem {
  label: string;
  href: string;
  icon: string;
  hint?: string;
  group?: string;
}

// Tabs principales en mobile (Wireframe 09): 4 ítems máximo + "Más"
const MOBILE_TABS = [
  { label: 'Inicio', href: '/admin', icon: '🏠' },
  { label: 'Ventas', href: '/admin/ventas', icon: '🧾' },
  { label: 'Movim.', href: '/admin/movimientos', icon: '💸' },
];

const NAV: NavItem[] = [
  { group: 'Inicio', label: 'Dashboard', href: '/admin', icon: '📊' },
  { group: 'Movimientos', label: 'Ventas', href: '/admin/ventas', icon: '🧾' },
  { group: 'Movimientos', label: 'Aportes y egresos', href: '/admin/movimientos', icon: '💸' },
  { group: 'Movimientos', label: 'Cuentas y saldos', href: '/admin/cuentas', icon: '💰' },
  { group: 'Productos', label: 'Catálogo', href: '/admin/productos', icon: '📋' },
  { group: 'Productos', label: 'Lista de precios', href: '/admin/precios', icon: '🏷️' },
  { group: 'Administración', label: 'Empleados', href: '/admin/empleados', icon: '👥' },
  { group: 'Administración', label: 'Clientes', href: '/admin/clientes', icon: '🤝' },
  { group: 'Administración', label: 'Insumos y proveedores', href: '/admin/insumos', icon: '📦' },
  { group: 'Administración', label: 'Analytics', href: '/admin/analytics', icon: '📈' },
  { group: 'Administración', label: 'Configuración', href: '/admin/configuracion', icon: '⚙️' },
  { group: 'Caja', label: 'Sesión actual', href: '/admin/sesion-actual', icon: '📅' },
  { group: 'Caja', label: 'Cierres', href: '/admin/cierres', icon: '💵' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [usuario, setUsuario] = useState<{ nombre: string; rol: string } | null>(null);
  const [verificando, setVerificando] = useState(true);
  const [pendientes, setPendientes] = useState(0);
  // Sheet: en mobile, sidebar oculta detrás de hamburger / "Más"
  const [sheetOpen, setSheetOpen] = useState(false);

  // Cerrar el sheet al cambiar de ruta
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  useEffect(() => {
    (async () => {
      try {
        const me = await api.get<{ usuario: { nombre: string; rol: string } }>('/auth/me');
        if (me.usuario.rol !== 'ADMIN') {
          router.replace('/cargar-pedido');
          return;
        }
        setUsuario(me.usuario);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
      } finally {
        setVerificando(false);
      }
    })();
  }, [router]);

  // Polling de pendientes para badge de notificaciones
  useEffect(() => {
    const fetchPendientes = async () => {
      try {
        const d = await api.get<{
          pendientes: {
            facturasSinValidar: number;
            facturasVencenPronto: number;
            cambiosExcelPendientes: number;
            sesionesSinAprobar: number;
          };
        }>('/admin/dashboard');
        const total =
          d.pendientes.facturasSinValidar +
          d.pendientes.cambiosExcelPendientes +
          d.pendientes.sesionesSinAprobar;
        setPendientes(total);
      } catch {
        /* silencioso */
      }
    };
    void fetchPendientes();
    const id = setInterval(fetchPendientes, 30_000);
    return () => clearInterval(id);
  }, []);

  if (verificando) {
    return (
      <div className="min-h-screen flex items-center justify-center text-ink-500">
        Verificando sesión...
      </div>
    );
  }

  // Agrupar NAV por group
  const groups = NAV.reduce<Record<string, NavItem[]>>((acc, item) => {
    const g = item.group ?? 'Otros';
    if (!acc[g]) acc[g] = [];
    acc[g].push(item);
    return acc;
  }, {});

  const renderNavGroups = (compact = false) =>
    Object.entries(groups).map(([group, items]) => (
      <div key={group} className="mb-4">
        <div
          className={cn(
            'px-5 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-300',
            compact && 'px-4',
          )}
        >
          {group}
        </div>
        {items.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== '/admin' && pathname.startsWith(item.href));
          const disabled = item.hint === 'pronto';
          return disabled ? (
            <div
              key={item.href}
              className="px-5 py-2 flex items-center justify-between text-sm text-ink-300 cursor-not-allowed"
            >
              <span className="flex items-center gap-2">
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </span>
              <span className="text-2xs">pronto</span>
            </div>
          ) : (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'px-5 py-2 flex items-center gap-2 text-sm transition-colors',
                active
                  ? 'bg-teresita-50 text-teresita-700 font-medium border-r-2 border-teresita-700'
                  : 'text-ink-700 hover:bg-cream-100',
              )}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    ));

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr] bg-surface-app">
      {/* Sidebar — solo desktop */}
      <aside className="hidden lg:flex bg-white border-r border-cream-300 flex-col">
        <div className="px-5 py-4 border-b border-cream-300">
          <Link href="/admin" className="flex items-center gap-2">
            <span className="text-2xl">🍝</span>
            <div>
              <div className="font-display text-md text-teresita-700 leading-tight">
                Santa Teresita
              </div>
              <div className="text-2xs text-ink-500">panel admin</div>
            </div>
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto py-3">{renderNavGroups()}</nav>

        <div className="px-5 py-3 border-t border-cream-300 text-xs text-ink-500">
          v0.1.0 · {usuario?.nombre}
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-col min-w-0">
        {/* Header — desktop */}
        <header className="hidden lg:flex bg-white border-b border-cream-300 px-6 py-3 items-center justify-between">
          <div className="text-sm text-ink-500">
            Sesión Admin · <span className="text-ink-700 font-medium">{usuario?.nombre}</span>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push('/cargar-pedido')}
              className="bg-teresita-700 text-cream-50 hover:bg-teresita-900 px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5"
              title="Cargar un pedido como vendedor"
            >
              <span>+</span>
              <span>Cargar pedido</span>
            </button>
            <button
              onClick={() => router.push('/admin')}
              className="relative text-ink-700 hover:text-teresita-700"
              title="Notificaciones"
            >
              🔔
              {pendientes > 0 && (
                <span className="absolute -top-1 -right-1 bg-pomodoro-600 text-white text-2xs font-mono rounded-full w-4 h-4 flex items-center justify-center">
                  {pendientes}
                </span>
              )}
            </button>
            <button
              onClick={async () => {
                await api.post('/auth/logout', {});
                router.push('/login');
              }}
              className="text-sm text-ink-500 hover:text-pomodoro-600"
            >
              Cerrar sesión
            </button>
          </div>
        </header>

        {/* Header — mobile (Wireframe 09) */}
        <header className="lg:hidden bg-teresita-700 text-cream-50 px-4 py-3 flex items-center justify-between sticky top-0 z-30">
          <button
            onClick={() => setSheetOpen(true)}
            className="text-cream-50 text-xl leading-none"
            aria-label="Abrir menú"
          >
            ☰
          </button>
          <Link href="/admin" className="flex items-center gap-2">
            <span className="text-xl">🍝</span>
            <span className="font-display text-md leading-tight">Santa Teresita</span>
          </Link>
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/cargar-pedido')}
              className="text-cream-50 text-xl leading-none"
              aria-label="Cargar pedido"
              title="Cargar pedido"
            >
              +
            </button>
            <button
              onClick={() => router.push('/admin')}
              className="relative text-cream-50"
              aria-label="Notificaciones"
            >
              🔔
              {pendientes > 0 && (
                <span className="absolute -top-1 -right-1 bg-pomodoro-600 text-white text-2xs font-mono rounded-full w-4 h-4 flex items-center justify-center">
                  {pendientes}
                </span>
              )}
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-3 sm:p-4 lg:p-6 pb-20 lg:pb-6">
          {children}
        </main>

        {/* Bottom tabs — solo mobile */}
        <nav className="lg:hidden fixed bottom-0 inset-x-0 bg-white border-t border-cream-300 grid grid-cols-4 z-30">
          {MOBILE_TABS.map((tab) => {
            const active =
              pathname === tab.href ||
              (tab.href !== '/admin' && pathname.startsWith(tab.href));
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  'flex flex-col items-center gap-0.5 py-2 text-2xs',
                  active ? 'text-teresita-700 font-medium' : 'text-ink-500',
                )}
              >
                <span className="text-lg">{tab.icon}</span>
                {tab.label}
              </Link>
            );
          })}
          <button
            onClick={() => setSheetOpen(true)}
            className="flex flex-col items-center gap-0.5 py-2 text-2xs text-ink-500 hover:text-teresita-700"
          >
            <span className="text-lg">☰</span>
            Más
          </button>
        </nav>

        {/* Sheet de navegación secundaria — mobile */}
        {sheetOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-ink-900/50 z-40"
            onClick={() => setSheetOpen(false)}
          >
            <aside
              className="absolute bottom-0 inset-x-0 bg-white rounded-t-xl shadow-modal max-h-[85vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="px-5 py-4 border-b border-cream-300 flex items-center justify-between">
                <div>
                  <div className="font-display text-md text-teresita-700">Más opciones</div>
                  <div className="text-2xs text-ink-500">{usuario?.nombre}</div>
                </div>
                <button
                  onClick={() => setSheetOpen(false)}
                  className="text-ink-500 text-xl leading-none"
                  aria-label="Cerrar"
                >
                  ✕
                </button>
              </header>
              <nav className="flex-1 overflow-y-auto py-3">{renderNavGroups()}</nav>
              <footer className="px-5 py-3 border-t border-cream-300">
                <button
                  onClick={async () => {
                    await api.post('/auth/logout', {});
                    router.push('/login');
                  }}
                  className="text-sm text-pomodoro-600 hover:underline"
                >
                  Cerrar sesión
                </button>
              </footer>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
