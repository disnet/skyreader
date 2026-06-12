import { db } from '$lib/services/db';
import { safePut, safeBulkPut } from '$lib/services/safeDb.svelte';
import { api, UrlSaveLimitError } from '$lib/services/api';
import { generateTid } from '$lib/utils/tid';
import { syncQueue, type SavedPayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import { extractArticle } from '$lib/services/extract';
import { computeContentStats } from '$lib/services/articleMerge';
import type { SavedItem } from '$lib/types';

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

  function rebuildMaps() {
    const byGuid = new Map<string, SavedItem>();
    const byUrl = new Map<string, SavedItem>();
    for (const bm of articles) {
      if (bm.itemGuid) byGuid.set(bm.itemGuid, bm);
      if (bm.url) byUrl.set(bm.url, bm);
    }
    savedByGuid = byGuid;
    savedByUrl = byUrl;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      // Load from local cache first. The in-memory list is kept "light" (no
      // body); IndexedDB retains the full rows.
      const cached = await db.saved.orderBy('rkey').reverse().toArray();
      if (cached.length > 0) {
        articles = cached.map(toLightSaved);
        rebuildMaps();
      }

      // Then fetch from backend
      const response = await api.getSaved();

      // Self-heal old saves that have a body but no stored word count (pre-fix
      // saves, failed extractions, offline replays). Without this they fall back
      // to counting the short RSS description and show a misleading "1 min".
      // Compute locally, persist to IndexedDB, and PATCH the backend so the fix
      // sticks across reloads and devices instead of recomputing every load.
      const backfilled: SavedItem[] = [];
      for (const a of response.articles) {
        if (a.wordCount == null && a.content) {
          const wc = wordCountFrom(a.content);
          if (wc != null) {
            a.wordCount = wc;
            backfilled.push(a);
          }
        }
      }

      articles = response.articles.map(toLightSaved);
      rebuildMaps();

      // Update local cache — persist the full rows (with bodies) so getContent
      // can read them back on demand.
      await db.saved.clear();
      if (response.articles.length > 0) {
        await safeBulkPut(db.saved, response.articles);
      }

      if (backfilled.length > 0 && syncStore.isOnline) {
        void Promise.all(
          backfilled.map((a) =>
            api.updateSaved(a.rkey, { wordCount: a.wordCount! }).catch((err) => {
              console.warn('Failed to backfill saved word count:', err);
            })
          )
        );
      }
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

      if (syncStore.isOnline) {
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
        // Offline: queue the API call with the RSS body. Extraction needs the
        // network, and the queue replays the save directly via the API (not this
        // path), so offline saves keep the RSS body rather than the extracted one.
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
        content: null,
        contentType: 'document',
        domain: null,
        image: null,
        wordCount: null,
        publishedAt: doc.publishedAt || null,
        savedAt: now,
        source: 'document',
        itemGuid: doc.recordUri,
      };

      articles = [savedItem, ...articles];
      rebuildMaps();
      await safePut(db.saved, savedItem);

      if (syncStore.isOnline) {
        try {
          const result = await api.saveFromUrl(doc.url || '', rkey, {
            source: 'document',
            itemGuid: doc.recordUri,
            title: doc.title,
            description: doc.description,
            publishedAt: doc.publishedAt,
          });

          const updated: SavedItem = {
            ...savedItem,
            uri: result.uri,
            rkey: result.rkey,
          };
          articles = articles.map((a) => (a.rkey === rkey ? updated : a));
          rebuildMaps();
          await safePut(db.saved, updated);
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
    await db.saved.where('itemGuid').equals(guid).delete();

    if (syncStore.isOnline) {
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
    await db.saved.delete(rkey);

    if (syncStore.isOnline) {
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
    return savedByGuid.has(guidOrUrl) || savedByUrl.has(guidOrUrl);
  }

  function getByUri(uri: string): SavedItem | undefined {
    return articles.find((a) => a.uri === uri);
  }

  function getByUrl(url: string): SavedItem | undefined {
    return savedByUrl.get(url);
  }

  function getByGuid(guid: string): SavedItem | undefined {
    return savedByGuid.get(guid);
  }

  // Read a saved item's full body back from IndexedDB by rkey. The in-memory
  // list drops bodies (see toLightSaved); the reader calls this on open.
  async function getContent(rkey: string): Promise<string | null> {
    try {
      const row = await db.saved.get(rkey);
      return row?.content ?? null;
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
  };
}

export const savesStore = createSavesStore();
