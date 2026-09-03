import { db } from '$lib/services/db';
import type { FollowedRoomEntry } from '$lib/services/db';
import {
  ensureFollowGraph,
  isFollowGraphComplete,
  resetFollowGraph,
} from '$lib/services/followGraph';
import { aggregateFollowedRooms, scanReadAlongs, type FollowedRoom } from '$lib/services/rooms';
import { auth } from './auth.svelte';

/**
 * Reading rooms the people you follow on Bluesky have joined.
 *
 * The same shape as /discover's publication scan, pointed at a different NSID:
 * walk the cached follow graph, list each account's own
 * app.skyreader.reading.readAlong records off their PDS, cache what we find.
 * Entirely client-side, so this stays clear of the deferred rooms directory
 * (which would need a Jetstream index of the join NSID) while still answering
 * the question a reader actually has: where is everyone I follow reading?
 *
 * Cached in IndexedDB per account, so a repeat visit paints from cache and only
 * rescans accounts whose scan has gone stale.
 * See docs/plans/READING_ROOMS_SPIKE.md.
 */

// Scan this many follows per batch — bounds work for huge follow graphs.
const PAGE_SIZE = 20;
// Re-scan an account's PDS for rooms at most once every three days. Shorter
// than the publication scan's week: joining a room is a far more frequent act
// than starting a publication, and a stale room list is the whole signal here.
const SCAN_TTL = 3 * 24 * 60 * 60 * 1000;

function createFollowingRoomsStore() {
  let entries = $state<FollowedRoomEntry[]>([]);
  let loading = $state(false);
  // True while the background pass is still walking the graph; the UI shows a
  // quiet "still looking" hint rather than an empty section.
  let scanning = $state(false);
  let loaded = $state(false);
  let error = $state<string | null>(null);

  const rooms = $derived(aggregateFollowedRooms(entries));

  // Bumped on every load() so an in-flight background pass from a prior load
  // (or a different account) bows out instead of writing stale results.
  let scanToken = 0;
  let loadedForDid: string | null = null;

  function replaceScanned(dids: string[], fresh: FollowedRoomEntry[]): void {
    const scanned = new Set(dids);
    entries = [...entries.filter((e) => !scanned.has(e.did)), ...fresh];
  }

  // Are there follows we haven't scanned for rooms (or whose scan has gone
  // stale)? Accounts hidden from discovery never count.
  async function hasUnscanned(): Promise<boolean> {
    const cutoff = Date.now() - SCAN_TTL;
    const stale = await db.follows
      .filter((f) => !f.hidden && (f.roomsScannedAt ?? 0) < cutoff)
      .limit(1)
      .toArray();
    return stale.length > 0;
  }

  // Scan the next PAGE_SIZE stale follows in parallel, replace their cached
  // rooms, and stamp them scanned.
  async function scanPage(): Promise<void> {
    const cutoff = Date.now() - SCAN_TTL;
    const batch = await db.follows
      .filter((f) => !f.hidden && (f.roomsScannedAt ?? 0) < cutoff)
      .limit(PAGE_SIZE)
      .toArray();
    if (batch.length === 0) return;

    const fresh = (await Promise.all(batch.map(scanReadAlongs))).flat();
    const dids = batch.map((b) => b.did);
    const now = Date.now();

    await db.transaction('rw', db.follows, db.followingRooms, async () => {
      // Replace, don't merge: a re-scan is also how a room someone left
      // disappears from here.
      await db.followingRooms.where('did').anyOf(dids).delete();
      if (fresh.length) await db.followingRooms.bulkPut(fresh);
      await db.follows.bulkPut(batch.map((b) => ({ ...b, roomsScannedAt: now })));
    });

    replaceScanned(dids, fresh);
  }

  // Background pass: keep scanning batches until the whole (possibly still
  // backfilling) follow graph has been walked, refreshing the list as each
  // batch lands. A newer load() bumps scanToken so this pass bows out; a failed
  // batch ends the pass rather than spin.
  let scanRun: Promise<void> | null = null;
  async function scanAll(token: number): Promise<void> {
    while (scanRun) {
      await scanRun;
      if (token !== scanToken) return;
    }
    scanning = true;
    scanRun = (async () => {
      try {
        while (token === scanToken) {
          if (await hasUnscanned()) {
            await scanPage();
            continue;
          }
          if (isFollowGraphComplete()) break;
          // Graph still backfilling more follows; wait, then re-check.
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch (e) {
        console.error('[followingRooms] background scan failed:', e);
      } finally {
        if (token === scanToken) scanning = false;
        scanRun = null;
      }
    })();
    await scanRun;
  }

  /** Show the cache immediately, scan one batch inline on a cold cache so the
   *  section isn't empty, then walk the rest of the graph behind the paint. */
  async function load(force = false): Promise<void> {
    const user = auth.user;
    if (!user) return;
    if (loading) return;
    if (loaded && !force && loadedForDid === user.did) return;
    // Never show one account's discoveries to the next.
    if (loadedForDid !== user.did) entries = [];

    loading = true;
    error = null;
    const token = ++scanToken;
    try {
      if (force) {
        await db.followingRooms.clear();
        await resetFollowGraph();
        entries = [];
        loaded = false;
      }
      await ensureFollowGraph(user.did, {
        onFollowsRemoved: (dids) => {
          const gone = new Set(dids);
          entries = entries.filter((e) => !gone.has(e.did));
        },
      });
      entries = await db.followingRooms.toArray();
      if (entries.length === 0) await scanPage();
      loaded = true;
      loadedForDid = user.did;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load rooms';
    } finally {
      loading = false;
    }
    void scanAll(token);
  }

  return {
    get rooms() {
      return rooms;
    },
    get loading() {
      return loading;
    },
    get scanning() {
      return scanning;
    },
    get loaded() {
      return loaded;
    },
    get error() {
      return error;
    },
    load,
  };
}

export const followingRoomsStore = createFollowingRoomsStore();
export type { FollowedRoom };
