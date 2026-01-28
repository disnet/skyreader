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
			// Process queue when coming back online
			await triggerSync();
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
	};
}

export const syncStore = createSyncStore();
