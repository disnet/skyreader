// The notification inbox (bell + badge), from two sources.
//
// @mentions come live from Constellation. Feedback the reader filed on the
// userinput.app board is polled separately and far more slowly, and turned into
// events by diffing against the last snapshot this browser saw — see
// `services/feedbackNotifications.ts` for why that has to be a stored event
// rather than a computed state.
//
// The badge polls a cheap source-list (index calls only) on an interval; the
// full list enriches lazily when the panel opens (author profile + post title/
// URL). Read-state lives in localStorage as a set of seen source URIs — keyed by
// globally-unique at:// URIs, so a freshly discovered mention (including one
// authored before signup, which has an old createdAt) reads as unread regardless
// of timestamp. Degrades silently when offline or a request fails — notifications
// are adornment, not load-bearing for reading.

import { auth } from '$lib/stores/auth.svelte';
import { api } from '$lib/services/api';
import { fetchMentionSources, enrichMention, type MentionSource } from '$lib/services/mentions';
import { tidToTimestamp } from '$lib/utils/tid';
import {
  diffFeedback,
  loadEvents,
  loadSnapshot,
  mergeEvents,
  saveEvents,
  saveSnapshot,
  snapshotOf,
  type FeedbackEvent,
  type FeedbackSnapshot,
} from '$lib/services/feedbackNotifications';
import type { SkyNotification } from '$lib/types';

const POLL_INTERVAL_MS = 60_000;
// A board moves in days, not minutes, and every poll is a request the reader
// didn't ask for. Once on start and rarely after is enough to catch a reply
// while the tab is open; the rest is caught next time the app boots.
const FEEDBACK_POLL_INTERVAL_MS = 15 * 60_000;
const MAX_SEEN = 200; // cap the persisted set; mentions are bounded anyway
// On the first sync for an account on this browser, mentions older than this
// start read. Read-state is per-browser, so without it signing in on a second
// device lights the badge with everything already read on the first.
const MENTION_BASELINE_MS = 7 * 24 * 60 * 60 * 1000;

// Per-DID key. Mentions are keyed by globally-unique source URI and two users
// can be mentioned in the same document, so a shared (un-namespaced) key would
// leak one account's read-state onto another on the same browser.
function seenKey(did: string): string {
  return `skyreader-mentions-seen:${did}`;
}

/** Null when this browser has never synced this account — see primeSeen. */
function loadSeen(did: string): string[] | null {
  try {
    const raw = localStorage.getItem(seenKey(did));
    return raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

function saveSeen(did: string, uris: string[]): void {
  try {
    localStorage.setItem(seenKey(did), JSON.stringify(uris.slice(-MAX_SEEN)));
  } catch {
    // storage unavailable — seen-state is best-effort
  }
}

/** "planned" → "Now planned"; a post with no status is back to untriaged. */
function statusHeadline(status: string | null | undefined): string {
  if (!status) return 'Back to open';
  const words = status.replaceAll('-', ' ');
  return `Now ${words}`;
}

function replyHeadline(count: number): string {
  return count === 1 ? '1 new reply' : `${count} new replies`;
}

function createNotificationsStore() {
  let sources = $state<MentionSource[]>([]);
  let mentions = $state<SkyNotification[]>([]);
  let feedbackEvents = $state<FeedbackEvent[]>([]);
  let feedbackSnapshot: FeedbackSnapshot | null = null;
  let feedbackDid: string | null = null; // which DID the two above belong to
  let loading = $state(false);
  let loaded = $state(false);
  let seen = $state<Set<string>>(new Set());
  let seenDid: string | null = null; // which DID `seen` was loaded for
  // Whether this browser has a stored read-state for that DID, as opposed to an
  // empty one. Only the first sync gets the week's grace below.
  let seenStored = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let feedbackTimer: ReturnType<typeof setInterval> | null = null;
  // Display-data cache so reopening the panel (same session) is instant and we
  // only re-fetch newly discovered sources.
  const enrichCache = new Map<string, SkyNotification>();

  // Feedback events carry everything they need to render, so unlike a mention
  // they never wait on an enrichment pass — the panel shows them whether or not
  // it has been opened before.
  const feedbackNotifications = $derived<SkyNotification[]>(
    feedbackEvents.map((event) => ({
      id: event.id,
      type: event.kind === 'status' ? 'feedback-status' : 'feedback-reply',
      actorDid: '',
      actorHandle: null,
      actorDisplayName: null,
      actorAvatar: null,
      sourceUri: event.postUri,
      // Into the app, not out to userinput.app: /feedback pins the reader's own
      // posts at the top with their replies already open.
      canonicalUrl: '/feedback',
      title: event.title,
      detail:
        event.kind === 'status'
          ? statusHeadline(event.status)
          : replyHeadline(event.newReplies ?? 1),
      createdAt: event.createdAt,
      seen: false,
    }))
  );

  const notifications = $derived(
    [...mentions, ...feedbackNotifications]
      .map((entry) => ({ ...entry, seen: seen.has(entry.id) }))
      .sort((a, b) => b.createdAt - a.createdAt)
  );

  const unreadCount = $derived(
    sources.filter((s) => !seen.has(s.sourceUri)).length +
      feedbackEvents.filter((event) => !seen.has(event.id)).length
  );

  function isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  // Load the persisted seen-set for `did` the first time we act on that DID.
  // Lazy (not in start()) because the DID may not be resolved yet at mount; this
  // also self-corrects if the account switches under the singleton.
  function ensureSeenLoaded(did: string) {
    if (seenDid === did) return;
    seenDid = did;
    const stored = loadSeen(did);
    seenStored = stored !== null;
    seen = new Set(stored ?? []);
  }

  /**
   * The first sync for an account on this browser starts anything older than a
   * week read.
   *
   * Mentions carry no read-state across devices, so a second device would
   * otherwise open with a badge for every mention already read on the first.
   * The cutoff keeps that from happening without hiding what the inbox is for:
   * a mention from the last week still arrives unread, and so does one this
   * can't date — a document's rkey is only a timestamp when its lexicon says
   * `"key": "tid"`, and an unread notification is a smaller mistake than a
   * silent one.
   */
  function primeSeen(did: string, discovered: MentionSource[]) {
    if (seenStored) return;
    seenStored = true;
    const cutoff = Date.now() - MENTION_BASELINE_MS;
    const next = new Set(seen);
    for (const source of discovered) {
      const created = tidToTimestamp(source.rkey);
      if (created !== null && created < cutoff) next.add(source.sourceUri);
    }
    seen = next;
    // Persisted even when nothing was old enough to add: the write is what
    // makes this a first sync exactly once.
    saveSeen(did, [...next]);
  }

  // Same idea as the seen-set: the reader's feedback state belongs to a DID,
  // and the singleton outlives a logout.
  function ensureFeedbackLoaded(did: string) {
    if (feedbackDid === did) return;
    feedbackDid = did;
    feedbackEvents = loadEvents(did);
    feedbackSnapshot = loadSnapshot(did);
  }

  /**
   * Poll the reader's own posts and turn what moved into events. Silent on a
   * first sync (see diffFeedback) and silent on failure: a board that can't be
   * reached is not something to interrupt anyone about.
   */
  async function refreshFeedback() {
    const did = auth.user?.did;
    if (!did || isOffline()) return;
    ensureSeenLoaded(did);
    ensureFeedbackLoaded(did);
    try {
      const { posts } = await api.getMyFeedback();
      const now = Date.now();
      const fresh = diffFeedback(feedbackSnapshot, posts, now);
      const merged = mergeEvents(feedbackEvents, fresh, now);
      // The snapshot moves whether or not anything changed, and only after the
      // diff: it is the record of what this browser has already accounted for.
      feedbackSnapshot = snapshotOf(posts);
      saveSnapshot(did, feedbackSnapshot);
      if (merged.length !== feedbackEvents.length || fresh.length > 0) {
        feedbackEvents = merged;
        saveEvents(did, merged);
      }
    } catch {
      // silent — a later poll retries
    }
  }

  // Cheap badge refresh: just the source list, no enrichment.
  async function refreshSources() {
    const did = auth.user?.did;
    if (!did || isOffline()) return;
    ensureSeenLoaded(did);
    try {
      const discovered = await fetchMentionSources(did);
      primeSeen(did, discovered);
      sources = discovered;
    } catch {
      // silent — a later poll retries
    }
  }

  // Full list for the panel: enrich each source (cache-backed), newest first.
  async function load() {
    const did = auth.user?.did;
    if (!did || isOffline()) return;
    ensureSeenLoaded(did);
    // The static pages (/feedback among them) render the bell without mounting
    // the shell that starts polling, so opening the panel there has to read the
    // stored events itself — and is as good a moment as any to look for new
    // ones.
    ensureFeedbackLoaded(did);
    void refreshFeedback();
    loading = true;
    try {
      let srcs = sources;
      if (srcs.length === 0) {
        srcs = await fetchMentionSources(did);
        primeSeen(did, srcs);
      }
      sources = srcs;
      const enriched = await Promise.all(
        srcs.map(async (s) => {
          let n = enrichCache.get(s.sourceUri);
          if (!n) {
            const m = await enrichMention(s);
            n = {
              id: m.sourceUri,
              type: 'mention',
              actorDid: m.actorDid,
              actorHandle: m.actorHandle,
              actorDisplayName: m.actorDisplayName,
              actorAvatar: m.actorAvatar,
              sourceUri: m.sourceUri,
              canonicalUrl: m.canonicalUrl,
              title: m.title,
              createdAt: m.createdAt,
              seen: false,
            };
            enrichCache.set(s.sourceUri, n);
          }
          return n;
        })
      );
      mentions = enriched;
      loaded = true;
    } catch (e) {
      console.error('Failed to load notifications:', e);
    } finally {
      loading = false;
    }
  }

  // Mark everything currently known as seen — purely local, persists to storage.
  function markAllSeen() {
    const did = auth.user?.did;
    if (!did || unreadCount === 0) return;
    ensureSeenLoaded(did);
    ensureFeedbackLoaded(did);
    const next = new Set(seen);
    for (const s of sources) next.add(s.sourceUri);
    for (const event of feedbackEvents) next.add(event.id);
    seen = next;
    saveSeen(did, [...next]);
  }

  // Begin badge polling (idempotent). Call when an authenticated shell mounts.
  // The seen-set is loaded lazily on first refresh (see ensureSeenLoaded), since
  // the DID may not be resolved at mount.
  function start() {
    if (pollTimer) return;
    void refreshSources();
    void refreshFeedback();
    pollTimer = setInterval(() => void refreshSources(), POLL_INTERVAL_MS);
    feedbackTimer = setInterval(() => void refreshFeedback(), FEEDBACK_POLL_INTERVAL_MS);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (feedbackTimer) {
      clearInterval(feedbackTimer);
      feedbackTimer = null;
    }
    // Drop all per-account state so a later login (possibly a different DID on
    // this browser) starts clean rather than inheriting the singleton's caches.
    sources = [];
    mentions = [];
    feedbackEvents = [];
    feedbackSnapshot = null;
    feedbackDid = null;
    loaded = false;
    seen = new Set();
    seenDid = null;
    seenStored = false;
    enrichCache.clear();
  }

  return {
    get unreadCount() {
      return unreadCount;
    },
    get notifications() {
      return notifications;
    },
    get loading() {
      return loading;
    },
    get loaded() {
      return loaded;
    },
    start,
    stop,
    load,
    markAllSeen,
  };
}

export const notificationsStore = createNotificationsStore();
