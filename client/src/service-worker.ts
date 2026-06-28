/// <reference lib="WebWorker" />
import { precacheAndRoute } from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope;

// Keep Workbox's injection point valid for the existing PWA build pipeline,
// then immediately clear the app-shell caches and unregister. CrossLAN should
// prefer fresh LAN pages over offline app caching.
precacheAndRoute(self.__WB_MANIFEST);

async function deleteAllCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.map(cacheName => caches.delete(cacheName)));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await deleteAllCaches();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await deleteAllCaches();
    await self.clients.claim();
    await self.registration.unregister();
  })());
});