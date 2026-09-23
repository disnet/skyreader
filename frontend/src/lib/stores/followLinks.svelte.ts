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

function createFollowLinksStore() {
  let links = $state<FollowLink[]>([]);
  let currentWindow = $state<FollowLinksWindow>('24h');
  let loading = $state(false);
  let scopeRequired = $state(false);
  let complete = $state(false);
  let refreshing = $state(false);
  let error = $state<string | null>(null);
  let loadedKey: string | null = null;
  let followUp: ReturnType<typeof setTimeout> | null = null;
  let followUps = 0;

  function clearFollowUp() {
    if (followUp) clearTimeout(followUp);
    followUp = null;
  }

  async function fetchOnce(did: string, w: FollowLinksWindow): Promise<void> {
    const res = await api.getFollowLinks(w);
    // The account or the window changed while this was in flight.
    if (auth.user?.did !== did || currentWindow !== w) return;

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
        void fetchOnce(did, w).catch(() => {});
      }, FOLLOW_UP_MS);
    } else if (!complete) {
      // Gave up waiting on a first refresh; stop showing it as in progress.
      refreshing = false;
    }
  }

  /** Load for the signed-in account. Cached per account + window for the
   *  session unless `force`; the server's own gate decides whether a load also
   *  refreshes from the timeline. */
  async function load(w: FollowLinksWindow = currentWindow, force = false): Promise<void> {
    const user = auth.user;
    if (!user || auth.isGuest) return;
    const key = `${user.did}|${w}`;
    if (!force && loadedKey === key) return;
    if (!loadedKey?.startsWith(`${user.did}|`)) links = []; // never show another account's
    currentWindow = w;
    loadedKey = key;
    followUps = 0;
    loading = true;
    try {
      await fetchOnce(user.did, w);
    } catch (err) {
      loadedKey = null;
      error = err instanceof Error ? err.message : 'Could not load';
    } finally {
      loading = false;
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
