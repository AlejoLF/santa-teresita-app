'use client';

import { useEffect } from 'react';

/**
 * Registra el Service Worker (`/sw.js`) si el browser lo soporta.
 *
 * Se monta en el layout raíz; corre en cada page load pero el browser
 * deduplica registros (no re-instala el SW si ya está activo).
 *
 * En modo demo no registramos — el SW interceptaría requests al backend
 * mock y rompería la UX de demo.
 *
 * En localhost también lo dejamos activo: Next.js dev-mode + SW funciona
 * y permite testear comportamiento offline. Si molesta durante dev, el
 * usuario puede desregistrar desde DevTools → Application → Service Workers.
 */
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (DEMO_MODE) return;
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    // Registro lazy — esperamos a que la página cargue para no competir
    // con first paint.
    const onLoad = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((reg) => {
          // Cuando hay una versión nueva del SW disponible, le pedimos que
          // active inmediatamente (skipWaiting) — el SW responde y al
          // próximo navigate los assets nuevos vienen del network.
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // Hay una versión nueva esperando. La activamos sin recargar.
                newWorker.postMessage({ type: 'SKIP_WAITING' });
              }
            });
          });
        })
        .catch((err) => {
          console.warn('[sw] registro falló:', err);
        });
    };

    if (document.readyState === 'complete') {
      onLoad();
    } else {
      window.addEventListener('load', onLoad, { once: true });
      return () => window.removeEventListener('load', onLoad);
    }
  }, []);

  return null;
}
