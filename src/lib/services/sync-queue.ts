import { db } from './db';
import { api } from './api';
import type { SyncQueueItem } from '$lib/types';
import { browser } from '$app/environment';
import { auth } from '$lib/stores/auth.svelte';

class SyncQueueService {
	private isProcessing = false;
	private onlineHandler: (() => void) | null = null;
	private onSyncCompleteCallbacks: Array<(collection: string, rkey: string) => void> = [];

	init() {
		if (!browser) return;

		this.onlineHandler = () => {
			if (navigator.onLine) {
				this.processQueue();
			}
		};
		window.addEventListener('online', this.onlineHandler);

		// Process on init if online
		if (navigator.onLine) {
			this.processQueue();
		}
	}

	destroy() {
		if (this.onlineHandler && browser) {
			window.removeEventListener('online', this.onlineHandler);
		}
	}

	async enqueue(item: Omit<SyncQueueItem, 'id' | 'timestamp' | 'retryCount'>) {
		await db.syncQueue.add({
			...item,
			timestamp: Date.now(),
			retryCount: 0,
		});

		if (browser && navigator.onLine) {
			this.processQueue();
		}
	}

	async processQueue() {
		if (this.isProcessing || !browser || !navigator.onLine || !auth.isAuthenticated) return;

		this.isProcessing = true;

		try {
			const items = await db.syncQueue.orderBy('timestamp').toArray();
			if (items.length === 0) return;

			// Group items by collection for batching
			const batches = new Map<string, SyncQueueItem[]>();
			for (const item of items) {
				const key = item.collection;
				if (!batches.has(key)) {
					batches.set(key, []);
				}
				batches.get(key)!.push(item);
			}

			// Process each collection batch
			for (const [collection, batchItems] of batches) {
				// Filter to only create operations for bulk sync (updates/deletes handled individually)
				const createItems = batchItems.filter((item) => item.operation === 'create');
				const otherItems = batchItems.filter((item) => item.operation !== 'create');

				// Process create operations in bulk
				if (createItems.length > 0) {
					try {
						await this.processBatch(createItems);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : 'Unknown error';

						if (errorMessage === 'Unauthorized') {
							console.error('Sync failed: session expired or invalid');
							return;
						}

						// Fall back to individual processing on batch failure
						console.warn(
							`Batch sync failed for ${collection}, falling back to individual processing:`,
							errorMessage
						);
						for (const item of createItems) {
							await this.processItemWithRetry(item);
						}
					}
				}

				// Process update/delete operations individually
				for (const item of otherItems) {
					await this.processItemWithRetry(item);
				}
			}
		} finally {
			this.isProcessing = false;
		}
	}

	private async processBatch(items: SyncQueueItem[]) {
		if (items.length === 0) return;

		console.log(`Processing batch of ${items.length} items for ${items[0].collection}`);

		const operations = items.map((item) => ({
			operation: item.operation,
			collection: item.collection,
			rkey: item.rkey,
			record: item.record,
		}));

		const response = await api.bulkSyncRecords(operations);

		// Update local records and remove from queue
		for (const result of response.results) {
			const item = items.find((i) => i.rkey === result.rkey);
			if (item) {
				if (result.uri) {
					await this.updateLocalRecord(item.collection, item.rkey, result.uri);
				}
				await db.syncQueue.delete(item.id!);
			}
		}
	}

	private async processItemWithRetry(item: SyncQueueItem) {
		try {
			await this.processItem(item);
			await db.syncQueue.delete(item.id!);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';

			if (errorMessage === 'Unauthorized') {
				console.error('Sync failed: session expired or invalid');
				throw error;
			}

			await db.syncQueue.update(item.id!, {
				retryCount: item.retryCount + 1,
				lastError: errorMessage,
			});

			if (item.retryCount >= 5) {
				console.error('Sync item failed after 5 retries:', item);
				await db.syncQueue.delete(item.id!);
			}
		}
	}

	private async processItem(item: SyncQueueItem) {
		console.log('Processing sync item:', item);

		const response = await api.syncRecord({
			operation: item.operation,
			collection: item.collection,
			rkey: item.rkey,
			record: item.record,
		});

		// Update local record with atUri and syncStatus after successful sync
		if (item.operation !== 'delete' && response.uri) {
			await this.updateLocalRecord(item.collection, item.rkey, response.uri);
		}
	}

	private async updateLocalRecord(collection: string, rkey: string, atUri: string) {
		if (collection === 'app.skyreader.feed.subscription') {
			const sub = await db.subscriptions.where('rkey').equals(rkey).first();
			if (sub?.id) {
				await db.subscriptions.update(sub.id, { atUri, syncStatus: 'synced' });
				this.notifySyncComplete(collection, rkey);
			}
		} else if (collection === 'app.skyreader.social.share') {
			const share = await db.userShares.where('rkey').equals(rkey).first();
			if (share?.id) {
				await db.userShares.update(share.id, { atUri, syncStatus: 'synced' });
				this.notifySyncComplete(collection, rkey);
			}
		} else if (collection === 'app.skyreader.social.shareReadPosition') {
			const pos = await db.shareReadPositions.where('rkey').equals(rkey).first();
			if (pos?.id) {
				await db.shareReadPositions.update(pos.id, { atUri, syncStatus: 'synced' });
				this.notifySyncComplete(collection, rkey);
			}
		}
	}

	async getPendingCount(): Promise<number> {
		return db.syncQueue.count();
	}

	onSyncComplete(callback: (collection: string, rkey: string) => void) {
		this.onSyncCompleteCallbacks.push(callback);
		return () => {
			this.onSyncCompleteCallbacks = this.onSyncCompleteCallbacks.filter((cb) => cb !== callback);
		};
	}

	private notifySyncComplete(collection: string, rkey: string) {
		for (const callback of this.onSyncCompleteCallbacks) {
			callback(collection, rkey);
		}
	}
}

export const syncQueue = new SyncQueueService();
