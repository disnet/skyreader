import { api } from '$lib/services/api';
import { urlKey } from '$lib/utils/urlKey';
import { compareCodePoints } from '$lib/utils/compareCodePoints';
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
/** The most one /all page may hold: what walks over every page ask for. */
const MAX_PAGE = 100;
/** A failed page waits this long before the next try, doubling to the cap. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60 * 1000;
/** Failed pages in a row before a walk over every page gives up for now. */
const EVERY_LINK_PATIENCE = 4;

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
  // After a page fails, the next waits out a backoff: the infinite-scroll
  // sentinel asks again as soon as loading ends, so without one an outage would
  // be a tight loop of failing requests. The river reads it as still loading.
  let moreFailures = 0;
  let backingOff = $state(false);
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffDone: Promise<void> | null = null;
  let endBackoff: (() => void) | null = null;
  /** Bumped by every fresh first page, so a walk over every page that gave up starts again. */
  let riverEpoch = $state(0);
  /** Bumped when a settings change starts and when it settles; an answer asked
   *  for before either says the old values. */
  let settingsEpoch = 0;
  /** Settings changes not yet saved; no answer overrides one meanwhile. */
  let settingsInFlight = 0;
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

  /** Ends a backoff now, releasing anything waiting on it. */
  function clearBackoff() {
    if (backoffTimer) clearTimeout(backoffTimer);
    backoffTimer = null;
    endBackoff?.();
    moreFailures = 0;
  }

  function startBackoff() {
    moreFailures++;
    const ms = Math.min(RETRY_BASE_MS * 2 ** (moreFailures - 1), RETRY_MAX_MS);
    backingOff = true;
    backoffDone = new Promise((resolve) => {
      endBackoff = () => {
        endBackoff = null;
        backoffDone = null;
        backingOff = false;
        resolve();
      };
    });
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      endBackoff?.();
    }, ms);
  }

  /** a came before b, in the order /all pages: older by first share, then lower
   *  URL in code point order (SQLite's, which `<` on UTF-16 isn't). */
  function olderThan(a: FollowLink, b: FollowLink): boolean {
    return (
      a.firstSharedAt < b.firstSharedAt ||
      (a.firstSharedAt === b.firstSharedAt &&
        compareCodePoints(a.urlNormalized, b.urlNormalized) < 0)
    );
  }

  function appendNew(list: FollowLink[], more: FollowLink[]): FollowLink[] {
    const have = new Set(list.map((l) => l.urlNormalized));
    return [...list, ...more.filter((l) => !have.has(l.urlNormalized))];
  }

  /** A fresh first page. A river already scrolled past it is re-read down to the
   *  depth it reached, so a refresh doesn't snap it back to page one, and a link
   *  that landed between pages (a backdated share) isn't skipped. If a page of
   *  that fails, the river keeps what was re-read and pages the rest in on scroll. */
  async function takeFirstPage(page: AllFollowLinksPage, token: number, did: string) {
    const deepest = allPages && allPages.length > page.links.length ? allPages.at(-1) : undefined;
    let list = page.links;
    let cursor = page.nextCursor;
    while (deepest && cursor && list.length > 0 && olderThan(deepest, list[list.length - 1])) {
      const next = await api.getAllFollowLinks(cursor, MAX_PAGE).catch(() => null);
      if (token !== seq || auth.user?.did !== did || !allLinks) return;
      if (!next || next.scopeRequired) break;
      list = appendNew(list, next.links);
      cursor = next.nextCursor;
    }
    allPages = list;
    nextCursor = cursor;
    riverEpoch++;
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
    // A setting changed while this was in flight, or is still saving: this
    // answer may predate it.
    if (epoch === settingsEpoch && settingsInFlight === 0) {
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
    if (page && !page.scopeRequired) await takeFirstPage(page, token, did);
  }

  /** The river's next page of every link. One at a time; a failure leaves the
   *  cursor and backs off, and the next scroll after that asks again. */
  function loadMoreLinks(limit?: number): Promise<void> {
    if (moreInFlight) return moreInFlight;
    const cursor = nextCursor;
    if (!allLinks || !allPages || !cursor || backingOff) return Promise.resolve();
    const token = seq;
    const did = loadedDid;
    loadingMore = true;
    moreInFlight = (async () => {
      try {
        const page = await api.getAllFollowLinks(cursor, limit);
        // Superseded by a load, or a fresh first page replaced what this extends.
        if (token !== seq || auth.user?.did !== did || nextCursor !== cursor || !allPages) return;
        allPages = appendNew(allPages, page.links);
        nextCursor = page.nextCursor;
        moreFailures = 0;
      } catch {
        // Kept the cursor. Backing off before loadingMore drops keeps the river
        // reading as loading, so the sentinel doesn't ask again straight away.
        if (token === seq && auth.user?.did === did) startBackoff();
      } finally {
        loadingMore = false;
        moreInFlight = null;
      }
    })();
    return moreInFlight;
  }

  /** Every page, for a river that can't show any until it has all of them
   *  (oldest first, most shared first) or that marks them all read. A failed
   *  page is retried after its backoff, and a load that replaced the list is
   *  waited for, up to `patience` tries in a row without progress. Resolves
   *  whether every link is in (true when the river isn't showing every link). */
  async function loadEveryLink(patience = EVERY_LINK_PATIENCE): Promise<boolean> {
    // Asked for now (a new first page, or a reader marking all read): a backoff
    // left by an earlier scroll would hold this up to a minute.
    if (backingOff) clearBackoff();
    let stalls = 0;
    while (allLinks && allPages && nextCursor) {
      if (backingOff && backoffDone) await backoffDone;
      const beforeCursor = nextCursor;
      const beforePages = allPages;
      await loadMoreLinks(MAX_PAGE);
      if (nextCursor !== beforeCursor || allPages !== beforePages) {
        stalls = 0;
        continue;
      }
      if (++stalls > patience) break;
      // Failed (the next try waits out the backoff, above), or dropped because
      // a load superseded it: wait for that load's first page.
      if (!backingOff && latestLoad) await latestLoad;
    }
    return !allLinks || (allPages !== null && nextCursor === null);
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
      clearBackoff();
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
    const prior = inEverything;
    inEverything = on;
    try {
      await saveSettings({ inEverything: on });
    } catch (err) {
      inEverything = prior;
      throw err;
    }
  }

  /** Saves a settings change. While it's in flight, and for any answer asked
   *  for before it settled, a load leaves the settings as set here. */
  async function saveSettings(settings: { inEverything?: boolean; allLinks?: boolean }) {
    settingsEpoch++;
    settingsInFlight++;
    try {
      await api.setFollowLinksSettings(settings);
    } finally {
      settingsInFlight--;
      settingsEpoch++;
    }
  }

  /** Whether the river shows every link your follows shared, newest first, or
   *  (the default) the week's most shared. Saved for the account; the lists are
   *  asked for again at once. Home's lane is the most shared either way. */
  async function setAllLinks(on: boolean): Promise<void> {
    const prior = allLinks;
    allLinks = on;
    try {
      await saveSettings({ allLinks: on });
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
    /** A page is on its way, or the next waits out a failure's backoff. */
    get loadingMore() {
      return loadingMore || backingOff;
    },
    /** Changes with every fresh first page of every link. */
    get riverEpoch() {
      return riverEpoch;
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
