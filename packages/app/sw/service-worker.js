/* Raccoon app service worker — build __RACCOON_BUILD_ID__ */
const BUILD_ID = '__RACCOON_BUILD_ID__';
const SHELL_CACHE = `raccoon-shell-${BUILD_ID}`;
const STATIC_CACHE = `raccoon-static-${BUILD_ID}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      const res = await fetch('/', { cache: 'no-store' });
      if (res.ok) {
        const html = await res.clone().text();
        await cache.put('/', res);
        // Precache the hashed assets the shell references. The SW registers after
        // the first page's JS/CSS have already loaded (uncontrolled), so without
        // this an immediate offline relaunch would serve cached HTML whose assets
        // were never cached. Best-effort: failures fall back to the fetch handler.
        const assetUrls = [...html.matchAll(/(?:src|href)="(\/(?:assets|icons)\/[^"]+)"/g)]
          .map((m) => m[1]);
        if (assetUrls.length > 0) {
          const staticCache = await caches.open(STATIC_CACHE);
          await Promise.all([...new Set(assetUrls)].map(async (u) => {
            try {
              const r = await fetch(u, { cache: 'no-store' });
              if (r.ok) await staticCache.put(u, r);
            } catch { /* best-effort precache */ }
          }));
        }
      }
    } catch { /* offline install — shell fills on first fetch */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n !== SHELL_CACHE && n !== STATIC_CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PURGE_SHELL_CACHE') {
    event.waitUntil(caches.delete(SHELL_CACHE));
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // version.json and the worker itself must never be cached
  if (url.pathname === '/version.json' || url.pathname === '/service-worker.js') return;

  if (event.request.mode === 'navigate') {
    const revalidate = fetch('/', { cache: 'no-store' })
      .then(async (res) => {
        if (res.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put('/', res.clone());
        }
        return res;
      })
      .catch(() => null);
    event.waitUntil(revalidate);
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match('/');
      if (cached) return cached;
      const fresh = await revalidate;
      return fresh ?? new Response('offline', { status: 503 });
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const res = await fetch(event.request);
      if (res.ok) await cache.put(event.request, res.clone());
      return res;
    })());
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* opaque push */ }
  const title = data.title || 'Raccoon';
  const tag = data.tag || (data.data && data.data.channel) || undefined;
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    ...(tag ? { tag } : {}),
    data: data.data || {},
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Same-origin relative paths only ('/x' yes, '//host/x' and absolute URLs
  // no) — mirrors the app-side handleSwNavigate rule, and keeps openWindow
  // from navigating off-origin or rejecting on malformed payload urls.
  const raw = event.notification.data && event.notification.data.url;
  const url = typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length > 0) {
      const client = clients[0];
      await client.focus();
      // The page can't be navigated from here without a reload; the app
      // listens for this message and routes client-side (?c=<channel>).
      client.postMessage({ type: 'NAVIGATE', url });
      return;
    }
    return self.clients.openWindow(url);
  })());
});
