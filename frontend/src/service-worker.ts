/// <reference lib="webworker" />
//
// Service worker (Workbox, injectManifest strategy).
//
// Built by @vite-pwa/sveltekit (see vite.config.ts). Workbox replaces
// `self.__WB_MANIFEST` at build time with the full, revisioned list of build
// assets, so a given SW version always precaches a COMPLETE, self-consistent set
// of HTML shell + hashed JS/CSS chunks. This is what makes updates atomic: the
// shell and the chunks it imports always come from the same build, eliminating
// the version-skew that caused blank screens / "Something went wrong" on iOS.

import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  type PrecacheEntry,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// Constants for background refresh (Chromium periodic sync)
const PERIODIC_SYNC_TAG = 'background-feed-refresh';
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const LAST_REFRESH_KEY = 'lastRefreshAt';

// ---------------------------------------------------------------------------
// Precaching — the full build, cached atomically on install.
// ---------------------------------------------------------------------------

// Drop caches from previous (Workbox) builds so we don't accumulate stale chunks.
cleanupOutdatedCaches();

// Precache + serve every build asset cache-first. If any asset fails to fetch
// during install, the install fails and the OLD worker keeps serving its complete
// set — we never end up half-installed with missing chunks.
precacheAndRoute(self.__WB_MANIFEST);

// ---------------------------------------------------------------------------
// Navigation — always serve the precached app shell (app-shell model).
// ---------------------------------------------------------------------------
//
// This is the key robustness change. Rather than network-first (which would fetch
// a NEW build's HTML while the OLD build's chunks are still cached → skew), every
// navigation is answered from the precached shell that belongs to THIS SW version.
// Fresh content still arrives via the API; fresh app code arrives via the SW update.
//
// The SPA shell is precached under the key '/' (see kit.spa.fallbackMapping in
// vite.config.ts). createHandlerBoundToURL does a direct precache-map lookup, so this
// must match that key exactly — binding to anything not in the manifest throws
// 'non-precached-url' at startup and the worker never boots.
const navigationHandler = createHandlerBoundToURL('/');
registerRoute(
  new NavigationRoute(navigationHandler, {
    // Don't treat API or build-asset paths as navigations (belt-and-suspenders —
    // NavigationRoute already only matches request.mode === 'navigate').
    denylist: [/^\/api\//, /^\/_app\//],
  })
);

// ---------------------------------------------------------------------------
// API GET routes — network-first with cache fallback (offline reads).
// ---------------------------------------------------------------------------
//
// Mirrors the previous SW's cached routes. NetworkFirst returns the cached
// response (or rejects) when offline — no more fake `{offline:true}` 200 body that
// could poison callers. registerRoute matches GET only by default, so POST/batch
// mutations are never cached.
registerRoute(
  ({ url }) =>
    url.pathname.startsWith('/api/v2/feeds/fetch') ||
    url.pathname.startsWith('/api/social/feed') ||
    url.pathname.startsWith('/api/social/popular'),
  new NetworkFirst({
    cacheName: 'skyreader-api',
    networkTimeoutSeconds: 5,
  })
);

// Take control of open clients as soon as we activate. Combined with the
// 'prompt' update flow (skipWaiting only on the SKIP_WAITING message below),
// this means: first install controls immediately; updates wait for the user.
clientsClaim();

// ---------------------------------------------------------------------------
// Custom message handler — explicit, user-driven update activation.
// ---------------------------------------------------------------------------
//
// useRegisterSW(...).updateServiceWorker(true) in the app posts {type:'SKIP_WAITING'}
// to the waiting worker; we activate only then so we never swap code mid-session.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---------------------------------------------------------------------------
// Background sync for queued mutations (not supported in Firefox/Safari).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Periodic background sync (Chromium only).
// ---------------------------------------------------------------------------
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
      clients.forEach((client) => {
        client.postMessage({ type: 'BACKGROUND_REFRESH_REQUESTED' });
      });
      console.log('Background refresh requested via client message');
    } else {
      // No clients open — the refresh will happen when the app is next opened.
      console.log('No clients available for background refresh');
    }
  } catch (error) {
    console.error('Periodic sync failed:', error);
  }
}

function getLastRefreshFromIndexedDB(): Promise<number | null> {
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
