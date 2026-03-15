const CACHE_NAME = 'sparkystudy-v6';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always fetch JS and CSS fresh — never serve from cache
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Network-first for HTML so updates propagate immediately
  if (url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for everything else (icons, images, fonts)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
      if (resp.ok && e.request.method === 'GET') {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return resp;
    }).catch(() => cached))
  );
});

// ── Push notifications ─────────────────────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'SparkStudy';
  const options = {
    body:    data.body || "Time to study! Your exam is coming up.",
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    tag:     data.tag || 'sparkstudy-reminder',
    data:    { url: data.url || '/' },
    actions: [
      { action: 'study', title: '⚡ Study Now' },
      { action: 'dismiss', title: 'Later' }
    ]
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window' }).then(windowClients => {
    for (const client of windowClients) {
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        return client.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
