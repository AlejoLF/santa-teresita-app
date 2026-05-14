'use client';

import { useState, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PinInput } from '@/components/ui/PinInput';
import { Numpad } from '@/components/ui/Numpad';
import { api, ApiError, setAuthToken, prefetch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { setDemoRol } from '@/lib/demo/mocks';

type Estado = 'IDLE' | 'INTENTANDO' | 'ERROR' | 'BLOQUEADO' | 'EXITO';

const PIN_LEN = 4;
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

export default function VendedorLoginPage() {
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [estado, setEstado] = useState<Estado>('IDLE');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [intentos, setIntentos] = useState(0);
  const [pcOrigen] = useState(() => {
    if (typeof window === 'undefined') return 'PC?';
    return localStorage.getItem('sta_pc_origen') ?? 'PC1';
  });
  const [now, setNow] = useState<string>('');
  const [, startTransition] = useTransition();

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mn = String(d.getMinutes()).padStart(2, '0');
      setNow(`${dd}/${mm} ${hh}:${mn}`);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  // Submit automático al completar 4 dígitos (Wireframe 01).
  useEffect(() => {
    if (DEMO_MODE) return;
    if (pin.length === PIN_LEN && estado !== 'INTENTANDO' && estado !== 'BLOQUEADO') {
      void submit(pin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  async function submit(pinValue: string) {
    setEstado('INTENTANDO');
    setErrorMsg(null);
    try {
      const res = await api.post<{
        usuario: { id: string; nombre: string; rol: 'VENDEDOR' | 'ADMIN' };
        token?: string;
      }>('/auth/login', { pin: pinValue, pcOrigen });
      // Guardamos el token para Authorization header en cross-origin
      // (web servido por Vercel ↔ API local). En same-origin/desktop la
      // cookie ya está seteada y el token es redundante pero no estorba.
      if (res.token) setAuthToken(res.token);

      // Prefetch agresivo: paralelizamos las llamadas que el usuario va a
      // hacer en cuanto entre a su pantalla destino. Cuando navega, el
      // cache cliente las tiene fresh → 0 round-trips.
      // Para Portugal (~150ms RTT a SP) esto es la diferencia entre
      // "tarda 1.5s en abrir cargar-pedido" y "abre instantáneo".
      prefetch('/auth/me', 5 * 60_000);
      prefetch('/catalogo/categorias', 5 * 60_000);
      prefetch('/catalogo/cuentas', 5 * 60_000);
      prefetch('/catalogo/listas-precios', 5 * 60_000);
      // Mismo URL que la pantalla cargar-pedido va a pedir (sino el prefetch
      // cae en miss). TTL 5min porque el catálogo cambia raramente y los 2000
      // productos pesan ~200KB JSON — vale la pena no re-bajarlo en cada mount.
      prefetch('/catalogo/productos?limit=2000', 5 * 60_000);
      prefetch('/catalogo/salsa/SIMPLE', 10 * 60_000);
      prefetch('/catalogo/salsa/ESPECIAL', 10 * 60_000);
      if (res.usuario.rol === 'VENDEDOR') {
        prefetch('/ventas/abiertas', 5_000);
      }

      setEstado('EXITO');
      startTransition(() => {
        router.push(res.usuario.rol === 'VENDEDOR' ? '/cargar-pedido' : '/admin');
      });
    } catch (e) {
      const intentosNuevo = intentos + 1;
      setIntentos(intentosNuevo);
      if (e instanceof ApiError) {
        if (e.body && (e.body as { code?: string }).code === 'USUARIO_BLOQUEADO') {
          setEstado('BLOQUEADO');
          setErrorMsg('Usuario bloqueado por intentos fallidos. Esperá 15 minutos.');
        } else {
          setEstado('ERROR');
          setErrorMsg(intentosNuevo >= 4 ? 'PIN incorrecto. Cuidado — un intento más y se bloquea.' : 'PIN incorrecto. Probá de nuevo.');
        }
      } else {
        setEstado('ERROR');
        setErrorMsg('No se pudo conectar al servidor. Intentá de nuevo.');
      }
      setTimeout(() => {
        setPin('');
        setEstado('IDLE');
      }, 1100);
    }
  }

  function entrarDemo(rol: 'VENDEDOR' | 'ADMIN') {
    setDemoRol(rol);
    setEstado('EXITO');
    startTransition(() => {
      router.push(rol === 'VENDEDOR' ? '/cargar-pedido' : '/admin');
    });
  }

  function appendDigit(d: string) {
    if (estado === 'BLOQUEADO' || estado === 'INTENTANDO') return;
    setPin((p) => (p.length >= PIN_LEN ? p : p + d));
  }
  function backspace() {
    if (estado === 'BLOQUEADO' || estado === 'INTENTANDO') return;
    setPin((p) => p.slice(0, -1));
  }
  function clearPin() {
    if (estado === 'BLOQUEADO' || estado === 'INTENTANDO') return;
    setPin('');
    setEstado('IDLE');
    setErrorMsg(null);
  }

  // ─── DEMO MODE: pantalla simplificada con dos botones ──────────────
  if (DEMO_MODE) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="flex flex-col items-center gap-10 w-full max-w-md">
          <header className="text-center">
            <div className="text-5xl mb-4">🍝</div>
            <h1 className="font-display text-3xl text-teresita-700 leading-tight tracking-tight">
              SANTA TERESITA
            </h1>
            <p className="font-display text-base text-teresita-500 italic mt-1">pastas & co</p>
          </header>

          <div className="text-center">
            <div className="inline-block px-3 py-1 rounded-full bg-saffron-100 text-saffron-600 text-2xs font-semibold uppercase tracking-widest mb-4">
              Only demonstration
            </div>
            <p className="text-sm text-ink-500 max-w-sm leading-relaxed">
              Esta es una versión interactiva sin backend real. Los datos son ficticios y se reinician al cerrar la pestaña. Ingresá como vendedor o como admin para recorrer la app.
            </p>
          </div>

          <div className="flex flex-col gap-3 w-full">
            <button
              onClick={() => entrarDemo('VENDEDOR')}
              className="w-full bg-teresita-700 hover:bg-teresita-900 text-cream-50 rounded-lg py-4 px-6 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <div className="font-display text-lg leading-tight">Sesión Vendedor</div>
                  <div className="text-2xs text-cream-100 opacity-80 mt-0.5">
                    Cargar pedidos · cobrar · cierre de turno
                  </div>
                </div>
                <span className="text-2xl group-hover:translate-x-1 transition-transform">→</span>
              </div>
            </button>

            <button
              onClick={() => entrarDemo('ADMIN')}
              className="w-full bg-white border-2 border-teresita-700 hover:bg-teresita-50 text-teresita-700 rounded-lg py-4 px-6 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <div className="font-display text-lg leading-tight">Sesión Admin</div>
                  <div className="text-2xs opacity-80 mt-0.5">
                    Dashboard · cuentas · productos · reportes
                  </div>
                </div>
                <span className="text-2xl group-hover:translate-x-1 transition-transform">→</span>
              </div>
            </button>
          </div>

          <footer className="text-2xs text-ink-300 mt-2 text-center">
            <div>Demo · {now}</div>
            <div className="mt-1">
              POS + cashflow + reportes para una pastería en La Plata
            </div>
          </footer>
        </div>
      </div>
    );
  }

  // ─── Modo normal con PIN ───────────────────────────────────────────
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="flex flex-col items-center gap-12 w-full max-w-sm">
        <header className="text-center">
          <div className="text-5xl mb-4">🍝</div>
          <h1 className="font-display text-3xl text-teresita-700 leading-tight tracking-tight">
            SANTA TERESITA
          </h1>
          <p className="font-display text-base text-teresita-500 italic mt-1">pastas & co</p>
        </header>

        <hr className="w-16 border-cream-300" />

        <div className="flex flex-col items-center gap-6 w-full">
          <div className="text-center">
            <h2 className="text-lg font-medium text-ink-700">Bienvenido</h2>
            <p className="text-base text-ink-500 mt-1">Ingresá tu PIN</p>
          </div>

          <PinInput
            value={pin}
            length={PIN_LEN}
            hasError={estado === 'ERROR'}
            className={cn(
              'transition-transform',
              estado === 'ERROR' && 'animate-shake',
              estado === 'EXITO' && 'opacity-50',
            )}
          />

          {errorMsg && (
            <p
              role="alert"
              className={cn('text-sm text-center', estado === 'BLOQUEADO' ? 'text-pomodoro-600 font-medium' : 'text-pomodoro-600')}
            >
              {errorMsg}
            </p>
          )}
        </div>

        <Numpad
          onDigit={appendDigit}
          onBackspace={backspace}
          onClear={clearPin}
          disabled={estado === 'BLOQUEADO' || estado === 'INTENTANDO'}
          className="w-full max-w-xs"
        />

        <footer className="text-2xs text-ink-300 mt-2">
          {pcOrigen} · {now}
        </footer>
      </div>

      <style jsx>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-6px); }
          40% { transform: translateX(6px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(4px); }
        }
        :global(.animate-shake) {
          animation: shake 350ms ease-in-out;
        }
      `}</style>
    </div>
  );
}
