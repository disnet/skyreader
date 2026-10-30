import { RateLimitError } from '$lib/services/api';

/**
 * Coalesces per-save body lookups from list surfaces (cards, the magazine) into
 * batched POST /api/saved/bodies calls. A list of a few hundred imported saves
 * with no text yet used to send one request per card, again on every re-render,
 * and nothing remembered an empty answer: hundreds of requests at once.
 *
 * - One request in flight at a time, each carrying up to `batchSize` rkeys
 *   gathered over `delayMs`. A second ask for an rkey already queued shares it.
 * - The server's "no body" is remembered until `forget(rkey)` (a body landed by
 *   another path, which then reads from IndexedDB first anyway).
 * - A failed request pauses lookups (Retry-After on a 429, else doubling from
 *   `baseBackoffMs`); asks during the pause answer null without a request.
 *
 * `get` never rejects: null means "no body to show", for whatever reason.
 */
export function createBodyBatcher(
  fetchBodies: (rkeys: string[]) => Promise<Record<string, string | null>>,
  {
    batchSize = 200,
    delayMs = 50,
    baseBackoffMs = 5_000,
    maxBackoffMs = 5 * 60_000,
    now = () => Date.now(),
  } = {}
) {
  const empty = new Set<string>();
  const waiting = new Map<string, Promise<string | null>>();
  let queue: Array<{ rkey: string; resolve: (body: string | null) => void }> = [];
  let flushing = false;
  let failures = 0;
  let pausedUntil = 0;

  function settle(batch: typeof queue, bodies: Record<string, string | null> | null) {
    for (const { rkey, resolve } of batch) {
      waiting.delete(rkey);
      const body = bodies?.[rkey] ?? null;
      if (bodies && !body) empty.add(rkey);
      resolve(body || null);
    }
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      await new Promise((r) => setTimeout(r, delayMs));
      while (queue.length > 0) {
        if (now() < pausedUntil) {
          settle(queue, null);
          queue = [];
          break;
        }
        const batch = queue.slice(0, batchSize);
        queue = queue.slice(batchSize);
        try {
          const bodies = await fetchBodies(batch.map((b) => b.rkey));
          failures = 0;
          settle(batch, bodies);
        } catch (err) {
          failures++;
          const wait =
            err instanceof RateLimitError
              ? err.retryAfter * 1000
              : Math.min(baseBackoffMs * 2 ** (failures - 1), maxBackoffMs);
          pausedUntil = now() + wait;
          settle(batch, null);
        }
      }
    } finally {
      flushing = false;
    }
  }

  return {
    get(rkey: string): Promise<string | null> {
      if (empty.has(rkey) || now() < pausedUntil) return Promise.resolve(null);
      const pending = waiting.get(rkey);
      if (pending) return pending;
      const promise = new Promise<string | null>((resolve) => queue.push({ rkey, resolve }));
      waiting.set(rkey, promise);
      void flush();
      return promise;
    },
    forget(rkey: string) {
      empty.delete(rkey);
    },
  };
}
