import { api } from '$lib/services/api';
import { urlKey } from '$lib/utils/urlKey';
import { auth } from './auth.svelte';
import type { AllFollowLinksPage, FollowLink } from '$lib/types';

// From your follows: the links people you follow share on Bluesky, grouped by
// article. The week's most shared back every surface: the follows source in the
// river (any channel that names it), the "shared by" line on river cards for
// articles your follows also shared, and Home's lane. A reader who turned on
// every link gets a second list for the river alone: every link, newest by
// first share, paged from GET /all as the river scrolls. The ranked list never
// changes order with the setting, so Home reads it as is.
// See docs/plans/FOLLOWS_LINKS_PLAN.md.
//
// Always the week: the retention window, and what the river and the lane both
// show. The server answers from D1 at once and refreshes the timeline behind the
// response (at most every 10 minutes). When a response says it started a
// refresh, this store asks again a few seconds later to pick up what it found,
// and keeps asking while a reader's first refresh is still gathering.
//
// Read state isn't here: a link is read the way everything else in the river
// is, through an item label (see followLinkReadKey).

/** How long to wait before asking again after a response started a refresh. */
const FOLLOW_UP_MS = 4000;
/** A first refresh walks up to 20 timeline pages (~10s); give it room. */
const MAX_FOLLOW_UPS = 6;
/** How long a loaded answer is reused before a visit asks again. An installed
 *  PWA stays open for days; the server's own 10-minute gate decides whether
 *  asking also refreshes from the timeline, so this only bounds staleness. */
const STALE_MS = 5 * 60 * 1000;

function createFollowLinksStore() {
  let links = $state<FollowLink[]>([]);
  let loaded = $state(false);
  let loading = $state(false);
  let scopeRequired = $state(false);
  let inEverything = $state<boolean | null>(null);
  let allLinks = $state(false);
  let complete = $state(false);
  let refreshing = $state(false);
  let error = $state<string | null>(null);
  // Every link, for the river: the pages loaded so far, null until the first
  // arrives (the river shows the ranked list till then), and where the next starts.
  let allPages = $state<FollowLink[] | null>(null);
  let nextCursor = $state<string | null>(null);
  let loadingMore = $state(false);
  let moreInFlight: Promise<void> | null = null;
  /** Bumped by a settings change; an answer asked for before it says the old values. */
  let settingsEpoch = 0;
  let loadedAt = 0;
  let loadedDid: string | null = null;
  /** Bumped by every load; a response or follow-up from an older one is dropped. */
  let seq = 0;
  /** The newest load; an older one it superseded waits on it before returning. */
  let latestLoad: Promise<void> | null = null;
  let followUp: ReturnType<typeof setTimeout> | null = null;
  let followUps = 0;

  // Every form a river item's URL might match a link under: the posted URL
  // (tracking and all) and the server's normalized one, both canonicalized.
  let byUrlKey = $derived.by(() => {
    const map = new Map<string, FollowLink>();
    for (const link of allPages ? [...links, ...allPages] : links) {
      for (const url of [link.url, link.urlNormalized]) {
        const key = urlKey(url);
        if (key && !map.has(key)) map.set(key, link);
      }
    }
    return map;
  });

  function clearFollowUp() {
    if (followUp) clearTimeout(followUp);
    followUp = null;
  }

  /** a came before b, in the order /all pages: older by first share, then lower URL. */
  function olderThan(a: FollowLink, b: FollowLink): boolean {
    return (
      a.firstSharedAt < b.firstSharedAt ||
      (a.firstSharedAt === b.firstSharedAt && a.urlNormalized < b.urlNormalized)
    );
  }

  /** A fresh first page. Pages already loaded past it are kept, with their cursor,
   *  so a refresh doesn't snap a river scrolled deep back to page one. */
  function takeFirstPage(page: AllFollowLinksPage) {
    const prior = allPages;
    const last = page.links.at(-1);
    if (prior && last && page.nextCursor && prior.length > page.links.length) {
      const fresh = new Set(page.links.map((l) => l.urlNormalized));
      const older = prior.filter((l) => !fresh.has(l.urlNormalized) && olderThan(l, last));
      allPages = [...page.links, ...older];
    } else {
      allPages = page.links;
      nextCursor = page.nextCursor;
    }
  }

  async function fetchOnce(token: number, did: string): Promise<void> {
    const epoch = settingsEpoch;
    // Already known to want every link: ask for both at once.
    const [res, firstPage] = await Promise.all([
      api.getFollowLinks('7d'),
      allLinks ? api.getAllFollowLinks().catch(() => null) : null,
    ]);
    // A newer load (another account, a forced re-ask) superseded this.
    if (token !== seq || auth.user?.did !== did) return;

    scopeRequired = res.scopeRequired;
    // A setting changed while this was in flight; this answer predates it.
    if (epoch === settingsEpoch) {
      inEverything = res.inEverything ?? null;
      allLinks = res.allLinks ?? false;
    }
    links = res.links;
    loaded = true;
    complete = res.sync?.complete ?? false;
    refreshing = res.sync?.refreshing ?? false;
    error = res.sync?.error ?? null;

    clearFollowUp();
    if (!res.scopeRequired && (refreshing || !complete) && followUps < MAX_FOLLOW_UPS) {
      followUps++;
      followUp = setTimeout(() => {
        followUp = null;
        void fetchOnce(token, did).catch(() => {});
      }, FOLLOW_UP_MS);
    } else if (!complete) {
      // Gave up waiting on a first refresh; stop showing it as in progress.
      refreshing = false;
    }

    if (!allLinks || scopeRequired) {
      allPages = null;
      nextCursor = null;
      return;
    }
    // Couldn't get it (or didn't know to ask): the river shows the ranked list meanwhile.
    const page = firstPage ?? (await api.getAllFollowLinks().catch(() => null));
    if (token !== seq || auth.user?.did !== did || !allLinks) return;
    if (page && !page.scopeRequired) takeFirstPage(page);
  }

  /** The river's next page of every link. One at a time; a failure leaves the
   *  cursor, so the next scroll asks again. */
  function loadMoreLinks(): Promise<void> {
    if (moreInFlight) return moreInFlight;
    const cursor = nextCursor;
    if (!allLinks || !allPages || !cursor) return Promise.resolve();
    const token = seq;
    const did = loadedDid;
    loadingMore = true;
    moreInFlight = (async () => {
      try {
        const page = await api.getAllFollowLinks(cursor);
        // Superseded by a load, or a fresh first page replaced what this extends.
        if (token !== seq || auth.user?.did !== did || nextCursor !== cursor || !allPages) return;
        const have = new Set(allPages.map((l) => l.urlNormalized));
        allPages = [...allPages, ...page.links.filter((l) => !have.has(l.urlNormalized))];
        nextCursor = page.nextCursor;
      } catch {
        // Kept the cursor; asked again on the next scroll.
      } finally {
        loadingMore = false;
        moreInFlight = null;
      }
    })();
    return moreInFlight;
  }

  /** Every page, for a river that can't show any until it has all of them
   *  (oldest first, most shared first) or that marks them all read. */
  async function loadEveryLink(): Promise<void> {
    while (allLinks && allPages && nextCursor) {
      const before = nextCursor;
      await loadMoreLinks();
      if (nextCursor === before) return; // Failed; don't spin.
    }
  }

  /** Load for the signed-in account. An answer is reused for a few minutes
   *  unless `force`, and a "no permission" answer for the rest of the session:
   *  granting it goes through the account provider and reloads the app. */
  async function load(force = false): Promise<void> {
    const user = auth.user;
    if (!user || auth.isGuest) return;
    if (loadedDid === user.did && !force) {
      if (scopeRequired) return;
      if (Date.now() - loadedAt < STALE_MS) return;
    }

    if (loadedDid !== user.did) {
      // Never show another account's links, permission ask or error.
      links = [];
      loaded = false;
      scopeRequired = false;
      inEverything = null;
      allLinks = false;
      allPages = null;
      nextCursor = null;
      complete = false;
      refreshing = false;
      error = null;
      loadedDid = user.did;
    }

    const token = ++seq;
    clearFollowUp();
    loadedAt = Date.now();
    followUps = 0;
    loading = true;
    const promise = (async () => {
      try {
        await fetchOnce(token, user.did);
      } catch (err) {
        if (token !== seq) return;
        loadedAt = 0;
        error = err instanceof Error ? err.message : 'Could not load';
      } finally {
        // Only the latest load owns the flag.
        if (token === seq) loading = false;
      }
    })();
    latestLoad = promise;
    await promise;
    // Superseded: its answer was dropped, so wait for the one that replaced it.
    // Otherwise a caller would resolve still reading "not loaded".
    while (latestLoad && latestLoad !== promise && token !== seq) {
      const newer: Promise<void> = latestLoad;
      await newer;
      if (latestLoad === newer) break;
    }
  }

  /** Show follows links in Everything, or not. Applied at once; saved for the
   *  account, so the first-run question is asked once, not once per device. */
  async function setInEverything(on: boolean): Promise<void> {
    settingsEpoch++;
    const prior = inEverything;
    inEverything = on;
    try {
      await api.setFollowLinksSettings({ inEverything: on });
    } catch (err) {
      inEverything = prior;
      throw err;
    }
  }

  /** Whether the river shows every link your follows shared, newest first, or
   *  (the default) the week's most shared. Saved for the account; the lists are
   *  asked for again at once. Home's lane is the most shared either way. */
  async function setAllLinks(on: boolean): Promise<void> {
    settingsEpoch++;
    const prior = allLinks;
    allLinks = on;
    try {
      await api.setFollowLinksSettings({ allLinks: on });
    } catch (err) {
      allLinks = prior;
      throw err;
    }
    if (!on) {
      allPages = null;
      nextCursor = null;
    }
    await load(true);
  }

  /** The link your follows shared at this URL, if any, in whatever form. */
  function forUrl(url: string | null | undefined): FollowLink | undefined {
    if (!url) return undefined;
    const key = urlKey(url);
    return key ? byUrlKey.get(key) : undefined;
  }

  return {
    /** The week's most shared, ranked: Home's lane, and the river by default. */
    get links() {
      return links;
    },
    /** What the river shows: every link loaded so far, newest by first share,
     *  when the reader turned that on; otherwise the most shared. */
    get riverLinks() {
      return allLinks && allPages ? allPages : links;
    },
    /** Another page of every link waits beyond riverLinks. */
    get moreRiverLinks() {
      return allLinks && allPages !== null && nextCursor !== null;
    },
    get loadingMore() {
      return loadingMore;
    },
    /** An answer has arrived for this account (with or without the permission). */
    get loaded() {
      return loaded;
    },
    get loading() {
      return loading;
    },
    get scopeRequired() {
      return scopeRequired;
    },
    /** Whether they show in Everything; null until the reader has been asked. */
    get inEverything() {
      return inEverything;
    },
    /** The river shows every link, newest first, rather than the week's most shared. */
    get allLinks() {
      return allLinks;
    },
    /** A first refresh is still walking the timeline. */
    get gathering() {
      return !scopeRequired && !complete && (refreshing || loading);
    },
    get refreshing() {
      return refreshing;
    },
    get complete() {
      return complete;
    },
    get error() {
      return error;
    },
    load,
    setInEverything,
    setAllLinks,
    loadMoreLinks,
    loadEveryLink,
    forUrl,
  };
}

export const followLinksStore = createFollowLinksStore();
