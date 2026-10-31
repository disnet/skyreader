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
 *   another path, which then reads from IndexedDB first anyway) or for
 *   `emptyTtlMs`, whichever comes first. `emptyEntries`/`restoreEmpty` let the
 *   caller keep those answers across page loads, so a list of bodyless imports
 *   isn't asked about again on every boot; `onEmptyChange` says when to save them.
 * - A failed request pauses lookups (Retry-After on a 429, else doubling from
 *   `baseBackoffMs`, at most `maxBackoffMs`); asks during the pause answer null
 *   without a request.
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
    emptyTtlMs = Infinity,
    onEmptyChange = () => {},
    now = () => Date.now(),
  }: {
    batchSize?: number;
    delayMs?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    emptyTtlMs?: number;
    onEmptyChange?: () => void;
    now?: () => number;
  } = {}
) {
  // rkey → when the server said it has no body for it.
  const empty = new Map<string, number>();
  function isEmpty(rkey: string): boolean {
    const at = empty.get(rkey);
    if (at === undefined) return false;
    if (now() - at < emptyTtlMs) return true;
    empty.delete(rkey);
    return false;
  }
  function addEmpty(rkey: string) {
    empty.set(rkey, now());
    onEmptyChange();
  }
  const waiting = new Map<string, Promise<string | null>>();
  let queue: Array<{ rkey: string; resolve: (body: string | null) => void }> = [];
  let flushing = false;
  let failures = 0;
  let pausedUntil = 0;

  function settle(batch: typeof queue, bodies: Record<string, string | null> | null) {
    for (const { rkey, resolve } of batch) {
      waiting.delete(rkey);
      const body = bodies?.[rkey] ?? null;
      if (bodies && !body) addEmpty(rkey);
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
          const wait = Math.min(
            err instanceof RateLimitError && err.retryAfter > 0
              ? err.retryAfter * 1000
              : baseBackoffMs * 2 ** (failures - 1),
            maxBackoffMs
          );
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
      if (isEmpty(rkey) || now() < pausedUntil) return Promise.resolve(null);
      const pending = waiting.get(rkey);
      if (pending) return pending;
      const promise = new Promise<string | null>((resolve) => queue.push({ rkey, resolve }));
      waiting.set(rkey, promise);
      void flush();
      return promise;
    },
    forget(rkey: string) {
      if (empty.delete(rkey)) onEmptyChange();
    },
    /** Whether the server has said it has no body for this rkey. */
    knownEmpty(rkey: string): boolean {
      return isEmpty(rkey);
    },
    /** Record a "no body" answer another request got. */
    markEmpty(rkey: string) {
      addEmpty(rkey);
    },
    /** The remembered "no body" answers that haven't expired, for saving. */
    emptyEntries(): Array<[string, number]> {
      const t = now();
      return [...empty].filter(([, at]) => t - at < emptyTtlMs);
    },
    /** Bring back answers saved by `emptyEntries`; expired ones are dropped. */
    restoreEmpty(entries: Array<[string, number]>) {
      const t = now();
      for (const [rkey, at] of entries) {
        if (typeof rkey === 'string' && typeof at === 'number' && t - at < emptyTtlMs) {
          if (!empty.has(rkey)) empty.set(rkey, at);
        }
      }
    },
  };
}
