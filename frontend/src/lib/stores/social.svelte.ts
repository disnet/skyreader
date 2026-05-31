import { db } from '$lib/services/db';
import { safeBulkPut } from '$lib/services/safeDb.svelte';
import { api } from '$lib/services/api';
import { profileService } from '$lib/services/profiles';
import { itemLabelsStore } from './itemLabels.svelte';
import { syncStore } from './sync.svelte';
import { reconcileDocuments, type DocumentScopeResult } from '$lib/services/documentSync';
import type { SocialDocument, SocialShare } from '$lib/types';

function createSocialStore() {
  let shares = $state<SocialShare[]>([]);
  let documents = $state<SocialDocument[]>([]);
  let popularShares = $state<(SocialShare & { shareCount: number })[]>([]);
  let isLoadingFeed = $state(false);
  let cursor = $state<string | null>(null);
  let hasMore = $state(true);
  let error = $state<string | null>(null);

  async function loadFeed(reset = false) {
    if (isLoadingFeed || (!hasMore && !reset)) {
      return;
    }

    isLoadingFeed = true;
    error = null;

    // When offline, load from cache immediately
    if (!syncStore.isOnline) {
      if (reset) {
        shares = await db.socialShares.orderBy('createdAt').reverse().toArray();
        documents = await db.socialDocuments.orderBy('publishedAt').reverse().toArray();
      }
      isLoadingFeed = false;
      return;
    }

    try {
      // Documents no longer come from /api/social/feed — they're fetched lazily
      // per-publication through the feed proxy (see fetchAllDocuments) and applied
      // via applyDocumentResults. This endpoint now serves shares only.
      const result = await api.getSocialFeed(reset ? undefined : (cursor ?? undefined), 50, false);

      if (reset) {
        shares = result.shares;
        // Load cached documents so they appear immediately; fetchAllDocuments
        // refreshes them from the proxy on the same cycle as RSS feeds.
        documents = await db.socialDocuments.orderBy('publishedAt').reverse().toArray();
        await db.socialShares.clear();
        await safeBulkPut(db.socialShares, result.shares);
      } else {
        const existingShareUris = new Set(shares.map((s) => s.recordUri));
        const newShares = result.shares.filter((s) => !existingShareUris.has(s.recordUri));
        shares = [...shares, ...newShares];
        await safeBulkPut(db.socialShares, result.shares);
      }

      cursor = result.cursor;
      hasMore = !!result.cursor;

      // Prefetch author profiles from Bluesky (fire and forget)
      const authorDids = [...new Set(result.shares.map((s) => s.authorDid))];
      profileService.prefetch(authorDids);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load social feed';

      // Load from cache on error
      if (reset) {
        shares = await db.socialShares.orderBy('createdAt').reverse().toArray();
        documents = await db.socialDocuments.orderBy('publishedAt').reverse().toArray();
      }
    } finally {
      isLoadingFeed = false;
    }
  }

  async function loadPopular(period: 'day' | 'week' | 'month' = 'week') {
    if (!syncStore.isOnline) return;

    isLoadingFeed = true;
    error = null;

    try {
      const result = await api.getPopularShares(period);
      popularShares = result.shares;
      // Prefetch author profiles from Bluesky (fire and forget)
      const authorDids = [...new Set(result.shares.map((s) => s.authorDid))];
      profileService.prefetch(authorDids);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load popular shares';
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
    shares = [];
    documents = [];
    popularShares = [];
    cursor = null;
    hasMore = true;
    error = null;
  }

  function getSharesByAuthor(authorDid: string): SocialShare[] {
    return shares.filter((s) => s.authorDid === authorDid);
  }

  return {
    get shares() {
      return shares;
    },
    get documents() {
      return documents;
    },
    get popularShares() {
      return popularShares;
    },
    get isLoading() {
      return isLoadingFeed;
    },
    get hasMore() {
      return hasMore;
    },
    get error() {
      return error;
    },
    loadFeed,
    loadPopular,
    applyDocumentResults,
    reset,
    getSharesByAuthor,
  };
}

export const socialStore = createSocialStore();
