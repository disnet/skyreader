import { browser } from '$app/environment';

const PERIODIC_SYNC_TAG = 'background-feed-refresh';
const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Register for periodic background sync (Chromium only)
 *
 * This allows the service worker to wake up periodically and refresh data
 * even when the tab is closed. Note that the browser controls the actual
 * interval and may delay syncs for low-engagement sites.
 */
export async function registerPeriodicSync(): Promise<boolean> {
	if (!browser) return false;

	// Check if periodic sync is supported (Chromium only)
	if (!('serviceWorker' in navigator)) return false;

	try {
		const registration = await navigator.serviceWorker.ready;

		// Check if periodicSync is available on the registration
		if (!('periodicSync' in registration)) {
			console.log('Periodic Background Sync not supported');
			return false;
		}

		// Check permission status
		const status = await navigator.permissions.query({
			name: 'periodic-background-sync' as PermissionName,
		});

		if (status.state !== 'granted') {
			console.log('Periodic Background Sync permission not granted');
			return false;
		}

		// Register for periodic sync
		await (
			registration as ServiceWorkerRegistration & {
				periodicSync: {
					register: (tag: string, options: { minInterval: number }) => Promise<void>;
				};
			}
		).periodicSync.register(PERIODIC_SYNC_TAG, {
			minInterval: MIN_INTERVAL_MS,
		});

		console.log('Periodic Background Sync registered');
		return true;
	} catch (error) {
		console.log('Failed to register Periodic Background Sync:', error);
		return false;
	}
}

/**
 * Unregister from periodic background sync
 *
 * Call this on logout to stop background refreshes
 */
export async function unregisterPeriodicSync(): Promise<void> {
	if (!browser) return;

	if (!('serviceWorker' in navigator)) return;

	try {
		const registration = await navigator.serviceWorker.ready;

		if (!('periodicSync' in registration)) return;

		await (
			registration as ServiceWorkerRegistration & {
				periodicSync: { unregister: (tag: string) => Promise<void> };
			}
		).periodicSync.unregister(PERIODIC_SYNC_TAG);

		console.log('Periodic Background Sync unregistered');
	} catch (error) {
		console.log('Failed to unregister Periodic Background Sync:', error);
	}
}

export { PERIODIC_SYNC_TAG };
