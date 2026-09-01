import { browser } from '$app/environment';
import { syncQueue } from '$lib/services/sync-queue';

function createSyncStore() {
  let isOnline = $state(browser ? navigator.onLine : true);
  let lastSyncedAt = $state<number | null>(null);
  let pendingCount = $state(0);

  if (browser) {
    // Initialize pending count
    syncQueue.getPendingCount().then((count) => {
      pendingCount = count;
    });

    // Listen for pending count changes
    syncQueue.setOnPendingCountChange((count) => {
      pendingCount = count;
    });

    window.addEventListener('online', async () => {
      isOnline = true;
      // Process queue when coming back online, THEN pull. Draining first means
      // our own offline writes reach the server before we ask what changed, so
      // the delta we get back already reflects them and can't briefly revert the
      // UI to the pre-offline state. This event used to only drain — coming back
      // online showed our own changes and none of anyone else's.
      await triggerSync();
      const { itemLabelsStore } = await import('./itemLabels.svelte');
      await itemLabelsStore.pullDelta();
    });

    window.addEventListener('offline', () => {
      isOnline = false;
      // Register for background sync when going offline
      syncQueue.registerBackgroundSync();
    });

    // Listen for service worker messages to process queue
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', async (event) => {
        if (event.data?.type === 'PROCESS_SYNC_QUEUE') {
          await triggerSync();
        } else if (event.data?.type === 'BACKGROUND_REFRESH_REQUESTED') {
          // Handle background refresh request from periodic sync
          console.log('Background refresh requested by service worker');
          // Dynamically import to avoid circular dependency
          const { appManager } = await import('./app.svelte');
          if (appManager.isInitialized) {
            await appManager.refreshFromBackend();
          }
        }
      });
    }
  }

  async function triggerSync() {
    if (!isOnline) return;

    const result = await syncQueue.processQueue();
    if (result.processed > 0 || result.failed > 0) {
      lastSyncedAt = Date.now();
    }
  }

  async function updatePendingCount() {
    pendingCount = await syncQueue.getPendingCount();
  }

  /**
   * Record that this device is up to date with the server.
   *
   * `lastSyncedAt` used to move only when the outbound queue drained, so a
   * device that had nothing to push reported "not since this page opened"
   * however much it had pulled — the one number a reader looks at to answer
   * "did my other device's reading arrive?" said nothing.
   */
  function markSynced() {
    lastSyncedAt = Date.now();
  }

  return {
    get isOnline() {
      return isOnline;
    },
    get pendingCount() {
      return pendingCount;
    },
    get lastSyncedAt() {
      return lastSyncedAt;
    },
    triggerSync,
    updatePendingCount,
    markSynced,
  };
}

export const syncStore = createSyncStore();
