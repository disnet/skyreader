import { api } from '$lib/services/api';
import { auth } from './auth.svelte';
import type { FollowLink, FollowLinksWindow } from '$lib/types';

// From your follows: the links people you follow share on Bluesky, grouped by
// article. Backs the /following page and Home's "Shared by people you follow"
// lane. See docs/plans/FOLLOWS_LINKS_PLAN.md.
//
// The server answers from D1 at once and refreshes the timeline behind the
// response (at most every 10 minutes). When a response says it started a
// refresh, this store asks again a few seconds later to pick up what it found,
// and keeps asking while a reader's first refresh is still gathering.

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
  let currentWindow = $state<FollowLinksWindow>('24h');
  let loading = $state(false);
  let scopeRequired = $state(false);
  let complete = $state(false);
  let refreshing = $state(false);
  let error = $state<string | null>(null);
  let loadedKey: string | null = null;
  let loadedAt = 0;
  let loadedDid: string | null = null;
  /** Bumped by every load; a response or follow-up from an older one is dropped. */
  let seq = 0;
  let followUp: ReturnType<typeof setTimeout> | null = null;
  let followUps = 0;

  function clearFollowUp() {
    if (followUp) clearTimeout(followUp);
    followUp = null;
  }

  async function fetchOnce(token: number, did: string, w: FollowLinksWindow): Promise<void> {
    const res = await api.getFollowLinks(w);
    // A newer load (another window, another account, a re-visit) superseded this.
    if (token !== seq || auth.user?.did !== did) return;

    scopeRequired = res.scopeRequired;
    links = res.links;
    complete = res.sync?.complete ?? false;
    refreshing = res.sync?.refreshing ?? false;
    error = res.sync?.error ?? null;

    clearFollowUp();
    if (!res.scopeRequired && (refreshing || !complete) && followUps < MAX_FOLLOW_UPS) {
      followUps++;
      followUp = setTimeout(() => {
        followUp = null;
        void fetchOnce(token, did, w).catch(() => {});
      }, FOLLOW_UP_MS);
    } else if (!complete) {
      // Gave up waiting on a first refresh; stop showing it as in progress.
      refreshing = false;
    }
  }

  /** Load for the signed-in account. An answer is reused per account + window
   *  for a few minutes unless `force`; the server's own gate decides whether a
   *  load also refreshes from the timeline. */
  async function load(w: FollowLinksWindow = currentWindow, force = false): Promise<void> {
    const user = auth.user;
    if (!user || auth.isGuest) return;
    const key = `${user.did}|${w}`;
    if (!force && loadedKey === key && Date.now() - loadedAt < STALE_MS) return;

    if (loadedDid !== user.did) {
      // Never show another account's links, permission ask or error.
      links = [];
      scopeRequired = false;
      complete = false;
      refreshing = false;
      error = null;
      loadedDid = user.did;
    } else if (w !== currentWindow) {
      // Another window's links under this window's chip would be wrong.
      links = [];
    }

    const token = ++seq;
    clearFollowUp();
    currentWindow = w;
    loadedKey = key;
    loadedAt = Date.now();
    followUps = 0;
    loading = true;
    try {
      await fetchOnce(token, user.did, w);
    } catch (err) {
      if (token !== seq) return;
      loadedKey = null;
      error = err instanceof Error ? err.message : 'Could not load';
    } finally {
      // Only the latest load owns the flag: an older one finishing mustn't clear
      // it while the current window is still in flight.
      if (token === seq) loading = false;
    }
  }

  function markOpened(url: string, urlNormalized: string) {
    links = links.map((l) => (l.urlNormalized === urlNormalized ? { ...l, opened: true } : l));
    void api.setFollowLinkState(url, 'opened').catch(() => {});
  }

  function dismiss(url: string, urlNormalized: string) {
    links = links.filter((l) => l.urlNormalized !== urlNormalized);
    void api.setFollowLinkState(url, 'dismissed').catch(() => {});
  }

  return {
    get links() {
      return links;
    },
    get window() {
      return currentWindow;
    },
    get loading() {
      return loading;
    },
    get scopeRequired() {
      return scopeRequired;
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
    markOpened,
    dismiss,
  };
}

export const followLinksStore = createFollowLinksStore();
