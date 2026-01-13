/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = `skyreader-${version}`;
const STATIC_ASSETS = [...build, ...files];

// API routes to cache with network-first strategy
const API_CACHE_ROUTES = ['/api/feeds/fetch', '/api/social/feed', '/api/social/popular'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and other non-http schemes
  if (!url.protocol.startsWith('http')) return;

  // Static assets: cache-first
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return cached || fetch(event.request);
      })
    );
    return;
  }

  // API routes: network-first with cache fallback
  if (API_CACHE_ROUTES.some((route) => url.pathname.startsWith(route))) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Clone and cache successful responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(async () => {
          // Fallback to cache when offline
          const cached = await caches.match(event.request);
          if (cached) return cached;

          // Return offline indicator for API calls
          return new Response(JSON.stringify({ offline: true, error: 'You are offline' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        })
    );
    return;
  }

  // Navigation requests: network with offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;

        // Return cached index for SPA navigation
        const index = await caches.match('/');
        if (index) return index;

        return new Response('Offline', { status: 503 });
      })
    );
    return;
  }

  // All other requests: network with cache fallback
  event.respondWith(
    fetch(event.request).catch(async () => {
      return (await caches.match(event.request)) || new Response('Offline', { status: 503 });
    })
  );
});

// Background sync for pending operations (not supported in Firefox)
if (typeof self.registration !== 'undefined' && 'sync' in self.registration) {
  self.addEventListener('sync', (event) => {
    if ((event as ExtendableEvent & { tag?: string }).tag === 'sync-queue') {
      event.waitUntil(
        self.clients.matchAll().then((clients) => {
          clients.forEach((client) => {
            client.postMessage({ type: 'PROCESS_SYNC_QUEUE' });
          });
        })
      );
    }
  });
}

// Listen for messages from the app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
