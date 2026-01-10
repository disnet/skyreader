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

      for (const item of items) {
        try {
          await this.processItem(item);
          await db.syncQueue.delete(item.id!);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          // If unauthorized, stop processing - session is invalid
          if (errorMessage === 'Unauthorized') {
            console.error('Sync failed: session expired or invalid');
            break;
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
    } finally {
      this.isProcessing = false;
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
    if (collection === 'com.at-rss.feed.subscription') {
      const sub = await db.subscriptions.where('rkey').equals(rkey).first();
      if (sub?.id) {
        await db.subscriptions.update(sub.id, { atUri, syncStatus: 'synced' });
        this.notifySyncComplete(collection, rkey);
      }
    } else if (collection === 'com.at-rss.feed.readPosition') {
      const pos = await db.readPositions.where('rkey').equals(rkey).first();
      if (pos?.id) {
        await db.readPositions.update(pos.id, { atUri, syncStatus: 'synced' });
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
      this.onSyncCompleteCallbacks = this.onSyncCompleteCallbacks.filter(cb => cb !== callback);
    };
  }

  private notifySyncComplete(collection: string, rkey: string) {
    for (const callback of this.onSyncCompleteCallbacks) {
      callback(collection, rkey);
    }
  }
}

export const syncQueue = new SyncQueueService();
