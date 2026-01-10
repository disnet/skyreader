import { db } from './db';
import type { SyncQueueItem } from '$lib/types';
import { browser } from '$app/environment';

class SyncQueueService {
  private isProcessing = false;
  private onlineHandler: (() => void) | null = null;

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
    if (this.isProcessing || !browser || !navigator.onLine) return;

    this.isProcessing = true;

    try {
      const items = await db.syncQueue.orderBy('timestamp').toArray();

      for (const item of items) {
        try {
          await this.processItem(item);
          await db.syncQueue.delete(item.id!);
        } catch (error) {
          await db.syncQueue.update(item.id!, {
            retryCount: item.retryCount + 1,
            lastError: error instanceof Error ? error.message : 'Unknown error',
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
    // This will be implemented when we have the AT Protocol client
    // For now, just log the operation
    console.log('Processing sync item:', item);

    // TODO: Implement actual AT Protocol record operations
    // await atproto.createRecord(item.collection, item.rkey, item.record!);
  }

  async getPendingCount(): Promise<number> {
    return db.syncQueue.count();
  }
}

export const syncQueue = new SyncQueueService();
