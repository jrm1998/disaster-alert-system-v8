// MDAS Service Worker: app-shell caching, offline emergency info, background push.
const CACHE_VERSION = 'mdas-v6';
const APP_SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/dashboard.html',
  '/offline.html',
  '/manifest.json',
  '/css/style.css',
  '/js/common.js',
  '/js/index.js',
  '/js/login.js',
  '/js/dashboard.js',
  '/js/call.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Emergency endpoints whose last successful response is served when offline.
const OFFLINE_API = [
  '/api/contacts',
  '/api/alerts',
  '/api/weather',
  '/api/evacuation',
  '/api/missing',
  '/api/flood/sensors',
  '/api/barangays',
  '/api/advisories',
  '/api/settings'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept real-time signaling (Socket.IO handshake/polling). Letting the
  // browser handle it natively keeps the websocket upgrade and polling intact.
  if (url.pathname.startsWith('/socket.io/')) return;

  if (url.origin !== self.location.origin) {
    // CDN assets (Leaflet etc.): cache-first so the map works offline after first load
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(resp => {
        if (resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        }
        return resp;
      }).catch(() => caches.match(req)))
    );
    return;
  }

  // Emergency API data: network-first, always update cache, fallback offline
  if (OFFLINE_API.some(p => url.pathname === p || url.pathname.startsWith(p + '?'))) {
    event.respondWith(
      fetch(req).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(url.pathname, copy));
        }
        return resp;
      }).catch(async () => {
        const cached = await caches.match(url.pathname);
        return cached || new Response(JSON.stringify({ offline: true, error: 'No cached data available.' }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // App shell / pages: network-first, cache fallback, then offline page
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        return (await caches.match(url.pathname)) || (await caches.match('/')) || (await caches.match('/offline.html'));
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).catch(() => caches.match('/offline.html')))
  );
});

// Background push notifications - delivered even when the site is closed
self.addEventListener('push', event => {
  let data = { title: 'MDAS Emergency Alert', body: 'Open the app for details.' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* use defaults */ }
  const severity = data.severity || 'info';
  const critical = severity === 'critical';

  event.waitUntil((async () => {
    // If the app is open in a tab, tell it to sound the in-app alarm immediately
    // (the page also polls, but this makes the siren instant on push arrival).
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'mdas-push', severity, title: data.title, body: data.body });
      }
    } catch { /* best effort */ }

    await self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.alertId ? 'alert-' + data.alertId : 'mdas',
      renotify: true,
      silent: false, // let the OS play its alert sound
      requireInteraction: critical,
      // Feature 1: incident pushes carry the exact GPS location, so offer a
      // one-tap "Open Maps" action that navigates straight to the scene.
      actions: data.mapsUrl ? [{ action: 'maps', title: 'Open Maps' }] : [],
      data: { url: data.url || '/', severity, mapsUrl: data.mapsUrl || null },
      // Strong, repeating vibration for critical alerts; shorter for others.
      vibrate: critical
        ? [600, 250, 600, 250, 600, 250, 600, 250, 600]
        : [350, 150, 350]
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  // The "Open Maps" action opens the external map; a normal tap opens the app.
  const target = (event.action === 'maps' && data.mapsUrl) ? data.mapsUrl : (data.url || '/');
  const external = /^https?:\/\//i.test(target);
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (external) return clients.openWindow(target);
      for (const client of list) {
        if ('focus' in client) { client.navigate(target); return client.focus(); }
      }
      return clients.openWindow(target);
    })
  );
});
