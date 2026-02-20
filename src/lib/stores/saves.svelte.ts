import { db } from '$lib/services/db';
import { api, UrlSaveLimitError } from '$lib/services/api';
import { generateTid } from '$lib/utils/tid';
import { syncQueue, type SavedPayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import type { SavedItem } from '$lib/types';

function createSavesStore() {
  let articles = $state<SavedItem[]>([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

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
      // Load from local cache first
      const cached = await db.saved.orderBy('rkey').reverse().toArray();
      if (cached.length > 0) {
        articles = cached;
        rebuildMaps();
      }

      // Then fetch from backend
      const response = await api.getSaved();
      articles = response.articles;
      rebuildMaps();

      // Update local cache
      await db.saved.clear();
      if (response.articles.length > 0) {
        await db.saved.bulkPut(response.articles);
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
      const result = await api.saveFromUrl(url, rkey);

      const savedItem: SavedItem = {
        rkey: result.rkey,
        uri: result.uri,
        url: result.url,
        title: result.title,
        author: result.author,
        description: result.description,
        content: result.content,
        contentType: result.contentType || 'webpage',
        domain: result.domain,
        image: result.image,
        wordCount: result.wordCount,
        publishedAt: result.publishedAt,
        savedAt: result.savedAt,
        source: result.source || 'url',
        itemGuid: result.itemGuid || undefined,
      };

      // Add to local state and cache
      articles = [savedItem, ...articles];
      rebuildMaps();
      await db.saved.put(savedItem);

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

      // Optimistically add to local state
      const savedItem: SavedItem = {
        rkey,
        uri: '', // Will be set by backend
        url: article.url,
        title: article.title || null,
        author: article.author || null,
        description: article.summary || null,
        content: null,
        contentType: 'article',
        domain: null,
        image: article.imageUrl || null,
        wordCount: null,
        publishedAt: article.publishedAt || null,
        savedAt: now,
        source: 'feed',
        itemGuid: article.guid,
      };

      articles = [savedItem, ...articles];
      rebuildMaps();
      await db.saved.put(savedItem);

      if (syncStore.isOnline) {
        try {
          const result = await api.saveFromUrl(article.url, rkey, {
            fromFeed: true,
            itemGuid: article.guid,
            title: article.title,
            author: article.author,
            description: article.summary,
            image: article.imageUrl,
            publishedAt: article.publishedAt,
          });

          // Update with server response
          const updated: SavedItem = {
            ...savedItem,
            uri: result.uri,
            rkey: result.rkey,
          };
          articles = articles.map((a) => (a.rkey === rkey ? updated : a));
          rebuildMaps();
          await db.saved.put(updated);

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
            image: article.imageUrl,
            publishedAt: article.publishedAt,
          } as SavedPayload);
          return savedItem;
        }
      } else {
        // Offline: queue the API call
        await syncQueue.enqueue('create', 'saved', article.guid, {
          rkey,
          url: article.url,
          fromFeed: true,
          itemGuid: article.guid,
          title: article.title,
          author: article.author,
          description: article.summary,
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

  async function saveShare(share: {
    recordUri: string;
    itemUrl: string;
    itemTitle?: string;
    itemAuthor?: string;
    itemDescription?: string;
    itemImage?: string;
    itemPublishedAt?: string;
  }): Promise<SavedItem> {
    saving = true;
    error = null;
    try {
      const rkey = generateTid();
      const now = new Date().toISOString();

      const savedItem: SavedItem = {
        rkey,
        uri: '',
        url: share.itemUrl || '',
        title: share.itemTitle || null,
        author: share.itemAuthor || null,
        description: share.itemDescription || null,
        content: null,
        contentType: 'share',
        domain: null,
        image: share.itemImage || null,
        wordCount: null,
        publishedAt: share.itemPublishedAt || null,
        savedAt: now,
        source: 'share',
        itemGuid: share.recordUri,
      };

      articles = [savedItem, ...articles];
      rebuildMaps();
      await db.saved.put(savedItem);

      if (syncStore.isOnline) {
        try {
          const result = await api.saveFromUrl(share.itemUrl || '', rkey, {
            source: 'share',
            itemGuid: share.recordUri,
            title: share.itemTitle,
            author: share.itemAuthor,
            description: share.itemDescription,
            image: share.itemImage,
            publishedAt: share.itemPublishedAt,
          });

          const updated: SavedItem = {
            ...savedItem,
            uri: result.uri,
            rkey: result.rkey,
          };
          articles = articles.map((a) => (a.rkey === rkey ? updated : a));
          rebuildMaps();
          await db.saved.put(updated);
          return updated;
        } catch (err) {
          console.error('Failed to save share to backend, queueing:', err);
          await syncQueue.enqueue('create', 'saved', share.recordUri, {
            rkey,
            url: share.itemUrl || '',
            source: 'share',
            itemGuid: share.recordUri,
            title: share.itemTitle,
            author: share.itemAuthor,
            description: share.itemDescription,
            image: share.itemImage,
            publishedAt: share.itemPublishedAt,
          } as SavedPayload);
          return savedItem;
        }
      } else {
        await syncQueue.enqueue('create', 'saved', share.recordUri, {
          rkey,
          url: share.itemUrl || '',
          source: 'share',
          itemGuid: share.recordUri,
          title: share.itemTitle,
          author: share.itemAuthor,
          description: share.itemDescription,
          image: share.itemImage,
          publishedAt: share.itemPublishedAt,
        } as SavedPayload);
        return savedItem;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save share';
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
      await db.saved.put(savedItem);

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
          await db.saved.put(updated);
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
    try {
      await api.deleteSaved(rkey);
      articles = articles.filter((a) => a.rkey !== rkey);
      rebuildMaps();
      await db.saved.delete(rkey);
    } catch (err) {
      console.error('Failed to delete saved item:', err);
      throw err;
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
    load,
    saveFromUrl,
    saveArticle,
    saveShare,
    saveDocument,
    unsaveByGuid,
    remove,
    isSaved,
    getByUri,
    getByUrl,
    getByGuid,
  };
}

export const savesStore = createSavesStore();
