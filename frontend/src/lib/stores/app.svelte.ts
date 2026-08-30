import { liveDb } from '$lib/services/liveDb.svelte';
import { itemLabelsStore } from './itemLabels.svelte';
import { linkblogStore } from './linkblog.svelte';
import { shareDraftsStore } from './shareDrafts.svelte';
import { myLinkblogStore } from './myLinkblog.svelte';
import { socialStore } from './social.svelte';
import { filteredViewsStore } from './filteredViews.svelte';
import { feedStatusStore } from './feedStatus.svelte';
import { articlesStore } from './articles.svelte';
import { syncStore } from './sync.svelte';
import { savesStore } from './saves.svelte';
import { magazineStore } from './magazine.svelte';
import { fetchAllFeeds, fetchAllDocuments } from '$lib/services/feedFetcher';
import { api } from '$lib/services/api';
import { dedupeRemoteSubscriptionRecords } from '$lib/services/subscriptionDedup';
import { getMetadata, setMetadata, checkDbHealth } from '$lib/services/db';
import type { Subscription } from '$lib/types';
import { auth } from './auth.svelte';

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
      const guestLoads = [
        liveDb.loadSubscriptions(),
        liveDb.loadArticles(),
        itemLabelsStore.load(),
      ];
      await Promise.all(
        auth.isGuest
          ? guestLoads
          : [
              ...guestLoads,
              linkblogStore.load(),
              shareDraftsStore.load(),
              filteredViewsStore.load(),
              savesStore.load(),
              magazineStore.load(),
            ]
      );

      // Feed statuses are NOT seeded here. A feed is healthy until the crawler's
      // health report says otherwise, and that report is the only thing that can
      // ever change a feed's status under the timeline path — see
      // feedStatus.svelte.ts.

      // Initialize pending count and process queue if online
      if (!auth.isGuest) await syncStore.updatePendingCount();
      if (!auth.isGuest && syncStore.isOnline && syncStore.pendingCount > 0) {
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
      if (auth.isGuest) {
        if (liveDb.subscriptions.length > 0) {
          newArticles = (await fetchAllFeeds(liveDb.subscriptions, articlesStore.savedGuids))
            .newArticles;
        }
        return newArticles;
      }

      await migrateGuestSubscriptions();
      // Sync subscriptions and reload every server-backed user collection in parallel.
      // Saves must participate here (not only during initialize): another device can
      // add one while this tab stays open, and an explicit refresh is the user's way
      // to pull that new server row into this device's IndexedDB cache.
      const [syncResult] = await Promise.all([
        syncSubscriptions(),
        itemLabelsStore.load(),
        savesStore.load(),
        magazineStore.load(),
        socialStore.loadFeed(true),
        filteredViewsStore.syncWithBackend(),
        // Pull the user's own linkblog so share-state reconciles across devices.
        // Forced each refresh so a share made elsewhere lights up the button here;
        // then reconcile prunes any local share the (complete) pull says is gone.
        myLinkblogStore.load(true).then(() => linkblogStore.reconcile()),
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

  // Runs before reconciliation: otherwise syncSubscriptions would interpret the
  // guest-only rkeys as remote deletions. The bulk endpoint is idempotent, so a
  // failed boot safely retries while the marker remains set.
  async function migrateGuestSubscriptions(): Promise<void> {
    if (!auth.isAuthenticated || !auth.hasGuestData) return;
    const rss = liveDb.subscriptions.filter((subscription) => subscription.feedUrl);
    for (let index = 0; index < rss.length; index += 50) {
      await api.bulkCreateSubscriptions(
        rss.slice(index, index + 50).map((subscription) => ({
          rkey: subscription.rkey,
          feedUrl: subscription.feedUrl!,
          title: subscription.title,
          siteUrl: subscription.siteUrl,
          category: subscription.category,
          source: subscription.source,
        }))
      );
    }
    auth.exitGuestMode();
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
        [...remoteByRkey.entries()].map(([rkey, r]) => ({
          rkey,
          value: r.value,
        }))
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
          // A documents subscription's feedUrl is the publication it's scoped to,
          // and that MOVES: when an author connects an existing publication, the
          // server re-points every follower's row. Take the remote value so this
          // device re-scopes too. (Only for documents — an RSS feedUrl is the
          // identity its cached articles hang off, so it stays local.)
          const resolvedFeedUrl =
            record.value.sourceType === 'atproto.documents' && record.value.feedUrl
              ? record.value.feedUrl
              : local.feedUrl;
          const hasChanges =
            local.title !== (record.value.title || record.value.feedUrl) ||
            local.siteUrl !== resolvedSiteUrl ||
            local.feedUrl !== resolvedFeedUrl ||
            local.category !== record.value.category ||
            local.sourceType !== record.value.sourceType ||
            local.subjectDid !== record.value.subjectDid ||
            local.customTitle !== record.value.customTitle ||
            local.customIconUrl !== record.value.customIconUrl;

          if (hasChanges) {
            await liveDb.updateSubscription(local.id, {
              title: record.value.title || record.value.feedUrl,
              feedUrl: resolvedFeedUrl,
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
