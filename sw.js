// Claimclub service worker. Network only: nothing is cached except a small offline page,
// so the site always shows live data. Needed for the Android app (Trusted Web Activity) and installability.
const OFFLINE = '/offline.html';
const CACHE = 'cc-offline-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add(new Request(OFFLINE, { cache: 'reload' }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
