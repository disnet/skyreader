// Share drafts. A draft is the unposted state of a linkblog share, keyed by the
// external article URL — the same key the linkblog dedups on.
//
// Drafts are durable and cross-device: D1 is the store of record and IndexedDB
// is an offline cache, so a draft started on the phone can be finished on the
// laptop and survives an IndexedDB eviction (a real hazard on iOS PWAs — see
// `checkDbHealth`). They are private to the account, exactly like saves and read
// state: never a PDS record, never public. Only posting makes a draft public,
// through the linkblog write path.
//
// Sync follows the magazines pattern: a persisted `?since=` cursor, tombstoned
// deletes replayed from other devices, and offline writes through the sync
// queue. Where it differs is the merge — a draft is keystroke-level content, so
// both sides resolve last-write-wins on the client ms clock (`ShareDraft.updatedAt`)
// rather than trusting arrival order, and the server enforces the same rule.

import { browser } from '$app/environment';
import { db, getMetadata, setMetadata } from '$lib/services/db';
import { api } from '$lib/services/api';
import { syncQueue } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import { auth } from './auth.svelte';
import { draftHasContent } from '$lib/utils/shareNote';
import type { RemoteShareDraft, ShareDraft } from '$lib/types';

// Persisted delta cursor: the max server `updated_at` (unix seconds) seen. The
// backend overlaps this second on the next delta, and the LWW merge below makes
// those boundary replays idempotent while catching same-second late writes.
// `db.metadata.clear()` on logout wipes it, so the next account starts cold.
const CURSOR_KEY = 'shareDraftsCursor';

// The composer already debounces its Dexie write at 600 ms. The server push is
// throttled on top of that — trailing, so the first keystroke of a burst starts
// the clock and the last edit in the window is what lands. Bounds D1 at roughly
// one write per 5 s of active typing per draft instead of one per typing pause.
const PUSH_THROTTLE_MS = 5000;

function toPlain(draft: ShareDraft): ShareDraft {
  // $state proxies can't cross into IndexedDB (or JSON) — copy to plain objects.
  return { ...draft, blocks: draft.blocks.map((b) => ({ ...b })) };
}

function createShareDraftsStore() {
  let drafts = $state<Map<string, ShareDraft>>(new Map());
  // The in-flight (or settled) hydration. Memoizing the promise rather than a
  // `hasLoaded` flag is what makes `await load()` mean "the drafts are here":
  // a flag set before the await lets a second caller through while the read is
  // still running, and the composer would then open blank over a saved draft
  // and overwrite it on the first keystroke. It stays Dexie-only for the same
  // reason — the composer awaits it, and it must not wait on the network.
  let loadPromise: Promise<void> | null = null;

  let cursor = 0;
  let cursorLoaded = false;
  let cursorHasValue = false;
  let syncInFlight: Promise<void> | null = null;

  // Trailing server pushes, one timer per article URL. `pending` holds the draft
  // the timer will send, replaced (not queued) by later edits in the window.
  const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, ShareDraft>();

  const list = $derived(
    [...drafts.values()]
      .filter((d) => draftHasContent(d.blocks))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  );

  async function hydrate() {
    try {
      const rows = await db.shareDrafts.toArray();
      // Merge under anything already in memory: a draft saved while the read was
      // in flight is newer than the row it came from.
      const next = new Map(rows.map((d) => [d.articleUrl, d]));
      for (const [url, draft] of drafts) next.set(url, draft);
      drafts = next;
    } catch (e) {
      console.error('Failed to load share drafts:', e);
    }
  }

  function load(): Promise<void> {
    return (loadPromise ??= hydrate());
  }

  // Server traffic is skipped entirely when logged out, so the /dev/linkblog
  // harness and any signed-out surface keep working purely against Dexie.
  function canSync(): boolean {
    return auth.isAuthenticated && syncStore.isOnline;
  }

  function setLocal(draft: ShareDraft) {
    drafts.set(draft.articleUrl, draft);
    drafts = new Map(drafts);
  }

  function deleteLocal(articleUrl: string) {
    if (drafts.delete(articleUrl)) drafts = new Map(drafts);
  }

  /** Whether a remote row is usable as a draft (well-formed and not emptied out). */
  function remoteDraftIsLive(row: RemoteShareDraft): boolean {
    return (
      row.deletedAt === null &&
      !!row.draft &&
      Array.isArray(row.draft.blocks) &&
      draftHasContent(row.draft.blocks)
    );
  }

  async function mergeRemote(rows: RemoteShareDraft[]) {
    for (const row of rows) {
      const local = drafts.get(row.articleUrl);
      // The server's row is authoritative for its own key, and only the client
      // clock decides the winner — the server's second-resolution `updated_at`
      // is a cursor, not a merge input.
      const remoteClock = row.draft?.updatedAt ?? row.clientUpdatedAt;

      if (!remoteDraftIsLive(row)) {
        // A tombstone, or a row emptied out elsewhere — either way there is no
        // draft to show. Drop ours unless it is strictly newer, in which case
        // the local edit won and the one-time/queued push resurrects it.
        if (local && local.updatedAt > remoteClock) continue;
        deleteLocal(row.articleUrl);
        try {
          await db.shareDrafts.delete(row.articleUrl);
        } catch (e) {
          console.error('Failed to drop cached share draft:', e);
        }
        continue;
      }

      if (local && local.updatedAt >= remoteClock) continue;

      const merged = toPlain({ ...(row.draft as ShareDraft), articleUrl: row.articleUrl });
      setLocal(merged);
      try {
        await db.shareDrafts.put(merged);
      } catch (e) {
        console.error('Failed to cache share draft:', e);
      }
    }
  }

  // First sync on an upgraded client: drafts already in IndexedDB have never
  // been pushed anywhere. Without this they would stay marooned on whichever
  // device typed them — or, on a second device, be quietly outvoted by an empty
  // server state. Only runs on the no-cursor (full snapshot) path.
  async function uploadPreExisting(rows: RemoteShareDraft[]) {
    const remoteClocks = new Map(
      rows.map((row) => [row.articleUrl, row.draft?.updatedAt ?? row.clientUpdatedAt])
    );
    for (const draft of [...drafts.values()]) {
      if (!draftHasContent(draft.blocks)) continue;
      const remoteClock = remoteClocks.get(draft.articleUrl);
      if (remoteClock !== undefined && remoteClock >= draft.updatedAt) continue;
      await push(toPlain(draft));
    }
  }

  async function syncFromServer() {
    if (!cursorLoaded) {
      const persisted = await getMetadata<number>(CURSOR_KEY);
      if (typeof persisted === 'number') {
        cursor = persisted;
        cursorHasValue = true;
      }
      cursorLoaded = true;
    }

    const isFull = !cursorHasValue;
    const rows = await api.getAllShareDrafts(isFull ? {} : { since: cursor });

    let maxUpdatedAt = cursor;
    for (const row of rows) {
      if (row.serverUpdatedAt > maxUpdatedAt) maxUpdatedAt = row.serverUpdatedAt;
    }

    await mergeRemote(rows);
    if (isFull) await uploadPreExisting(rows);

    // Advance only after the merge: a cursor committed ahead of a failed merge
    // would skip those rows forever.
    if (maxUpdatedAt > cursor || !cursorHasValue) {
      cursor = maxUpdatedAt;
      cursorHasValue = true;
      await setMetadata(CURSOR_KEY, cursor);
    }
  }

  /**
   * Pull the account's drafts (full snapshot the first time, `?since=` delta
   * after) and merge them in. Safe to call on every refresh; concurrent callers
   * share one request.
   */
  function sync(): Promise<void> {
    if (!canSync()) return Promise.resolve();
    // Claimed synchronously: two refreshes firing in the same tick would both
    // get past an `await` before either had set the flag, and the second run's
    // merge would race the first one's cursor commit.
    if (syncInFlight) return syncInFlight;
    syncInFlight = (async () => {
      try {
        // The cache first, so the merge has something to resolve against.
        await load();
        await syncFromServer();
      } catch (e) {
        console.error('Failed to sync share drafts:', e);
      } finally {
        syncInFlight = null;
      }
    })();
    return syncInFlight;
  }

  async function push(draft: ShareDraft) {
    if (!auth.isAuthenticated) return;
    if (!syncStore.isOnline) {
      await syncQueue.enqueue('update', 'shareDraft', draft.articleUrl, draft);
      return;
    }
    try {
      await api.upsertShareDraft(draft);
    } catch (e) {
      console.error('Failed to sync share draft, queueing for retry:', e);
      await syncQueue.enqueue('update', 'shareDraft', draft.articleUrl, draft);
    }
  }

  function cancelPush(articleUrl: string) {
    const timer = pushTimers.get(articleUrl);
    if (timer) clearTimeout(timer);
    pushTimers.delete(articleUrl);
    pending.delete(articleUrl);
  }

  async function flushOne(articleUrl: string) {
    const draft = pending.get(articleUrl);
    cancelPush(articleUrl);
    if (draft) await push(draft);
  }

  function schedulePush(draft: ShareDraft) {
    pending.set(draft.articleUrl, draft);
    if (pushTimers.has(draft.articleUrl)) return;
    pushTimers.set(
      draft.articleUrl,
      setTimeout(() => void flushOne(draft.articleUrl), PUSH_THROTTLE_MS)
    );
  }

  /**
   * Send any throttled writes now. Drained on composer close/switch/post and on
   * `pagehide`, so words typed a second before the PWA is backgrounded still land.
   */
  async function flushServer(): Promise<void> {
    await Promise.all([...pending.keys()].map((url) => flushOne(url)));
  }

  function get(articleUrl: string): ShareDraft | undefined {
    return drafts.get(articleUrl);
  }

  /** Whether a resumable draft (with real content) exists for this article. */
  function hasDraft(articleUrl: string): boolean {
    const draft = drafts.get(articleUrl);
    return Boolean(draft && draftHasContent(draft.blocks));
  }

  async function save(draft: ShareDraft) {
    const plain = toPlain(draft);
    setLocal(plain);
    try {
      await db.shareDrafts.put(plain);
    } catch (e) {
      console.error('Failed to persist share draft:', e);
    }
    schedulePush(plain);
  }

  async function remove(articleUrl: string) {
    deleteLocal(articleUrl);
    try {
      await db.shareDrafts.delete(articleUrl);
    } catch (e) {
      console.error('Failed to delete share draft:', e);
    }

    // Drop the throttled upsert this delete supersedes. It would be rejected by
    // the server's clock guard anyway, but there is no reason to send it.
    cancelPush(articleUrl);
    if (!auth.isAuthenticated) return;

    // Stamped with the client clock so the delete is on the same last-write-wins
    // footing as an edit made on another device.
    const updatedAt = Date.now();
    const tombstone: ShareDraft = { articleUrl, blocks: [], createdAt: 0, updatedAt };
    if (!syncStore.isOnline) {
      await syncQueue.enqueue('delete', 'shareDraft', articleUrl, tombstone);
      return;
    }
    try {
      await api.deleteShareDraft(articleUrl, updatedAt);
    } catch (e) {
      console.error('Failed to delete share draft on the server, queueing for retry:', e);
      await syncQueue.enqueue('delete', 'shareDraft', articleUrl, tombstone);
    }
  }

  return {
    load,
    sync,
    flushServer,
    get,
    hasDraft,
    save,
    remove,
    get list() {
      return list;
    },
  };
}

export const shareDraftsStore = createShareDraftsStore();

// A backgrounded PWA can be frozen or killed without another chance to write, so
// drain the throttle on the way out. `visibilitychange` is the one that actually
// fires on mobile; `pagehide` covers the desktop tab-close. The local copy is
// already in IndexedDB either way — this is about the words reaching the account.
if (browser) {
  const drain = () => void shareDraftsStore.flushServer();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') drain();
  });
  window.addEventListener('pagehide', drain);
}
