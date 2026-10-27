import { db, type SyncQueueEntry } from './db';
import { api, ApiError } from './api';
import { toUnifiedReadItem } from './readSync';
import { marginPublishQueue } from '$lib/stores/marginPublishQueue.svelte';
import type {
  MagazineItemSnapshot,
  MagazineParams,
  MagazinePosition,
  SavedMetadataEdit,
  ShareDraft,
} from '$lib/types';

const MAX_RETRIES = 5;

export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncCollection =
  'reading' | 'socialReading' | 'label' | 'saved' | 'integration' | 'magazine' | 'shareDraft';

// Payload types for each collection
export interface ReadingPayload {
  articleGuid: string;
  articleUrl?: string;
  articleTitle?: string;
}

export interface SocialReadingPayload {
  type: 'document';
  rkey: string;
  itemUri: string;
  authorDid: string;
  itemUrl?: string;
  itemTitle?: string;
}

export interface LabelPayload {
  itemKey: string;
  itemType: string;
  label: string;
  props?: Record<string, unknown>;
  // Set on highlight writes made in guest mode, so draining them into an
  // existing account unions rather than replacing. See syncHighlightsToBackend.
  mode?: 'replace' | 'merge';
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
  content?: string;
  wordCount?: number;
  image?: string;
  publishedAt?: string;
  domain?: string;
  doi?: string;
  // The reader's edit of the save's metadata: an 'update' carries only this,
  // and an edit made before the save itself synced rides on its 'create'.
  metadata?: SavedMetadataEdit;
}

export interface IntegrationPayload {
  type: 'semble' | 'margin';
  url: string;
  title?: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  collections?: { uri: string; cid: string }[];
  // Legacy single-collection fields — still read from in-flight queued entries
  collectionUri?: string;
  collectionCid?: string;
}

// Saving a highlight to Margin (at.margin.note). Routed through the `integration`
// collection but distinguished from bookmark/card payloads by `kind: 'note'`.
export interface MarginNotePayload {
  kind: 'note';
  itemKey: string;
  highlightId: string;
  source: string;
  title?: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  note?: string;
  rkey?: string; // present for updates/deletes of already-synced notes
}

// Offline magazine write. Both create and position-update carry the FULL
// magazine so the generic create+update / update+update conflict merges stay
// correct (the position-only PATCH endpoint is only used on the online fast
// path). Delete only needs `rkey`.
export interface MagazinePayload {
  rkey: string;
  params: MagazineParams;
  items: MagazineItemSnapshot[];
  position?: MagazinePosition | null;
  title?: string | null;
}

// Offline share-draft write. Carries the whole draft (like magazines) so the
// generic create+update / update+update conflict collapse stays trivial; the
// key is the article URL. The draft's own `updatedAt` (client ms) is what the
// server's last-write-wins guard compares, so a queued write that has been
// overtaken by an edit elsewhere is dropped server-side rather than clobbering
// it — which is exactly what makes replaying a stale queue safe.
export type ShareDraftPayload = ShareDraft;

type SyncPayload =
  | ReadingPayload
  | SocialReadingPayload
  | LabelPayload
  | SavedPayload
  | IntegrationPayload
  | MarginNotePayload
  | MagazinePayload
  | ShareDraftPayload;

/** Saves one bulk delete request carries (the backend's MAX_BULK_DELETE). */
export const SAVED_DELETE_BATCH = 500;

/** The save a queued saved entry is about, whatever key it was queued under. */
function payloadRkey(entry: SyncQueueEntry): string | null {
  try {
    const rkey = (JSON.parse(entry.payload) as { rkey?: unknown }).rkey;
    return typeof rkey === 'string' ? rkey : null;
  } catch {
    return null;
  }
}

/** A queued save delete by rkey, which the bulk delete endpoint can carry. */
function isBulkSavedDelete(entry: SyncQueueEntry): boolean {
  if (entry.collection !== 'saved' || entry.operation !== 'delete') return false;
  try {
    const payload = JSON.parse(entry.payload) as SavedPayload;
    return !payload.itemGuid && payload.rkey === entry.key;
  } catch {
    return false;
  }
}

class SyncQueue {
  private processing = false;
  private onPendingCountChange: ((count: number) => void) | null = null;

  setOnPendingCountChange(callback: (count: number) => void) {
    this.onPendingCountChange = callback;
  }

  /**
   * The queued entry for this collection+key that belongs to the CURRENT
   * library — i.e. not one held for a signed-out account (see clearAllData).
   */
  private async liveEntry(
    collection: SyncCollection,
    key: string
  ): Promise<SyncQueueEntry | undefined> {
    const entries = await db.syncQueue
      .where('[collection+key]')
      .equals([collection, key])
      .toArray();
    return entries.find((entry) => entry.status !== 'held');
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
    await this.write(operation, collection, key, payload);
    await this.notifyPendingCount();
  }

  /**
   * Queue the deletes of several saves at once (the Library's bulk delete), in
   * one transaction and before any is sent. Each is cleared as the server
   * confirms it (`clearSavedDeletes`), so a delete a refresh or a closed tab cuts
   * short still finishes from the queue instead of leaving the rest on the
   * server. Returns the rkeys still to delete there.
   *
   * A save's create and edits are queued under the key they were made with (a
   * feed save's guid, a document's record uri), so they're matched here by the
   * rkey in their payload. A create still waiting to be sent means the save
   * never reached the server: it and its edits just go, and there's nothing to
   * send. Edits of a save that did reach it go too; the delete supersedes them.
   */
  async enqueueSavedDeletes(saves: SavedPayload[]): Promise<string[]> {
    const toSend: string[] = [];
    await db.transaction('rw', db.syncQueue, async () => {
      const queued = new Map<string, SyncQueueEntry[]>();
      for (const entry of await db.syncQueue.where('collection').equals('saved').toArray()) {
        const rkey = entry.status === 'held' ? null : payloadRkey(entry);
        if (rkey) queued.set(rkey, [...(queued.get(rkey) ?? []), entry]);
      }
      for (const save of saves) {
        const entries = queued.get(save.rkey) ?? [];
        const unsent = entries.some((e) => e.operation === 'create' && e.status === 'pending');
        const superseded = entries.filter(
          (e) => e.operation === 'update' || (unsent && e.operation === 'create')
        );
        if (superseded.length > 0) await db.syncQueue.bulkDelete(superseded.map((e) => e.id!));
        if (unsent) continue;
        if (await this.write('delete', 'saved', save.rkey, save)) toSend.push(save.rkey);
      }
    });
    await this.notifyPendingCount();
    return toSend;
  }

  /** Drop the queued deletes of these saves: the server has confirmed them. */
  async clearSavedDeletes(rkeys: string[]): Promise<void> {
    await db.transaction('rw', db.syncQueue, async () => {
      for (const rkey of rkeys) {
        const entry = await this.liveEntry('saved', rkey);
        if (entry?.operation === 'delete') await db.syncQueue.delete(entry.id!);
      }
    });
    await this.notifyPendingCount();
  }

  /** The queue write behind `enqueue`. False when it cancelled a queued entry out. */
  private async write(
    operation: SyncOperation,
    collection: SyncCollection,
    key: string,
    payload: SyncPayload
  ): Promise<boolean> {
    // Check for existing entry with same collection+key. A HELD entry (parked by
    // an expired session, owned by a DID that may never come back) is not a
    // conflict partner: merging into one would leak the previous account's write
    // into this library, and updating it would strand the new write behind a
    // hold. Skip it and queue alongside.
    const existing = await this.liveEntry(collection, key);

    if (existing) {
      // Conflict resolution
      const resolved = this.resolveConflict(existing, operation, payload);
      if (resolved === null) {
        // Cancel out - delete the existing entry
        await db.syncQueue.delete(existing.id!);
        return false;
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
    return true;
  }

  /**
   * Drop a pending queued entry matching collection+key, if one exists.
   * Used to cancel an unsynced create (e.g. a Margin note save queued offline)
   * when the user undoes the action before it syncs.
   */
  async cancelPending(collection: SyncCollection, key: string): Promise<void> {
    const existing = await this.liveEntry(collection, key);
    if (existing) {
      await db.syncQueue.delete(existing.id!);
      await this.notifyPendingCount();
    }
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

    // Edits to a save's metadata accumulate: a second offline edit (of another
    // field) must not drop the first, and an edit of a save still waiting to be
    // created rides on that create.
    if (existing.collection === 'saved' && newOperation === 'update' && existingOp !== 'delete') {
      const prev = JSON.parse(existing.payload) as SavedPayload;
      const next = newPayload as SavedPayload;
      return {
        operation: existingOp,
        payload: { ...prev, metadata: { ...prev.metadata, ...next.metadata } },
      };
    }

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
      const savedDeleteBatch: SyncQueueEntry[] = [];
      const individualItems: SyncQueueEntry[] = [];

      for (const item of pendingItems) {
        if (item.collection === 'reading' && item.operation === 'create') {
          readingCreateBatch.push(item);
        } else if (item.collection === 'socialReading' && item.operation === 'create') {
          socialReadingCreateBatch.push(item);
        } else if (isBulkSavedDelete(item)) {
          savedDeleteBatch.push(item);
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

      // Save deletes in bulk, before the saves' other writes: a create queued
      // before a delete of the same save was cancelled out when the delete was
      // queued (enqueueSavedDeletes), so any create still here is a later one (a
      // re-save of the same article), and it must land after the delete.
      if (savedDeleteBatch.length > 0) {
        const result = await this.processBatchSavedDeletes(savedDeleteBatch);
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

  /** Queued save deletes, a bulk request (of up to 500) at a time. */
  private async processBatchSavedDeletes(
    items: SyncQueueEntry[]
  ): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < items.length; i += SAVED_DELETE_BATCH) {
      // Left 'pending' while in flight: nothing returns an entry from
      // 'processing', and a refresh mid-request would strand the whole batch.
      // Sending one twice is harmless; the bulk delete skips saves already gone.
      const batch = items.slice(i, i + SAVED_DELETE_BATCH);
      try {
        await api.deleteSavedMany(batch.map((item) => item.key));
        await db.syncQueue.bulkDelete(batch.map((item) => item.id!));
        processed += batch.length;
      } catch (e) {
        console.error('Bulk saved delete sync failed:', e);
        for (const item of batch) {
          if ((await this.handleItemError(item, e as Error)) === 'failed') failed++;
        }
      }
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
            // The enqueue time IS the user's action time. Sending it is what
            // stops a queue draining an hour late from overwriting what the
            // user has since done on another device.
            updatedAt: item.timestamp,
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
        const bulkItems = batch.map((item) => ({
          ...toUnifiedReadItem(JSON.parse(item.payload) as SocialReadingPayload),
          updatedAt: item.timestamp,
        }));

        // Document reads are unified onto the article read path (/api/reading).
        await api.markAsReadBulk(bulkItems);

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
        await this.executeReadingOperation(
          entry.operation,
          payload as ReadingPayload,
          entry.timestamp
        );
        break;
      case 'socialReading':
        await this.executeSocialReadingOperation(
          entry.operation,
          payload as SocialReadingPayload,
          entry.timestamp
        );
        break;
      case 'label':
        await this.executeLabelOperation(entry.operation, payload as LabelPayload, entry.timestamp);
        break;
      case 'saved':
        await this.executeSavedOperation(entry.operation, payload as SavedPayload);
        break;
      case 'integration': {
        const integrationPayload = payload as IntegrationPayload | MarginNotePayload;
        if ('kind' in integrationPayload && integrationPayload.kind === 'note') {
          await this.executeMarginNoteOperation(entry.operation, integrationPayload);
        } else {
          await this.executeIntegrationOperation(
            entry.operation,
            integrationPayload as IntegrationPayload
          );
        }
        break;
      }
      case 'magazine':
        await this.executeMagazineOperation(entry.operation, payload as MagazinePayload);
        break;
      case 'shareDraft':
        await this.executeShareDraftOperation(entry.operation, payload as ShareDraftPayload);
        break;
    }
  }

  private async executeShareDraftOperation(
    operation: SyncOperation,
    payload: ShareDraftPayload
  ): Promise<void> {
    switch (operation) {
      case 'create':
      case 'update':
        await api.upsertShareDraft(payload);
        break;
      case 'delete':
        await api.deleteShareDraft(payload.articleUrl, payload.updatedAt);
        break;
    }
  }

  private async executeMagazineOperation(
    operation: SyncOperation,
    payload: MagazinePayload
  ): Promise<void> {
    switch (operation) {
      case 'create':
      case 'update':
        // Offline writes always resend the whole magazine (position included).
        await api.upsertMagazine({
          rkey: payload.rkey,
          params: payload.params,
          items: payload.items,
          position: payload.position ?? null,
          title: payload.title ?? null,
        });
        break;
      case 'delete':
        await api.deleteMagazine(payload.rkey);
        break;
    }
  }

  // `queuedAt` is the entry's own enqueue time — the moment the USER acted. It
  // rides every write as the last-write-wins key, so a queue that drains long
  // after the fact loses to anything the user did more recently elsewhere
  // instead of winning on arrival order.
  private async executeReadingOperation(
    operation: SyncOperation,
    payload: ReadingPayload,
    queuedAt: number
  ): Promise<void> {
    switch (operation) {
      case 'create':
      case 'update':
        await api.markAsRead({
          itemGuid: payload.articleGuid,
          itemUrl: payload.articleUrl,
          itemTitle: payload.articleTitle,
          updatedAt: queuedAt,
        });
        break;
      case 'delete':
        await api.markAsUnread(payload.articleGuid, queuedAt);
        break;
    }
  }

  private async executeSocialReadingOperation(
    operation: SyncOperation,
    payload: SocialReadingPayload,
    queuedAt: number
  ): Promise<void> {
    switch (operation) {
      case 'create':
        // Document reads are unified onto the article read path (/api/reading).
        await api.markAsRead({ ...toUnifiedReadItem(payload), updatedAt: queuedAt });
        break;
      case 'delete':
        await api.markAsUnread(payload.itemUri, queuedAt);
        break;
    }
  }

  private async executeLabelOperation(
    operation: SyncOperation,
    payload: LabelPayload,
    queuedAt: number
  ): Promise<void> {
    switch (operation) {
      case 'create':
        await api.addLabel({
          itemKey: payload.itemKey,
          itemType: payload.itemType as 'article' | 'document',
          label: payload.label,
          props: payload.props,
          updatedAt: queuedAt,
          mode: payload.mode,
        });
        break;
      case 'delete':
        await api.deleteLabel(payload.itemKey, payload.label, queuedAt);
        break;
    }
  }

  private async executeSavedOperation(
    operation: SyncOperation,
    payload: SavedPayload
  ): Promise<void> {
    switch (operation) {
      case 'create': {
        const created = await api.saveFromUrl(payload.url, payload.rkey, {
          fromFeed: payload.fromFeed,
          source: payload.source as 'url' | 'feed' | 'document' | undefined,
          itemGuid: payload.itemGuid,
          title: payload.title,
          author: payload.author,
          description: payload.description,
          content: payload.content,
          wordCount: payload.wordCount,
          image: payload.image,
          publishedAt: payload.publishedAt,
          domain: payload.domain,
          doi: payload.doi,
        });
        // The save landed, so this entry is done whatever the edit does: a
        // failed edit mustn't replay the create, so it waits as an update of
        // its own (keyed by rkey, apart from this create's entry). The server
        // may have filed the save under an existing save's rkey.
        if (payload.metadata) {
          const rkey = created.rkey || payload.rkey;
          await api.updateSaved(rkey, payload.metadata).catch(async (err) => {
            console.warn('Failed to apply queued edit to a new save, requeueing:', err);
            await this.enqueue('update', 'saved', rkey, {
              rkey,
              url: payload.url,
              metadata: payload.metadata,
            });
          });
        }
        break;
      }
      case 'update':
        if (payload.metadata) await api.updateSaved(payload.rkey, payload.metadata);
        break;
      case 'delete':
        try {
          if (payload.itemGuid) {
            await api.deleteSavedByGuid(payload.itemGuid);
          } else {
            await api.deleteSaved(payload.rkey);
          }
        } catch (err) {
          // Already gone: a bulk delete that sent this one and was cut off
          // before it could clear the entry. The delete is done.
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        break;
    }
  }

  /** Save/delete a Margin highlight note (at.margin.note). */
  private async executeMarginNoteOperation(
    operation: SyncOperation,
    payload: MarginNotePayload
  ): Promise<void> {
    if (operation === 'delete') {
      if (payload.rkey) await api.deleteMarginNote(payload.rkey);
      return;
    }
    if (operation === 'update') {
      // Editing the note on an already-synced highlight: update in place by rkey.
      if (payload.rkey) {
        await api.updateMarginNote(payload.rkey, {
          source: payload.source,
          title: payload.title,
          exact: payload.exact,
          prefix: payload.prefix,
          suffix: payload.suffix,
          note: payload.note,
        });
      }
      return;
    }
    if (operation !== 'create') return;
    const result = await api.createMarginNote({
      source: payload.source,
      title: payload.title,
      exact: payload.exact,
      prefix: payload.prefix,
      suffix: payload.suffix,
      note: payload.note,
    });
    // Write the returned note uri/rkey back onto the highlight. Dynamic import
    // avoids a static cycle (itemLabels imports this module).
    const { itemLabelsStore } = await import('$lib/stores/itemLabels.svelte');
    await itemLabelsStore.setHighlightMargin(payload.itemKey, payload.highlightId, {
      uri: result.uri,
      rkey: result.rkey,
    });
    marginPublishQueue.delete(payload.highlightId);
  }

  private async executeIntegrationOperation(
    operation: SyncOperation,
    payload: IntegrationPayload
  ): Promise<void> {
    if (operation !== 'create') return;

    // Normalize legacy single-collection queued entries into the new array shape.
    const collections =
      payload.collections && payload.collections.length > 0
        ? payload.collections
        : payload.collectionUri && payload.collectionCid
          ? [{ uri: payload.collectionUri, cid: payload.collectionCid }]
          : [];

    if (payload.type === 'margin') {
      await api.createMarginBookmark({
        url: payload.url,
        title: payload.title,
        description: payload.description,
        collectionUris: collections.map((c) => c.uri),
      });
    } else {
      await api.createSembleCard({
        url: payload.url,
        title: payload.title,
        description: payload.description,
        author: payload.author,
        publishedAt: payload.publishedAt,
        collections,
      });
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
  /**
   * The rkeys of saves whose create (or, with `operation`, delete) has not
   * reached the backend yet (queued, in flight, or failed and still retryable).
   *
   * An external-backed snapshot is authoritative about collection MEMBERSHIP,
   * but it cannot know about a save that was never sent — so a wholesale
   * replace has to be told which rows to leave alone. A pending delete is a
   * save the server still lists that mustn't come back. See savesStore.load().
   */
  async pendingSavedRkeys(operation: SyncOperation = 'create'): Promise<Set<string>> {
    const rkeys = new Set<string>();
    const entries = await db.syncQueue.where('collection').equals('saved').toArray();
    for (const entry of entries) {
      if (entry.operation !== operation) continue;
      // Held entries belong to a signed-out account; their saves are not in
      // this library, so they must not shield rows from a snapshot replace.
      if (entry.status === 'held') continue;
      // A delete that failed for good never reached the server, whose save then
      // still stands: it mustn't hide it here.
      if (operation === 'delete' && entry.status === 'failed') continue;
      try {
        const payload = JSON.parse(entry.payload) as { rkey?: unknown };
        if (typeof payload.rkey === 'string') rkeys.add(payload.rkey);
      } catch {
        // A payload we can't read can't identify a row to protect.
      }
    }
    return rkeys;
  }

  /**
   * The ids of highlights with a Margin note write still in the queue (pending,
   * in flight, or failed and not yet cleared).
   *
   * The Margin highlight sync reads the note records back and lets Margin win
   * for what it holds, but a queued write is the reader's own change that hasn't
   * reached Margin yet: reading the older record back over it would undo it, and
   * a create not yet sent has no record to find. So the sync leaves these alone.
   */
  async pendingMarginNoteHighlightIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const entries = await db.syncQueue.where('collection').equals('integration').toArray();
    for (const entry of entries) {
      // Held entries belong to a signed-out account's library, not this one.
      if (entry.status === 'held') continue;
      try {
        const payload = JSON.parse(entry.payload) as { kind?: unknown; highlightId?: unknown };
        if (payload.kind === 'note' && typeof payload.highlightId === 'string') {
          ids.add(payload.highlightId);
        }
      } catch {
        // A payload we can't read can't name a highlight to protect.
      }
    }
    return ids;
  }

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
