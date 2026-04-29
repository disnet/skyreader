/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = `skyreader-${version}`;
const STATIC_ASSETS = [...build, ...files];

// Constants for background refresh
const PERIODIC_SYNC_TAG = 'background-feed-refresh';
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const LAST_REFRESH_KEY = 'lastRefreshAt';

// API routes to cache with network-first strategy
const API_CACHE_ROUTES = ['/api/v2/feeds/fetch', '/api/social/feed', '/api/social/popular'];

self.addEventListener('install', (event) => {
  // Only cache the SPA fallback — static assets are cached lazily on fetch.
  // This keeps install fast so the update banner appears quickly.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add('/')));
  // Do NOT call skipWaiting() here. Activating a new SW while old pages are
  // still running can break lazily-loaded code-split chunks whose filenames
  // changed between builds. Instead, the app sends a SKIP_WAITING message
  // when the user explicitly accepts the update.
});

// Listen for messages from the app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version });
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        return Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        );
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and other non-http schemes
  if (!url.protocol.startsWith('http')) return;

  // Static assets: cache-first, cache on miss (lazy population)
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
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

  // Navigation requests: network-first with timeout, cache fallback.
  // iOS PWAs can hang on fetch after long idle — the timeout ensures
  // we fall back to the cached shell instead of showing a white screen.
  if (event.request.mode === 'navigate') {
    const NAVIGATION_TIMEOUT_MS = 3000;

    event.respondWith(
      new Promise<Response>((resolve) => {
        let settled = false;

        const timer = setTimeout(async () => {
          if (settled) return;
          settled = true;
          // Timeout — serve from cache
          const cached = (await caches.match(event.request)) || (await caches.match('/'));
          resolve(cached || new Response('Offline', { status: 503 }));
        }, NAVIGATION_TIMEOUT_MS);

        fetch(event.request)
          .then(async (response) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            // Cache the fresh HTML so next offline load is up-to-date
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put('/', clone));
            }
            resolve(response);
          })
          .catch(async () => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            const cached = (await caches.match(event.request)) || (await caches.match('/'));
            resolve(cached || new Response('Offline', { status: 503 }));
          });
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

// Periodic background sync handler (Chromium only)
self.addEventListener('periodicsync', (event: Event) => {
  const syncEvent = event as ExtendableEvent & { tag: string };
  if (syncEvent.tag === PERIODIC_SYNC_TAG) {
    syncEvent.waitUntil(handlePeriodicSync());
  }
});

async function handlePeriodicSync(): Promise<void> {
  try {
    // Check if data is stale by reading from IndexedDB
    const lastRefreshAt = await getLastRefreshFromIndexedDB();
    const now = Date.now();

    if (lastRefreshAt && now - lastRefreshAt < STALE_THRESHOLD_MS) {
      console.log('Data is fresh, skipping background refresh');
      return;
    }

    // Try to notify any open clients to refresh
    const clients = await self.clients.matchAll({ type: 'window' });

    if (clients.length > 0) {
      // Send message to clients to trigger refresh
      clients.forEach((client) => {
        client.postMessage({ type: 'BACKGROUND_REFRESH_REQUESTED' });
      });
      console.log('Background refresh requested via client message');
    } else {
      // No clients open - just update the timestamp
      // The actual refresh will happen when the app is opened
      console.log('No clients available for background refresh');
    }
  } catch (error) {
    console.error('Periodic sync failed:', error);
  }
}

async function getLastRefreshFromIndexedDB(): Promise<number | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open('skyreader');

    request.onerror = () => resolve(null);

    request.onsuccess = () => {
      const db = request.result;

      // Check if metadata store exists
      if (!db.objectStoreNames.contains('metadata')) {
        db.close();
        resolve(null);
        return;
      }

      try {
        const transaction = db.transaction('metadata', 'readonly');
        const store = transaction.objectStore('metadata');
        const getRequest = store.get(LAST_REFRESH_KEY);

        getRequest.onsuccess = () => {
          db.close();
          if (getRequest.result?.value) {
            try {
              resolve(JSON.parse(getRequest.result.value));
            } catch {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        };

        getRequest.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}
