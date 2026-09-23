import { api } from '$lib/services/api';
import { auth } from './auth.svelte';
import type { FollowLinkSharer } from '$lib/types';

// Who you follow on Bluesky shared a given article: the "People you follow"
// rows in the Discussion panel. One small indexed read per article, cached for
// the session. See docs/plans/FOLLOWS_LINKS_PLAN.md.
//
// A reader who hasn't granted the timeline permission gets an empty answer; the
// first one says so, and the store stops asking for the rest of the session.

interface SharersState {
  loading: boolean;
  sharers: FollowLinkSharer[];
}

const EMPTY: SharersState = { loading: false, sharers: [] };

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
    if (off || byUrl[url]) return;
    byUrl[url] = { loading: true, sharers: [] };
    api
      .getFollowLinkSharers(url)
      .then((res) => {
        if (res.scopeRequired) off = true;
        byUrl[url] = { loading: false, sharers: res.sharers };
      })
      .catch(() => {
        // Adornment: a failed lookup just means no follows rows this time.
        byUrl[url] = { loading: false, sharers: [] };
      });
  }

  function get(url: string): SharersState {
    return byUrl[url] ?? EMPTY;
  }

  return { load, get };
}

export const followLinkSharersStore = createFollowLinkSharersStore();
