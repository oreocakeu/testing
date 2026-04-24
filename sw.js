/* ── WatchTogether Service Worker ── */
var CACHE = 'watchtogether-v1';
var ASSETS = [
  '/watch2gether/',
  '/watch2gether/index.html',
  '/watch2gether/style.css',
  '/watch2gether/app.js',
  '/watch2gether/icon-192.png',
  '/watch2gether/icon-512.png'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  // Always go network first for Firebase and video requests
  if (e.request.url.includes('firebase') ||
      e.request.url.includes('google') ||
      e.request.url.includes('youtube') ||
      e.request.url.includes('fonts')) {
    e.respondWith(fetch(e.request).catch(function() {
      return caches.match(e.request);
    }));
    return;
  }

  // Cache first for app assets
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      return cached || fetch(e.request).then(function(response) {
        return caches.open(CACHE).then(function(cache) {
          cache.put(e.request, response.clone());
          return response;
        });
      });
    })
  );
});
