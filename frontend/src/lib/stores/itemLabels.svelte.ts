import { api } from '$lib/services/api';
import { db, getMetadata, setMetadata } from '$lib/services/db';
import { safePut, safeBulkPut } from '$lib/services/safeDb.svelte';
import {
  planReadDelta,
  planAnnotatedReads,
  advanceCursor,
  mergeReadProgress,
  type ReadProgressProps,
} from '$lib/services/readDelta';
import {
  syncQueue,
  type ReadingPayload,
  type SocialReadingPayload,
  type LabelPayload,
} from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import { savesStore } from './saves.svelte';
import { generateTid } from '$lib/utils/tid';
import {
  mutateHighlightUnion,
  resolveHighlightAliases,
  savedItemLabelType,
  unionHighlightSources,
} from '$lib/utils/highlightAliases';
import type { ItemLabel, ItemLabelType, SocialItemType, Highlight, ReviewIntent } from '$lib/types';

const BULK_BATCH_SIZE = 500;

// Re-export for consumers that used this type from reading store
export interface SavedArticle {
  articleGuid: string;
  articleUrl?: string;
  articleTitle?: string;
  readAt: number;
}

function createItemLabelsStore() {
  // Primary state: all labels indexed by compound key "itemKey:label"
  let labelMap = $state<Map<string, ItemLabel>>(new Map());
  // Secondary index: itemKey → Set of labels
  let labelsByItem = $state<Map<string, Set<string>>>(new Map());
  let isLoading = $state(true);
  let hasLoaded = false;

  // Forward-read-delta cursor, persisted across sessions in IndexedDB (same
  // pattern as the managed-labels cursor). Bootstrap read state arrives via
  // inline annotation on the fetch response, so there is no full/windowed
  // snapshot: the cursor is *seeded* from the batch fetch's `readCursor`, then
  // every refresh fetches only the read changes since it (live rows +
  // tombstones), for both articles and documents. A client with no seeded cursor
  // yet skips the delta (annotation covers it) until the next refresh, by which
  // point the batch fetch has seeded it.
  //
  // The value is the server's opaque compound `(updated_at, id)` cursor — a bare
  // unix-seconds number only at seeding, and after the first delta always the
  // string the server handed back. Seconds alone couldn't express "everything
  // after this row", so any row written in the cursor's own second was dropped
  // and never asked for again.
  const READ_CURSOR_KEY = 'readPositionsCursor';
  let readPositionsCursor: number | string = 0;
  let readPositionsCursorLoaded = false;
  let readPositionsCursorHasValue = false;

  // Managed-labels (tagged/archived/readProgress) delta-sync cursor, same
  // compound form. Unlike read positions, this cursor is PERSISTED across
  // sessions in IndexedDB: the backend tombstones deletions, so the delta is
  // lossless and a cold start can resume from the saved cursor instead of
  // re-fetching the whole label history. A brand-new client (no saved cursor)
  // does one full snapshot to bootstrap; every sync after that is a delta.
  // Hydrated once per session from `MANAGED_LABELS_CURSOR_KEY`.
  const MANAGED_LABELS_CURSOR_KEY = 'managedLabelsCursor';
  let managedLabelsCursor: number | string = 0;
  let managedLabelsCursorLoaded = false;
  let managedLabelsCursorHasValue = false;

  // Debounce state for batching mark-read calls
  let pendingMarkRead: Array<{
    articleGuid: string;
    articleUrl: string;
    articleTitle?: string;
    // When the user actually read it, not when the debounce happened to flush.
    // Carried all the way to the server as the last-write-wins key.
    readAt: number;
  }> = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 300;

  // In-flight document mark-reads (itemUri), held from the moment the local read
  // label is added until its push to the server resolves. Documents push
  // immediately rather than through the debounce buffer above, so this is their
  // analog of pendingMarkRead for the forward-delta optimistic-race guard: a
  // stale tombstone on the delta must not clear a fresh local document read whose
  // push is still in flight.
  const pendingDocumentMarkRead = new Set<string>();

  // True while a just-marked local read for `key` is still being pushed (article
  // debounce buffer or in-flight document push). The forward delta skips
  // tombstone removals for such keys so it can't clear a read mid-flight.
  function isMarkReadInFlight(key: string): boolean {
    return (
      pendingDocumentMarkRead.has(key) || pendingMarkRead.some((item) => item.articleGuid === key)
    );
  }

  // When this device last marked an item UNREAD, unix ms. The mirror of the
  // in-flight read guard: removing the local `read` label leaves nothing behind
  // to compare a stale remote row against, so a delta carrying another device's
  // older read would silently re-read the item. Bounded and expiring — this is a
  // race window, not a second source of truth, and the server's own user-time
  // LWW settles the durable answer once the push lands.
  const UNREAD_INTENT_TTL_MS = 10 * 60 * 1000;
  const MAX_UNREAD_INTENTS = 500;
  const unreadIntent = new Map<string, number>();

  function recordUnreadIntent(key: string, at: number) {
    unreadIntent.set(key, at);
    if (unreadIntent.size > MAX_UNREAD_INTENTS) {
      // Map iterates in insertion order, so the head is the oldest.
      const oldest = unreadIntent.keys().next();
      if (!oldest.done) unreadIntent.delete(oldest.value);
    }
  }

  function unreadIntentAt(key: string): number | undefined {
    const at = unreadIntent.get(key);
    if (at === undefined) return undefined;
    if (Date.now() - at > UNREAD_INTENT_TTL_MS) {
      unreadIntent.delete(key);
      return undefined;
    }
    return at;
  }

  // --- Internal helpers ---

  function makeKey(itemKey: string, label: string): string {
    return `${itemKey}\0${label}`;
  }

  function addToState(lbl: ItemLabel) {
    const key = makeKey(lbl.itemKey, lbl.label);
    labelMap.set(key, lbl);

    let itemLabels = labelsByItem.get(lbl.itemKey);
    if (!itemLabels) {
      itemLabels = new Set();
      labelsByItem.set(lbl.itemKey, itemLabels);
    }
    itemLabels.add(lbl.label);
  }

  function removeFromState(itemKey: string, label: string) {
    const key = makeKey(itemKey, label);
    labelMap.delete(key);

    const itemLabels = labelsByItem.get(itemKey);
    if (itemLabels) {
      itemLabels.delete(label);
      if (itemLabels.size === 0) {
        labelsByItem.delete(itemKey);
      }
    }
  }

  function triggerReactivity() {
    labelMap = new Map(labelMap);
    labelsByItem = new Map(labelsByItem);
  }

  /**
   * Convert a server label row's timestamps to the store's unit at the boundary.
   *
   * The invariant is MILLISECONDS everywhere in the label store — that is what
   * every local write (`Date.now()`) already produced. Rows arriving from the
   * delta carried unix SECONDS, so a delta-written label and a locally-written
   * one were being compared across a factor of a thousand: `getReadActivity`
   * ranked any locally-touched item above every synced one, and the highlight
   * union's per-row recency ordering was decided by which device wrote last
   * rather than when. Converting here, once, is what makes the invariant true.
   */
  function localTimestamps(raw: { createdAt: number; updatedAt: number }): {
    createdAt: number;
    updatedAt: number;
  } {
    return { createdAt: raw.createdAt * 1000, updatedAt: raw.updatedAt * 1000 };
  }

  async function putLabel(lbl: ItemLabel) {
    addToState(lbl);
    await safePut(db.itemLabels, lbl);
  }

  async function deleteLabel(itemKey: string, label: string) {
    removeFromState(itemKey, label);
    try {
      await db.itemLabels.where('[itemKey+label]').equals([itemKey, label]).delete();
    } catch (e) {
      console.error('Failed to delete label from DB:', e);
    }
  }

  // --- Flush pending mark-read ---

  async function flushPendingMarkRead() {
    if (pendingMarkRead.length === 0) return;

    const itemsToFlush = [...pendingMarkRead];
    pendingMarkRead = [];
    debounceTimer = null;

    if (syncStore.isOnline) {
      try {
        const bulkItems = itemsToFlush.map((item) => ({
          itemGuid: item.articleGuid,
          itemUrl: item.articleUrl,
          itemTitle: item.articleTitle,
          updatedAt: item.readAt,
        }));
        for (let i = 0; i < bulkItems.length; i += BULK_BATCH_SIZE) {
          await api.markAsReadBulk(bulkItems.slice(i, i + BULK_BATCH_SIZE));
        }
      } catch (e) {
        console.error('Failed to mark as read (batch), queueing for retry:', e);
        for (const item of itemsToFlush) {
          await syncQueue.enqueue('create', 'reading', item.articleGuid, {
            articleGuid: item.articleGuid,
            articleUrl: item.articleUrl,
            articleTitle: item.articleTitle,
          } as ReadingPayload);
        }
      }
    } else {
      for (const item of itemsToFlush) {
        await syncQueue.enqueue('create', 'reading', item.articleGuid, {
          articleGuid: item.articleGuid,
          articleUrl: item.articleUrl,
          articleTitle: item.articleTitle,
        } as ReadingPayload);
      }
    }
  }

  // --- Load ---

  // Delta-only pull state. A full `load()` re-reads the whole Dexie table; this
  // is the cheap path the freshness triggers use — two indexed queries that
  // usually return zero rows.
  let deltaPullInFlight: Promise<void> | null = null;
  let lastDeltaPullAt = 0;

  /**
   * Pull both deltas without the local cache rebuild.
   *
   * Labels used to be pulled only at app init, on a manual refresh, on
   * tab-visible-and-≥30-minutes-stale, or through Chromium's periodic background
   * sync — so an open tab never observed another device's changes, and
   * "phone → laptop" felt broken even though the sync itself worked. There is no
   * push channel and deliberately none planned; a delta that finds nothing is
   * one indexed query returning zero rows, which is cheap enough to just ask.
   *
   * `minIntervalMs` lets a noisy trigger (visibility flapping) stay quiet
   * without each caller keeping its own timestamp. Concurrent calls share the
   * in-flight promise rather than racing two drains against one cursor.
   */
  async function pullDelta(minIntervalMs = 0): Promise<void> {
    if (!syncStore.isOnline) return;
    if (deltaPullInFlight) return deltaPullInFlight;
    if (minIntervalMs > 0 && Date.now() - lastDeltaPullAt < minIntervalMs) return;

    deltaPullInFlight = (async () => {
      try {
        await Promise.all([loadReadDeltaFromBackend(), loadManagedLabelsFromBackend()]);
        lastDeltaPullAt = Date.now();
        syncStore.markSynced();
      } catch (e) {
        console.error('Failed to pull label delta:', e);
      } finally {
        deltaPullInFlight = null;
      }
    })();
    return deltaPullInFlight;
  }

  async function load() {
    isLoading = true;

    // 1. Load from local IndexedDB cache first
    try {
      const allLabels = await db.itemLabels.toArray();
      if (allLabels.length > 0) {
        const newMap = new Map<string, ItemLabel>();
        const newByItem = new Map<string, Set<string>>();
        for (const lbl of allLabels) {
          newMap.set(makeKey(lbl.itemKey, lbl.label), lbl);
          let set = newByItem.get(lbl.itemKey);
          if (!set) {
            set = new Set();
            newByItem.set(lbl.itemKey, set);
          }
          set.add(lbl.label);
        }
        labelMap = newMap;
        labelsByItem = newByItem;
        isLoading = false;
      }
    } catch (e) {
      console.error('Failed to load item labels from cache:', e);
    }

    // 2. Fetch from backend and reconcile (skip when offline)
    if (syncStore.isOnline) {
      try {
        await Promise.all([loadReadDeltaFromBackend(), loadManagedLabelsFromBackend()]);
        hasLoaded = true;
      } catch (e) {
        console.error('Failed to load labels from backend:', e);
        if (labelMap.size > 0) {
          hasLoaded = true;
        }
      }
    } else {
      // Offline: use cached data
      hasLoaded = labelMap.size > 0;
    }

    isLoading = false;
  }

  // Seed the forward-read-delta cursor from the batch fetch's `readCursor` (server
  // time at annotation). Idempotent: only seeds if no cursor is set yet, so the
  // first annotated fetch establishes the delta's starting point with no clock
  // skew, and later fetches don't rewind it. Called by feedFetcher after a batch.
  async function seedReadCursor(cursor: number) {
    if (!cursor) return;
    if (!readPositionsCursorLoaded) {
      const persisted = await getMetadata<number | string>(READ_CURSOR_KEY);
      if (typeof persisted === 'number' || typeof persisted === 'string') {
        readPositionsCursor = persisted;
        readPositionsCursorHasValue = true;
      }
      readPositionsCursorLoaded = true;
    }
    if (readPositionsCursorHasValue) return;
    readPositionsCursor = cursor;
    readPositionsCursorHasValue = true;
    try {
      await setMetadata(READ_CURSOR_KEY, readPositionsCursor);
    } catch (e) {
      console.error('Failed to persist read cursor:', e);
    }
  }

  // Apply inline read annotation from a fetch response: mark the given keys read,
  // additively. Set only — never clears. Freshly-fetched items have no prior local
  // label to protect, and clears are the forward delta's job (cross-device
  // un-read), so additive merge stays race-free with a just-marked-read item.
  async function applyAnnotatedReads(keys: string[], itemType: ItemLabelType) {
    if (keys.length === 0) return;
    const dbOps = planAnnotatedReads(keys, itemType, {
      hasRead: (key) => hasLabel(key, 'read'),
      now: Date.now(),
    });
    if (dbOps.length === 0) return;
    for (const readLabel of dbOps) addToState(readLabel);
    triggerReactivity();
    try {
      await safeBulkPut(db.itemLabels, dbOps);
    } catch (e) {
      console.error('Failed to persist annotated reads to cache:', e);
    }
  }

  // Forward read delta: fetch every `read` change since our cursor — live rows
  // and tombstones — for both articles and documents, and apply them. Live rows
  // are added; tombstoned rows are removed (cross-device un-read), except for any
  // item with an in-flight local mark-read (optimistic-race guard: a stale
  // tombstone must not clear a fresh local read whose push is still in flight —
  // see isMarkReadInFlight, which covers both articles and documents). Closes the
  // only gap annotation can't: an already-cached item read or un-read on another
  // device, which this device won't re-fetch.
  // Rounds of the read-delta drain. A page is 500 rows, so this covers 5 000
  // read changes in one pull; anything beyond continues on the next one, in
  // order, because the cursor only ever sits on a row we actually applied.
  const MAX_READ_DELTA_PAGES = 10;

  async function loadReadDeltaFromBackend() {
    if (!readPositionsCursorLoaded) {
      const persisted = await getMetadata<number | string>(READ_CURSOR_KEY);
      if (typeof persisted === 'number' || typeof persisted === 'string') {
        readPositionsCursor = persisted;
        readPositionsCursorHasValue = true;
      }
      readPositionsCursorLoaded = true;
    }

    // No cursor yet → annotation covers bootstrap; the batch fetch will seed the
    // cursor this cycle, and the next refresh runs the delta from there.
    if (!readPositionsCursorHasValue) return;

    for (let round = 0; round < MAX_READ_DELTA_PAGES; round++) {
      const { positions, cursor, nextSince, hasMore } =
        await api.getReadPositions(readPositionsCursor);

      // Reconcile the delta into adds/removes. The race guards — an in-flight
      // local mark-read, a newer local read, a newer local un-read — all live in
      // planReadDelta.
      const { puts: dbPuts, deletes: dbDeletes } = planReadDelta(positions, {
        isInFlight: isMarkReadInFlight,
        now: Date.now(),
        localReadAt: (key) => getLabel(key, 'read')?.updatedAt,
        unreadIntentAt,
      });

      for (const readLabel of dbPuts) addToState(readLabel);
      for (const [itemKey, label] of dbDeletes) removeFromState(itemKey, label);

      triggerReactivity();

      // The cursor moves only after the batch is DURABLE. It used to advance in
      // a separate try, so a failed IndexedDB write lost the batch and still
      // skipped past it — permanently, since the delta is forward-only.
      try {
        for (const [itemKey, label] of dbDeletes) {
          await db.itemLabels.where('[itemKey+label]').equals([itemKey, label]).delete();
        }
        if (dbPuts.length > 0) {
          await safeBulkPut(db.itemLabels, dbPuts);
        }
      } catch (e) {
        console.error('Failed to sync read delta to cache; keeping cursor for retry:', e);
        return;
      }

      // Prefer the compound cursor. `advanceCursor` still guards the legacy
      // numeric one, whose forward-only comparison is all it ever had.
      let next: number | string | null = nextSince ?? null;
      if (next === null && typeof readPositionsCursor === 'number') {
        next = advanceCursor(readPositionsCursor, cursor);
      }
      if (next === null || next === readPositionsCursor) return;

      readPositionsCursor = next;
      try {
        await setMetadata(READ_CURSOR_KEY, readPositionsCursor);
      } catch (e) {
        console.error('Failed to persist read cursor:', e);
      }

      if (!hasMore) return;
    }
    console.warn('[itemLabels] Read delta page cap reached; the rest continues on the next pull.');
  }

  // The backend-managed (non-read) label types stored in item_labels_cache.
  // 'read' positions live in dedicated tables/endpoints. Everything else here
  // is fetched in a single pass. 'highlights' carries a Highlight[] array and
  // is merged by id (union) rather than overwritten — see the loop below.
  const MANAGED_LABELS = ['tagged', 'archived', 'readProgress', 'highlights'] as const;

  // Fetch managed labels in ONE paginated stream and reconcile each type,
  // instead of issuing a separate (paginated) /api/labels request per type.
  //
  // The cursor is persisted across sessions (see MANAGED_LABELS_CURSOR_KEY): a
  // brand-new client does one full snapshot to bootstrap, and every sync after
  // that — including cold starts — is a delta. Because the backend tombstones
  // deletions, deltas carry removals too (rows with `deletedAt` set), so there
  // is NO periodic full reconcile: cross-device deletes arrive in the delta.
  async function loadManagedLabelsFromBackend() {
    const managed = new Set<string>(MANAGED_LABELS);

    // Hydrate the persisted cursor once per session. A saved value means a prior
    // session already bootstrapped the full snapshot, so we can delta from here.
    if (!managedLabelsCursorLoaded) {
      const persisted = await getMetadata<number | string>(MANAGED_LABELS_CURSOR_KEY);
      if (typeof persisted === 'number' || typeof persisted === 'string') {
        managedLabelsCursor = persisted;
        managedLabelsCursorHasValue = true;
      }
      managedLabelsCursorLoaded = true;
    }

    // Restrict the fetch to our label types server-side. `item_labels_cache`
    // also holds `read` rows (owned by the reading route); without this filter
    // the delta would carry that read churn for the client to discard, and a big
    // enough batch could spill into extra pagination round-trips.
    const labels = [...MANAGED_LABELS];
    const isFull = !managedLabelsCursorHasValue;
    const { labels: fetched, nextSince } = await api.getAllLabels(
      isFull ? { labels } : { since: managedLabelsCursor, labels }
    );

    // Walk the fetched rows: apply tombstones as removals and group live rows by
    // type. (A full snapshot never contains tombstones — the backend filters
    // them — so the deletedAt branch only fires on deltas.)
    const removed: Array<[string, string]> = [];
    const byLabel = new Map<string, typeof fetched>();
    for (const raw of fetched) {
      if (!managed.has(raw.label)) continue;
      if (raw.deletedAt != null) {
        removeFromState(raw.itemKey, raw.label);
        removed.push([raw.itemKey, raw.label]);
        continue;
      }
      let arr = byLabel.get(raw.label);
      if (!arr) {
        arr = [];
        byLabel.set(raw.label, arr);
      }
      arr.push(raw);
    }

    // Upsert fetched labels (full and delta), normalising props per label type.
    const dbOps: ItemLabel[] = [];
    for (const raw of byLabel.get('tagged') || []) {
      const tags = (raw.props?.tags as string[]) || [];
      if (tags.length === 0) {
        // Defensive: an empty tag set means "untagged" — drop it locally.
        removeFromState(raw.itemKey, 'tagged');
        removed.push([raw.itemKey, 'tagged']);
        continue;
      }
      const lbl: ItemLabel = {
        itemKey: raw.itemKey,
        itemType: raw.itemType as ItemLabelType,
        label: 'tagged',
        props: { tags },
        ...localTimestamps(raw),
      };
      addToState(lbl);
      dbOps.push(lbl);
    }
    for (const raw of byLabel.get('archived') || []) {
      const lbl: ItemLabel = {
        itemKey: raw.itemKey,
        itemType: (raw.itemType as ItemLabelType) || 'article',
        label: 'archived',
        props: raw.props || {},
        ...localTimestamps(raw),
      };
      addToState(lbl);
      dbOps.push(lbl);
    }
    for (const raw of byLabel.get('readProgress') || []) {
      // Progress is merged by `lastReadAt`, not overwritten. The delta used to
      // clobber it unconditionally, so a device mid-scroll — its 500 ms debounce
      // still pending — was rewound to another device's older position and then
      // republished that older position as authoritative when the debounce
      // fired. Position may legitimately move backwards on a re-read, so
      // `lastReadAt` is the ordering and `paragraphIndex` never is.
      const remoteProps = (raw.props || {}) as ReadProgressProps;
      const localProps = getLabel(raw.itemKey, 'readProgress')?.props as
        ReadProgressProps | undefined;
      if (mergeReadProgress(localProps, remoteProps) === 'local') continue;
      const lbl: ItemLabel = {
        itemKey: raw.itemKey,
        itemType: (raw.itemType as ItemLabelType) || 'article',
        label: 'readProgress',
        props: raw.props || {},
        ...localTimestamps(raw),
      };
      addToState(lbl);
      dbOps.push(lbl);
    }
    // Highlights are a Highlight[] array, so we union with the local set by id
    // instead of overwriting — a highlight added on another device must never
    // clobber one added here. We use each highlight's own createdAt (epoch ms,
    // vs the row's updatedAt in unix seconds) to tell "the server hasn't seen
    // my new highlight yet" (keep it) from "this was deleted remotely after I
    // cached it" (drop it). Note: removing a SINGLE highlight from a multi-
    // highlight item may not propagate to a device that already cached it, since
    // union re-adds it; full clears do propagate via the deletedAt tombstone
    // above. Per-highlight tombstones would close that gap but are out of scope.
    for (const raw of byLabel.get('highlights') || []) {
      const serverHls = (raw.props?.highlights as Highlight[]) || [];
      const serverCutoffMs = raw.updatedAt * 1000;
      const byId = new Map<string, Highlight>(serverHls.map((h) => [h.id, h]));
      for (const h of rawHighlights(raw.itemKey)) {
        if (!byId.has(h.id) && h.createdAt > serverCutoffMs) byId.set(h.id, h);
      }
      const merged = [...byId.values()];
      if (merged.length === 0) {
        removeFromState(raw.itemKey, 'highlights');
        removed.push([raw.itemKey, 'highlights']);
        continue;
      }
      const lbl: ItemLabel = {
        itemKey: raw.itemKey,
        itemType: (raw.itemType as ItemLabelType) || 'article',
        label: 'highlights',
        props: { highlights: merged },
        ...localTimestamps(raw),
      };
      addToState(lbl);
      dbOps.push(lbl);
    }

    triggerReactivity();

    // Sync to IndexedDB, THEN move the cursor — never the other way round. The
    // cursor used to be committed in its own try, so a failed Dexie write lost
    // the batch and still advanced past it, permanently: the delta is
    // forward-only and never re-offers a row it has already delivered.
    try {
      for (const [itemKey, label] of removed) {
        await db.itemLabels.where('[itemKey+label]').equals([itemKey, label]).delete();
      }
      if (dbOps.length > 0) {
        await safeBulkPut(db.itemLabels, dbOps);
      }
    } catch (e) {
      console.error('Failed to sync managed labels to cache; keeping cursor for retry:', e);
      return;
    }

    // The cursor is the last row the server DELIVERED — compound `(updated_at,
    // id)`, so the next delta resumes strictly after it without dropping
    // same-second siblings. `nextSince` is absent only on an older backend; the
    // legacy max-updatedAt fallback keeps that case working.
    const nextCursor =
      nextSince ??
      fetched.reduce(
        (max, raw) => (raw.updatedAt > max ? raw.updatedAt : max),
        typeof managedLabelsCursor === 'number' ? managedLabelsCursor : 0
      );
    managedLabelsCursor = nextCursor;
    managedLabelsCursorHasValue = true;
    try {
      await setMetadata(MANAGED_LABELS_CURSOR_KEY, managedLabelsCursor);
    } catch (e) {
      console.error('Failed to persist managed labels cursor:', e);
    }
  }

  // --- Query methods ---

  function hasLabel(itemKey: string, label: string): boolean {
    return labelMap.has(makeKey(itemKey, label));
  }

  function getLabel(itemKey: string, label: string): ItemLabel | undefined {
    return labelMap.get(makeKey(itemKey, label));
  }

  function isRead(itemKey: string): boolean {
    return hasLabel(itemKey, 'read');
  }

  function isSaved(itemKey: string): boolean {
    return savesStore.isSaved(itemKey);
  }

  function isArchived(itemKey: string): boolean {
    return hasLabel(itemKey, 'archived');
  }

  function getTagsForItem(itemKey: string): string[] {
    const lbl = getLabel(itemKey, 'tagged');
    if (!lbl) return [];
    const tags = (lbl.props.tags as string[]) || [];
    return [...tags].sort();
  }

  function hasTag(itemKey: string, tag: string): boolean {
    const lbl = getLabel(itemKey, 'tagged');
    if (!lbl) return false;
    return ((lbl.props.tags as string[]) || []).includes(tag);
  }

  function itemHasAnyTag(itemKey: string, tags: string[]): boolean {
    const lbl = getLabel(itemKey, 'tagged');
    if (!lbl) return false;
    const itemTags = (lbl.props.tags as string[]) || [];
    return tags.some((t) => itemTags.includes(t));
  }

  // All highlights across every item, flattened to one entry per highlight.
  // Drives the standalone Highlights view; stays reactive off labelMap.
  let allHighlights = $derived.by(
    (): Array<{ itemKey: string; itemType: ItemLabelType; highlight: Highlight }> => {
      const out: Array<{ itemKey: string; itemType: ItemLabelType; highlight: Highlight }> = [];
      const emitted = new Set<string>();
      for (const [, lbl] of labelMap) {
        if (lbl.label !== 'highlights') continue;
        const context = highlightContext(lbl.itemKey);
        if (emitted.has(context.canonicalKey)) continue;
        emitted.add(context.canonicalKey);
        const itemType = context.labels.reduce(
          (newest, entry) => (entry.updatedAt > newest.updatedAt ? entry : newest),
          lbl
        ).itemType;
        const highlights = context.highlights;
        for (const highlight of highlights) {
          out.push({ itemKey: context.canonicalKey, itemType, highlight });
        }
      }
      return out;
    }
  );

  // All unique tags across all items
  let allTags = $derived.by((): string[] => {
    const tagSet = new Set<string>();
    for (const [, lbl] of labelMap) {
      if (lbl.label === 'tagged') {
        const tags = (lbl.props.tags as string[]) || [];
        for (const t of tags) {
          tagSet.add(t);
        }
      }
    }
    return [...tagSet].sort();
  });

  // --- Read positions map (for reactivity tracking in unreadCounts) ---
  // Returns a Map<articleGuid, { readAt }> — only read state, no starred/archived
  let readPositions = $derived.by(() => {
    const map = new Map<string, { readAt: number; itemUrl?: string; itemTitle?: string }>();

    for (const [, lbl] of labelMap) {
      if (lbl.itemType !== 'article') continue;
      if (lbl.label !== 'read') continue;

      map.set(lbl.itemKey, {
        readAt: (lbl.props.readAt as number) || 0,
        itemUrl: lbl.props.itemUrl as string | undefined,
        itemTitle: lbl.props.itemTitle as string | undefined,
      });
    }

    return map;
  });

  // Document read state, keyed by recordUri. Derived from labelMap so it stays
  // reactive (document reads now live in the unified label store, not a separate
  // map). Consumers (unreadCounts) only depend on this for reactivity + presence;
  // the actual read check is isSocialRead → hasLabel.
  let socialPositions = $derived.by(() => {
    const map = new Map<string, { readAt: unknown }>();
    for (const [, lbl] of labelMap) {
      if (lbl.itemType !== 'document') continue;
      if (lbl.label !== 'read') continue;
      map.set(lbl.itemKey, { readAt: lbl.props.readAt });
    }
    return map;
  });

  // Saved count: purely from saves
  let savedCount = $derived(savesStore.articles.length);

  // Inbox count: saved but not archived
  // Use itemGuid first for archive key, matching feedView.svelte.ts which stores
  // archive labels against the article guid, not the AT Protocol URI
  let inboxCount = $derived.by(() => {
    let count = 0;
    for (const bm of savesStore.articles) {
      const key = bm.itemGuid || bm.uri || '';
      if (key && !hasLabel(key, 'archived')) count++;
    }
    return count;
  });

  // Archived count (saved + archived)
  let archivedCount = $derived.by(() => {
    let count = 0;
    for (const [itemKey, labels] of labelsByItem) {
      if (labels.has('archived')) {
        if (savesStore.isSaved(itemKey)) count++;
      }
    }
    return count;
  });

  // --- Article read/unread mutations ---

  function markAsRead(
    _subscriptionAtUri: string,
    articleGuid: string,
    articleUrl: string,
    articleTitle?: string
  ) {
    if (isRead(articleGuid)) return;
    if (pendingMarkRead.some((item) => item.articleGuid === articleGuid)) return;

    const now = Date.now();
    const readLabel: ItemLabel = {
      itemKey: articleGuid,
      itemType: 'article',
      label: 'read',
      props: { readAt: now, itemUrl: articleUrl, itemTitle: articleTitle },
      createdAt: now,
      updatedAt: now,
    };

    addToState(readLabel);
    triggerReactivity();
    safePut(db.itemLabels, readLabel);

    pendingMarkRead.push({ articleGuid, articleUrl, articleTitle, readAt: now });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPendingMarkRead, DEBOUNCE_MS);
  }

  /**
   * Mark a set of articles read.
   *
   * `scope` turns this into a SERVER operation over the canonical per-feed
   * window rather than a loop over whatever this device happens to hold. That
   * distinction is the whole point: the local list stops at this device's
   * window, so items another device holds below it stayed unread there — the one
   * action that should force every device to agree didn't. The optimistic local
   * pass still runs first (the UI must not wait on a round trip), and the
   * per-item queue path is still the offline fallback.
   */
  async function markAllAsRead(
    articles: Array<{
      subscriptionRkey: string;
      articleGuid: string;
      articleUrl: string;
      articleTitle?: string;
    }>,
    scope?: { feedUrl?: string; beforeSeq?: number }
  ) {
    const unreadArticles = articles.filter((a) => !isRead(a.articleGuid));
    if (unreadArticles.length === 0) return;

    const now = Date.now();
    const dbOps: ItemLabel[] = [];

    for (const article of unreadArticles) {
      const readLabel: ItemLabel = {
        itemKey: article.articleGuid,
        itemType: 'article',
        label: 'read',
        props: {
          readAt: now,
          itemUrl: article.articleUrl,
          itemTitle: article.articleTitle,
        },
        createdAt: now,
        updatedAt: now,
      };
      addToState(readLabel);
      dbOps.push(readLabel);
    }
    triggerReactivity();

    if (dbOps.length > 0) {
      await safeBulkPut(db.itemLabels, dbOps);
    }

    if (syncStore.isOnline) {
      try {
        if (scope) {
          // One call covers the whole window, including items this device never
          // held; the resulting rows ride the existing forward delta out to
          // every other device.
          await api.markFeedRead({ ...scope, updatedAt: now });
        } else {
          const bulkItems = unreadArticles.map((a) => ({
            itemGuid: a.articleGuid,
            itemUrl: a.articleUrl,
            itemTitle: a.articleTitle,
            updatedAt: now,
          }));
          for (let i = 0; i < bulkItems.length; i += BULK_BATCH_SIZE) {
            await api.markAsReadBulk(bulkItems.slice(i, i + BULK_BATCH_SIZE));
          }
        }
      } catch (e) {
        console.error('Failed to mark all as read, queueing for retry:', e);
        for (const article of unreadArticles) {
          await syncQueue.enqueue('create', 'reading', article.articleGuid, {
            articleGuid: article.articleGuid,
            articleUrl: article.articleUrl,
            articleTitle: article.articleTitle,
          } as ReadingPayload);
        }
      }
    } else {
      for (const article of unreadArticles) {
        await syncQueue.enqueue('create', 'reading', article.articleGuid, {
          articleGuid: article.articleGuid,
          articleUrl: article.articleUrl,
          articleTitle: article.articleTitle,
        } as ReadingPayload);
      }
    }
  }

  async function markAsUnread(articleGuid: string) {
    if (!isRead(articleGuid)) return;

    const now = Date.now();
    removeFromState(articleGuid, 'read');
    // Removing the label leaves nothing for the delta to compare against, so
    // remember the intent for the length of the race window.
    recordUnreadIntent(articleGuid, now);
    triggerReactivity();

    try {
      await db.itemLabels.where('[itemKey+label]').equals([articleGuid, 'read']).delete();
    } catch (e) {
      console.error('Failed to remove read label from DB:', e);
    }

    if (syncStore.isOnline) {
      try {
        await api.markAsUnread(articleGuid, now);
      } catch (e) {
        console.error('Failed to mark as unread, queueing for retry:', e);
        await syncQueue.enqueue('delete', 'reading', articleGuid, {
          articleGuid,
        } as ReadingPayload);
      }
    } else {
      await syncQueue.enqueue('delete', 'reading', articleGuid, {
        articleGuid,
      } as ReadingPayload);
    }
  }

  // --- Save mutations (decoupled from read state) ---
  // All save operations now delegate to savesStore (saved_articles is the sole source of truth)

  type SaveMeta =
    | {
        type: 'article';
        guid: string;
        subscriptionId?: number;
        url: string;
        title?: string;
        author?: string;
        summary?: string;
        imageUrl?: string;
        publishedAt?: string;
      }
    | {
        type: 'document';
        recordUri: string;
        url: string;
        title?: string;
        description?: string;
        publishedAt?: string;
        // Pre-rendered body HTML, when the caller has the full document (e.g. a
        // saved collection piece). Persisted as the saved copy's content.
        content?: string;
      };

  async function toggleSave(
    itemKey: string,
    _itemType: ItemLabelType = 'article',
    _itemUrl?: string,
    _itemTitle?: string,
    saveMeta?: SaveMeta
  ) {
    const wasSaved = isSaved(itemKey);

    if (!saveMeta) {
      // No metadata — can only unsave
      if (wasSaved) {
        await savesStore.unsaveByGuid(itemKey);
      }
      return;
    }

    if (saveMeta.type === 'article') {
      if (!wasSaved) {
        await savesStore.saveArticle(saveMeta);
      } else {
        await savesStore.unsaveByGuid(saveMeta.guid);
      }
    } else if (saveMeta.type === 'document') {
      if (!wasSaved) {
        await savesStore.saveDocument(saveMeta);
      } else {
        await savesStore.unsaveByGuid(saveMeta.recordUri);
      }
    }
  }

  // --- Archive mutations ---

  async function syncArchiveToBackend(
    itemKey: string,
    archived: boolean,
    itemType: ItemLabelType = 'article'
  ) {
    const payload: LabelPayload = {
      itemKey,
      itemType,
      label: 'archived',
      props: { archivedAt: Date.now() },
    };
    if (archived) {
      if (syncStore.isOnline) {
        try {
          await api.addLabel({
            itemKey,
            itemType: 'article',
            label: 'archived',
            props: payload.props,
          });
        } catch (e) {
          console.error('Failed to sync archive label, queueing for retry:', e);
          await syncQueue.enqueue('create', 'label', `${itemKey}\0archived`, payload);
        }
      } else {
        await syncQueue.enqueue('create', 'label', `${itemKey}\0archived`, payload);
      }
    } else {
      if (syncStore.isOnline) {
        try {
          await api.deleteLabel(itemKey, 'archived');
        } catch (e) {
          console.error('Failed to delete archive label, queueing for retry:', e);
          await syncQueue.enqueue('delete', 'label', `${itemKey}\0archived`, payload);
        }
      } else {
        await syncQueue.enqueue('delete', 'label', `${itemKey}\0archived`, payload);
      }
    }
  }

  async function toggleArchive(itemKey: string, itemType: ItemLabelType = 'article') {
    const wasArchived = isArchived(itemKey);
    const now = Date.now();

    if (wasArchived) {
      removeFromState(itemKey, 'archived');
      await deleteLabel(itemKey, 'archived');
    } else {
      const label: ItemLabel = {
        itemKey,
        itemType,
        label: 'archived',
        props: { archivedAt: now },
        createdAt: now,
        updatedAt: now,
      };
      addToState(label);
      await safePut(db.itemLabels, label);
    }
    triggerReactivity();

    await syncArchiveToBackend(itemKey, !wasArchived, itemType);
  }

  async function archiveItem(itemKey: string, itemType: ItemLabelType = 'article') {
    if (isArchived(itemKey)) return;
    const now = Date.now();
    const label: ItemLabel = {
      itemKey,
      itemType,
      label: 'archived',
      props: { archivedAt: now },
      createdAt: now,
      updatedAt: now,
    };
    addToState(label);
    triggerReactivity();
    await safePut(db.itemLabels, label);

    await syncArchiveToBackend(itemKey, true, itemType);
  }

  async function unarchiveItem(itemKey: string, itemType: ItemLabelType = 'article') {
    if (!isArchived(itemKey)) return;
    removeFromState(itemKey, 'archived');
    triggerReactivity();
    await deleteLabel(itemKey, 'archived');

    await syncArchiveToBackend(itemKey, false, itemType);
  }

  // --- Tag mutations ---

  async function syncTaggedLabel(itemKey: string, itemType: ItemLabelType, tags: string[]) {
    const payload: LabelPayload = {
      itemKey,
      itemType,
      label: 'tagged',
      props: { tags },
    };
    if (tags.length === 0) {
      // No tags left — delete the label
      if (syncStore.isOnline) {
        try {
          await api.deleteLabel(itemKey, 'tagged');
        } catch (e) {
          console.error('Failed to delete tagged label, queueing for retry:', e);
          await syncQueue.enqueue('delete', 'label', `${itemKey}\0tagged`, payload);
        }
      } else {
        await syncQueue.enqueue('delete', 'label', `${itemKey}\0tagged`, payload);
      }
    } else {
      // Upsert the tagged label with current tags
      if (syncStore.isOnline) {
        try {
          await api.addLabel({
            itemKey,
            itemType,
            label: 'tagged',
            props: { tags },
          });
        } catch (e) {
          console.error('Failed to sync tagged label, queueing for retry:', e);
          await syncQueue.enqueue('create', 'label', `${itemKey}\0tagged`, payload);
        }
      } else {
        await syncQueue.enqueue('create', 'label', `${itemKey}\0tagged`, payload);
      }
    }
  }

  async function addTag(itemKey: string, itemType: ItemLabelType, tag: string) {
    const trimmed = tag.trim().slice(0, 64);
    if (!trimmed) return;
    if (hasTag(itemKey, trimmed)) return;

    // Max 10 tags per item
    const currentTags = getTagsForItem(itemKey);
    if (currentTags.length >= 10) return;

    const now = Date.now();
    const newTags = [...currentTags, trimmed];
    const existing = getLabel(itemKey, 'tagged');

    const label: ItemLabel = {
      itemKey,
      itemType: existing?.itemType || itemType,
      label: 'tagged',
      props: { tags: newTags },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    addToState(label);
    triggerReactivity();
    await safePut(db.itemLabels, label);

    await syncTaggedLabel(itemKey, label.itemType as ItemLabelType, newTags);
  }

  async function removeTag(itemKey: string, tag: string) {
    if (!hasTag(itemKey, tag)) return;

    const existing = getLabel(itemKey, 'tagged')!;
    const currentTags = (existing.props.tags as string[]) || [];
    const newTags = currentTags.filter((t) => t !== tag);
    const now = Date.now();

    if (newTags.length === 0) {
      removeFromState(itemKey, 'tagged');
      triggerReactivity();
      try {
        await db.itemLabels.where('[itemKey+label]').equals([itemKey, 'tagged']).delete();
      } catch (e) {
        console.error('Failed to delete tagged label from DB:', e);
      }
    } else {
      const label: ItemLabel = {
        ...existing,
        props: { tags: newTags },
        updatedAt: now,
      };
      addToState(label);
      triggerReactivity();
      await safePut(db.itemLabels, label);
    }

    await syncTaggedLabel(itemKey, existing.itemType as ItemLabelType, newTags);
  }

  async function toggleTag(itemKey: string, itemType: ItemLabelType, tag: string) {
    if (hasTag(itemKey, tag)) {
      await removeTag(itemKey, tag);
    } else {
      await addTag(itemKey, itemType, tag);
    }
  }

  async function deleteTagFromAll(tag: string) {
    // Find all items that have this tag
    const toUpdate: Array<{ itemKey: string; lbl: ItemLabel }> = [];
    for (const [, lbl] of labelMap) {
      if (lbl.label === 'tagged') {
        const tags = (lbl.props.tags as string[]) || [];
        if (tags.includes(tag)) {
          toUpdate.push({ itemKey: lbl.itemKey, lbl });
        }
      }
    }

    const now = Date.now();
    for (const { itemKey, lbl } of toUpdate) {
      const currentTags = (lbl.props.tags as string[]) || [];
      const newTags = currentTags.filter((t) => t !== tag);

      if (newTags.length === 0) {
        removeFromState(itemKey, 'tagged');
        try {
          await db.itemLabels.where('[itemKey+label]').equals([itemKey, 'tagged']).delete();
        } catch (e) {
          console.error('Failed to delete tagged label from DB:', e);
        }
      } else {
        const updated: ItemLabel = {
          ...lbl,
          props: { tags: newTags },
          updatedAt: now,
        };
        addToState(updated);
        await safePut(db.itemLabels, updated);
      }

      await syncTaggedLabel(itemKey, lbl.itemType as ItemLabelType, newTags);
    }

    triggerReactivity();
  }

  // --- Social reading mutations ---

  function isSocialRead(itemUri: string): boolean {
    return hasLabel(itemUri, 'read');
  }

  async function markSocialAsRead(
    type: SocialItemType,
    itemUri: string,
    authorDid: string,
    itemUrl: string,
    itemTitle?: string
  ) {
    if (isSocialRead(itemUri)) return;

    const rkey = generateTid();
    const now = Date.now();
    const nowIso = new Date().toISOString();

    const itemType: ItemLabelType = 'document';
    const readLabel: ItemLabel = {
      itemKey: itemUri,
      itemType,
      label: 'read',
      props: {
        readAt: nowIso,
        rkey,
        authorDid,
        itemUrl,
        itemTitle,
      },
      createdAt: now,
      updatedAt: now,
    };

    addToState(readLabel);
    // Guard the optimistic local read against a concurrent forward delta until
    // its push resolves (see isMarkReadInFlight / loadReadDeltaFromBackend).
    pendingDocumentMarkRead.add(itemUri);
    triggerReactivity();
    await safePut(db.itemLabels, readLabel);

    const payload: SocialReadingPayload = {
      type,
      rkey,
      itemUri,
      authorDid,
      itemUrl:
        itemUrl && (itemUrl.startsWith('http://') || itemUrl.startsWith('https://'))
          ? itemUrl
          : undefined,
      itemTitle: itemTitle || undefined,
    };

    // Document reads are unified onto the article read path: the same
    // /api/reading writers, parameterized by itemType. The sync-queue
    // 'socialReading' collection routes to those writers too.
    try {
      if (syncStore.isOnline) {
        try {
          await api.markAsRead({
            itemGuid: itemUri,
            itemType: 'document',
            rkey,
            authorDid,
            itemUrl: payload.itemUrl,
            itemTitle: payload.itemTitle,
          });
        } catch (e) {
          console.error('Failed to mark social item as read, queueing for retry:', e);
          await syncQueue.enqueue('create', 'socialReading', itemUri, payload);
        }
      } else {
        await syncQueue.enqueue('create', 'socialReading', itemUri, payload);
      }
    } finally {
      pendingDocumentMarkRead.delete(itemUri);
    }
  }

  async function markAllSocialAsRead(
    items: Array<{
      type: SocialItemType;
      itemUri: string;
      authorDid: string;
      itemUrl: string;
      itemTitle?: string;
    }>
  ) {
    const unreadItems = items.filter((item) => !isSocialRead(item.itemUri));
    if (unreadItems.length === 0) return;

    const now = Date.now();
    const nowIso = new Date().toISOString();
    const itemsWithRkeys = unreadItems.map((item) => ({
      ...item,
      rkey: generateTid(),
    }));

    const dbOps: ItemLabel[] = [];

    for (const item of itemsWithRkeys) {
      const itemType: ItemLabelType = 'document';
      const readLabel: ItemLabel = {
        itemKey: item.itemUri,
        itemType,
        label: 'read',
        props: {
          readAt: nowIso,
          rkey: item.rkey,
          authorDid: item.authorDid,
          itemUrl: item.itemUrl,
          itemTitle: item.itemTitle,
        },
        createdAt: now,
        updatedAt: now,
      };
      addToState(readLabel);
      dbOps.push(readLabel);
    }

    // Guard each optimistic local read against a concurrent forward delta until
    // the bulk push resolves (see isMarkReadInFlight / loadReadDeltaFromBackend).
    for (const item of itemsWithRkeys) pendingDocumentMarkRead.add(item.itemUri);
    triggerReactivity();

    if (dbOps.length > 0) {
      await safeBulkPut(db.itemLabels, dbOps);
    }

    // Build API payloads
    const apiItems = itemsWithRkeys.map((item) => ({
      type: item.type,
      rkey: item.rkey,
      itemUri: item.itemUri,
      authorDid: item.authorDid,
      itemUrl:
        item.itemUrl && (item.itemUrl.startsWith('http://') || item.itemUrl.startsWith('https://'))
          ? item.itemUrl
          : undefined,
      itemTitle: item.itemTitle || undefined,
    }));

    try {
      if (syncStore.isOnline) {
        try {
          for (let i = 0; i < apiItems.length; i += BULK_BATCH_SIZE) {
            // Unified read path: documents bulk-mark through /api/reading too.
            await api.markAsReadBulk(
              apiItems.slice(i, i + BULK_BATCH_SIZE).map((item) => ({
                itemGuid: item.itemUri,
                itemType: 'document' as const,
                rkey: item.rkey,
                authorDid: item.authorDid,
                itemUrl: item.itemUrl,
                itemTitle: item.itemTitle,
              }))
            );
          }
        } catch (e) {
          console.error('Failed to bulk mark social items as read, queueing for retry:', e);
          for (const item of apiItems) {
            await syncQueue.enqueue(
              'create',
              'socialReading',
              item.itemUri,
              item as SocialReadingPayload
            );
          }
        }
      } else {
        for (const item of apiItems) {
          await syncQueue.enqueue(
            'create',
            'socialReading',
            item.itemUri,
            item as SocialReadingPayload
          );
        }
      }
    } finally {
      for (const item of itemsWithRkeys) pendingDocumentMarkRead.delete(item.itemUri);
    }
  }

  async function markSocialAsUnread(itemUri: string) {
    const readLabel = getLabel(itemUri, 'read');
    if (!readLabel) return;

    const rkey = (readLabel.props.rkey as string) || '';
    const authorDid = (readLabel.props.authorDid as string) || '';

    const now = Date.now();
    removeFromState(itemUri, 'read');
    // Same guard as articles: the removed label leaves nothing for the delta to
    // compare against, so the un-read intent is remembered for the race window.
    recordUnreadIntent(itemUri, now);
    triggerReactivity();

    try {
      await db.itemLabels.where('[itemKey+label]').equals([itemUri, 'read']).delete();
    } catch (e) {
      console.error('Failed to remove social read label from DB:', e);
    }

    const payload: SocialReadingPayload = {
      type: 'document',
      rkey,
      itemUri,
      authorDid,
    };

    // Unified unread: keyed by itemUri (item_key), so it goes through the same
    // soft-delete writer as articles. The backend tombstones the row so the
    // un-read carries on the forward read delta to other devices.
    if (syncStore.isOnline) {
      try {
        await api.markAsUnread(itemUri, now);
      } catch (e) {
        console.error('Failed to mark social item as unread, queueing for retry:', e);
        await syncQueue.enqueue('delete', 'socialReading', itemUri, payload);
      }
    } else {
      await syncQueue.enqueue('delete', 'socialReading', itemUri, payload);
    }
  }

  // --- Read progress tracking ---

  let readProgressDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const READ_PROGRESS_DEBOUNCE_MS = 500;

  async function persistReadProgress(
    itemKey: string,
    itemType: ItemLabelType,
    paragraphIndex: number,
    totalParagraphs: number
  ) {
    const current = getReadProgress(itemKey);
    const now = Date.now();
    const lbl: ItemLabel = {
      itemKey,
      itemType,
      label: 'readProgress',
      props: { paragraphIndex, totalParagraphs, lastReadAt: now },
      createdAt: current ? (labelMap.get(makeKey(itemKey, 'readProgress'))?.createdAt ?? now) : now,
      updatedAt: now,
    };
    await putLabel(lbl);
    triggerReactivity();

    const props = { paragraphIndex, totalParagraphs, lastReadAt: now };
    if (syncStore.isOnline) {
      try {
        await api.addLabel({
          itemKey,
          itemType,
          label: 'readProgress',
          props,
          updatedAt: now,
        });
      } catch (e) {
        console.error('Failed to sync read progress, queueing for retry:', e);
        await syncQueue.enqueue('create', 'label', `${itemKey}\0readProgress`, {
          itemKey,
          itemType,
          label: 'readProgress',
          props,
        } as LabelPayload);
      }
    } else {
      await syncQueue.enqueue('create', 'label', `${itemKey}\0readProgress`, {
        itemKey,
        itemType,
        label: 'readProgress',
        props,
      } as LabelPayload);
    }
  }

  function getReadProgress(
    itemKey: string
  ): { paragraphIndex: number; totalParagraphs: number } | null {
    const lbl = labelMap.get(makeKey(itemKey, 'readProgress'));
    if (!lbl) return null;
    return {
      paragraphIndex: lbl.props.paragraphIndex as number,
      totalParagraphs: lbl.props.totalParagraphs as number,
    };
  }

  // Most recent reading activity for an item, resolved across the several keys a
  // single logical item can be addressed by (a saved feed article is keyed by its
  // guid in one place and by the save's AT-URI in another). Returns the newest
  // `readAt` (finished) or `lastReadAt` (in-progress) timestamp seen across those
  // keys, plus the current scroll progress when one exists. Returns null when the
  // item has never been opened. Drives the Home "Continue reading" lane.
  // Reads labelMap directly so it stays reactive when called inside a $derived.
  function getReadActivity(itemKeys: string[]): {
    lastActivityAt: number;
    progress: { paragraphIndex: number; totalParagraphs: number } | null;
  } | null {
    let lastActivityAt = 0;
    let progress: { paragraphIndex: number; totalParagraphs: number } | null = null;

    for (const key of itemKeys) {
      if (!key) continue;

      const read = labelMap.get(makeKey(key, 'read'));
      if (read) {
        const at = (read.props.readAt as number) || read.updatedAt || 0;
        if (at > lastActivityAt) lastActivityAt = at;
      }

      const rp = labelMap.get(makeKey(key, 'readProgress'));
      if (rp) {
        const at = (rp.props.lastReadAt as number) || rp.updatedAt || 0;
        if (at > lastActivityAt) lastActivityAt = at;
        const paragraphIndex = rp.props.paragraphIndex as number;
        const totalParagraphs = rp.props.totalParagraphs as number;
        if (typeof paragraphIndex === 'number' && typeof totalParagraphs === 'number') {
          progress = { paragraphIndex, totalParagraphs };
        }
      }
    }

    if (lastActivityAt === 0) return null;
    return { lastActivityAt, progress };
  }

  function setReadProgress(
    itemKey: string,
    itemType: ItemLabelType,
    paragraphIndex: number,
    totalParagraphs: number
  ) {
    // Skip only when NOTHING changed. Comparing paragraphIndex alone dropped
    // updates that carried a corrected `totalParagraphs` — the reader learns the
    // real total after layout, so the first write for an article was usually the
    // one with the wrong denominator, and it was the one that stuck.
    const current = getReadProgress(itemKey);
    if (
      current &&
      paragraphIndex === current.paragraphIndex &&
      totalParagraphs === current.totalParagraphs
    ) {
      return;
    }

    // Debounce the actual persist
    if (readProgressDebounceTimer) clearTimeout(readProgressDebounceTimer);
    readProgressDebounceTimer = setTimeout(
      () => void persistReadProgress(itemKey, itemType, paragraphIndex, totalParagraphs),
      READ_PROGRESS_DEBOUNCE_MS
    );
  }

  // Record that a combined reading surface reached this item without inventing
  // paragraph progress. The sentinel (-1 / 0) is visible to getReadActivity,
  // but ignored by the single-article reader's restore/progress calculations.
  function markOpened(itemKey: string, itemType: ItemLabelType) {
    if (getReadActivity([itemKey])) return;
    void persistReadProgress(itemKey, itemType, -1, 0);
  }

  // --- Highlight mutations ---

  // A logical item can be addressed by more than one key: a saved feed article is
  // keyed by its guid on the feed card/reader, but by the save's AT-URI in the
  // saved-list reader. We store every highlight under ONE canonical key — the
  // guid when a save bridges to one, else the key itself — so a single item never
  // splits into two rows. This resolves any incoming key (guid or uri) to that
  // canonical key; an item with no save (or no guid) resolves to itself.
  // Depends on savesStore being loaded: a highlight created before saves hydrate
  // resolves to its uri and is folded back under the guid by a later write.
  function canonicalKey(itemKey: string): string {
    return resolveHighlightAliases(itemKey, savesStore.articles).canonicalKey;
  }

  // Exact-key read. Used by reconcile (which reconciles each server row by its
  // own key) and internally by the mutations after they've canonicalized.
  function rawHighlights(key: string): Highlight[] {
    const lbl = getLabel(key, 'highlights');
    return lbl ? (lbl.props.highlights as Highlight[]) || [] : [];
  }

  function highlightContext(itemKey: string) {
    const resolution = resolveHighlightAliases(itemKey, savesStore.articles);
    const labels = resolution.keys
      .map((key) => getLabel(key, 'highlights'))
      .filter((label): label is ItemLabel => Boolean(label));
    const highlights = unionHighlightSources(
      labels.map((label) => ({
        key: label.itemKey,
        updatedAt: label.updatedAt,
        highlights: (label.props.highlights as Highlight[]) || [],
      }))
    );
    return { ...resolution, labels, highlights };
  }

  // Public read: callers may hold a guid or a uri — serve the union of every
  // alias row. This keeps URI-keyed highlights visible when saves hydrate later
  // and reveal that the canonical key is the article guid.
  function getHighlights(itemKey: string): Highlight[] {
    return highlightContext(itemKey).highlights;
  }

  function hasHighlights(itemKey: string): boolean {
    return getHighlights(itemKey).length > 0;
  }

  /**
   * Push the current highlights array for an item to the backend so it syncs
   * across devices. Mirrors syncTaggedLabel / syncArchiveToBackend: direct API
   * call when online, fall back to the sync queue (collection 'label') on
   * failure or when offline. An empty array deletes the label (tombstone).
   */
  async function syncHighlightsToBackend(
    itemKey: string,
    itemType: ItemLabelType,
    highlights: Highlight[]
  ) {
    const payload: LabelPayload = {
      itemKey,
      itemType,
      label: 'highlights',
      props: { highlights },
    };
    if (highlights.length === 0) {
      if (syncStore.isOnline) {
        try {
          await api.deleteLabel(itemKey, 'highlights');
        } catch (e) {
          console.error('Failed to delete highlights label, queueing for retry:', e);
          await syncQueue.enqueue('delete', 'label', `${itemKey}\0highlights`, payload);
        }
      } else {
        await syncQueue.enqueue('delete', 'label', `${itemKey}\0highlights`, payload);
      }
    } else {
      if (syncStore.isOnline) {
        try {
          await api.addLabel({ itemKey, itemType, label: 'highlights', props: { highlights } });
        } catch (e) {
          console.error('Failed to sync highlights label, queueing for retry:', e);
          await syncQueue.enqueue('create', 'label', `${itemKey}\0highlights`, payload);
        }
      } else {
        await syncQueue.enqueue('create', 'label', `${itemKey}\0highlights`, payload);
      }
    }
  }

  async function persistHighlightUnion(
    itemKey: string,
    itemType: ItemLabelType,
    highlights: Highlight[]
  ) {
    const context = highlightContext(itemKey);
    const canonicalExisting = context.labels.find(
      (label) => label.itemKey === context.canonicalKey
    );
    const newestExisting = context.labels.reduce<ItemLabel | undefined>(
      (newest, label) => (!newest || label.updatedAt > newest.updatedAt ? label : newest),
      undefined
    );
    const resolvedType = canonicalExisting?.itemType || newestExisting?.itemType || itemType;
    const aliasKeys = context.keys.filter((key) => key !== context.canonicalKey);

    if (highlights.length > 0) {
      const now = Date.now();
      const createdAt = context.labels.reduce(
        (oldest, label) => Math.min(oldest, label.createdAt),
        canonicalExisting?.createdAt || newestExisting?.createdAt || now
      );
      const canonicalLabel: ItemLabel = {
        itemKey: context.canonicalKey,
        itemType: resolvedType,
        label: 'highlights',
        props: { highlights },
        createdAt,
        updatedAt: now,
      };

      // Write the canonical row before deleting aliases so a failed local write
      // never strands the only copy of a highlight.
      addToState(canonicalLabel);
      triggerReactivity();
      await safePut(db.itemLabels, canonicalLabel);
      for (const aliasKey of aliasKeys) removeFromState(aliasKey, 'highlights');
      triggerReactivity();
      for (const aliasKey of aliasKeys) {
        try {
          await db.itemLabels.where('[itemKey+label]').equals([aliasKey, 'highlights']).delete();
        } catch (error) {
          console.error('Failed to delete migrated highlights alias from DB:', error);
        }
      }

      // Preserve ordering remotely too: publish the union under the canonical
      // key, then tombstone every alias via the normal API/queue path.
      void (async () => {
        await syncHighlightsToBackend(context.canonicalKey, resolvedType, highlights);
        for (const aliasKey of aliasKeys) {
          await syncHighlightsToBackend(aliasKey, resolvedType, []);
        }
      })();
      return;
    }

    for (const key of context.keys) removeFromState(key, 'highlights');
    triggerReactivity();
    for (const key of context.keys) {
      try {
        await db.itemLabels.where('[itemKey+label]').equals([key, 'highlights']).delete();
      } catch (error) {
        console.error('Failed to delete highlights label from DB:', error);
      }
    }
    void (async () => {
      for (const key of context.keys) await syncHighlightsToBackend(key, resolvedType, []);
    })();
  }

  async function addHighlight(itemKey: string, itemType: ItemLabelType, highlight: Highlight) {
    const mutation = mutateHighlightUnion(getHighlights(itemKey), { type: 'add', highlight });
    await persistHighlightUnion(itemKey, itemType, mutation.highlights);
  }

  /**
   * Add several highlights to one item in a single union write. Used by the
   * Margin import, where a heavily-annotated article can arrive with dozens of
   * highlights at once and one write per highlight would mean one API round trip
   * (and one full-array rewrite) each.
   */
  async function addHighlights(itemKey: string, itemType: ItemLabelType, highlights: Highlight[]) {
    if (highlights.length === 0) return;
    let merged = getHighlights(itemKey);
    for (const highlight of highlights) {
      merged = mutateHighlightUnion(merged, { type: 'add', highlight }).highlights;
    }
    await persistHighlightUnion(itemKey, itemType, merged);
  }

  async function removeHighlight(itemKey: string, highlightId: string) {
    const context = highlightContext(itemKey);
    const mutation = mutateHighlightUnion(context.highlights, { type: 'remove', highlightId });
    if (!mutation.changed) return;
    await persistHighlightUnion(
      itemKey,
      context.labels[0]?.itemType || 'saved',
      mutation.highlights
    );
  }

  /**
   * Record (or clear) the Margin sync state for a single highlight — persists
   * the at.margin.note uri/rkey so the UI can show "saved" state and later
   * delete the note. Synced to the backend with the rest of the highlights.
   */
  async function setHighlightMargin(
    itemKey: string,
    highlightId: string,
    margin: { uri: string; rkey: string } | null
  ) {
    const context = highlightContext(itemKey);
    const mutation = mutateHighlightUnion(context.highlights, {
      type: 'margin',
      highlightId,
      margin,
    });
    if (!mutation.changed) return;
    await persistHighlightUnion(
      itemKey,
      context.labels[0]?.itemType || 'saved',
      mutation.highlights
    );
  }

  /**
   * Set (or clear) the note attached to a single highlight, then persist and
   * sync. Pass an empty/whitespace note to drop the field entirely. The Margin
   * note record (if any) is updated separately by the caller.
   */
  async function setHighlightNote(itemKey: string, highlightId: string, note: string | undefined) {
    const context = highlightContext(itemKey);
    const mutation = mutateHighlightUnion(context.highlights, {
      type: 'note',
      highlightId,
      note,
    });
    if (!mutation.changed) return;
    await persistHighlightUnion(
      itemKey,
      context.labels[0]?.itemType || 'saved',
      mutation.highlights
    );
  }

  async function setHighlightSelector(
    itemKey: string,
    highlightId: string,
    selector: Highlight['selector']
  ) {
    const context = highlightContext(itemKey);
    const mutation = mutateHighlightUnion(context.highlights, {
      type: 'selector',
      highlightId,
      selector,
    });
    if (!mutation.changed) return;
    await persistHighlightUnion(
      itemKey,
      context.labels[0]?.itemType || 'saved',
      mutation.highlights
    );
  }

  /**
   * Stamp a highlight as reviewed (review deck). Rides the same union write as
   * every other highlight mutation, so it syncs and queues offline for free.
   * No-op when the stamp wouldn't move forward.
   */
  async function markHighlightReviewed(itemKey: string, highlightId: string, at = Date.now()) {
    const context = highlightContext(itemKey);
    const mutation = mutateHighlightUnion(context.highlights, {
      type: 'reviewed',
      highlightId,
      at,
    });
    if (!mutation.changed) return;
    await persistHighlightUnion(
      itemKey,
      context.labels[0]?.itemType || 'saved',
      mutation.highlights
    );
  }

  /**
   * Set how often a highlight should come back around in the review deck, or
   * pass null to put it back at the default pace. Nothing is deleted, even for
   * 'never': the highlight stays in the highlights list and on Margin, it just
   * stops being dealt. Rides the same union write as every other highlight
   * mutation, so it reaches D1 with the rest of the highlights array (and so
   * syncs across devices, and queues when offline) for free.
   */
  async function setHighlightReviewIntent(
    itemKey: string,
    highlightId: string,
    intent: ReviewIntent | null
  ) {
    const context = highlightContext(itemKey);
    const mutation = mutateHighlightUnion(context.highlights, {
      type: 'intent',
      highlightId,
      intent,
    });
    if (!mutation.changed) return;
    await persistHighlightUnion(
      itemKey,
      context.labels[0]?.itemType || 'saved',
      mutation.highlights
    );
  }

  // --- Derived helpers ---

  function getSavedArticles(): SavedArticle[] {
    return savesStore.articles
      .filter((bm) => bm.source === 'feed' && bm.itemGuid)
      .map((bm) => ({
        articleGuid: bm.itemGuid!,
        articleUrl: bm.url || undefined,
        articleTitle: bm.title || undefined,
        readAt: new Date(bm.savedAt).getTime(),
      }));
  }

  /** Get all saved item keys grouped by source type */
  function getSavedItemKeys(): Map<ItemLabelType, Set<string>> {
    const result = new Map<ItemLabelType, Set<string>>();
    for (const bm of savesStore.articles) {
      const type = savedItemLabelType(bm);
      let set = result.get(type);
      if (!set) {
        set = new Set();
        result.set(type, set);
      }
      set.add(bm.itemGuid || bm.uri || bm.rkey);
    }
    return result;
  }

  async function getUnreadCount(subscriptionId: number): Promise<number> {
    try {
      const articles = await db.articles.where('subscriptionId').equals(subscriptionId).toArray();
      return articles.filter((a) => !isRead(a.guid)).length;
    } catch {
      return 0;
    }
  }

  return {
    // Backward-compat: readPositions map for feedViewStore/articlesStore
    get readPositions() {
      return readPositions;
    },
    get isLoading() {
      return isLoading;
    },
    get savedCount() {
      return inboxCount;
    },
    get archivedCount() {
      return archivedCount;
    },
    get inboxCount() {
      return inboxCount;
    },
    // Tags
    get allTags() {
      return allTags;
    },
    get tagsByItem() {
      return labelsByItem;
    },
    // Social positions (backward compat)
    get socialPositions() {
      return socialPositions;
    },
    // Lifecycle
    load,
    // Cheap mid-session freshness: both deltas, no cache rebuild.
    pullDelta,
    // Inline read annotation (called by feedFetcher after a batch fetch)
    seedReadCursor,
    applyAnnotatedReads,
    // Raw label access — the eviction guard needs "does this item carry a tag",
    // and the count reconciliation needs a label's own timestamp.
    hasLabel,
    getLabel,
    // Article read
    isRead,
    markAsRead,
    markAllAsRead,
    markAsUnread,
    // Article save (decoupled from read)
    isSaved,
    toggleSave,
    // Archive
    isArchived,
    toggleArchive,
    archiveItem,
    unarchiveItem,
    // Tags
    getTagsForItem,
    hasTag,
    addTag,
    removeTag,
    toggleTag,
    deleteTag: deleteTagFromAll,
    itemHasAnyTag,
    // Social reading
    isSocialRead,
    markSocialAsRead,
    markAllSocialAsRead,
    markSocialAsUnread,
    // Read progress
    getReadProgress,
    getReadActivity,
    setReadProgress,
    markOpened,
    // Highlights
    get allHighlights() {
      return allHighlights;
    },
    getHighlights,
    canonicalKey,
    hasHighlights,
    addHighlight,
    addHighlights,
    removeHighlight,
    setHighlightMargin,
    setHighlightNote,
    setHighlightSelector,
    markHighlightReviewed,
    setHighlightReviewIntent,
    // Derived helpers
    getSavedArticles,
    getSavedItemKeys,
    getUnreadCount,
  };
}

export const itemLabelsStore = createItemLabelsStore();
