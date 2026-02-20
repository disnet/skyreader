import { db, type SyncQueueEntry } from './db';
import { api } from './api';

const MAX_RETRIES = 5;

export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncCollection =
  | 'reading'
  | 'shares'
  | 'shareReading'
  | 'socialReading'
  | 'follows'
  | 'label'
  | 'saved';

// Payload types for each collection
export interface ReadingPayload {
  articleGuid: string;
  articleUrl?: string;
  articleTitle?: string;
}

export interface SharePayload {
  rkey: string;
  subscriptionRkey?: string;
  feedUrl: string;
  articleGuid: string;
  articleUrl: string;
  articleTitle?: string;
  articleAuthor?: string;
  articleContent?: string;
  articleDescription?: string;
  articleImage?: string;
  articlePublishedAt?: string;
  reshareOf?: {
    uri: string;
    authorDid: string;
  };
}

export interface ShareReadingPayload {
  rkey: string;
  shareUri: string;
  shareAuthorDid: string;
  itemUrl?: string;
  itemTitle?: string;
}

export interface SocialReadingPayload {
  type: 'share' | 'document';
  rkey: string;
  itemUri: string;
  authorDid: string;
  itemUrl?: string;
  itemTitle?: string;
}

export interface FollowPayload {
  rkey: string;
  did: string;
}

export interface LabelPayload {
  itemKey: string;
  itemType: string;
  label: string;
  props?: Record<string, unknown>;
}

export interface SavedPayload {
  rkey: string;
  url: string;
  fromFeed?: boolean;
  source?: string;
  itemGuid?: string;
  title?: string;
  author?: string;
  description?: string;
  image?: string;
  publishedAt?: string;
  domain?: string;
}

type SyncPayload =
  | ReadingPayload
  | SharePayload
  | ShareReadingPayload
  | SocialReadingPayload
  | FollowPayload
  | LabelPayload
  | SavedPayload;

class SyncQueue {
  private processing = false;
  private onPendingCountChange: ((count: number) => void) | null = null;

  setOnPendingCountChange(callback: (count: number) => void) {
    this.onPendingCountChange = callback;
  }

  /**
   * Add an operation to the sync queue
   * Handles deduplication and conflict resolution
   */
  async enqueue(
    operation: SyncOperation,
    collection: SyncCollection,
    key: string,
    payload: SyncPayload
  ): Promise<void> {
    // Check for existing entry with same collection+key
    const existing = await db.syncQueue.where('[collection+key]').equals([collection, key]).first();

    if (existing) {
      // Conflict resolution
      const resolved = this.resolveConflict(existing, operation, payload);
      if (resolved === null) {
        // Cancel out - delete the existing entry
        await db.syncQueue.delete(existing.id!);
      } else {
        // Update existing entry
        await db.syncQueue.update(existing.id!, {
          operation: resolved.operation,
          payload: JSON.stringify(resolved.payload),
          timestamp: Date.now(),
        });
      }
    } else {
      // No conflict - add new entry
      await db.syncQueue.add({
        operation,
        collection,
        key,
        payload: JSON.stringify(payload),
        timestamp: Date.now(),
        retryCount: 0,
        status: 'pending',
      });
    }

    await this.notifyPendingCount();
  }

  /**
   * Resolve conflicts between existing and new operations
   * Returns null if operations cancel out
   */
  private resolveConflict(
    existing: SyncQueueEntry,
    newOperation: SyncOperation,
    newPayload: SyncPayload
  ): { operation: SyncOperation; payload: SyncPayload } | null {
    const existingOp = existing.operation;

    // Same key, create -> delete: Remove both (never synced)
    if (existingOp === 'create' && newOperation === 'delete') {
      return null;
    }

    // Same key, any -> delete: Keep only delete
    if (newOperation === 'delete') {
      return { operation: 'delete', payload: newPayload };
    }

    // Same key, update -> update: Keep latest payload
    if (existingOp === 'update' && newOperation === 'update') {
      return { operation: 'update', payload: newPayload };
    }

    // Same key, create -> update: Keep create with updated payload
    if (existingOp === 'create' && newOperation === 'update') {
      return { operation: 'create', payload: newPayload };
    }

    // Default: keep new operation
    return { operation: newOperation, payload: newPayload };
  }

  /**
   * Process all pending items in the queue.
   * Batches reading and social reading create operations into bulk API calls.
   */
  async processQueue(): Promise<{ processed: number; failed: number }> {
    if (this.processing) {
      return { processed: 0, failed: 0 };
    }

    this.processing = true;
    let processed = 0;
    let failed = 0;

    try {
      const pendingItems = await db.syncQueue.where('status').equals('pending').sortBy('timestamp');

      // Partition items into batchable and non-batchable
      const readingCreateBatch: SyncQueueEntry[] = [];
      const socialReadingCreateBatch: SyncQueueEntry[] = [];
      const individualItems: SyncQueueEntry[] = [];

      for (const item of pendingItems) {
        if (item.collection === 'reading' && item.operation === 'create') {
          readingCreateBatch.push(item);
        } else if (item.collection === 'socialReading' && item.operation === 'create') {
          socialReadingCreateBatch.push(item);
        } else {
          individualItems.push(item);
        }
      }

      // Process reading creates in bulk
      if (readingCreateBatch.length > 0) {
        const result = await this.processBatchReadingCreates(readingCreateBatch);
        processed += result.processed;
        failed += result.failed;
      }

      // Process social reading creates in bulk
      if (socialReadingCreateBatch.length > 0) {
        const result = await this.processBatchSocialReadingCreates(socialReadingCreateBatch);
        processed += result.processed;
        failed += result.failed;
      }

      // Process remaining items individually
      for (const item of individualItems) {
        await db.syncQueue.update(item.id!, { status: 'processing' });

        try {
          await this.executeOperation(item);
          await db.syncQueue.delete(item.id!);
          processed++;
        } catch (e) {
          const error = e as Error;
          console.error(`Sync queue error for ${item.collection}/${item.key}:`, error);
          const result = await this.handleItemError(item, error);
          if (result === 'failed') failed++;
        }
      }
    } finally {
      this.processing = false;
      await this.notifyPendingCount();
    }

    return { processed, failed };
  }

  /**
   * Batch-process reading create operations using the bulk API.
   * Sends up to 500 items per request (matching backend limit).
   */
  private async processBatchReadingCreates(
    items: SyncQueueEntry[]
  ): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    const BATCH_SIZE = 500;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);

      // Mark all as processing
      for (const item of batch) {
        await db.syncQueue.update(item.id!, { status: 'processing' });
      }

      try {
        const bulkItems = batch.map((item) => {
          const payload = JSON.parse(item.payload) as ReadingPayload;
          return {
            itemGuid: payload.articleGuid,
            itemUrl: payload.articleUrl,
            itemTitle: payload.articleTitle,
          };
        });

        await api.markAsReadBulk(bulkItems);

        // Success — delete all from queue
        for (const item of batch) {
          await db.syncQueue.delete(item.id!);
        }
        processed += batch.length;
      } catch (e) {
        const error = e as Error;
        console.error('Bulk reading sync failed, falling back to individual:', error);

        // Fall back to individual processing
        for (const item of batch) {
          try {
            await this.executeOperation(item);
            await db.syncQueue.delete(item.id!);
            processed++;
          } catch (itemError) {
            const result = await this.handleItemError(item, itemError as Error);
            if (result === 'failed') failed++;
          }
        }
      }
    }

    return { processed, failed };
  }

  /**
   * Batch-process social reading create operations using the bulk API.
   * Sends up to 500 items per request (matching backend limit).
   */
  private async processBatchSocialReadingCreates(
    items: SyncQueueEntry[]
  ): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    const BATCH_SIZE = 500;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);

      // Mark all as processing
      for (const item of batch) {
        await db.syncQueue.update(item.id!, { status: 'processing' });
      }

      try {
        const bulkItems = batch.map((item) => {
          const payload = JSON.parse(item.payload) as SocialReadingPayload;
          return {
            type: payload.type,
            rkey: payload.rkey,
            itemUri: payload.itemUri,
            authorDid: payload.authorDid,
            itemUrl:
              payload.itemUrl &&
              (payload.itemUrl.startsWith('http://') || payload.itemUrl.startsWith('https://'))
                ? payload.itemUrl
                : undefined,
            itemTitle: payload.itemTitle || undefined,
          };
        });

        await api.markSocialItemsAsReadBulk(bulkItems);

        // Success — delete all from queue
        for (const item of batch) {
          await db.syncQueue.delete(item.id!);
        }
        processed += batch.length;
      } catch (e) {
        const error = e as Error;
        console.error('Bulk social reading sync failed, falling back to individual:', error);

        // Fall back to individual processing
        for (const item of batch) {
          try {
            await this.executeOperation(item);
            await db.syncQueue.delete(item.id!);
            processed++;
          } catch (itemError) {
            const result = await this.handleItemError(item, itemError as Error);
            if (result === 'failed') failed++;
          }
        }
      }
    }

    return { processed, failed };
  }

  /**
   * Handle an error for a single queue item (retry or fail).
   * Returns 'failed' if the item was marked as permanently failed.
   */
  private async handleItemError(
    item: SyncQueueEntry,
    error: Error
  ): Promise<'retrying' | 'failed'> {
    if (this.isRetryableError(error)) {
      const newRetryCount = item.retryCount + 1;
      if (newRetryCount >= MAX_RETRIES) {
        await db.syncQueue.update(item.id!, {
          status: 'failed',
          retryCount: newRetryCount,
        });
        return 'failed';
      } else {
        await db.syncQueue.update(item.id!, {
          status: 'pending',
          retryCount: newRetryCount,
        });
        return 'retrying';
      }
    } else {
      await db.syncQueue.update(item.id!, {
        status: 'failed',
        retryCount: item.retryCount + 1,
      });
      return 'failed';
    }
  }

  /**
   * Execute a single sync operation
   */
  private async executeOperation(entry: SyncQueueEntry): Promise<void> {
    const payload = JSON.parse(entry.payload) as SyncPayload;

    switch (entry.collection) {
      case 'reading':
        await this.executeReadingOperation(entry.operation, payload as ReadingPayload);
        break;
      case 'shares':
        await this.executeShareOperation(entry.operation, payload as SharePayload);
        break;
      case 'shareReading':
        await this.executeShareReadingOperation(entry.operation, payload as ShareReadingPayload);
        break;
      case 'socialReading':
        await this.executeSocialReadingOperation(entry.operation, payload as SocialReadingPayload);
        break;
      case 'follows':
        await this.executeFollowOperation(entry.operation, payload as FollowPayload);
        break;
      case 'label':
        await this.executeLabelOperation(entry.operation, payload as LabelPayload);
        break;
      case 'saved':
        await this.executeSavedOperation(entry.operation, payload as SavedPayload);
        break;
    }
  }

  private async executeReadingOperation(
    operation: SyncOperation,
    payload: ReadingPayload
  ): Promise<void> {
    switch (operation) {
      case 'create':
      case 'update':
        await api.markAsRead({
          itemGuid: payload.articleGuid,
          itemUrl: payload.articleUrl,
          itemTitle: payload.articleTitle,
        });
        break;
      case 'delete':
        await api.markAsUnread(payload.articleGuid);
        break;
    }
  }

  private async executeShareOperation(
    operation: SyncOperation,
    payload: SharePayload
  ): Promise<void> {
    switch (operation) {
      case 'create':
        await api.createShare({
          rkey: payload.rkey,
          itemUrl: payload.articleUrl,
          feedUrl: payload.feedUrl || undefined,
          itemGuid: payload.articleGuid || undefined,
          itemTitle: payload.articleTitle,
          itemAuthor: payload.articleAuthor,
          itemDescription: payload.articleDescription
            ? payload.articleDescription.slice(0, 1000)
            : undefined,
          content: payload.articleContent,
          itemImage:
            payload.articleImage &&
            (payload.articleImage.startsWith('http://') ||
              payload.articleImage.startsWith('https://'))
              ? payload.articleImage
              : undefined,
          itemPublishedAt: payload.articlePublishedAt,
          reshareOf: payload.reshareOf,
        });
        break;
      case 'delete':
        await api.deleteShare(payload.rkey);
        break;
    }
  }

  private async executeShareReadingOperation(
    operation: SyncOperation,
    payload: ShareReadingPayload
  ): Promise<void> {
    switch (operation) {
      case 'create':
        await api.markShareAsRead({
          rkey: payload.rkey,
          shareUri: payload.shareUri,
          shareAuthorDid: payload.shareAuthorDid,
          itemUrl:
            payload.itemUrl &&
            (payload.itemUrl.startsWith('http://') || payload.itemUrl.startsWith('https://'))
              ? payload.itemUrl
              : undefined,
          itemTitle: payload.itemTitle || undefined,
        });
        break;
      case 'delete':
        await api.markShareAsUnread(payload.rkey);
        break;
    }
  }

  private async executeSocialReadingOperation(
    operation: SyncOperation,
    payload: SocialReadingPayload
  ): Promise<void> {
    switch (operation) {
      case 'create':
        await api.markSocialItemAsRead({
          type: payload.type,
          rkey: payload.rkey,
          itemUri: payload.itemUri,
          authorDid: payload.authorDid,
          itemUrl:
            payload.itemUrl &&
            (payload.itemUrl.startsWith('http://') || payload.itemUrl.startsWith('https://'))
              ? payload.itemUrl
              : undefined,
          itemTitle: payload.itemTitle || undefined,
        });
        break;
      case 'delete':
        await api.markSocialItemAsUnread(payload.rkey);
        break;
    }
  }

  private async executeFollowOperation(
    operation: SyncOperation,
    payload: FollowPayload
  ): Promise<void> {
    switch (operation) {
      case 'create':
        await api.followUser(payload.rkey, payload.did);
        break;
      case 'delete':
        await api.unfollowUser(payload.rkey);
        break;
    }
  }

  private async executeLabelOperation(
    operation: SyncOperation,
    payload: LabelPayload
  ): Promise<void> {
    switch (operation) {
      case 'create':
        await api.addLabel({
          itemKey: payload.itemKey,
          itemType: payload.itemType as 'article' | 'share' | 'document' | 'userShare',
          label: payload.label,
          props: payload.props,
        });
        break;
      case 'delete':
        await api.deleteLabel(payload.itemKey, payload.label);
        break;
    }
  }

  private async executeSavedOperation(
    operation: SyncOperation,
    payload: SavedPayload
  ): Promise<void> {
    switch (operation) {
      case 'create':
        await api.saveFromUrl(payload.url, payload.rkey, {
          fromFeed: payload.fromFeed,
          source: payload.source as 'url' | 'feed' | 'share' | 'document' | undefined,
          itemGuid: payload.itemGuid,
          title: payload.title,
          author: payload.author,
          description: payload.description,
          image: payload.image,
          publishedAt: payload.publishedAt,
          domain: payload.domain,
        });
        break;
      case 'delete':
        if (payload.itemGuid) {
          await api.deleteSavedByGuid(payload.itemGuid);
        } else {
          await api.deleteSaved(payload.rkey);
        }
        break;
    }
  }

  /**
   * Check if an error is retryable (network issues)
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    // Network errors are retryable
    if (
      message.includes('network') ||
      message.includes('fetch') ||
      message.includes('timeout') ||
      message.includes('offline')
    ) {
      return true;
    }
    // 5xx server errors are retryable
    if (message.includes('http 5')) {
      return true;
    }
    // 401 should trigger logout, not retry
    if (message.includes('session expired') || message.includes('401')) {
      return false;
    }
    // 400, 409 errors are not retryable
    if (message.includes('http 4')) {
      return false;
    }
    // Default: assume retryable
    return true;
  }

  /**
   * Get count of pending items
   */
  async getPendingCount(): Promise<number> {
    return db.syncQueue.where('status').equals('pending').count();
  }

  /**
   * Get count of failed items
   */
  async getFailedCount(): Promise<number> {
    return db.syncQueue.where('status').equals('failed').count();
  }

  /**
   * Clear failed items
   */
  async clearFailed(): Promise<void> {
    await db.syncQueue.where('status').equals('failed').delete();
    await this.notifyPendingCount();
  }

  /**
   * Retry failed items
   */
  async retryFailed(): Promise<void> {
    await db.syncQueue.where('status').equals('failed').modify({
      status: 'pending',
      retryCount: 0,
    });
    await this.notifyPendingCount();
  }

  private async notifyPendingCount(): Promise<void> {
    if (this.onPendingCountChange) {
      const count = await this.getPendingCount();
      this.onPendingCountChange(count);
    }
  }

  /**
   * Register for background sync (if supported)
   */
  async registerBackgroundSync(): Promise<void> {
    if ('serviceWorker' in navigator && 'sync' in window.ServiceWorkerRegistration.prototype) {
      try {
        const registration = await navigator.serviceWorker.ready;
        await (
          registration as ServiceWorkerRegistration & {
            sync: { register: (tag: string) => Promise<void> };
          }
        ).sync.register('sync-queue');
      } catch (e) {
        console.warn('Background sync registration failed:', e);
      }
    }
  }
}

export const syncQueue = new SyncQueue();
