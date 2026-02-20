import { db } from '$lib/services/db';
import { api } from '$lib/services/api';
import { generateTid } from '$lib/utils/tid';
import { syncQueue, type SavedPayload } from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import type { Bookmark } from '$lib/types';

function createBookmarksStore() {
  let articles = $state<Bookmark[]>([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  // O(1) lookup maps
  let savedByGuid = $state<Map<string, Bookmark>>(new Map());
  let savedByUrl = $state<Map<string, Bookmark>>(new Map());

  function rebuildMaps() {
    const byGuid = new Map<string, Bookmark>();
    const byUrl = new Map<string, Bookmark>();
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
      const cached = await db.bookmarks.orderBy('rkey').reverse().toArray();
      if (cached.length > 0) {
        articles = cached;
        rebuildMaps();
      }

      // Then fetch from backend
      const response = await api.getBookmarks();
      articles = response.articles;
      rebuildMaps();

      // Update local cache
      await db.bookmarks.clear();
      if (response.articles.length > 0) {
        await db.bookmarks.bulkPut(response.articles);
      }
    } catch (err) {
      console.error('Failed to load bookmarks:', err);
      // Keep cached data if backend fails
    } finally {
      loading = false;
    }
  }

  async function saveFromUrl(url: string): Promise<Bookmark> {
    saving = true;
    error = null;
    try {
      const rkey = generateTid();
      const result = await api.saveBookmarkFromUrl(url, rkey);

      const bookmark: Bookmark = {
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
      articles = [bookmark, ...articles];
      rebuildMaps();
      await db.bookmarks.put(bookmark);

      return bookmark;
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
  }): Promise<Bookmark> {
    saving = true;
    error = null;
    try {
      const rkey = generateTid();
      const now = new Date().toISOString();

      // Optimistically add to local state
      const bookmark: Bookmark = {
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

      articles = [bookmark, ...articles];
      rebuildMaps();
      await db.bookmarks.put(bookmark);

      if (syncStore.isOnline) {
        try {
          const result = await api.saveBookmarkFromUrl(article.url, rkey, {
            fromFeed: true,
            itemGuid: article.guid,
            title: article.title,
            author: article.author,
            description: article.summary,
            image: article.imageUrl,
            publishedAt: article.publishedAt,
          });

          // Update with server response
          const updated: Bookmark = {
            ...bookmark,
            uri: result.uri,
            rkey: result.rkey,
          };
          articles = articles.map((a) => (a.rkey === rkey ? updated : a));
          rebuildMaps();
          await db.bookmarks.put(updated);

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
          return bookmark;
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
        return bookmark;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save article';
      error = msg;
      throw err;
    } finally {
      saving = false;
    }
  }

  async function unsaveByGuid(guid: string) {
    const bookmark = savedByGuid.get(guid);
    if (!bookmark) return;

    // Optimistically remove from local state
    articles = articles.filter((a) => a.itemGuid !== guid);
    rebuildMaps();
    await db.bookmarks.where('itemGuid').equals(guid).delete();

    if (syncStore.isOnline) {
      try {
        await api.deleteBookmarkByGuid(guid);
      } catch (err) {
        console.error('Failed to unsave by guid, queueing:', err);
        await syncQueue.enqueue('delete', 'saved', guid, {
          rkey: bookmark.rkey,
          url: bookmark.url,
          itemGuid: guid,
        } as SavedPayload);
      }
    } else {
      await syncQueue.enqueue('delete', 'saved', guid, {
        rkey: bookmark.rkey,
        url: bookmark.url,
        itemGuid: guid,
      } as SavedPayload);
    }
  }

  async function remove(rkey: string) {
    try {
      await api.deleteBookmark(rkey);
      articles = articles.filter((a) => a.rkey !== rkey);
      rebuildMaps();
      await db.bookmarks.delete(rkey);
    } catch (err) {
      console.error('Failed to delete bookmark:', err);
      throw err;
    }
  }

  function isSaved(guidOrUrl: string): boolean {
    return savedByGuid.has(guidOrUrl) || savedByUrl.has(guidOrUrl);
  }

  function getByUri(uri: string): Bookmark | undefined {
    return articles.find((a) => a.uri === uri);
  }

  function getByUrl(url: string): Bookmark | undefined {
    return savedByUrl.get(url);
  }

  function getByGuid(guid: string): Bookmark | undefined {
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
    unsaveByGuid,
    remove,
    isSaved,
    getByUri,
    getByUrl,
    getByGuid,
  };
}

export const bookmarksStore = createBookmarksStore();
