// BodUp service worker. Its job is to let the browser offer "Add to home screen".
// It does not cache anything, so coaches and clients always see the latest app and their latest records.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
