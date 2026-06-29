'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * "Usar como app" — invita a instalar la PWA en la pantalla de inicio para que
 * la encargada / empleados / gerente la abran como una app más, sin pasar por
 * el navegador cada vez.
 *
 * Comportamiento:
 *   - Si ya corre instalada (standalone) → no muestra nada.
 *   - Android / desktop Chromium: captura `beforeinstallprompt` y ofrece un
 *     botón "Instalar app" de 1 toque (prompt nativo).
 *   - iPhone/iPad (Safari): no hay prompt nativo → muestra el instructivo
 *     "Compartir → Agregar a inicio".
 *   - Se auto-abre UNA vez (se recuerda en localStorage). Se puede reabrir desde
 *     el header/sidebar despachando el evento `sta:install-open`.
 *   - Pill flotante "📱 Usar como app" solo en /login (ahí el fondo está libre);
 *     dentro de la app se reabre desde el header/sidebar.
 *
 * Para reabrir desde cualquier botón:
 *   onClick={() => window.dispatchEvent(new Event('sta:install-open'))}
 */

const DISMISS_KEY = 'sta_install_dismissed_v1';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // En el .exe de escritorio (Electron) la app YA está instalada → nunca tiene
  // sentido el cartel "Usar como app". Lo tratamos como standalone para ocultarlo.
  // (En navegadores reales —celular del dueño, etc.— sí se sigue ofreciendo.)
  if (/electron/i.test(window.navigator.userAgent)) return true;
  const mm = window.matchMedia?.('(display-mode: standalone)')?.matches === true;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return mm || iosStandalone;
}

export function InstallPrompt() {
  const pathname = usePathname();
  // Arrancamos "true" para no parpadear pill/modal antes de detectar.
  const [standalone, setStandalone] = useState(true);
  const [open, setOpen] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const deferred = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    setStandalone(detectStandalone());
  }, []);

  // Evento nativo de instalación (Android / Chrome / Edge desktop).
  useEffect(() => {
    const onBIP = (e: Event) => {
      e.preventDefault();
      deferred.current = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const onInstalled = () => {
      deferred.current = null;
      setCanInstall(false);
      setOpen(false);
      try {
        localStorage.setItem(DISMISS_KEY, '1');
      } catch {}
    };
    window.addEventListener('beforeinstallprompt', onBIP);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Auto-abrir una sola vez.
  useEffect(() => {
    if (standalone) return;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === '1';
    } catch {}
    if (dismissed) return;
    const t = setTimeout(() => setOpen(true), 1500);
    return () => clearTimeout(t);
  }, [standalone]);

  // Reabrir bajo demanda desde header/sidebar.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('sta:install-open', onOpen);
    return () => window.removeEventListener('sta:install-open', onOpen);
  }, []);

  // Cerrar con Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cerrar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cerrar = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {}
  }, []);

  const instalar = useCallback(async () => {
    const d = deferred.current;
    if (!d) return;
    try {
      await d.prompt();
      await d.userChoice;
    } catch {}
    deferred.current = null;
    setCanInstall(false);
    cerrar();
  }, [cerrar]);

  if (standalone) return null;

  const mostrarPill = !open && pathname === '/login';

  return (
    <>
      {mostrarPill && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed z-40 left-1/2 -translate-x-1/2 bottom-[calc(env(safe-area-inset-bottom)+1.25rem)] bg-white border border-cream-300 shadow-lg text-teresita-700 text-sm font-semibold px-4 py-2.5 rounded-full flex items-center gap-2 active:bg-cream-100"
        >
          <span aria-hidden>📱</span> Usar como app
        </button>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4"
          onClick={cerrar}
          role="dialog"
          aria-modal="true"
          aria-label="Usar como app"
        >
          <div
            className="bg-white w-full max-w-sm rounded-2xl p-5 shadow-xl safe-bottom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-3">
              <div className="shrink-0 w-11 h-11 rounded-xl bg-teresita-50 flex items-center justify-center text-2xl">
                📱
              </div>
              <h2 className="font-display text-lg text-ink-900 leading-snug flex-1 pt-0.5">
                Usá esto como una app
              </h2>
              <button
                onClick={cerrar}
                aria-label="Cerrar"
                className="text-ink-500 text-2xl leading-none -mt-1"
              >
                ×
              </button>
            </div>

            <p className="text-sm text-ink-700 mb-4">
              Agregá Santa Teresita a la pantalla de inicio de tu celular, tablet
              o notebook. Se abre directo y a pantalla completa, sin tener que
              entrar por el navegador cada vez.
            </p>

            {canInstall && (
              <button
                onClick={instalar}
                className="w-full mb-4 bg-teresita-700 text-cream-50 px-4 py-3 rounded-md font-semibold active:bg-teresita-900"
              >
                Instalar app
              </button>
            )}

            <div className="space-y-2">
              <div className="bg-cream-100 rounded-lg p-3">
                <p className="text-sm font-semibold text-ink-900 mb-0.5">
                  🤖 Android (Chrome)
                </p>
                <p className="text-xs text-ink-700">
                  Abrí el menú del navegador (los tres puntos{' '}
                  <span className="font-semibold">⋮</span> arriba a la derecha) y
                  tocá <span className="font-semibold">«Agregar a pantalla principal»</span>{' '}
                  o <span className="font-semibold">«Instalar app»</span>.
                </p>
              </div>
              <div className="bg-cream-100 rounded-lg p-3">
                <p className="text-sm font-semibold text-ink-900 mb-0.5">
                  🍎 iPhone / iPad (Safari)
                </p>
                <p className="text-xs text-ink-700">
                  Tocá el botón <span className="font-semibold">Compartir</span>{' '}
                  (el cuadradito con la flecha hacia arriba) y elegí{' '}
                  <span className="font-semibold">«Agregar a inicio»</span>.
                </p>
              </div>
            </div>

            <button
              onClick={cerrar}
              className="w-full mt-4 bg-saffron-600 text-cream-50 px-4 py-3 rounded-md font-semibold active:opacity-90"
            >
              Entendido
            </button>
          </div>
        </div>
      )}
    </>
  );
}
