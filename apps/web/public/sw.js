/* Santa Teresita — Service Worker
 *
 * Objetivo: que el web servido por Vercel funcione si Vercel se cae o no
 * hay internet. El API local en 127.0.0.1 sigue respondiendo igual,
 * entonces si tenemos los assets cacheados podemos seguir vendiendo
 * durante un outage de Vercel/internet.
 *
 * Estrategias:
 *   - HTML (navegación): network-first. Si hay red, sirve la versión más
 *     reciente; sino fallback al cache. Esto hace que cuando Vercel
 *     publique un cambio, los clientes lo vean al próximo refresh.
 *   - /_next/static/ (JS/CSS hasheados): cache-first. Inmutables — el
 *     hash en el nombre garantiza unicidad por versión.
 *   - /favicon.ico, /manifest.json, /icons/*: cache-first.
 *   - 127.0.0.1:3001 (API local): pass-through, no cache.
 *   - Cualquier otro origen externo: pass-through.
 *
 * Versionado: bumpear CACHE_VERSION cuando cambien las URLs de los assets
 * de _next/static (idealmente el build de Vercel los hashea, así que NO
 * debería hacer falta nunca).
 */

// Bumpeamos a v2 cuando la rama de optimizaciones (alpha.18) cambió SHELL_URLS
// y agregó rutas admin frecuentes. El activate event borra las caches v1
// automáticamente.
const CACHE_VERSION = 'v2';
const SHELL_CACHE = `sta-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `sta-static-${CACHE_VERSION}`;

// El shell mínimo: la URL raíz y rutas críticas. Las precacheamos al
// instalar para que el primer offline arranque "instantáneo".
const SHELL_URLS = [
  '/',
  '/login',
  '/cargar-pedido',
  '/admin',
  '/admin/ventas',
  '/admin/movimientos',
  '/admin/cuentas',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_URLS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Limpieza de caches viejos al activar una versión nueva del SW.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((k) => {
            if (k !== SHELL_CACHE && k !== STATIC_CACHE) return caches.delete(k);
            return undefined;
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Solo manejamos GET. Writes (POST/PUT/DELETE) van directo a red.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API local (127.0.0.1 / localhost) — no tocar.
  if (
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname.startsWith('192.168.')
  ) {
    return; // pass-through al network
  }

  // Solo cacheamos cosas del mismo origen (Vercel deploy). Externos
  // pasan derecho.
  if (url.origin !== self.location.origin) return;

  // Static assets: cache-first
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Manifest / favicon: cache-first
  if (
    url.pathname === '/manifest.json' ||
    url.pathname === '/favicon.ico' ||
    url.pathname.match(/\.(png|svg|webmanifest)$/)
  ) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // Navegación HTML / rutas Next: network-first con fallback a cache
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  // Cualquier otro mismo-origen: network-first conservador
  event.respondWith(networkFirst(req, SHELL_CACHE));
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // Solo cacheamos respuestas 2xx para no envenenar el cache con 404s
    if (res.ok) cache.put(req, res.clone()).catch(() => undefined);
    return res;
  } catch (e) {
    // Sin red y sin cache → el browser muestra error de red estándar
    return Response.error();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) {
      // Clone antes de retornar — el body es un stream que se consume
      cache.put(req, res.clone()).catch(() => undefined);
    }
    return res;
  } catch (e) {
    // Fallback al cache
    const hit = await cache.match(req);
    if (hit) return hit;
    // Última chance: si pidió HTML, devolver el shell de '/'
    if (req.mode === 'navigate') {
      const root = await cache.match('/');
      if (root) return root;
    }
    return Response.error();
  }
}

// Permite que la app fuerce un update del SW desde la UI cuando detecte
// una versión nueva (postMessage({ type: 'SKIP_WAITING' })).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
