import { browser } from '$app/environment';
import { db } from '$lib/services/db';
import { syncQueue } from '$lib/services/sync-queue';

function createSyncStore() {
  let isOnline = $state(browser ? navigator.onLine : true);
  let pendingCount = $state(0);
  let lastSyncedAt = $state<number | null>(null);

  if (browser) {
    window.addEventListener('online', () => {
      isOnline = true;
      syncQueue.processQueue();
    });

    window.addEventListener('offline', () => {
      isOnline = false;
    });

    // Initialize sync queue
    syncQueue.init();

    // Update pending count periodically
    const updatePendingCount = async () => {
      pendingCount = await syncQueue.getPendingCount();
    };

    updatePendingCount();
    setInterval(updatePendingCount, 5000);
  }

  async function triggerSync() {
    if (!isOnline) return;

    await syncQueue.processQueue();
    pendingCount = await syncQueue.getPendingCount();
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
  };
}

export const syncStore = createSyncStore();
