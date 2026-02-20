import { db } from '$lib/services/db';
import { api } from '$lib/services/api';
import { generateTid } from '$lib/utils/tid';
import type { SavedArticle } from '$lib/types';

function createSavedArticlesStore() {
  let articles = $state<SavedArticle[]>([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  async function load() {
    loading = true;
    error = null;
    try {
      // Load from local cache first
      const cached = await db.savedArticles.orderBy('rkey').reverse().toArray();
      if (cached.length > 0) {
        articles = cached;
      }

      // Then fetch from backend
      const response = await api.getSavedArticles();
      articles = response.articles;

      // Update local cache
      await db.savedArticles.clear();
      if (response.articles.length > 0) {
        await db.savedArticles.bulkPut(response.articles);
      }
    } catch (err) {
      console.error('Failed to load saved articles:', err);
      // Keep cached data if backend fails
    } finally {
      loading = false;
    }
  }

  async function saveFromUrl(url: string): Promise<SavedArticle> {
    saving = true;
    error = null;
    try {
      const rkey = generateTid();
      const result = await api.saveArticleFromUrl(url, rkey);

      const savedArticle: SavedArticle = {
        rkey: result.rkey,
        uri: result.uri,
        url: result.url,
        title: result.title,
        author: result.author,
        description: result.description,
        content: result.content,
        domain: result.domain,
        image: result.image,
        wordCount: result.wordCount,
        publishedAt: result.publishedAt,
        savedAt: result.savedAt,
      };

      // Add to local state and cache
      articles = [savedArticle, ...articles];
      await db.savedArticles.put(savedArticle);

      return savedArticle;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save article';
      error = msg;
      throw err;
    } finally {
      saving = false;
    }
  }

  async function remove(rkey: string) {
    try {
      await api.deleteSavedArticle(rkey);
      articles = articles.filter((a) => a.rkey !== rkey);
      await db.savedArticles.delete(rkey);
    } catch (err) {
      console.error('Failed to delete saved article:', err);
      throw err;
    }
  }

  function getByUri(uri: string): SavedArticle | undefined {
    return articles.find((a) => a.uri === uri);
  }

  function getByUrl(url: string): SavedArticle | undefined {
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

export const savedArticlesStore = createSavedArticlesStore();
