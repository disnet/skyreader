import { SvelteMap } from 'svelte/reactivity';
import { api, type ChannelItemsResponse, type ChannelMatch } from '$lib/services/api';
import { getMetadata, setMetadata } from '$lib/services/db';
import {
  classifyChannelItemsError,
  compareResponseToKey,
  searchChannelUnread,
  type SearchChannelError,
} from '$lib/utils/searchChannels';

// The open saved search's matches, and every saved search's unread count.
//
// A saved search's items come from the server (GET /api/channels/:uuid/items),
// not from the local timeline, so this holds them the way followLinks holds
// the follows river: a page at a time, newest first, with the last first page
// kept in Dexie so the channel opens offline. Read state stays in itemLabels;
// a match's `read` flag only says how it stood when served, which is what the
// unread count corrects for (searchChannelUnread).

const PAGE_SIZE = 50;
/** How often an open channel checks again while it's still filling or setting up. */
const POLL_MS = 20_000;
/**
 * The first polls come quicker: saving a channel starts its look back at once,
 * so a new one usually fills within seconds and shouldn't sit empty for 20.
 */
const FAST_POLL_MS = 3_000;
const FAST_POLLS = 10;
/** Polls before giving up on a channel whose query never reaches the server. */
const MAX_SETUP_POLLS = 15;
/** Polls while the 30-day look back runs. Ten minutes covers a large one. */
const MAX_BACKFILL_POLLS = 30;
/** Counts are one request per channel; a few at a time. */
const COUNT_CONCURRENCY = 4;
/** Mark-all-read loads every match first, within reason. */
const MAX_PAGES_FOR_ALL = 20;

const cacheKey = (uuid: string) => `searchChannel:${uuid}`;

interface CachedPage {
  /** channelMatchKey of the version these matches are for. */
  key: string;
  response: ChannelItemsResponse;
}

interface ChannelCount {
  unread: number;
  capped: boolean;
  /** The matches this count was served with, for correcting it as items are read. */
  served: ChannelMatch[];
}

function matchId(m: ChannelMatch): string {
  return `${m.kind}:${m.itemKey}`;
}

function createSearchChannelsStore() {
  // The open channel, and its query and sources (channelMatchKey).
  let uuid = $state<string | null>(null);
  let key = $state<string | null>(null);
  let matches = $state.raw<ChannelMatch[]>([]);
  let nextCursor = $state<string | null>(null);
  let status = $state<ChannelItemsResponse['status']>('active');
  let backfilling = $state(false);
  // Whether anything has been shown for the open channel yet (cache or server).
  let loaded = $state(false);
  let loading = $state(false);
  let loadingMore = $state(false);
  // The last page request failed; scrolling asks again, the auto-fill doesn't.
  let moreFailed = $state(false);
  let error = $state<SearchChannelError | null>(null);

  // Unread per saved search, by uuid; the sidebar's badges.
  const counts = new SvelteMap<string, ChannelCount>();

  // Bumped whenever the open channel (or its query) changes, so a response for
  // the one before can't land on this one.
  let generation = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polls = 0;

  function clearPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(max: number) {
    clearPoll();
    // The fast polls come on top of the budget, so its wall-clock span holds.
    if (polls >= max + FAST_POLLS) {
      // A query the server never picked up: its channel write didn't land, so
      // waiting longer won't help. Saving the channel again sends it again.
      if (error === 'not_ready') error = 'failed';
      return;
    }
    polls++;
    const gen = generation;
    pollTimer = setTimeout(
      () => {
        pollTimer = null;
        if (gen === generation) void fetchFirst();
      },
      polls <= FAST_POLLS ? FAST_POLL_MS : POLL_MS
    );
  }

  function apply(res: ChannelItemsResponse) {
    // A refresh replaces the first page and keeps what was paged in below it.
    // The cursor goes back to the first page's end all the same: the look back
    // can land a match between there and the old cursor, and paging on picks
    // it up (already-held matches are skipped).
    if (matches.length > res.items.length && res.nextCursor) {
      const fresh = new Set(res.items.map(matchId));
      const last = res.items.at(-1);
      const tail = matches.filter(
        (m) => !fresh.has(matchId(m)) && last != null && m.publishedAt <= last.publishedAt
      );
      matches = [...res.items, ...tail];
    } else {
      matches = res.items;
    }
    nextCursor = res.nextCursor;
    status = res.status;
    backfilling = res.backfilling;
    error = null;
    loaded = true;
  }

  function setCount(id: string, res: ChannelItemsResponse, served: ChannelMatch[]) {
    counts.set(id, { unread: res.unread, capped: res.unreadCapped, served });
  }

  async function fetchFirst(): Promise<void> {
    const id = uuid;
    const k = key;
    if (!id || !k) return;
    const gen = generation;
    loading = true;
    try {
      const res = await api.getChannelItems(id, { limit: PAGE_SIZE });
      if (gen !== generation) return;
      const version = compareResponseToKey(res, k);
      // Sources the server hasn't caught up with are waited on only briefly:
      // a channel whose sources here never reached it (an edit made offline)
      // shows what the server has rather than nothing.
      if (version === 'query' || (version === 'sources' && polls < FAST_POLLS)) {
        // The server still holds the query or sources from before this edit:
        // the channel write is on its way. Its matches are for the old version,
        // so show none.
        error = 'not_ready';
        schedulePoll(MAX_SETUP_POLLS);
        return;
      }
      apply(res);
      // Counted against this page alone: its read flags are as fresh as the
      // count, where a tail paged in earlier carries older ones.
      setCount(id, res, res.items);
      void setMetadata<CachedPage>(cacheKey(id), {
        key: k,
        response: { ...res, items: res.items.slice(0, PAGE_SIZE) },
      }).catch(() => {});
      if (res.backfilling) schedulePoll(MAX_BACKFILL_POLLS);
      else clearPoll();
    } catch (e) {
      if (gen !== generation) return;
      const kind = classifyChannelItemsError(e);
      // Offline with something cached: keep showing it, and say so.
      error = kind;
      if (kind === 'offline' && loaded) return;
      if (kind === 'not_ready') schedulePoll(MAX_SETUP_POLLS);
      if (kind === 'off' || kind === 'upgrade') counts.delete(id);
    } finally {
      if (gen === generation) loading = false;
    }
  }

  /**
   * Show a saved search; `k` is its channelMatchKey. A no-op when it's already
   * the open one, unedited.
   */
  async function open(id: string, k: string): Promise<void> {
    if (uuid === id && key === k) return;
    generation++;
    clearPoll();
    polls = 0;
    const sameChannel = uuid === id;
    uuid = id;
    key = k;
    matches = [];
    nextCursor = null;
    status = 'active';
    backfilling = false;
    loaded = false;
    error = null;
    loadingMore = false;
    moreFailed = false;
    pageInFlight = null;
    if (sameChannel) {
      // An edited query or sources: the server clears and re-runs it, so the old count is wrong too.
      counts.delete(id);
    } else {
      const gen = generation;
      const cached = await getMetadata<CachedPage>(cacheKey(id)).catch(() => null);
      if (gen !== generation) return;
      if (cached && cached.key === k && !loaded) apply(cached.response);
    }
    await fetchFirst();
  }

  function close() {
    if (uuid === null) return;
    generation++;
    clearPoll();
    uuid = null;
    key = null;
    matches = [];
    nextCursor = null;
    loaded = false;
    error = null;
    pageInFlight = null;
  }

  /** Try the open channel again, after a failure or a give-up. */
  async function retry(): Promise<void> {
    clearPoll();
    polls = 0;
    error = null;
    await fetchFirst();
  }

  // The page in flight, so a second caller (mark-all-read behind a scroll)
  // waits for it rather than taking an early return for a failure.
  let pageInFlight: Promise<void> | null = null;

  function loadMore(): Promise<void> {
    if (pageInFlight) return pageInFlight;
    const id = uuid;
    const before = nextCursor;
    if (!id || !before) return Promise.resolve();
    pageInFlight = loadPage(id, before).finally(() => (pageInFlight = null));
    return pageInFlight;
  }

  async function loadPage(id: string, before: string): Promise<void> {
    const gen = generation;
    loadingMore = true;
    try {
      const res = await api.getChannelItems(id, { before, limit: PAGE_SIZE });
      if (gen !== generation) return;
      const seen = new Set(matches.map(matchId));
      const added = res.items.filter((m) => !seen.has(matchId(m)));
      // A page re-walked after a refresh can fill a gap above the tail.
      matches = [...matches, ...added].sort((a, b) => b.publishedAt - a.publishedAt);
      nextCursor = res.nextCursor;
      moreFailed = false;
      const count = counts.get(id);
      if (count) counts.set(id, { ...count, served: matches });
    } catch (e) {
      console.warn('Saved search: loading more failed:', e);
      if (gen === generation) moreFailed = true;
    } finally {
      if (gen === generation) loadingMore = false;
    }
  }

  /** Page in every match (up to a limit), for marking them all read. False if some didn't load. */
  async function loadAll(): Promise<boolean> {
    for (let page = 0; nextCursor && page < MAX_PAGES_FOR_ALL; page++) {
      const before = nextCursor;
      await loadMore();
      if (nextCursor === before) return false;
    }
    return nextCursor === null;
  }

  /**
   * Refresh the open channel and every saved search's unread count. `channels`
   * is every channel carrying a query, with its channelMatchKey; counts for any
   * other are dropped.
   */
  async function refresh(channels: Array<{ uuid: string; key: string }>): Promise<void> {
    const live = new Set(channels.map((c) => c.uuid));
    for (const id of [...counts.keys()]) if (!live.has(id)) counts.delete(id);

    const openFetch = uuid && live.has(uuid) ? ((polls = 0), fetchFirst()) : Promise.resolve();
    const rest = channels.filter((c) => c.uuid !== uuid);
    let next = 0;
    async function worker() {
      while (next < rest.length) {
        const { uuid: id, key: k } = rest[next++];
        try {
          const res = await api.getChannelItems(id, { limit: 1 });
          // An edit still on its way: the count is the old version's.
          if (compareResponseToKey(res, k) === 'query') counts.delete(id);
          else setCount(id, res, res.items);
        } catch (e) {
          const kind = classifyChannelItemsError(e);
          if (kind === 'off' || kind === 'upgrade' || kind === 'not_ready') counts.delete(id);
          // A whole environment with the switch off answers the same for all.
          if (kind === 'off' || kind === 'upgrade' || kind === 'offline') return;
        }
      }
    }
    await Promise.all([
      openFetch,
      ...Array.from({ length: Math.min(COUNT_CONCURRENCY, rest.length) }, () => worker()),
    ]);
  }

  /** A saved search's unread count, or undefined when none has been served. */
  function unreadFor(id: string, isRead: (match: ChannelMatch) => boolean): number | undefined {
    const count = counts.get(id);
    if (!count) return undefined;
    // Past the cap the true count is unknown, so there's nothing to correct.
    if (count.capped) return count.unread;
    return searchChannelUnread(count.unread, count.served, isRead);
  }

  // The open channel's snippets and sharers, by a match's itemKey, or for a save
  // match its save's rkey (a save row's key isn't one the server knows).
  let byKey = $derived(
    new Map(matches.map((m) => [m.kind === 'save' ? m.save.rkey : m.itemKey, m]))
  );

  return {
    get uuid() {
      return uuid;
    },
    get key() {
      return key;
    },
    get matches() {
      return matches;
    },
    get hasMore() {
      return nextCursor !== null;
    },
    get status() {
      return status;
    },
    get backfilling() {
      return backfilling;
    },
    get loaded() {
      return loaded;
    },
    get loading() {
      return loading;
    },
    get loadingMore() {
      return loadingMore;
    },
    get moreFailed() {
      return moreFailed;
    },
    get error() {
      return error;
    },
    matchFor(key: string): ChannelMatch | undefined {
      return byKey.get(key);
    },
    open,
    close,
    retry,
    loadMore,
    loadAll,
    refresh,
    unreadFor,
  };
}

export const searchChannelsStore = createSearchChannelsStore();
