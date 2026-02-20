import { db } from '$lib/services/db';
import { api } from '$lib/services/api';
import { generateTid } from '$lib/utils/tid';
import type { Bookmark } from '$lib/types';

function createBookmarksStore() {
  let articles = $state<Bookmark[]>([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      // Load from local cache first
      const cached = await db.bookmarks.orderBy('rkey').reverse().toArray();
      if (cached.length > 0) {
        articles = cached;
      }

      // Then fetch from backend
      const response = await api.getBookmarks();
      articles = response.articles;

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
      };

      // Add to local state and cache
      articles = [bookmark, ...articles];
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

  async function remove(rkey: string) {
    try {
      await api.deleteBookmark(rkey);
      articles = articles.filter((a) => a.rkey !== rkey);
      await db.bookmarks.delete(rkey);
    } catch (err) {
      console.error('Failed to delete bookmark:', err);
      throw err;
    }
  }

  function getByUri(uri: string): Bookmark | undefined {
    return articles.find((a) => a.uri === uri);
  }

  function getByUrl(url: string): Bookmark | undefined {
    return articles.find((a) => a.url === url);
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
    remove,
    getByUri,
    getByUrl,
  };
}

export const bookmarksStore = createBookmarksStore();
