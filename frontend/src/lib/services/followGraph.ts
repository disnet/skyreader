// The reader's Bluesky follow graph, cached in IndexedDB and shared by every
// surface that scans the people you follow.
//
// Two of them now: /discover looks for standard.site publications on each
// follow's PDS, and /rooms looks for readAlong records. Both want the same
// graph, refreshed on the same cadence, so it lives here rather than inside
// either store — one owner of `db.follows`, one TTL, one background walk.
//
// Everything is best-effort: a failed page ends the walk with whatever was
// already cached, never a wiped graph.

import { db, getMetadata, setMetadata } from '$lib/services/db';
import { fetchFollowsPage, resolvePdsUrl, type FollowLite } from '$lib/services/socialGraph';

// Cap the follow graph at 30 pages (~3000 follows) so it can't run unbounded.
const MAX_FOLLOW_PAGES = 30;
// Refetch the follow graph at most once a day.
const GRAPH_TTL = 24 * 60 * 60 * 1000;
const GRAPH_FETCHED_KEY = 'followsGraphFetchedAt';

// True once the whole graph has been walked (no more follows will appear).
// Background scanners wait on this before declaring themselves done.
let graphComplete = false;
// Dedupes concurrent ensureFollowGraph calls: /discover and /rooms both ask,
// and walking the graph twice would just double the AppView traffic.
let inFlight: Promise<void> | null = null;

export function isFollowGraphComplete(): boolean {
  return graphComplete;
}

/** Upsert a batch of follows, preserving the per-scanner timestamps, the cached
 *  PDS and the "hidden" flag of any we already cached (a fresh row defaults to
 *  scannedAt=0, not hidden). Excludes self. */
async function upsertFollows(follows: FollowLite[], selfDid: string): Promise<void> {
  const incoming = follows.filter((f) => f.did !== selfDid);
  if (incoming.length === 0) return;
  const existing = await db.follows.bulkGet(incoming.map((f) => f.did));
  const prior = new Map(existing.filter(Boolean).map((f) => [f!.did, f!]));
  await db.follows.bulkPut(
    incoming.map((f) => {
      const was = prior.get(f.did);
      return {
        ...f,
        scannedAt: was?.scannedAt ?? 0,
        roomsScannedAt: was?.roomsScannedAt ?? 0,
        pdsUrl: was?.pdsUrl,
        hidden: was?.hidden,
      };
    })
  );
}

/** Once the whole graph has been walked, prune accounts the user no longer
 *  follows along with everything cached about them, then stamp the graph fresh. */
async function finalizeGraph(
  seen: Set<string>,
  onFollowsRemoved?: (dids: string[]) => void
): Promise<void> {
  const cached = (await db.follows.toCollection().primaryKeys()) as string[];
  const removed = cached.filter((d) => !seen.has(d));
  if (removed.length) {
    await db.transaction(
      'rw',
      db.follows,
      db.followingPublications,
      db.followingRooms,
      async () => {
        await db.follows.bulkDelete(removed);
        await db.followingPublications.where('did').anyOf(removed).delete();
        await db.followingRooms.where('did').anyOf(removed).delete();
      }
    );
    onFollowsRemoved?.(removed);
  }
  await setMetadata(GRAPH_FETCHED_KEY, Date.now());
  graphComplete = true;
}

/** Walk the remaining follow pages in the background, caching each as it
 *  arrives so newly-available accounts become scannable without blocking the
 *  first paint. Best-effort: a failed page just ends the backfill early. */
async function backfillGraph(
  selfDid: string,
  cursor: string,
  seen: Set<string>,
  onFollowsRemoved?: (dids: string[]) => void
): Promise<void> {
  try {
    let next: string | undefined = cursor;
    // Page 1 was already fetched up front, so backfill the remaining budget.
    for (let page = 1; page < MAX_FOLLOW_PAGES && next; page++) {
      const res = await fetchFollowsPage(selfDid, next);
      if (res.follows.length === 0) break;
      res.follows.forEach((f) => seen.add(f.did));
      await upsertFollows(res.follows, selfDid);
      next = res.cursor;
    }
    await finalizeGraph(seen, onFollowsRemoved); // sets graphComplete
  } catch (e) {
    console.error('[followGraph] backfill failed:', e);
    // Don't strand background scanners waiting on a graph that errored out;
    // let them finish with whatever follows we managed to cache.
    graphComplete = true;
  }
}

/**
 * Refresh the cached follow graph when it's missing or stale: fetch page 1
 * synchronously (so the caller can scan + paint immediately) and kick off the
 * background backfill of the rest. A no-op while the cache is still fresh.
 *
 * `onFollowsRemoved` fires when a walk finds accounts the user no longer
 * follows; their cached rows are already gone by then, so a caller only needs
 * to drop them from whatever it's holding in memory.
 */
export async function ensureFollowGraph(
  selfDid: string,
  opts: { force?: boolean; onFollowsRemoved?: (dids: string[]) => void } = {}
): Promise<void> {
  if (inFlight && !opts.force) return inFlight;
  const run = (async () => {
    const fetchedAt = (await getMetadata<number>(GRAPH_FETCHED_KEY)) ?? 0;
    const count = await db.follows.count();
    // Cache still fresh: the graph is whatever we already have — complete.
    if (!opts.force && count > 0 && Date.now() - fetchedAt < GRAPH_TTL) {
      graphComplete = true;
      return;
    }

    // A new refetch may still grow the follow list, so the graph isn't complete
    // until page 1 lands (no cursor) or the background backfill finishes.
    graphComplete = false;

    const first = await fetchFollowsPage(selfDid);
    // A failed fetch yields []; keep whatever we already cached rather than
    // wiping the graph on a transient network blip.
    if (first.follows.length === 0) {
      graphComplete = true;
      return;
    }

    await upsertFollows(first.follows, selfDid);
    const seen = new Set(first.follows.map((f) => f.did));

    if (first.cursor) {
      // Don't await — let the rest of the graph fill in behind the first paint.
      void backfillGraph(selfDid, first.cursor, seen, opts.onFollowsRemoved);
    } else {
      await finalizeGraph(seen, opts.onFollowsRemoved);
    }
  })();
  inFlight = run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return inFlight;
}

/** Drop the cached graph so the next ensureFollowGraph walks it fresh. Callers
 *  clear their own scan results; this only owns `db.follows` and the TTL. */
export async function resetFollowGraph(): Promise<void> {
  graphComplete = false;
  await db.follows.clear();
  await setMetadata(GRAPH_FETCHED_KEY, 0);
}

/**
 * A follow's PDS endpoint, remembered on their cached row.
 *
 * Resolution is a plc.directory round trip per account, and every scanner wants
 * the same answer for the same DID, so the first one to ask pays for all of
 * them. A migrated account leaves a stale endpoint behind, which reads as an
 * empty scan — so a scanner that fails against the cached PDS calls
 * `forgetFollowPds` and the next pass re-resolves.
 */
export async function pdsForFollow(did: string): Promise<string | null> {
  const cached = await db.follows.get(did);
  if (cached?.pdsUrl) return cached.pdsUrl;
  const pdsUrl = await resolvePdsUrl(did);
  if (pdsUrl && cached) await db.follows.update(did, { pdsUrl });
  return pdsUrl;
}

/** Forget a follow's cached PDS, so the next scan resolves it again. */
export async function forgetFollowPds(did: string): Promise<void> {
  await db.follows.update(did, { pdsUrl: undefined });
}
