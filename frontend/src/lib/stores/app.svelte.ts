import { liveDb } from '$lib/services/liveDb.svelte';
import { itemLabelsStore } from './itemLabels.svelte';
import { shareReadingStore } from './shareReading.svelte';
import { sharesStore } from './shares.svelte';
import { linkblogStore } from './linkblog.svelte';
import { socialStore } from './social.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
import { feedStatusStore } from './feedStatus.svelte';
import { articlesStore } from './articles.svelte';
import { syncStore } from './sync.svelte';
import { savesStore } from './saves.svelte';
import { fetchAllFeeds, fetchAllDocuments } from '$lib/services/feedFetcher';
import { api } from '$lib/services/api';
import { dedupeRemoteSubscriptionRecords } from '$lib/services/subscriptionDedup';
import { getMetadata, setMetadata, checkDbHealth } from '$lib/services/db';
import type { Subscription } from '$lib/types';

const LAST_REFRESH_KEY = 'lastRefreshAt';

export type AppPhase = 'idle' | 'hydrating' | 'refreshing' | 'ready' | 'error';

/**
 * App Manager - Central orchestrator for data loading
 *
 * Coordinates the cache-first loading strategy:
 * 1. Hydrate: Load from IndexedDB immediately for instant UI
 * 2. Refresh: Sync with backend in background
 *
 * This replaces the scattered initialization logic in +page.svelte
 */
function createAppManager() {
  let phase = $state<AppPhase>('idle');
  let error = $state<string | null>(null);
  let lastRefreshAt = $state<number | null>(null);

  // Derived: is the app initialized?
  let isInitialized = $derived(phase === 'ready' || phase === 'refreshing');
  let isHydrating = $derived(phase === 'hydrating');
  let isRefreshing = $derived(phase === 'refreshing');
  let hasError = $derived(phase === 'error');

  /**
   * Initialize the app with cache-first loading
   *
   * Phase 1 (Hydrate): Load from IndexedDB for instant display
   * Phase 2 (Refresh): Sync with backend in background
   */
  async function initialize(): Promise<void> {
    if (phase !== 'idle') return;

    phase = 'hydrating';
    error = null;

    try {
      // Verify IndexedDB is accessible before reading from it.
      // On iOS, the DB can become corrupted or evicted after long idle.
      const dbHealthy = await checkDbHealth();
      if (!dbHealthy) {
        console.warn('IndexedDB was reset — starting with empty cache');
      }

      // Load persisted lastRefreshAt from IndexedDB
      const persistedRefreshAt = await getMetadata<number>(LAST_REFRESH_KEY);
      if (persistedRefreshAt) {
        lastRefreshAt = persistedRefreshAt;
      }

      // Phase 1: Hydrate from cache (parallel)
      await Promise.all([
        liveDb.loadSubscriptions(),
        liveDb.loadArticles(),
        itemLabelsStore.load(),
        shareReadingStore.load(),
        sharesStore.load(),
        linkblogStore.load(),
        filteredViewsStore.load(),
        savesStore.load(),
      ]);

      // Initialize feed statuses for existing subscriptions
      const feedUrls = liveDb.subscriptions
        .filter((s) => !s.sourceType?.startsWith('atproto.'))
        .map((s) => s.feedUrl)
        .filter((u): u is string => !!u);
      feedStatusStore.initializeFeeds(feedUrls);

      // Initialize pending count and process queue if online
      await syncStore.updatePendingCount();
      if (syncStore.isOnline && syncStore.pendingCount > 0) {
        // Process queue in background - don't block initialization
        syncStore.triggerSync();
      }

      // Phase 2: Refresh from backend (background, skip when offline)
      // This also syncs channels bidirectionally via filteredViewsStore.syncWithBackend()
      if (syncStore.isOnline) {
        phase = 'refreshing';
        await refreshFromBackend();
      }

      phase = 'ready';
      lastRefreshAt = Date.now();
      // Persist to IndexedDB for service worker and cross-session access
      setMetadata(LAST_REFRESH_KEY, lastRefreshAt);
    } catch (e) {
      console.error('App initialization failed:', e);
      error = e instanceof Error ? e.message : 'Initialization failed';
      phase = 'error';
    }
  }

  /**
   * Refresh data from backend
   *
   * - Syncs subscriptions from PDS
   * - Fetches feed content via V2 batch API
   * - Loads social feed
   */
  async function refreshFromBackend(): Promise<number> {
    // Skip entirely when offline - cached data is already loaded
    if (!syncStore.isOnline) return 0;

    const wasPhase = phase;
    if (phase === 'idle' || phase === 'ready') {
      phase = 'refreshing';
    }

    let newArticles = 0;

    try {
      // Sync subscriptions, read positions, social data, and channels in parallel
      const [syncResult] = await Promise.all([
        syncSubscriptions(),
        itemLabelsStore.load(),
        shareReadingStore.load(),
        socialStore.loadFeed(true),
        filteredViewsStore.syncWithBackend(),
      ]);

      // One-time migration: push existing local custom fields to backend
      await migrateCustomFieldsToBackend();

      // Fetch all feeds (RSS) and standard.site documents in parallel; both
      // source from the proxy and merge client-side.
      if (liveDb.subscriptions.length > 0) {
        const [result] = await Promise.all([
          fetchAllFeeds(liveDb.subscriptions, articlesStore.savedGuids),
          fetchAllDocuments(liveDb.subscriptions),
        ]);
        newArticles = result.newArticles;
      }

      lastRefreshAt = Date.now();
      // Persist to IndexedDB for service worker and cross-session access
      setMetadata(LAST_REFRESH_KEY, lastRefreshAt);
    } catch (e) {
      console.error('Background refresh failed:', e);
      // Don't set error phase for background refresh failures
      // The app can still work with cached data
    } finally {
      if (wasPhase === 'idle' || wasPhase === 'ready') {
        phase = 'ready';
      }
    }

    return newArticles;
  }

  /**
   * Sync subscriptions from backend PDS
   *
   * Returns lists of added and removed feed URLs for follow-up actions
   */
  async function syncSubscriptions(): Promise<{
    added: string[];
    removed: string[];
    addedSubs: Subscription[];
  }> {
    const result = {
      added: [] as string[],
      removed: [] as string[],
      addedSubs: [] as Subscription[],
    };

    try {
      const response = await api.listRecords<{
        feedUrl?: string;
        title?: string;
        siteUrl?: string;
        category?: string;
        tags?: string[];
        createdAt: string;
        updatedAt?: string;
        sourceType?: string;
        subjectDid?: string;
        collectionNsid?: string;
        customTitle?: string;
        customIconUrl?: string;
      }>('app.skyreader.feed.subscription');

      // Build maps for comparison
      const localByRkey = new Map(liveDb.subscriptions.map((s) => [s.rkey, s]));
      const remoteByRkey = new Map(response.records.map((r) => [r.uri.split('/').pop() || '', r]));

      // Collapse PDS records that point at the same feed but carry different
      // rkeys (e.g. the same feed added on two devices). Without this the diff
      // below would re-add every duplicate to the cache on each sync. Keep the
      // oldest record and delete the rest from the PDS so the duplicate source
      // does not reappear.
      const { duplicateRkeys } = dedupeRemoteSubscriptionRecords(
        [...remoteByRkey.entries()].map(([rkey, r]) => ({ rkey, value: r.value }))
      );
      for (const rkey of duplicateRkeys) {
        remoteByRkey.delete(rkey);
        try {
          await api.deleteSubscription(rkey);
        } catch (e) {
          console.error('Failed to delete duplicate PDS subscription:', e);
        }
        const localDup = liveDb.getSubscriptionByRkey(rkey);
        if (localDup?.id != null) {
          await liveDb.deleteSubscription(localDup.id);
          localByRkey.delete(rkey);
          result.removed.push(localDup.feedUrl || '');
          if (localDup.feedUrl) feedStatusStore.clearStatus(localDup.feedUrl);
        }
      }

      // Find added subscriptions (in remote but not local)
      for (const [rkey, record] of remoteByRkey) {
        if (!localByRkey.has(rkey)) {
          const isAtProto = record.value.sourceType?.startsWith('atproto.');
          const subscription: Subscription = {
            rkey,
            feedUrl: record.value.feedUrl,
            title:
              record.value.title || record.value.feedUrl || record.value.subjectDid || 'Untitled',
            siteUrl: record.value.siteUrl,
            category: record.value.category,
            tags: record.value.tags || [],
            createdAt: record.value.createdAt,
            updatedAt: record.value.updatedAt,
            localUpdatedAt: Date.now(),
            fetchStatus: isAtProto ? 'ready' : 'pending',
            sourceType: record.value.sourceType as Subscription['sourceType'],
            subjectDid: record.value.subjectDid,
            collectionNsid: record.value.collectionNsid,
            customTitle: record.value.customTitle,
            customIconUrl: record.value.customIconUrl,
          };

          const id = await liveDb.addSubscription(subscription);
          result.added.push(subscription.feedUrl || '');
          result.addedSubs.push({ ...subscription, id });
          if (subscription.feedUrl && !isAtProto) feedStatusStore.markPending(subscription.feedUrl);
        }
      }

      // Find removed subscriptions (in local but not remote)
      for (const [rkey, sub] of localByRkey) {
        if (!remoteByRkey.has(rkey)) {
          if (sub.id) {
            await liveDb.deleteSubscription(sub.id);
          }
          result.removed.push(sub.feedUrl || '');
          if (sub.feedUrl) feedStatusStore.clearStatus(sub.feedUrl);
        }
      }

      // Update existing subscriptions with any remote changes
      for (const [rkey, record] of remoteByRkey) {
        const local = localByRkey.get(rkey);
        if (local?.id) {
          // Check if anything changed
          // Preserve local siteUrl if PDS record doesn't have it
          const resolvedSiteUrl = record.value.siteUrl || local.siteUrl;
          const hasChanges =
            local.title !== (record.value.title || record.value.feedUrl) ||
            local.siteUrl !== resolvedSiteUrl ||
            local.category !== record.value.category ||
            local.sourceType !== record.value.sourceType ||
            local.subjectDid !== record.value.subjectDid ||
            local.customTitle !== record.value.customTitle ||
            local.customIconUrl !== record.value.customIconUrl;

          if (hasChanges) {
            await liveDb.updateSubscription(local.id, {
              title: record.value.title || record.value.feedUrl,
              siteUrl: resolvedSiteUrl,
              category: record.value.category,
              tags: record.value.tags || [],
              updatedAt: record.value.updatedAt,
              localUpdatedAt: Date.now(),
              sourceType: record.value.sourceType as Subscription['sourceType'],
              subjectDid: record.value.subjectDid,
              customTitle: record.value.customTitle,
              customIconUrl: record.value.customIconUrl,
            });
          }
        }
      }

      return result;
    } catch (e) {
      console.error('Failed to sync subscriptions:', e);
      return result;
    }
  }

  /**
   * Force refresh all feeds (bypass cache)
   */
  async function forceRefresh(): Promise<void> {
    phase = 'refreshing';

    try {
      const { forceRefreshAllFeeds } = await import('$lib/services/feedFetcher');
      await forceRefreshAllFeeds(liveDb.subscriptions, articlesStore.savedGuids);
      lastRefreshAt = Date.now();
      // Persist to IndexedDB for service worker and cross-session access
      setMetadata(LAST_REFRESH_KEY, lastRefreshAt);
    } catch (e) {
      console.error('Force refresh failed:', e);
    } finally {
      phase = 'ready';
    }
  }

  /**
   * Reset app state (for logout)
   */
  async function reset(): Promise<void> {
    phase = 'idle';
    error = null;
    lastRefreshAt = null;
    feedStatusStore.clearAll();
    articlesStore.resetPagination();
  }

  /**
   * Check if a refresh is needed (stale data)
   */
  function isStale(thresholdMs: number = 5 * 60 * 1000): boolean {
    if (!lastRefreshAt) return true;
    return Date.now() - lastRefreshAt > thresholdMs;
  }

  /**
   * One-time migration: push existing local customTitle/customIconUrl to backend
   */
  async function migrateCustomFieldsToBackend(): Promise<void> {
    try {
      const migrated = await getMetadata<boolean>('customFieldsMigrated');
      if (migrated) return;

      const subsWithCustomFields = liveDb.subscriptions.filter(
        (s) => s.customTitle || s.customIconUrl
      );

      if (subsWithCustomFields.length > 0) {
        console.log(
          `[Migration] Pushing ${subsWithCustomFields.length} custom field(s) to backend...`
        );
        await Promise.all(
          subsWithCustomFields.map((sub) =>
            api
              .updateSubscription(sub.rkey, {
                customTitle: sub.customTitle ?? null,
                customIconUrl: sub.customIconUrl ?? null,
              })
              .catch((err) => {
                console.error(`[Migration] Failed to push custom fields for ${sub.rkey}:`, err);
              })
          )
        );
      }

      await setMetadata('customFieldsMigrated', true);
    } catch (err) {
      console.error('[Migration] Custom fields migration failed:', err);
    }
  }

  return {
    // State
    get phase() {
      return phase;
    },
    get error() {
      return error;
    },
    get lastRefreshAt() {
      return lastRefreshAt;
    },

    // Derived
    get isInitialized() {
      return isInitialized;
    },
    get isHydrating() {
      return isHydrating;
    },
    get isRefreshing() {
      return isRefreshing;
    },
    get hasError() {
      return hasError;
    },

    // Actions
    initialize,
    refreshFromBackend,
    syncSubscriptions,
    forceRefresh,
    reset,
    isStale,
  };
}

export const appManager = createAppManager();
