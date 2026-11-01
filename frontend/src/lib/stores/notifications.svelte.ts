// The notification inbox (bell + badge), from three sources.
//
// @mentions come live from Constellation. Feedback the reader filed on the
// userinput.app board is polled separately and far more slowly, and turned into
// events by diffing against the last snapshot this browser saw — see
// `services/feedbackNotifications.ts` for why that has to be a stored event
// rather than a computed state. "New in Skyreader" is the newest Dev Log posts,
// served by the backend (routes/updates.ts) and polled as rarely as feedback.
//
// The badge polls a cheap source-list (index calls only) on an interval; the
// full list enriches lazily when the panel opens (author profile + post title/
// URL). Read-state is a set of seen ids — globally-unique at:// URIs for
// mentions and Dev Log posts, so a freshly discovered mention (including one
// authored before signup, which has an old createdAt) reads as unread regardless
// of timestamp. The set belongs to the account and is synced through the backend
// (routes/notifications.ts), so something read on one device is read on all of
// them; localStorage holds a copy for an instant badge and for offline. Degrades
// silently when offline or a request fails — notifications are adornment, not
// load-bearing for reading.

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
import type { DevLogUpdate } from '$lib/services/api';
import type { SkyNotification } from '$lib/types';

// The badge only has to catch up within a few minutes. Each poll is two requests
// (the mention sources and the account's seen-set), sent from every open tab, so
// the cadence is most of what the bell costs the backend.
export const POLL_INTERVAL_MS = 3 * 60_000;
// A board moves in days, not minutes, and every poll is a request the reader
// didn't ask for. Once on start and rarely after is enough to catch a reply
// while the tab is open; the rest is caught next time the app boots.
const FEEDBACK_POLL_INTERVAL_MS = 15 * 60_000;
// The Dev Log moves in weeks; the feedback cadence is plenty.
const UPDATES_POLL_INTERVAL_MS = FEEDBACK_POLL_INTERVAL_MS;
const MAX_SEEN = 500; // cap the cached set, as the server caps its copy
const MAX_IDS_PER_PUSH = 200; // the server's per-request limit
const MAX_ID_LENGTH = 512; // and the longest id it keeps
// On the first sync for an account, mentions older than this start read, so an
// account that predates the bell doesn't open with a badge full of old news.
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
  let updates = $state<DevLogUpdate[]>([]);
  let feedbackSnapshot: FeedbackSnapshot | null = null;
  let feedbackDid: string | null = null; // which DID the two above belong to
  let loading = $state(false);
  let loaded = $state(false);
  let seen = $state<Set<string>>(new Set());
  let seenDid: string | null = null; // which DID `seen` was loaded for
  // Whether this account's first sync has run — on any device, once the server
  // has answered; on this browser alone until then. Only the first sync gets the
  // week's grace below.
  let primed = false;
  // Whether the server's copy of the seen-set has been merged in since `seenDid`
  // was loaded. Until it has, priming waits: the account may already be primed.
  let seenSynced = false;
  // Seen ids (and a first-sync mark) the server hasn't taken yet; see pushSeen.
  let unsent = new Set<string>();
  let primePending = false;
  let flushing = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let feedbackTimer: ReturnType<typeof setInterval> | null = null;
  let updatesTimer: ReturnType<typeof setInterval> | null = null;
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

  const updateNotifications = $derived<SkyNotification[]>(
    updates.map((update) => ({
      id: update.uri,
      type: 'update',
      actorDid: '',
      actorHandle: null,
      actorDisplayName: null,
      actorAvatar: null,
      sourceUri: update.uri,
      canonicalUrl: update.url,
      title: update.title,
      detail: update.description ?? undefined,
      createdAt: Date.parse(update.publishedAt) || 0,
      seen: false,
    }))
  );

  // One entry per id. A Dev Log post that @mentions the reader is both an update
  // and a mention under the same URI; it shows once, as the update.
  const notifications = $derived(
    [
      ...new Map(
        [...mentions, ...feedbackNotifications, ...updateNotifications].map((entry) => [
          entry.id,
          entry,
        ])
      ).values(),
    ]
      .map((entry) => ({ ...entry, seen: seen.has(entry.id) }))
      .sort((a, b) => b.createdAt - a.createdAt)
  );

  const unreadCount = $derived(
    new Set(
      [
        ...sources.map((source) => source.sourceUri),
        ...feedbackEvents.map((event) => event.id),
        ...updates.map((update) => update.uri),
      ].filter((id) => !seen.has(id))
    ).size
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
    primed = stored !== null;
    seenSynced = false;
    unsent = new Set();
    primePending = false;
    seen = new Set(stored ?? []);
  }

  /**
   * Record ids as seen on the server. They wait in `unsent` until the server
   * takes them, so a failed write is retried by the next sync rather than lost —
   * and only these are ever sent, never the whole local set, which the server
   * (capped) and this browser would otherwise trade back and forth forever.
   */
  function pushSeen(ids: string[], markPrimed = false) {
    // The server skips an id longer than it stores; there's no sense sending one.
    for (const id of ids) if (id.length <= MAX_ID_LENGTH) unsent.add(id);
    if (markPrimed) primePending = true;
    void flushSeen();
  }

  async function flushSeen() {
    if (flushing || isOffline() || (unsent.size === 0 && !primePending)) return;
    flushing = true;
    const owner = seenDid;
    try {
      while (seenDid === owner && (unsent.size > 0 || primePending)) {
        const batch = [...unsent].slice(0, MAX_IDS_PER_PUSH);
        const markPrimed = primePending;
        await api.markNotificationsSeen(batch, markPrimed);
        if (seenDid !== owner) break;
        for (const id of batch) unsent.delete(id);
        if (markPrimed) primePending = false;
      }
    } catch {
      // silent — the next sync retries what's left
    } finally {
      flushing = false;
    }
  }

  /**
   * Merge the account's seen-set from the server with this browser's copy, both
   * ways. What this browser saw while offline (or before the server kept read
   * state at all) goes up; what another device saw comes down. A browser that
   * had already primed under the old per-browser state primes the account.
   */
  async function syncSeen(did: string) {
    if (isOffline()) return;
    // A background tab needn't keep up with other devices; it catches up when
    // it's looked at. The first sync still runs, since priming waits on it.
    if (seenSynced && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    try {
      const remote = await api.getNotificationSeen();
      if (seenDid !== did) return; // the account switched while this was in flight
      const firstSync = !seenSynced;
      const promote = primed && !remote.primed;
      primed = primed || remote.primed;
      seenSynced = true;
      // The server lists newest first; appended oldest first, so the newest are
      // the ones the capped local copy keeps.
      const incoming = remote.ids.filter((id) => !seen.has(id)).reverse();
      if (incoming.length > 0) {
        seen = new Set([...seen, ...incoming]);
        saveSeen(did, [...seen]);
      }
      // Once per load, what this browser holds and the server doesn't goes up:
      // reads made offline, or before the account kept read state at all.
      // Against the set as it is now, not as it was when the request left, so a
      // markAllSeen in between is included.
      const remoteIds = new Set(remote.ids);
      const localOnly = firstSync ? [...seen].filter((id) => !remoteIds.has(id)) : [];
      pushSeen(localOnly, promote);
    } catch {
      // silent — the local copy stands and a later poll retries
    }
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
    // Offline, or the server didn't answer: wait rather than guess. Priming
    // twice is harmless only before anything has been read.
    if (primed || !seenSynced) return;
    primed = true;
    const cutoff = Date.now() - MENTION_BASELINE_MS;
    const next = new Set(seen);
    const added: string[] = [];
    for (const source of discovered) {
      const created = tidToTimestamp(source.rkey);
      if (created !== null && created < cutoff && !next.has(source.sourceUri)) {
        next.add(source.sourceUri);
        added.push(source.sourceUri);
      }
    }
    seen = next;
    // Persisted even when nothing was old enough to add: the write is what
    // makes this a first sync exactly once, here and on the account's other
    // devices.
    saveSeen(did, [...next]);
    pushSeen(added, true);
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
    // Every poll also picks up what the account's other devices have read, so a
    // badge cleared on the phone clears here within a poll.
    const synced = syncSeen(did);
    try {
      const discovered = await fetchMentionSources(did);
      await synced;
      primeSeen(did, discovered);
      sources = discovered;
    } catch {
      // silent — a later poll retries
    }
  }

  /** The newest Dev Log posts. Silent on failure, like every other source. */
  async function refreshUpdates() {
    const did = auth.user?.did;
    if (!did || isOffline()) return;
    try {
      const { updates: fresh } = await api.getUpdates();
      if (auth.user?.did === did) updates = fresh;
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
    void refreshUpdates();
    const synced = syncSeen(did);
    loading = true;
    try {
      let srcs = sources;
      if (srcs.length === 0) {
        srcs = await fetchMentionSources(did);
        await synced;
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

  // Mark everything currently known as seen, here and for the account's other
  // devices.
  function markAllSeen() {
    const did = auth.user?.did;
    if (!did || unreadCount === 0) return;
    ensureSeenLoaded(did);
    ensureFeedbackLoaded(did);
    const ids = [
      ...sources.map((source) => source.sourceUri),
      ...feedbackEvents.map((event) => event.id),
      ...updates.map((update) => update.uri),
    ];
    const added = ids.filter((id) => !seen.has(id));
    seen = new Set([...seen, ...added]);
    saveSeen(did, [...seen]);
    pushSeen(added);
  }

  // Begin badge polling (idempotent). Call when an authenticated shell mounts.
  // The seen-set is loaded lazily on first refresh (see ensureSeenLoaded), since
  // the DID may not be resolved at mount.
  function start() {
    if (pollTimer) return;
    void refreshSources();
    void refreshFeedback();
    void refreshUpdates();
    pollTimer = setInterval(() => void refreshSources(), POLL_INTERVAL_MS);
    feedbackTimer = setInterval(() => void refreshFeedback(), FEEDBACK_POLL_INTERVAL_MS);
    updatesTimer = setInterval(() => void refreshUpdates(), UPDATES_POLL_INTERVAL_MS);
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
    if (updatesTimer) {
      clearInterval(updatesTimer);
      updatesTimer = null;
    }
    // Drop all per-account state so a later login (possibly a different DID on
    // this browser) starts clean rather than inheriting the singleton's caches.
    sources = [];
    mentions = [];
    feedbackEvents = [];
    updates = [];
    feedbackSnapshot = null;
    feedbackDid = null;
    loaded = false;
    seen = new Set();
    seenDid = null;
    primed = false;
    seenSynced = false;
    unsent = new Set();
    primePending = false;
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
