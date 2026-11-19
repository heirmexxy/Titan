// Titan Field service worker: the app shell works offline; API calls always go to the network
// (the page keeps its own queue of tests and custody events and sends them when back online).
const SHELL = 'titan-field-v1';
const FILES = ['/app/', '/app/index.html', '/app/manifest.webmanifest', '/app/icon.svg', '/app/icon-192.png', '/app/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/app/api') || url.pathname.startsWith('/admin/api') || url.pathname.startsWith('/console/api')) return;
  if (url.pathname.startsWith('/app')) {
    // Network first so updates arrive; cache when offline.
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('/app/'))));
  }
});
