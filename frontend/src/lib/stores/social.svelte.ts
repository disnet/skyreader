import { db } from '$lib/services/db';
import { safeBulkPut } from '$lib/services/safeDb.svelte';
import { profileService } from '$lib/services/profiles';
import { reconcileDocuments, type DocumentScopeResult } from '$lib/services/documentSync';
import type { SocialDocument } from '$lib/types';

function createSocialStore() {
  let documents = $state<SocialDocument[]>([]);
  let isLoadingFeed = $state(false);
  let error = $state<string | null>(null);

  // Documents are fetched lazily per-publication through the feed proxy (see
  // fetchAllDocuments) and applied via applyDocumentResults. loadFeed only
  // hydrates the cached set so it paints instantly on reset; the proxy refreshes
  // it on the same cycle as RSS feeds. (The old share read path is gone.)
  async function loadFeed(reset = false) {
    if (isLoadingFeed) return;
    if (!reset) return;

    isLoadingFeed = true;
    error = null;
    try {
      documents = await db.socialDocuments.orderBy('publishedAt').reverse().toArray();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load social feed';
    } finally {
      isLoadingFeed = false;
    }
  }

  /**
   * Apply freshly-fetched documents from the proxy. Each result is authoritative
   * for its (author, publication scope), so reconciling per scope makes edits and
   * deletes self-heal: in-scope documents the proxy no longer returns are dropped,
   * the rest upserted. Persists the full set to IndexedDB in one pass.
   */
  async function applyDocumentResults(results: DocumentScopeResult[]): Promise<void> {
    const ready = results.filter((r) => r.status === 'ready');
    if (ready.length === 0) return;

    documents = reconcileDocuments(documents, ready);

    // Mirror to IndexedDB. The table uses an auto-increment id, so strip stale ids
    // and rewrite wholesale (counts are small — a few authors × ~100 docs).
    try {
      await db.socialDocuments.clear();
      await safeBulkPut(
        db.socialDocuments,
        documents.map(({ id: _id, ...rest }) => rest)
      );
    } catch (e) {
      console.error('Failed to persist documents to IndexedDB:', e);
    }

    // Prefetch author profiles (fire and forget).
    profileService.prefetch([...new Set(ready.map((r) => r.did))]);
  }

  function reset() {
    documents = [];
    error = null;
  }

  return {
    get documents() {
      return documents;
    },
    get isLoading() {
      return isLoadingFeed;
    },
    get error() {
      return error;
    },
    loadFeed,
    applyDocumentResults,
    reset,
  };
}

export const socialStore = createSocialStore();
