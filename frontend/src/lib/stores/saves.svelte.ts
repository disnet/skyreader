import { db } from '$lib/services/db';
import { safePut, safeBulkPut } from '$lib/services/safeDb.svelte';
import { api } from '$lib/services/api';
import { generateTid } from '$lib/utils/tid';
import { urlKey } from '$lib/utils/urlKey';
import { syncQueue, type SavedPayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import { auth } from './auth.svelte';
import { extractArticle } from '$lib/services/extract';
import { computeContentStats } from '$lib/services/articleMerge';
import { savedSearchStore } from './savedSearch.svelte';
import type { SavedItem } from '$lib/types';

/**
 * Whether save writes/reads can reach the backend at all.
 *
 * A guest has no account, so every mutation takes the offline branch: the save
 * is written to IndexedDB and the server-bound half is queued. That queue is
 * also the migration — signing in flushes it to the new account through the
 * ordinary sync run, the same way itemLabels migrates read state. Guest saves
 * keep the RSS body (extraction is session-gated), matching an offline save.
 */
function canReachBackend(): boolean {
  return syncStore.isOnline && !auth.isGuest;
}

// Derive a word count from the best available body text, returning null when
// there's nothing to count. Used so a saved item's read time never silently
// falls back to "1 min" from the short RSS description — every save path that
// has any body computes a real count locally even when the extractor/proxy
// didn't supply one.
function wordCountFrom(...texts: (string | null | undefined)[]): number | null {
  const body = texts.find((t) => t && t.trim().length > 0) || undefined;
  return computeContentStats(body).wordCount || null;
}

// The extracted webpage body is the largest field on a saved item and is only
// read in the fullscreen reader (the card preview uses `description`; read time
// uses the stored `wordCount`). Drop it from the in-memory list so the store
// doesn't hold every body at once — the full text stays in IndexedDB and is
// pulled back per-item by getContent() when the reader opens.
function toLightSaved(item: SavedItem): SavedItem {
  if (item.content == null) return item;
  const { content: _content, ...rest } = item;
  return { ...rest, content: null };
}

function createSavesStore() {
  let articles = $state<SavedItem[]>([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Display-item key of a freshly-added save that the saved view should open in
  // the reader once it appears. Consumed (and cleared) by SavedListView.
  let pendingOpenKey = $state<string | null>(null);

  // O(1) lookup maps
  let savedByGuid = $state<Map<string, SavedItem>>(new Map());
  let savedByUrl = $state<Map<string, SavedItem>>(new Map());
  // The same saves under their canonical form, so a link that arrives from
  // another network (a Semble connection, a share) still finds the save the
  // reader already has when only a trailing slash or a utm param differs.
  // Exact matches always win; this is only consulted when one misses.
  let savedByUrlKey = $state<Map<string, SavedItem>>(new Map());

  function rebuildMaps() {
    const byGuid = new Map<string, SavedItem>();
    const byUrl = new Map<string, SavedItem>();
    const byUrlKey = new Map<string, SavedItem>();
    for (const bm of articles) {
      if (bm.itemGuid) byGuid.set(bm.itemGuid, bm);
      if (bm.url) {
        byUrl.set(bm.url, bm);
        const key = urlKey(bm.url);
        if (key) byUrlKey.set(key, bm);
      }
    }
    savedByGuid = byGuid;
    savedByUrl = byUrl;
    savedByUrlKey = byUrlKey;
  }

  // Self-heal old saves that have a body but no stored word count (pre-fix
  // saves, failed extractions, offline replays). Without this they fall back to
  // counting the short RSS description and show a misleading "1 min". Mutates
  // each item's wordCount in place and returns the ones that changed so the
  // caller can PATCH the backend (so the fix sticks across reloads/devices).
  function backfillWordCounts(items: SavedItem[]): SavedItem[] {
    const backfilled: SavedItem[] = [];
    for (const a of items) {
      if (a.wordCount == null && a.content) {
        const wc = wordCountFrom(a.content);
        if (wc != null) {
          a.wordCount = wc;
          backfilled.push(a);
        }
      }
    }
    return backfilled;
  }

  function pushWordCountBackfills(backfilled: SavedItem[]) {
    if (backfilled.length > 0 && canReachBackend()) {
      void Promise.all(
        backfilled.map((a) =>
          api.updateSaved(a.rkey, { wordCount: a.wordCount! }).catch((err) => {
            console.warn('Failed to backfill saved word count:', err);
          })
        )
      );
    }
  }

  const PAGE_SIZE = 50;
  const BODY_BATCH = 200;

  // The list endpoint returns metadata only (the body is the bulk of a row and
  // we already cache it). Fill each item's `content` in place: reuse the cached
  // body when we still have it, otherwise fetch bodies for the unseen rkeys.
  // Offline, items keep whatever body the cache had (null for genuinely new ones).
  async function hydrateBodies(items: SavedItem[], cachedByRkey: Map<string, SavedItem>) {
    const needFetch: string[] = [];
    for (const it of items) {
      if (it.content != null) continue;
      const cachedBody = cachedByRkey.get(it.rkey)?.content;
      if (cachedBody != null) {
        it.content = cachedBody;
      } else {
        needFetch.push(it.rkey);
      }
    }
    if (needFetch.length === 0 || !syncStore.isOnline) return;

    const byRkey = new Map(items.map((it) => [it.rkey, it]));
    for (let i = 0; i < needFetch.length; i += BODY_BATCH) {
      const chunk = needFetch.slice(i, i + BODY_BATCH);
      try {
        const { bodies } = await api.getSavedBodies(chunk);
        for (const [rkey, body] of Object.entries(bodies)) {
          const it = byRkey.get(rkey);
          if (it && body != null) it.content = body;
        }
      } catch (err) {
        console.warn('Failed to hydrate saved bodies:', err);
      }
    }
  }

  async function load() {
    loading = true;
    error = null;
    try {
      // Load from local cache first. The in-memory list is kept "light" (no
      // body); IndexedDB retains the full rows.
      const cached = await db.saved.orderBy('rkey').reverse().toArray();
      const cachedByRkey = new Map(cached.map((c) => [c.rkey, c]));
      const firstLoad = cached.length === 0;
      if (!firstLoad) {
        articles = cached.map(toLightSaved);
        rebuildMaps();
      }

      // A guest's saves live only in this browser: the cache IS the list, and
      // there is no backend to reconcile against (the list endpoint would 401).
      if (auth.isGuest) return;

      // Fetch the first page. The backend pages newest-first over a keyset
      // cursor; `full` means an external-backed snapshot that must replace the
      // cache wholesale (membership can be *removed* elsewhere, so it can't be
      // merged incrementally).
      const first = await api.getSaved({ limit: PAGE_SIZE });

      if (first.full) {
        const snapshot = first.articles as SavedItem[];
        // Bodies aren't in the response — reuse cached ones, fetch the rest —
        // before the clear()+replace below drops the old cache (and its bodies).
        await hydrateBodies(snapshot, cachedByRkey);
        const backfilled = backfillWordCounts(snapshot);
        articles = snapshot.map(toLightSaved);
        rebuildMaps();
        await db.saved.clear();
        if (snapshot.length > 0) {
          await safeBulkPut(db.saved, snapshot);
        }
        // A batch landed: rebuild the search corpus on the next search rather
        // than patching it row by row.
        savedSearchStore.invalidate();
        pushWordCountBackfills(backfilled);
        return;
      }

      // Incremental merge: page newest-first, keeping items we don't already
      // have. New saves always sort ahead of cached ones (saved_at is set at
      // save time), so the first already-cached rkey means we've caught up —
      // stop there. On a first-ever load (empty cache) page through everything.
      const fresh: SavedItem[] = [];
      let page = first;
      let caughtUp = false;
      while (!caughtUp) {
        for (const a of page.articles as SavedItem[]) {
          if (!firstLoad && cachedByRkey.has(a.rkey)) {
            caughtUp = true;
            break;
          }
          fresh.push(a);
        }
        if (caughtUp || !page.cursor) break;
        page = await api.getSaved({ limit: PAGE_SIZE, cursor: page.cursor });
      }

      // Fresh items are new (not in cache), so their bodies always need fetching.
      await hydrateBodies(fresh, cachedByRkey);
      const backfilled = backfillWordCounts(fresh);

      // Merge the fresh (newer) items ahead of the cached ones, dropping any
      // cached row a fresh item supersedes, then keep the list in saved_at order.
      const freshKeys = new Set(fresh.map((a) => a.rkey));
      const merged = [
        ...fresh.map(toLightSaved),
        ...cached.filter((c) => !freshKeys.has(c.rkey)).map(toLightSaved),
      ].sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
      articles = merged;
      rebuildMaps();

      // Upsert only the fresh rows (full bodies) — no clear(), so the rest of
      // the cache is left untouched.
      if (fresh.length > 0) {
        await safeBulkPut(db.saved, fresh);
        savedSearchStore.invalidate();
      }

      pushWordCountBackfills(backfilled);
    } catch (err) {
      console.error('Failed to load saved items:', err);
      // Keep cached data if backend fails
    } finally {
      loading = false;
    }
  }

  async function saveFromUrl(url: string): Promise<SavedItem> {
    saving = true;
    error = null;
    try {
      const rkey = generateTid();

      // Fetch HTML via proxy and extract content client-side
      const extracted = await extractArticle(url);

      // Prefer the extractor's word count, but never leave it null when a body
      // exists — count locally so the read time is right even if the proxy
      // omitted it.
      const wordCount = extracted.wordCount || wordCountFrom(extracted.content);

      const result = await api.saveFromUrl(url, rkey, {
        title: extracted.title || undefined,
        author: extracted.author || undefined,
        description: extracted.description || undefined,
        content: extracted.content || undefined,
        domain: extracted.domain || undefined,
        image: extracted.image || undefined,
        publishedAt: extracted.published || undefined,
        wordCount: wordCount || undefined,
      });

      const savedItem: SavedItem = {
        rkey,
        uri: result.uri,
        url,
        title: extracted.title,
        author: extracted.author,
        description: extracted.description,
        content: extracted.content,
        contentType: 'webpage',
        domain: extracted.domain,
        image: extracted.image,
        wordCount,
        publishedAt: extracted.published,
        savedAt: result.savedAt,
        source: 'url',
      };

      // Insert a light copy into memory immediately, then persist the full row
      // (with body) to IndexedDB — getContent reads it back on reader open.
      articles = [toLightSaved(savedItem), ...articles];
      rebuildMaps();
      await safePut(db.saved, savedItem);
      savedSearchStore.upsert(savedItem);

      return savedItem;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save bookmark';
      error = msg;
      throw err;
    } finally {
      saving = false;
    }
  }

  async function saveArticle(article: {
    url: string;
    guid: string;
    subscriptionId?: number;
    title?: string;
    author?: string;
    summary?: string;
    imageUrl?: string;
    publishedAt?: string;
  }): Promise<SavedItem> {
    saving = true;
    error = null;
    try {
      const rkey = generateTid();
      const now = new Date().toISOString();

      // Instant/offline fallback body: pull the RSS body back from IndexedDB.
      // The in-memory feed list is kept "light" (content stripped — see
      // toLightArticle), so the body isn't on the article passed in; db.articles
      // still holds the full row. The RSS body is often just an excerpt, so when
      // online we replace it below with a clean full-text extraction.
      let rssBody: string | null = null;
      if (article.subscriptionId != null) {
        try {
          const row = await db.articles
            .where('guid')
            .equals(article.guid)
            .filter((r) => r.subscriptionId === article.subscriptionId)
            .first();
          rssBody = row?.content ?? null;
        } catch {
          // Best effort — fall back to no stored body.
        }
      }

      // Optimistically add to local state with the RSS body so the save appears
      // immediately and stays readable offline; the extracted body upgrades it
      // below. Insert a light copy into memory; persist the full row (with body)
      // to IndexedDB so getContent reads it back when the reader opens.
      const savedItem: SavedItem = {
        rkey,
        uri: '', // Will be set by backend
        url: article.url,
        title: article.title || null,
        author: article.author || null,
        description: article.summary || null,
        content: rssBody,
        contentType: 'article',
        domain: null,
        image: article.imageUrl || null,
        // Count the RSS body up-front so the read time is right immediately —
        // including offline, where extraction never runs. Upgraded below with
        // the extracted body's count when online.
        wordCount: wordCountFrom(rssBody),
        publishedAt: article.publishedAt || null,
        savedAt: now,
        source: 'feed',
        itemGuid: article.guid,
      };

      articles = [toLightSaved(savedItem), ...articles];
      rebuildMaps();
      await safePut(db.saved, savedItem);
      savedSearchStore.upsert(savedItem);

      if (canReachBackend()) {
        try {
          // Prefer a clean, full-text extraction of the article (same source as
          // URL saves) over the RSS body. Fall back to the RSS body if
          // extraction fails or returns nothing.
          let content = rssBody;
          let wordCount: number | null = null;
          let domain: string | null = null;
          try {
            const extracted = await extractArticle(article.url);
            if (extracted.content) {
              content = extracted.content;
              wordCount = extracted.wordCount || null;
              domain = extracted.domain || null;
            }
          } catch (err) {
            console.warn('Article extraction failed, using feed body:', err);
          }

          // Never leave the count null when a body exists: extraction may have
          // failed (content stayed the RSS body) or returned a body with no
          // count. Count whatever body we ended up with.
          if (wordCount == null) wordCount = wordCountFrom(content);

          const result = await api.saveFromUrl(article.url, rkey, {
            fromFeed: true,
            itemGuid: article.guid,
            title: article.title,
            author: article.author,
            description: article.summary,
            content: content ?? undefined,
            image: article.imageUrl,
            publishedAt: article.publishedAt,
            domain: domain ?? undefined,
            wordCount: wordCount ?? undefined,
          });

          // Update with extracted content + server response
          const updated: SavedItem = {
            ...savedItem,
            content,
            wordCount,
            domain: domain ?? savedItem.domain,
            uri: result.uri,
            rkey: result.rkey,
          };
          articles = articles.map((a) => (a.rkey === rkey ? toLightSaved(updated) : a));
          rebuildMaps();
          await safePut(db.saved, updated);
          // The backend can hand back a different rkey; drop the optimistic key
          // so the corpus doesn't keep a stale copy of the same save.
          if (updated.rkey !== rkey) savedSearchStore.remove(rkey);
          savedSearchStore.upsert(updated);

          return updated;
        } catch (err) {
          // API failed but local state is already updated, queue for retry
          console.error('Failed to save article to backend, queueing:', err);
          await syncQueue.enqueue('create', 'saved', article.guid, {
            rkey,
            url: article.url,
            fromFeed: true,
            itemGuid: article.guid,
            title: article.title,
            author: article.author,
            description: article.summary,
            content: rssBody ?? undefined,
            wordCount: wordCountFrom(rssBody) ?? undefined,
            image: article.imageUrl,
            publishedAt: article.publishedAt,
          } as SavedPayload);
          return savedItem;
        }
      } else {
        // Offline or guest: queue the API call with the RSS body. Extraction
        // needs the network (and a session), and the queue replays the save
        // directly via the API (not this path), so these saves keep the RSS
        // body rather than the extracted one.
        await syncQueue.enqueue('create', 'saved', article.guid, {
          rkey,
          url: article.url,
          fromFeed: true,
          itemGuid: article.guid,
          title: article.title,
          author: article.author,
          description: article.summary,
          content: rssBody ?? undefined,
          wordCount: wordCountFrom(rssBody) ?? undefined,
          image: article.imageUrl,
          publishedAt: article.publishedAt,
        } as SavedPayload);
        return savedItem;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save article';
      error = msg;
      throw err;
    } finally {
      saving = false;
    }
  }

  async function saveDocument(doc: {
    recordUri: string;
    url: string;
    title?: string;
    description?: string;
    publishedAt?: string;
    // Pre-rendered body HTML. Standard.site documents render from structured
    // content, not URL extraction, so the caller passes the rendered body here
    // and we persist it as the saved copy's content (otherwise the saved reader
    // has nothing to show — see the collection-piece save path).
    content?: string;
  }): Promise<SavedItem> {
    saving = true;
    error = null;
    try {
      const rkey = generateTid();
      const now = new Date().toISOString();

      const savedItem: SavedItem = {
        rkey,
        uri: '',
        url: doc.url || '',
        title: doc.title || null,
        author: null,
        description: doc.description || null,
        content: doc.content ?? null,
        contentType: 'document',
        domain: null,
        image: null,
        wordCount: doc.content ? wordCountFrom(doc.content) : null,
        publishedAt: doc.publishedAt || null,
        savedAt: now,
        source: 'document',
        itemGuid: doc.recordUri,
      };

      articles = [savedItem, ...articles];
      rebuildMaps();
      await safePut(db.saved, savedItem);
      savedSearchStore.upsert(savedItem);

      if (canReachBackend()) {
        try {
          const result = await api.saveFromUrl(doc.url || '', rkey, {
            source: 'document',
            itemGuid: doc.recordUri,
            title: doc.title,
            description: doc.description,
            publishedAt: doc.publishedAt,
            // Persist the rendered body server-side too, so it survives the
            // backend-authoritative reload in load() (a 'document' save is a
            // metadata save — the backend stores this content rather than
            // extracting from the URL).
            content: doc.content,
            wordCount: savedItem.wordCount ?? undefined,
          });

          const updated: SavedItem = {
            ...savedItem,
            uri: result.uri,
            rkey: result.rkey,
          };
          articles = articles.map((a) => (a.rkey === rkey ? updated : a));
          rebuildMaps();
          await safePut(db.saved, updated);
          if (updated.rkey !== rkey) savedSearchStore.remove(rkey);
          savedSearchStore.upsert(updated);
          return updated;
        } catch (err) {
          console.error('Failed to save document to backend, queueing:', err);
          await syncQueue.enqueue('create', 'saved', doc.recordUri, {
            rkey,
            url: doc.url || '',
            source: 'document',
            itemGuid: doc.recordUri,
            title: doc.title,
            description: doc.description,
            publishedAt: doc.publishedAt,
            content: doc.content,
            wordCount: savedItem.wordCount ?? undefined,
          } as SavedPayload);
          return savedItem;
        }
      } else {
        await syncQueue.enqueue('create', 'saved', doc.recordUri, {
          rkey,
          url: doc.url || '',
          source: 'document',
          itemGuid: doc.recordUri,
          title: doc.title,
          description: doc.description,
          publishedAt: doc.publishedAt,
          content: doc.content,
          wordCount: savedItem.wordCount ?? undefined,
        } as SavedPayload);
        return savedItem;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save document';
      error = msg;
      throw err;
    } finally {
      saving = false;
    }
  }

  async function unsaveByGuid(guid: string) {
    const item = savedByGuid.get(guid);
    if (!item) return;

    // Optimistically remove from local state
    articles = articles.filter((a) => a.itemGuid !== guid);
    rebuildMaps();
    savedSearchStore.remove(item.rkey, guid);
    await db.saved.where('itemGuid').equals(guid).delete();

    if (canReachBackend()) {
      try {
        await api.deleteSavedByGuid(guid);
      } catch (err) {
        console.error('Failed to unsave by guid, queueing:', err);
        await syncQueue.enqueue('delete', 'saved', guid, {
          rkey: item.rkey,
          url: item.url,
          itemGuid: guid,
        } as SavedPayload);
      }
    } else {
      await syncQueue.enqueue('delete', 'saved', guid, {
        rkey: item.rkey,
        url: item.url,
        itemGuid: guid,
      } as SavedPayload);
    }
  }

  async function remove(rkey: string) {
    const item = articles.find((a) => a.rkey === rkey);

    // Optimistically remove from local state
    articles = articles.filter((a) => a.rkey !== rkey);
    rebuildMaps();
    contentCache.delete(rkey);
    savedSearchStore.remove(rkey, item?.itemGuid);
    await db.saved.delete(rkey);

    if (canReachBackend()) {
      try {
        await api.deleteSaved(rkey);
      } catch (err) {
        console.error('Failed to delete saved item, queueing:', err);
        await syncQueue.enqueue('delete', 'saved', rkey, {
          rkey,
          url: item?.url || '',
        } as SavedPayload);
      }
    } else {
      await syncQueue.enqueue('delete', 'saved', rkey, {
        rkey,
        url: item?.url || '',
      } as SavedPayload);
    }
  }

  function isSaved(guidOrUrl: string): boolean {
    if (savedByGuid.has(guidOrUrl) || savedByUrl.has(guidOrUrl)) return true;
    const key = urlKey(guidOrUrl);
    return key !== null && savedByUrlKey.has(key);
  }

  function getByUri(uri: string): SavedItem | undefined {
    return articles.find((a) => a.uri === uri);
  }

  function getByUrl(url: string): SavedItem | undefined {
    const exact = savedByUrl.get(url);
    if (exact) return exact;
    const key = urlKey(url);
    return key ? savedByUrlKey.get(key) : undefined;
  }

  function getByGuid(guid: string): SavedItem | undefined {
    return savedByGuid.get(guid);
  }

  // In-memory body cache, primed by prefetchContent() when a tile is hovered, so
  // opening the reader is instant — no IndexedDB roundtrip, no null→content flash.
  // Only non-null bodies are cached: a save's extracted text is immutable, but a
  // missing body can later be backfilled, so nulls always re-read. Bounded by the
  // handful of tiles a user can hover; entries are dropped on item removal.
  const contentCache = new Map<string, string>();

  // Warm the cache for a saved item ahead of an open (hover prefetch). Cheap and
  // idempotent; failures are non-fatal since getContent re-reads on open.
  async function prefetchContent(rkey: string): Promise<void> {
    if (!rkey || contentCache.has(rkey)) return;
    try {
      const row = await db.saved.get(rkey);
      if (row?.content) contentCache.set(rkey, row.content);
    } catch {
      // Non-fatal: getContent falls back to a fresh read on open.
    }
  }

  // Read a saved item's full body back from IndexedDB by rkey. The in-memory
  // list drops bodies (see toLightSaved); the reader calls this on open.
  async function getContent(rkey: string): Promise<string | null> {
    const cached = contentCache.get(rkey);
    if (cached != null) return cached;
    try {
      const row = await db.saved.get(rkey);
      if (row?.content != null) {
        contentCache.set(rkey, row.content);
        return row.content;
      }

      // The list is metadata-only and bodies are hydrated for fresh items in
      // load(); if that hydration was skipped or failed (offline at sync time, a
      // batch error, a backed stub awaiting extraction) the body never lands and
      // the incremental refresh won't revisit an already-cached row. Fetch it on
      // demand here as a self-healing fallback, and cache it so the next open is local.
      // A guest's saves have no server copy to fall back to.
      if (!canReachBackend()) return null;
      const { bodies } = await api.getSavedBodies([rkey]);
      const body = bodies[rkey] ?? null;
      if (body != null && row) {
        const filled = { ...row, content: body };
        await safePut(db.saved, filled);
        savedSearchStore.upsert(filled);
      }
      if (body != null) contentCache.set(rkey, body);
      return body;
    } catch {
      return null;
    }
  }

  return {
    get articles() {
      return articles;
    },
    get loading() {
      return loading;
    },
    get saving() {
      return saving;
    },
    get error() {
      return error;
    },
    get pendingOpenKey() {
      return pendingOpenKey;
    },
    set pendingOpenKey(key: string | null) {
      pendingOpenKey = key;
    },
    load,
    saveFromUrl,
    saveArticle,
    saveDocument,
    unsaveByGuid,
    remove,
    isSaved,
    getByUri,
    getByUrl,
    getByGuid,
    getContent,
    prefetchContent,
  };
}

export const savesStore = createSavesStore();
