import { db, getMetadata, setMetadata } from '$lib/services/db';
import { fetchFollowsPage, scanPublications, type FollowLite } from '$lib/services/socialGraph';
import { auth } from './auth.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import type { FollowingPublication } from '$lib/types';

/**
 * Discover standard.site publications from the people you follow on Bluesky —
 * entirely client-side, cached in IndexedDB.
 *
 *  - The follow graph (app.bsky.graph.getFollows) is cached and refetched only
 *    after GRAPH_TTL. On a cold cache the first page is fetched up front so the
 *    section paints fast, then the rest of the graph backfills in the background.
 *  - Each follow's PDS is scanned for publications PAGE_SIZE accounts at a time
 *    ("Show more"), and the results are cached per account. A scanned account
 *    isn't re-scanned until SCAN_TTL passes, so repeat visits are instant.
 *
 * Subscribing reuses the normal `atproto.documents` subscription path, mirroring
 * linkblog discovery.
 */

// Scan this many follows per "Show more" — bounds work for huge follow graphs.
const PAGE_SIZE = 20;
// Cap the follow graph at 30 pages (~3000 follows) so it can't run unbounded.
const MAX_FOLLOW_PAGES = 30;
// Refetch the follow graph at most once a day.
const GRAPH_TTL = 24 * 60 * 60 * 1000;
// Re-scan an account's PDS for publications at most once a week.
const SCAN_TTL = 7 * 24 * 60 * 60 * 1000;
const GRAPH_FETCHED_KEY = 'followsGraphFetchedAt';

function createFollowingPublicationsStore() {
  let publications = $state<FollowingPublication[]>([]);
  let hiddenAccounts = $state<FollowLite[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  // `scanning` is true while the background pass is still walking the follow
  // graph and scanning PDSes; the UI shows a quiet "finding more" hint.
  let scanning = $state(false);
  let error = $state<string | null>(null);

  // True once the whole follow graph has been fetched (no more follows will
  // appear). The background scan waits on this before declaring itself done.
  let graphComplete = false;
  // Bumped on every load() so an in-flight background scan from a prior load
  // (or before a force-refresh) bows out instead of writing stale results.
  let scanToken = 0;

  // Refresh the in-memory list of accounts the user has hidden from discovery.
  async function loadHidden(): Promise<void> {
    const rows = await db.follows.filter((f) => !!f.hidden).toArray();
    hiddenAccounts = rows.map((f) => ({
      did: f.did,
      handle: f.handle,
      displayName: f.displayName,
      avatar: f.avatar,
    }));
  }

  // Upsert a batch of follows, preserving the last-scanned timestamp and the
  // "hidden" flag of any we already cached (a fresh row defaults to scannedAt=0,
  // not hidden). Excludes self.
  async function upsertFollows(follows: FollowLite[], selfDid: string): Promise<void> {
    const incoming = follows.filter((f) => f.did !== selfDid);
    if (incoming.length === 0) return;
    const existing = await db.follows.bulkGet(incoming.map((f) => f.did));
    const prior = new Map(existing.filter(Boolean).map((f) => [f!.did, f!]));
    await db.follows.bulkPut(
      incoming.map((f) => ({
        ...f,
        scannedAt: prior.get(f.did)?.scannedAt ?? 0,
        hidden: prior.get(f.did)?.hidden,
      }))
    );
  }

  // Once the whole graph has been walked, prune accounts the user no longer
  // follows (and their cached publications), then stamp the graph as fresh.
  async function finalizeGraph(seen: Set<string>): Promise<void> {
    const cached = (await db.follows.toCollection().primaryKeys()) as string[];
    const removed = cached.filter((d) => !seen.has(d));
    if (removed.length) {
      await db.transaction('rw', db.follows, db.followingPublications, async () => {
        await db.follows.bulkDelete(removed);
        await db.followingPublications.where('did').anyOf(removed).delete();
      });
      const removedSet = new Set(removed);
      publications = publications.filter((p) => !removedSet.has(p.did));
    }
    await setMetadata(GRAPH_FETCHED_KEY, Date.now());
    graphComplete = true;
  }

  // Walk the remaining follow pages in the background, caching each as it
  // arrives so newly-available accounts become scannable without blocking the
  // first paint. Best-effort: a failed page just ends the backfill early.
  async function backfillGraph(selfDid: string, cursor: string, seen: Set<string>): Promise<void> {
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
      await finalizeGraph(seen); // sets graphComplete
    } catch (e) {
      console.error('[followingPublications] graph backfill failed:', e);
      // Don't strand the background scan waiting on a graph that errored out;
      // let it finish with whatever follows we managed to cache.
      graphComplete = true;
    }
  }

  // Refresh the cached follow graph when it's missing or stale: fetch page 1
  // synchronously (so the caller can scan + paint immediately) and kick off the
  // background backfill of the rest. A no-op while the cache is still fresh.
  async function ensureGraph(force: boolean): Promise<void> {
    const did = auth.user?.did;
    if (!did) throw new Error('Not signed in');

    const fetchedAt = (await getMetadata<number>(GRAPH_FETCHED_KEY)) ?? 0;
    const count = await db.follows.count();
    // Cache still fresh: the graph is whatever we already have — complete.
    if (!force && count > 0 && Date.now() - fetchedAt < GRAPH_TTL) {
      graphComplete = true;
      return;
    }

    // A new refetch may still grow the follow list, so the graph isn't complete
    // until page 1 lands (no cursor) or the background backfill finishes.
    graphComplete = false;

    const first = await fetchFollowsPage(did);
    // A failed fetch yields []; keep whatever we already cached rather than
    // wiping the graph on a transient network blip.
    if (first.follows.length === 0) {
      graphComplete = true;
      return;
    }

    await upsertFollows(first.follows, did);
    const seen = new Set(first.follows.map((f) => f.did));

    if (first.cursor) {
      // Don't await — let the rest of the graph fill in behind the first paint.
      void backfillGraph(did, first.cursor, seen);
    } else {
      await finalizeGraph(seen);
    }
  }

  // Are there follows we haven't scanned (or whose scan has gone stale)?
  // Hidden accounts never count — they're ignored regardless of scan age.
  async function hasUnscanned(): Promise<boolean> {
    return (
      (await db.follows
        .where('scannedAt')
        .below(Date.now() - SCAN_TTL)
        .filter((f) => !f.hidden)
        .count()) > 0
    );
  }

  // Scan the next PAGE_SIZE unscanned/stale follows: list each one's PDS in
  // parallel, refresh their cached publications, and mark them scanned. Hidden
  // accounts are skipped.
  async function scanPage(): Promise<void> {
    const cutoff = Date.now() - SCAN_TTL;
    const batch = await db.follows
      .where('scannedAt')
      .below(cutoff)
      .filter((f) => !f.hidden)
      .limit(PAGE_SIZE)
      .toArray();
    if (batch.length === 0) return;

    const results = await Promise.all(batch.map(scanPublications));
    const fresh = results.flat();
    const scannedDids = batch.map((b) => b.did);
    const now = Date.now();

    await db.transaction('rw', db.follows, db.followingPublications, async () => {
      // Replace any prior publications for these accounts (a re-scan may have
      // found new ones, or that the account deleted a publication).
      await db.followingPublications.where('did').anyOf(scannedDids).delete();
      if (fresh.length) await db.followingPublications.bulkPut(fresh);
      await db.follows.bulkPut(batch.map((b) => ({ ...b, scannedAt: now })));
    });

    const scannedSet = new Set(scannedDids);
    publications = [...publications.filter((p) => !scannedSet.has(p.did)), ...fresh];
  }

  // First load: show cached publications immediately, scan the first page inline
  // on a cold cache so the section isn't empty, then walk the rest of the follow
  // graph in the background so search + counts can cover everything.
  async function load(force = false): Promise<void> {
    if (loading || (loaded && !force)) return;
    loading = true;
    error = null;
    const token = ++scanToken;
    try {
      if (force) {
        await db.followingPublications.clear();
        await db.follows.clear();
        await setMetadata(GRAPH_FETCHED_KEY, 0);
        publications = [];
        loaded = false;
      }
      await ensureGraph(force);
      publications = await db.followingPublications.toArray();
      if (publications.length === 0) await scanPage();
      await loadHidden();
      loaded = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load publications';
    } finally {
      loading = false;
    }
    // Behind the first paint, scan every remaining follow into the cache.
    void scanAll(token);
  }

  // Background pass: keep scanning batches until the whole (possibly still
  // backfilling) follow graph is scanned, refreshing `publications` as each
  // batch lands. A newer load() bumps scanToken so this pass bows out instead
  // of writing stale results; a failed batch ends the pass rather than spin.
  let scanRun: Promise<void> | null = null;
  async function scanAll(token: number): Promise<void> {
    // Let any prior pass notice the token bump and unwind before starting.
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
          // Nothing left to scan and the graph is fully fetched — done.
          if (graphComplete) break;
          // Graph still backfilling more follows; wait, then re-check.
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch (e) {
        console.error('[followingPublications] background scan failed:', e);
      } finally {
        if (token === scanToken) scanning = false;
        scanRun = null;
      }
    })();
    await scanRun;
  }

  // Ignore an account in discovery: flag it hidden (so it's never scanned or
  // counted again, even after SCAN_TTL) and drop its cached + displayed
  // publications. The flag survives graph refetches via upsertFollows.
  async function hide(did: string): Promise<void> {
    const sample = publications.find((p) => p.did === did);
    await db.transaction('rw', db.follows, db.followingPublications, async () => {
      await db.follows.where('did').equals(did).modify({ hidden: true });
      await db.followingPublications.where('did').equals(did).delete();
    });
    publications = publications.filter((p) => p.did !== did);
    if (sample) {
      const entry: FollowLite = {
        did,
        handle: sample.handle,
        displayName: sample.displayName,
        avatar: sample.avatar,
      };
      hiddenAccounts = [entry, ...hiddenAccounts.filter((a) => a.did !== did)];
    } else {
      await loadHidden();
    }
  }

  // Un-ignore an account: clear the flag and re-scan its PDS immediately so its
  // publications reappear (they were dropped when it was hidden).
  async function unhide(did: string): Promise<void> {
    const follow = await db.follows.get(did);
    hiddenAccounts = hiddenAccounts.filter((a) => a.did !== did);
    if (!follow) return;

    const fresh = await scanPublications({
      did: follow.did,
      handle: follow.handle,
      displayName: follow.displayName,
      avatar: follow.avatar,
    });
    await db.transaction('rw', db.follows, db.followingPublications, async () => {
      await db.follows.update(did, { hidden: false, scannedAt: Date.now() });
      if (fresh.length) await db.followingPublications.bulkPut(fresh);
    });
    publications = [...publications.filter((p) => p.did !== did), ...fresh];
  }

  // Subscribe to a publication: an `atproto.documents` stream scoped to it, with
  // the publication's icon (or the owner's avatar) carried over as the source icon.
  async function subscribe(pub: FollowingPublication): Promise<void> {
    const owner = pub.displayName?.trim() || (pub.handle ? `@${pub.handle}` : 'Publication');
    const title = pub.name?.trim() || owner;
    const id = await subscriptionsStore.add(pub.publicationUri, title, {
      sourceType: 'atproto.documents',
      subjectDid: pub.did,
      feedUrl: pub.publicationUri,
      siteUrl: pub.url || undefined,
    });
    const icon = pub.iconUrl || pub.avatar;
    if (icon) {
      await subscriptionsStore.updateLocal(id, { customIconUrl: icon });
    }
  }

  return {
    get publications() {
      return publications;
    },
    get loaded() {
      return loaded;
    },
    get loading() {
      return loading;
    },
    get scanning() {
      return scanning;
    },
    get error() {
      return error;
    },
    get hiddenAccounts() {
      return hiddenAccounts;
    },
    load,
    subscribe,
    hide,
    unhide,
  };
}

export const followingPublicationsStore = createFollowingPublicationsStore();
