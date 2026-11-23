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
 *  a full-size photo, and the HTTP cache can have it. */
const MAX_IMAGE_BYTES = 1_500_000;
const CONCURRENCY = 4;

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
// for it at its real size; an opaque one otherwise, which is what an <img>
// would have fetched anyway.
async function fetchForCache(url: string): Promise<Response | null> {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    return isSmallImage(res) ? res : null;
  } catch {
    // No CORS headers (or offline): fall through to the opaque fetch.
  }
  try {
    const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
    return res.type === 'opaque' || res.ok ? res : null;
  } catch {
    return null;
  }
}

async function sync(urls: string[]): Promise<void> {
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
  for (const request of await cache.keys()) {
    if (wantedSet.has(request.url)) have.add(request.url);
    else await cache.delete(request);
  }
  const missing = wanted.filter((u) => !have.has(u));
  let next = 0;
  async function worker() {
    while (next < missing.length) {
      const url = missing[next++];
      const res = await fetchForCache(url);
      if (!res) continue;
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
  try {
    if (typeof caches !== 'undefined') await caches.delete(CARD_IMAGE_CACHE);
  } catch {
    // Nothing to clear.
  }
}
