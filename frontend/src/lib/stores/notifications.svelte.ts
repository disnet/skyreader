// @mention notification inbox (bell + badge), sourced live from Constellation.
//
// The badge polls a cheap source-list (index calls only) on an interval; the
// full list enriches lazily when the panel opens (author profile + post title/
// URL). Read-state lives in localStorage as a set of seen source URIs — keyed by
// globally-unique at:// URIs, so a freshly discovered mention (including one
// authored before signup, which has an old createdAt) reads as unread regardless
// of timestamp. Degrades silently when offline or a request fails — notifications
// are adornment, not load-bearing for reading.

import { auth } from '$lib/stores/auth.svelte';
import { fetchMentionSources, enrichMention, type MentionSource } from '$lib/services/mentions';
import type { SkyNotification } from '$lib/types';

const POLL_INTERVAL_MS = 60_000;
const MAX_SEEN = 200; // cap the persisted set; mentions are bounded anyway

// Per-DID key. Mentions are keyed by globally-unique source URI and two users
// can be mentioned in the same document, so a shared (un-namespaced) key would
// leak one account's read-state onto another on the same browser.
function seenKey(did: string): string {
  return `skyreader-mentions-seen:${did}`;
}

function loadSeen(did: string): string[] {
  try {
    const raw = localStorage.getItem(seenKey(did));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveSeen(did: string, uris: string[]): void {
  try {
    localStorage.setItem(seenKey(did), JSON.stringify(uris.slice(-MAX_SEEN)));
  } catch {
    // storage unavailable — seen-state is best-effort
  }
}

function createNotificationsStore() {
  let sources = $state<MentionSource[]>([]);
  let notifications = $state<SkyNotification[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let seen = $state<Set<string>>(new Set());
  let seenDid: string | null = null; // which DID `seen` was loaded for
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // Display-data cache so reopening the panel (same session) is instant and we
  // only re-fetch newly discovered sources.
  const enrichCache = new Map<string, SkyNotification>();

  const unreadCount = $derived(sources.filter((s) => !seen.has(s.sourceUri)).length);

  function isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  // Load the persisted seen-set for `did` the first time we act on that DID.
  // Lazy (not in start()) because the DID may not be resolved yet at mount; this
  // also self-corrects if the account switches under the singleton.
  function ensureSeenLoaded(did: string) {
    if (seenDid === did) return;
    seenDid = did;
    seen = new Set(loadSeen(did));
  }

  // Cheap badge refresh: just the source list, no enrichment.
  async function refreshSources() {
    const did = auth.user?.did;
    if (!did || isOffline()) return;
    ensureSeenLoaded(did);
    try {
      sources = await fetchMentionSources(did);
    } catch {
      // silent — a later poll retries
    }
  }

  // Full list for the panel: enrich each source (cache-backed), newest first.
  async function load() {
    const did = auth.user?.did;
    if (!did || isOffline()) return;
    ensureSeenLoaded(did);
    loading = true;
    try {
      const srcs = sources.length > 0 ? sources : await fetchMentionSources(did);
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
      enriched.sort((a, b) => b.createdAt - a.createdAt);
      notifications = enriched.map((n) => ({ ...n, seen: seen.has(n.sourceUri) }));
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
    const next = new Set(seen);
    for (const s of sources) next.add(s.sourceUri);
    seen = next;
    saveSeen(did, [...next]);
    notifications = notifications.map((n) => ({ ...n, seen: true }));
  }

  // Begin badge polling (idempotent). Call when an authenticated shell mounts.
  // The seen-set is loaded lazily on first refresh (see ensureSeenLoaded), since
  // the DID may not be resolved at mount.
  function start() {
    if (pollTimer) return;
    void refreshSources();
    pollTimer = setInterval(() => void refreshSources(), POLL_INTERVAL_MS);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    // Drop all per-account state so a later login (possibly a different DID on
    // this browser) starts clean rather than inheriting the singleton's caches.
    sources = [];
    notifications = [];
    loaded = false;
    seen = new Set();
    seenDid = null;
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
