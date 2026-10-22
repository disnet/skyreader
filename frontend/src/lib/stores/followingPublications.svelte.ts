import { db, getMetadata, setMetadata, type FollowCacheEntry } from '$lib/services/db';
import {
  ensureFollowGraph,
  expireFollowGraph,
  isFollowGraphComplete,
  resetFollowGraph,
} from '$lib/services/followGraph';
import { scanFollow, type FollowLite } from '$lib/services/socialGraph';
import { findFollowFeeds, sharedHandleParents } from '$lib/services/followSites';
import { fetchAllDocuments, fetchSingleFeed } from '$lib/services/feedFetcher';
import { api, RateLimitError } from '$lib/services/api';
import { auth } from './auth.svelte';
import { articlesStore } from './articles.svelte';
import { subscriptionsStore } from './subscriptions.svelte';
import type { FollowingPublication } from '$lib/types';

/**
 * Discover the writing of the people you follow on Bluesky: standard.site
 * publications on their PDS, and web feeds at their domain handle, the sites
 * on their Sifa profile, or sites linked from their bio. Cached in IndexedDB.
 *
 *  - The follow graph itself is maintained by services/followGraph.ts (shared
 *    with the reading-rooms scan): cached, refetched on its own TTL, with the
 *    first page fetched up front so the section paints fast.
 *  - Each follow's PDS is scanned for publications PAGE_SIZE accounts at a time
 *    ("Show more"), and the results are cached per account. The same pass asks
 *    the backend for feeds at each account's candidate sites
 *    (services/followSites.ts); that lookup is the one part that isn't
 *    client-side, since a browser can't read other sites' pages, and the backend
 *    caches it per site for every reader. A scanned account
 *    isn't re-scanned until SCAN_TTL passes, so repeat visits are instant.
 *
 * Subscribing reuses the normal paths: `atproto.documents` for a publication
 * (mirroring linkblog discovery), an RSS subscription for a web feed.
 */

// Scan this many follows per "Show more" — bounds work for huge follow graphs.
const PAGE_SIZE = 20;
// Re-scan an account's PDS for publications at most once a week.
const SCAN_TTL = 7 * 24 * 60 * 60 * 1000;
// Sites per backend call (the route's cap).
const SITES_PER_CALL = 30;
// A rate-limited site lookup waits and tries again this many times; after that
// its sites go unanswered for this pass (and keep what was found before).
const SITE_RETRIES = 3;
// Set once this device has rescanned its cached follows for web feeds: rows
// scanned before web feeds were looked for (and fetched without bios) would
// otherwise wait out SCAN_TTL.
const FEEDS_SCAN_KEY = 'followFeedsScannedV1';

// Handle parents shared by several follows (hosting providers), memoized on the
// graph's size so a walk of many pages doesn't reread the whole graph per page.
let parentsMemo: { count: number; parents: Set<string> } | null = null;
async function hostingParents(): Promise<Set<string>> {
  const count = await db.follows.count();
  if (parentsMemo?.count !== count) {
    parentsMemo = { count, parents: sharedHandleParents(await db.follows.toArray()) };
  }
  return parentsMemo.parents;
}

// Feeds per site from the backend. Never throws: a site the lookup couldn't
// answer is simply missing, and findFollowFeeds keeps its earlier answer, so a
// failed call never costs the publications scan it rides along with.
async function discoverSites(sites: string[]): Promise<Map<string, string[] | null>> {
  const out = new Map<string, string[] | null>();
  for (let i = 0; i < sites.length; i += SITES_PER_CALL) {
    const chunk = sites.slice(i, i + SITES_PER_CALL);
    for (let attempt = 0; ; attempt++) {
      try {
        const { results } = await api.discoverSites(chunk);
        for (const r of results) out.set(r.site, r.feeds);
        break;
      } catch (e) {
        if (e instanceof RateLimitError && attempt < SITE_RETRIES) {
          await new Promise((r) => setTimeout(r, Math.min(e.retryAfter, 60) * 1000));
          continue;
        }
        console.error('[followingPublications] site lookup failed:', e);
        break;
      }
    }
  }
  return out;
}

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

  // Hidden accounts are never scanned. While the graph is still being walked, a
  // row cached before bios were kept (description undefined) waits for the walk
  // to refresh it, so its bio links aren't missed for a whole SCAN_TTL.
  function scannable(f: FollowCacheEntry): boolean {
    return !f.hidden && (f.description !== undefined || isFollowGraphComplete());
  }

  // Are there follows we haven't scanned (or whose scan has gone stale)?
  // Hidden accounts never count — they're ignored regardless of scan age.
  async function hasUnscanned(): Promise<boolean> {
    return (
      (await db.follows
        .where('scannedAt')
        .below(Date.now() - SCAN_TTL)
        .filter(scannable)
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
      .filter(scannable)
      .limit(PAGE_SIZE)
      .toArray();
    if (batch.length === 0) return;

    const results = await Promise.all(batch.map(scanFollow));
    const found = results.flatMap((r) => r.publications);
    const withLinks = batch.map((b, i) => ({ ...b, sifaLinks: results[i].sifaLinks }));
    const scannedDids = batch.map((b) => b.did);
    const scannedSet = new Set(scannedDids);
    // A feed someone else we follow already brought in (two people linking the
    // same newsletter) stays theirs: the table is keyed by feed URL.
    const elsewhere = new Set(
      publications.filter((p) => !scannedSet.has(p.did)).map((p) => p.publicationUri)
    );
    const prior = publications.filter((p) => p.kind === 'feed' && scannedSet.has(p.did));
    const feeds = (
      await findFollowFeeds(withLinks, found, await hostingParents(), discoverSites, prior)
    ).filter((f) => !elsewhere.has(f.publicationUri));
    const fresh = [...found, ...feeds];
    const now = Date.now();

    await db.transaction('rw', db.follows, db.followingPublications, async () => {
      // Replace any prior publications for these accounts (a re-scan may have
      // found new ones, or that the account deleted a publication).
      await db.followingPublications.where('did').anyOf(scannedDids).delete();
      if (fresh.length) await db.followingPublications.bulkPut(fresh);
      // Only the stamp: the graph walk may have refreshed these rows meanwhile.
      await db.follows.where('did').anyOf(scannedDids).modify({ scannedAt: now });
    });

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
      parentsMemo = null;
      // Once per device: rescan follows cached before web feeds were looked
      // for, and refetch the graph so every row carries its bio.
      if (!(await getMetadata<boolean>(FEEDS_SCAN_KEY))) {
        await db.follows.toCollection().modify({ scannedAt: 0 });
        await expireFollowGraph();
        await setMetadata(FEEDS_SCAN_KEY, true);
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

    const { publications: found, sifaLinks } = await scanFollow(follow);
    // A feed another account we follow already brought in stays theirs.
    const elsewhere = new Set(
      publications.filter((p) => p.did !== did).map((p) => p.publicationUri)
    );
    const feeds = (
      await findFollowFeeds(
        [{ ...follow, sifaLinks }],
        found,
        await hostingParents(),
        discoverSites
      )
    ).filter((f) => !elsewhere.has(f.publicationUri));
    const fresh = [...found, ...feeds];
    await db.transaction('rw', db.follows, db.followingPublications, async () => {
      await db.follows.update(did, { hidden: false, scannedAt: Date.now() });
      if (fresh.length) await db.followingPublications.bulkPut(fresh);
    });
    publications = [...publications.filter((p) => p.did !== did), ...fresh];
  }

  // Subscribe to a publication: an `atproto.documents` stream scoped to it, with
  // the publication's icon (or the owner's avatar) carried over as the source icon.
  // A web feed is an ordinary RSS subscription, retitled from the feed once fetched.
  async function subscribe(pub: FollowingPublication): Promise<void> {
    if (pub.kind === 'feed') {
      const id = await subscriptionsStore.add(pub.publicationUri, pub.name, { siteUrl: pub.url });
      const sub = subscriptionsStore.getById(id);
      if (sub) {
        void fetchSingleFeed(sub, true, articlesStore.savedGuids).then(async (result) => {
          if (!result.success || !result.title) return;
          try {
            await subscriptionsStore.update(id, {
              title: result.title,
              siteUrl: result.siteUrl ?? pub.url,
            });
          } catch {
            // Keep the site's name as the title.
          }
        });
      }
      return;
    }
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
