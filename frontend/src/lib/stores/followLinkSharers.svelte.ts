import { api } from '$lib/services/api';
import { auth } from './auth.svelte';
import type { FollowLinkSharer } from '$lib/types';

// Who you follow on Bluesky shared a given article: the "People you follow"
// rows in the Discussion panel. One small indexed read per article, reused for a
// few minutes: an article opened before a timeline refresh found its sharers
// picks them up the next time it's opened. See docs/plans/FOLLOWS_LINKS_PLAN.md.
//
// A reader who hasn't granted the timeline permission gets an empty answer; the
// first one says so, and the store stops asking for the rest of the session.

interface SharersState {
  loading: boolean;
  sharers: FollowLinkSharer[];
  /** When the answer arrived; 0 while it's in flight. */
  at: number;
}

const EMPTY: SharersState = { loading: false, sharers: [], at: 0 };

/** How long an answer is reused before opening the article asks again. */
const STALE_MS = 5 * 60 * 1000;

function createFollowLinkSharersStore() {
  let byUrl = $state<Record<string, SharersState>>({});
  let off = false;
  let forDid: string | null = null;

  function load(url: string) {
    const user = auth.user;
    if (!url || !user || auth.isGuest) return;
    if (forDid !== user.did) {
      // Another account's answers aren't this one's.
      byUrl = {};
      off = false;
      forDid = user.did;
    }
    if (off) return;
    const prior = byUrl[url];
    if (prior && (prior.loading || Date.now() - prior.at < STALE_MS)) return;
    // Keep showing what we had while asking again.
    byUrl[url] = { loading: true, sharers: prior?.sharers ?? [], at: 0 };
    const did = user.did;
    api
      .getFollowLinkSharers(url)
      .then((res) => {
        if (forDid !== did) return;
        if (res.scopeRequired) off = true;
        byUrl[url] = { loading: false, sharers: res.sharers, at: Date.now() };
      })
      .catch(() => {
        if (forDid !== did) return;
        // Adornment: a failed lookup just means no follows rows this time.
        byUrl[url] = { loading: false, sharers: prior?.sharers ?? [], at: Date.now() };
      });
  }

  function get(url: string): SharersState {
    return byUrl[url] ?? EMPTY;
  }

  return { load, get };
}

export const followLinkSharersStore = createFollowLinkSharersStore();
