import { browser } from '$app/environment';

function createSyncStore() {
	let isOnline = $state(browser ? navigator.onLine : true);
	let lastSyncedAt = $state<number | null>(null);

	if (browser) {
		window.addEventListener('online', () => {
			isOnline = true;
		});

		window.addEventListener('offline', () => {
			isOnline = false;
		});
	}

	async function triggerSync() {
		// Sync is now handled directly by the stores - this is a no-op
		// but kept for API compatibility
		lastSyncedAt = Date.now();
	}

	return {
		get isOnline() {
			return isOnline;
		},
		get pendingCount() {
			// No more pending queue - data syncs directly
			return 0;
		},
		get lastSyncedAt() {
			return lastSyncedAt;
		},
		triggerSync,
	};
}

export const syncStore = createSyncStore();
