// Keeps the pictures Home paints in a Cache API cache the service worker reads
// from (see src/service-worker.ts), so a cold start draws them with the tiles
// instead of a beat later. The browser's HTTP cache can't be relied on for that:
// a cover's host decides its headers, and many have it revalidate every time.
//
// The set is exactly what Home's snapshot paints (utils/homeSnapshot.ts), so it
// stays small and is replaced, not grown: whatever the snapshot no longer shows
// is deleted. Article images and everything else go to the network as before.

import { CARD_IMAGE_CACHE } from '$lib/constants/cardImages';

/** Enough for every lane's tiles, with room to spare. */
export const MAX_CARD_IMAGES = 160;
/** A thumbnail is drawn at a few dozen pixels. A cover much bigger than this is
 *  a full-size photo, and the HTTP cache can have it. Only measurable on a CORS
 *  copy: an opaque one can't be sized, which MAX_OPAQUE_IMAGES bounds instead. */
const MAX_IMAGE_BYTES = 1_500_000;
const CONCURRENCY = 4;
/** Pictures from hosts without CORS headers are stored opaque, and browsers
 *  count an opaque entry at a padded size (megabytes in Chromium) against the
 *  same quota as the library in IndexedDB. So only the first few, which are the
 *  first lanes' tiles, the ones on screen when Home opens. */
export const MAX_OPAQUE_IMAGES = 24;

/** The URLs worth caching, normalized as the cache stores them. Only https
 *  pictures from other sites: our own API's are private (an EPUB's cover) and
 *  have their own cache headers. */
export function cacheableImageUrls(urls: string[], ownOrigins: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || ownOrigins.includes(url.origin)) continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(url.href);
    if (out.length >= MAX_CARD_IMAGES) break;
  }
  return out;
}

function isSmallImage(res: Response): boolean {
  const type = res.headers.get('content-type') ?? '';
  if (type && !type.startsWith('image/')) return false;
  const length = Number(res.headers.get('content-length'));
  return !(length > MAX_IMAGE_BYTES);
}

// A readable (CORS) copy where the host allows it, since the browser accounts
// for it at its real size; an opaque one otherwise (when `opaqueOk`), which is
// what an <img> would have fetched anyway. `undefined` when the network
// couldn't be reached, so a copy already stored is kept rather than dropped.
async function fetchForCache(url: string, opaqueOk: boolean): Promise<Response | null | undefined> {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    return isSmallImage(res) ? res : null;
  } catch {
    // No CORS headers (or offline): fall through to the opaque fetch.
  }
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline) return undefined;
  if (!opaqueOk) return null;
  try {
    const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
    return res.type === 'opaque' || res.ok ? res : null;
  } catch {
    return undefined;
  }
}

// Bumped by clearCardImages, so a pass already running stops writing.
let generation = 0;
// Opaque entries refreshed in this page's lifetime. An opaque response can't
// say whether it was an error (a 429 looks like a picture), so each is fetched
// again once a session rather than kept for as long as its tile is.
const refreshedOpaque = new Set<string>();

async function sync(urls: string[]): Promise<void> {
  const gen = generation;
  if (typeof caches === 'undefined' || typeof location === 'undefined') return;
  const own = [location.origin];
  const apiBase = import.meta.env.VITE_API_URL;
  if (apiBase) {
    try {
      own.push(new URL(apiBase).origin);
    } catch {
      // A relative API base is this origin.
    }
  }
  const wanted = cacheableImageUrls(urls, own);
  const wantedSet = new Set(wanted);
  const cache = await caches.open(CARD_IMAGE_CACHE);
  const have = new Set<string>();
  let opaque = 0;
  for (const request of await cache.keys()) {
    if (gen !== generation) return;
    if (!wantedSet.has(request.url)) {
      await cache.delete(request);
      continue;
    }
    const stored = await cache.match(request);
    if (stored?.type === 'opaque') {
      if (!refreshedOpaque.has(request.url)) continue; // fetch it again below
      opaque++;
    }
    have.add(request.url);
  }
  const missing = wanted.filter((u) => !have.has(u));
  let next = 0;
  async function worker() {
    while (next < missing.length) {
      const url = missing[next++];
      const res = await fetchForCache(url, opaque < MAX_OPAQUE_IMAGES);
      if (gen !== generation) return;
      if (res === undefined) continue;
      if (!res) {
        // Dropped (an error, or over the opaque allowance): don't keep a stale copy.
        await cache.delete(url);
        continue;
      }
      if (res.type === 'opaque') {
        if (opaque >= MAX_OPAQUE_IMAGES) {
          await cache.delete(url);
          continue;
        }
        opaque++;
        refreshedOpaque.add(url);
      }
      try {
        await cache.put(url, res);
      } catch {
        // Over quota: the picture just comes from the network.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
}

let running: Promise<void> | null = null;
let pending: string[] | null = null;

/** Make the cache hold exactly these pictures (up to MAX_CARD_IMAGES). Calls
 *  while one is running collapse into one more pass with the latest set. */
export function keepCardImages(urls: string[]): void {
  if (running) {
    pending = urls;
    return;
  }
  running = sync(urls)
    .catch((err) => console.warn('[cardImages] Failed to update the cache:', err))
    .finally(() => {
      running = null;
      const again = pending;
      pending = null;
      if (again) keepCardImages(again);
    });
}

/** Drop the cache, for clearAllData: it holds pictures from this reader's saves. */
export async function clearCardImages(): Promise<void> {
  generation++;
  pending = null;
  try {
    if (typeof caches !== 'undefined') await caches.delete(CARD_IMAGE_CACHE);
  } catch {
    // Nothing to clear.
  }
}
