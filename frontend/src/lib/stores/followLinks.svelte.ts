import { api } from '$lib/services/api';
import { urlKey } from '$lib/utils/urlKey';
import { auth } from './auth.svelte';
import type { FollowLink } from '$lib/types';

// From your follows: the links people you follow share on Bluesky, grouped by
// article. One list backs every surface: the follows source in the river (any
// channel that names it), the "shared by" line on river cards for articles your
// follows also shared, and Home's lane. See docs/plans/FOLLOWS_LINKS_PLAN.md.
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
  let complete = $state(false);
  let refreshing = $state(false);
  let error = $state<string | null>(null);
  let loadedAt = 0;
  let loadedDid: string | null = null;
  /** Bumped by every load; a response or follow-up from an older one is dropped. */
  let seq = 0;
  let followUp: ReturnType<typeof setTimeout> | null = null;
  let followUps = 0;

  // Every form a river item's URL might match a link under: the posted URL
  // (tracking and all) and the server's normalized one, both canonicalized.
  let byUrlKey = $derived.by(() => {
    const map = new Map<string, FollowLink>();
    for (const link of links) {
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

  async function fetchOnce(token: number, did: string): Promise<void> {
    const res = await api.getFollowLinks('7d');
    // A newer load (another account, a forced re-ask) superseded this.
    if (token !== seq || auth.user?.did !== did) return;

    scopeRequired = res.scopeRequired;
    inEverything = res.inEverything ?? null;
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
  }

  /** Show follows links in Everything, or not. Applied at once; saved for the
   *  account, so the first-run question is asked once, not once per device. */
  async function setInEverything(on: boolean): Promise<void> {
    const prior = inEverything;
    inEverything = on;
    try {
      await api.setFollowLinksInEverything(on);
    } catch (err) {
      inEverything = prior;
      throw err;
    }
  }

  /** The link your follows shared at this URL, if any, in whatever form. */
  function forUrl(url: string | null | undefined): FollowLink | undefined {
    if (!url) return undefined;
    const key = urlKey(url);
    return key ? byUrlKey.get(key) : undefined;
  }

  return {
    get links() {
      return links;
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
    forUrl,
  };
}

export const followLinksStore = createFollowLinksStore();
