const CACHE_NAME = 'sparkstudy-v2';

// Files to cache on install
const CACHE_FILES = [
  // Root pages
  'index.html',
  'login.html',
  'dashboard.html',
  'tools.html',
  'games.html',
  'worksheets.html',
  'pricing.html',
  'payment.html',
  'onboarding.html',
  'period1.html',
  'period2.html',
  'progress.html',
  'achievements.html',
  'formula-sheet.html',
  'institutions.html',
  'terms.html',
  'refund.html',
  'admin.html',
  // Tool pages
  'tools/ohms-law.html',
  'tools/power-triangle.html',
  'tools/faraday-law.html',
  'tools/circuit-builder.html',
  'tools/conductor-sizing.html',
  'tools/conduit-fill.html',
  'tools/demand-factor.html',
  'tools/voltage-drop.html',
  'tools/trig-calculator.html',
  'tools/formula-transposing.html',
  'tools/ac-waveform.html',
  'tools/time-constant.html',
  'tools/impedance-calculator.html',
  'tools/motor-control.html',
  'tools/transformer-calculator.html',
  'tools/wire-ampacity.html',
  // Game pages
  'games/wire-runner.html',
  'games/conduit-tetris.html',
  'games/circuit-connect.html',
  'games/fault-finder.html',
  'games/power-match.html',
  // Worksheet pages
  'worksheets/ohms-law.html',
  'worksheets/power.html',
  'worksheets/reactance.html',
  'worksheets/time-constant.html',
  'worksheets/voltage-drop.html',
  'worksheets/transformer.html',
  // Module pages
  'modules/diagnostic-assessment.html',
  'modules/study-guide.html',
  'modules/concepts.html',
  'modules/flashcards.html',
  'modules/sample-module.html',
  'modules/class1-class2-assessment.html',
  'modules/class1-class2-concepts.html',
  'modules/class1-class2-flashcards.html',
  // PWA assets
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// Install event - cache files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_FILES).catch(err => {
        console.warn('Some files could not be cached during install:', err);
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - network-first for HTML, cache-first for assets
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Network-first for HTML pages (so updates propagate)
  if (url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) return response;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match(event.request));
    })
  );
});
