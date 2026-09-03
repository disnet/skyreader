import { db } from '$lib/services/db';
import {
  ensureFollowGraph,
  isFollowGraphComplete,
  resetFollowGraph,
} from '$lib/services/followGraph';
import { scanPublications, type FollowLite } from '$lib/services/socialGraph';
import { fetchAllDocuments } from '$lib/services/feedFetcher';
import { auth } from './auth.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import type { FollowingPublication } from '$lib/types';

/**
 * Discover standard.site publications from the people you follow on Bluesky —
 * entirely client-side, cached in IndexedDB.
 *
 *  - The follow graph itself is maintained by services/followGraph.ts (shared
 *    with the reading-rooms scan): cached, refetched on its own TTL, with the
 *    first page fetched up front so the section paints fast.
 *  - Each follow's PDS is scanned for publications PAGE_SIZE accounts at a time
 *    ("Show more"), and the results are cached per account. A scanned account
 *    isn't re-scanned until SCAN_TTL passes, so repeat visits are instant.
 *
 * Subscribing reuses the normal `atproto.documents` subscription path, mirroring
 * linkblog discovery.
 */

// Scan this many follows per "Show more" — bounds work for huge follow graphs.
const PAGE_SIZE = 20;
// Re-scan an account's PDS for publications at most once a week.
const SCAN_TTL = 7 * 24 * 60 * 60 * 1000;

function createFollowingPublicationsStore() {
  let publications = $state<FollowingPublication[]>([]);
  let hiddenAccounts = $state<FollowLite[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  // `scanning` is true while the background pass is still walking the follow
  // graph and scanning PDSes; the UI shows a quiet "finding more" hint.
  let scanning = $state(false);
  let error = $state<string | null>(null);

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

  // Refresh the cached follow graph (shared with the reading-rooms scan), and
  // drop any publication we're showing for an account the walk found the user
  // no longer follows. Their cached rows are already gone by then.
  async function ensureGraph(force: boolean): Promise<void> {
    const did = auth.user?.did;
    if (!did) throw new Error('Not signed in');
    await ensureFollowGraph(did, {
      force,
      onFollowsRemoved: (dids) => {
        const removed = new Set(dids);
        publications = publications.filter((p) => !removed.has(p.did));
      },
    });
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
        await resetFollowGraph();
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
          if (isFollowGraphComplete()) break;
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
    // Fetch this publication's documents now so its feed isn't empty until the
    // next full refresh (also refreshed on the regular cycle).
    void fetchAllDocuments(subscriptionsStore.subscriptions);
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
