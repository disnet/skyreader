import { api } from '$lib/services/api';
import { db } from '$lib/services/db';
import { safePut, safeAdd, safeBulkPut } from '$lib/services/safeDb.svelte';
import {
  syncQueue,
  type ReadingPayload,
  type SocialReadingPayload,
  type LabelPayload,
} from '$lib/services/sync-queue';
import { syncStore } from './sync.svelte';
import { savesStore } from './saves.svelte';
import type {
  ItemLabel,
  ItemLabelType,
  SocialItemType,
  SocialReadPosition,
  Highlight,
} from '$lib/types';

const BULK_BATCH_SIZE = 500;

// Re-export for consumers that used this type from reading store
export interface SavedArticle {
  articleGuid: string;
  articleUrl?: string;
  articleTitle?: string;
  readAt: number;
}

function generateTid(): string {
  const now = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${now.toString(36)}${random}`;
}

function createItemLabelsStore() {
  // Primary state: all labels indexed by compound key "itemKey:label"
  let labelMap = $state<Map<string, ItemLabel>>(new Map());
  // Secondary index: itemKey → Set of labels
  let labelsByItem = $state<Map<string, Set<string>>>(new Map());
  // Social read positions: itemUri → SocialReadPosition (for backend sync compatibility)
  let socialPositions = $state<Map<string, SocialReadPosition>>(new Map());
  let isLoading = $state(true);
  let hasLoaded = false;

  // Debounce state for batching mark-read calls
  let pendingMarkRead: Array<{
    articleGuid: string;
    articleUrl: string;
    articleTitle?: string;
  }> = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 300;

  // --- Internal helpers ---

  function makeKey(itemKey: string, label: string): string {
    return `${itemKey}\0${label}`;
  }

  function addToState(lbl: ItemLabel) {
    const key = makeKey(lbl.itemKey, lbl.label);
    labelMap.set(key, lbl);

    let itemLabels = labelsByItem.get(lbl.itemKey);
    if (!itemLabels) {
      itemLabels = new Set();
      labelsByItem.set(lbl.itemKey, itemLabels);
    }
    itemLabels.add(lbl.label);
  }

  function removeFromState(itemKey: string, label: string) {
    const key = makeKey(itemKey, label);
    labelMap.delete(key);

    const itemLabels = labelsByItem.get(itemKey);
    if (itemLabels) {
      itemLabels.delete(label);
      if (itemLabels.size === 0) {
        labelsByItem.delete(itemKey);
      }
    }
  }

  function triggerReactivity() {
    labelMap = new Map(labelMap);
    labelsByItem = new Map(labelsByItem);
  }

  async function putLabel(lbl: ItemLabel) {
    addToState(lbl);
    await safePut(db.itemLabels, lbl);
  }

  async function deleteLabel(itemKey: string, label: string) {
    removeFromState(itemKey, label);
    try {
      await db.itemLabels.where('[itemKey+label]').equals([itemKey, label]).delete();
    } catch (e) {
      console.error('Failed to delete label from DB:', e);
    }
  }

  // --- Flush pending mark-read ---

  async function flushPendingMarkRead() {
    if (pendingMarkRead.length === 0) return;

    const itemsToFlush = [...pendingMarkRead];
    pendingMarkRead = [];
    debounceTimer = null;

    if (syncStore.isOnline) {
      try {
        const bulkItems = itemsToFlush.map((item) => ({
          itemGuid: item.articleGuid,
          itemUrl: item.articleUrl,
          itemTitle: item.articleTitle,
        }));
        for (let i = 0; i < bulkItems.length; i += BULK_BATCH_SIZE) {
          await api.markAsReadBulk(bulkItems.slice(i, i + BULK_BATCH_SIZE));
        }
      } catch (e) {
        console.error('Failed to mark as read (batch), queueing for retry:', e);
        for (const item of itemsToFlush) {
          await syncQueue.enqueue('create', 'reading', item.articleGuid, {
            articleGuid: item.articleGuid,
            articleUrl: item.articleUrl,
            articleTitle: item.articleTitle,
          } as ReadingPayload);
        }
      }
    } else {
      for (const item of itemsToFlush) {
        await syncQueue.enqueue('create', 'reading', item.articleGuid, {
          articleGuid: item.articleGuid,
          articleUrl: item.articleUrl,
          articleTitle: item.articleTitle,
        } as ReadingPayload);
      }
    }
  }

  // --- Load ---

  async function load() {
    isLoading = true;

    // 1. Load from local IndexedDB cache first
    try {
      const allLabels = await db.itemLabels.toArray();
      if (allLabels.length > 0) {
        const newMap = new Map<string, ItemLabel>();
        const newByItem = new Map<string, Set<string>>();
        for (const lbl of allLabels) {
          newMap.set(makeKey(lbl.itemKey, lbl.label), lbl);
          let set = newByItem.get(lbl.itemKey);
          if (!set) {
            set = new Set();
            newByItem.set(lbl.itemKey, set);
          }
          set.add(lbl.label);
        }
        labelMap = newMap;
        labelsByItem = newByItem;
        isLoading = false;
      }
    } catch (e) {
      console.error('Failed to load item labels from cache:', e);
    }

    // 2. Fetch from backend and reconcile (skip when offline)
    if (syncStore.isOnline) {
      try {
        await Promise.all([
          loadReadPositionsFromBackend(),
          loadSocialReadPositionsFromBackend(),
          loadTagsFromBackend(),
          loadArchivedFromBackend(),
          loadReadProgressFromBackend(),
        ]);
        hasLoaded = true;
      } catch (e) {
        console.error('Failed to load labels from backend:', e);
        if (labelMap.size > 0) {
          hasLoaded = true;
        }
      }
    } else {
      // Offline: use cached data
      hasLoaded = labelMap.size > 0;
    }

    isLoading = false;
  }

  async function loadReadPositionsFromBackend() {
    const { positions } = await api.getReadPositions();
    const now = Date.now();

    // Preserve local-only labels (archived, tags) that aren't in backend
    // Remove old read labels for articles, then re-add from backend
    const toRemove: Array<[string, string]> = [];
    for (const [compKey, lbl] of labelMap) {
      if (lbl.itemType === 'article' && lbl.label === 'read') {
        toRemove.push([lbl.itemKey, lbl.label]);
      }
    }
    for (const [itemKey, label] of toRemove) {
      removeFromState(itemKey, label);
    }

    // Add from backend
    const dbOps: ItemLabel[] = [];
    for (const p of positions) {
      const readLabel: ItemLabel = {
        itemKey: p.item_guid,
        itemType: 'article',
        label: 'read',
        props: {
          readAt: p.read_at,
          itemUrl: p.item_url || undefined,
          itemTitle: p.item_title || undefined,
        },
        createdAt: p.read_at || now,
        updatedAt: now,
      };
      addToState(readLabel);
      dbOps.push(readLabel);
    }

    triggerReactivity();

    // Sync to IndexedDB: clear old read labels for articles and re-add
    try {
      // Delete old article read labels
      const oldLabels = await db.itemLabels
        .where('label')
        .equals('read')
        .filter((l) => l.itemType === 'article')
        .toArray();
      const deleteKeys = oldLabels.map((l) => [l.itemKey, l.label] as [string, string]);
      for (const [itemKey, label] of deleteKeys) {
        await db.itemLabels.where('[itemKey+label]').equals([itemKey, label]).delete();
      }
      if (dbOps.length > 0) {
        await safeBulkPut(db.itemLabels, dbOps);
      }
    } catch (e) {
      console.error('Failed to sync read positions to cache:', e);
    }
  }

  async function loadSocialReadPositionsFromBackend() {
    const { positions } = await api.getSocialReadPositions();
    const now = Date.now();

    // Clear old social read labels
    const toRemove: Array<[string, string]> = [];
    for (const [, lbl] of labelMap) {
      if ((lbl.itemType === 'share' || lbl.itemType === 'document') && lbl.label === 'read') {
        toRemove.push([lbl.itemKey, lbl.label]);
      }
    }
    for (const [itemKey, label] of toRemove) {
      removeFromState(itemKey, label);
    }

    // Rebuild social positions map and add labels
    const newSocialPositions = new Map<string, SocialReadPosition>();
    const dbOps: ItemLabel[] = [];

    for (const p of positions) {
      const itemType: ItemLabelType = p.type === 'share' ? 'share' : 'document';
      const readLabel: ItemLabel = {
        itemKey: p.itemUri,
        itemType,
        label: 'read',
        props: {
          readAt: p.readAt,
          rkey: p.rkey,
          authorDid: p.authorDid,
          itemUrl: p.itemUrl || undefined,
          itemTitle: p.itemTitle || undefined,
        },
        createdAt: now,
        updatedAt: now,
      };
      addToState(readLabel);
      dbOps.push(readLabel);

      newSocialPositions.set(p.itemUri, {
        rkey: p.rkey,
        type: p.type,
        itemUri: p.itemUri,
        authorDid: p.authorDid,
        itemUrl: p.itemUrl || '',
        itemTitle: p.itemTitle || undefined,
        readAt: p.readAt,
      });
    }

    socialPositions = newSocialPositions;
    triggerReactivity();

    // Sync to IndexedDB
    try {
      const oldLabels = await db.itemLabels
        .where('label')
        .equals('read')
        .filter((l) => l.itemType === 'share' || l.itemType === 'document')
        .toArray();
      for (const l of oldLabels) {
        await db.itemLabels.where('[itemKey+label]').equals([l.itemKey, l.label]).delete();
      }
      if (dbOps.length > 0) {
        await safeBulkPut(db.itemLabels, dbOps);
      }
      // Also sync socialReadPositions table for backward compat
      await db.socialReadPositions.clear();
      for (const p of newSocialPositions.values()) {
        await safeAdd(db.socialReadPositions, p);
      }
    } catch (e) {
      console.error('Failed to sync social read positions to cache:', e);
    }
  }

  async function loadTagsFromBackend() {
    const taggedLabels = await api.getAllLabels({ label: 'tagged' });

    // Remove old tagged labels from state
    const toRemove: string[] = [];
    for (const [, lbl] of labelMap) {
      if (lbl.label === 'tagged') {
        toRemove.push(lbl.itemKey);
      }
    }
    for (const itemKey of toRemove) {
      removeFromState(itemKey, 'tagged');
    }

    // Add from backend
    const dbOps: ItemLabel[] = [];
    for (const t of taggedLabels) {
      const tags = (t.props?.tags as string[]) || [];
      if (tags.length === 0) continue;
      const lbl: ItemLabel = {
        itemKey: t.itemKey,
        itemType: t.itemType as ItemLabelType,
        label: 'tagged',
        props: { tags },
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
      addToState(lbl);
      dbOps.push(lbl);
    }

    triggerReactivity();

    // Sync to IndexedDB
    try {
      const oldTagged = await db.itemLabels.where('label').equals('tagged').toArray();
      for (const l of oldTagged) {
        await db.itemLabels.where('[itemKey+label]').equals([l.itemKey, 'tagged']).delete();
      }
      if (dbOps.length > 0) {
        await safeBulkPut(db.itemLabels, dbOps);
      }
    } catch (e) {
      console.error('Failed to sync tags to cache:', e);
    }
  }

  async function loadArchivedFromBackend() {
    const archivedLabels = await api.getAllLabels({ label: 'archived' });

    // Remove old archived labels from state
    const toRemove: string[] = [];
    for (const [, lbl] of labelMap) {
      if (lbl.label === 'archived') {
        toRemove.push(lbl.itemKey);
      }
    }
    for (const itemKey of toRemove) {
      removeFromState(itemKey, 'archived');
    }

    // Add from backend
    const dbOps: ItemLabel[] = [];
    for (const a of archivedLabels) {
      const lbl: ItemLabel = {
        itemKey: a.itemKey,
        itemType: (a.itemType as ItemLabelType) || 'article',
        label: 'archived',
        props: a.props || {},
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      };
      addToState(lbl);
      dbOps.push(lbl);
    }

    triggerReactivity();

    // Sync to IndexedDB
    try {
      const oldArchived = await db.itemLabels.where('label').equals('archived').toArray();
      for (const l of oldArchived) {
        await db.itemLabels.where('[itemKey+label]').equals([l.itemKey, 'archived']).delete();
      }
      if (dbOps.length > 0) {
        await safeBulkPut(db.itemLabels, dbOps);
      }
    } catch (e) {
      console.error('Failed to sync archived labels to cache:', e);
    }
  }

  async function loadReadProgressFromBackend() {
    const progressLabels = await api.getAllLabels({ label: 'readProgress' });

    // Remove old readProgress labels from state
    const toRemove: string[] = [];
    for (const [, lbl] of labelMap) {
      if (lbl.label === 'readProgress') {
        toRemove.push(lbl.itemKey);
      }
    }
    for (const itemKey of toRemove) {
      removeFromState(itemKey, 'readProgress');
    }

    // Add from backend
    const dbOps: ItemLabel[] = [];
    for (const p of progressLabels) {
      const lbl: ItemLabel = {
        itemKey: p.itemKey,
        itemType: (p.itemType as ItemLabelType) || 'article',
        label: 'readProgress',
        props: p.props || {},
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
      addToState(lbl);
      dbOps.push(lbl);
    }

    triggerReactivity();

    // Sync to IndexedDB
    try {
      const oldProgress = await db.itemLabels.where('label').equals('readProgress').toArray();
      for (const l of oldProgress) {
        await db.itemLabels.where('[itemKey+label]').equals([l.itemKey, 'readProgress']).delete();
      }
      if (dbOps.length > 0) {
        await safeBulkPut(db.itemLabels, dbOps);
      }
    } catch (e) {
      console.error('Failed to sync read progress to cache:', e);
    }
  }

  // --- Query methods ---

  function hasLabel(itemKey: string, label: string): boolean {
    return labelMap.has(makeKey(itemKey, label));
  }

  function getLabel(itemKey: string, label: string): ItemLabel | undefined {
    return labelMap.get(makeKey(itemKey, label));
  }

  function isRead(itemKey: string): boolean {
    return hasLabel(itemKey, 'read');
  }

  function isSaved(itemKey: string): boolean {
    return savesStore.isSaved(itemKey);
  }

  function isArchived(itemKey: string): boolean {
    return hasLabel(itemKey, 'archived');
  }

  function getTagsForItem(itemKey: string): string[] {
    const lbl = getLabel(itemKey, 'tagged');
    if (!lbl) return [];
    const tags = (lbl.props.tags as string[]) || [];
    return [...tags].sort();
  }

  function hasTag(itemKey: string, tag: string): boolean {
    const lbl = getLabel(itemKey, 'tagged');
    if (!lbl) return false;
    return ((lbl.props.tags as string[]) || []).includes(tag);
  }

  function itemHasAnyTag(itemKey: string, tags: string[]): boolean {
    const lbl = getLabel(itemKey, 'tagged');
    if (!lbl) return false;
    const itemTags = (lbl.props.tags as string[]) || [];
    return tags.some((t) => itemTags.includes(t));
  }

  // All unique tags across all items
  let allTags = $derived.by((): string[] => {
    const tagSet = new Set<string>();
    for (const [, lbl] of labelMap) {
      if (lbl.label === 'tagged') {
        const tags = (lbl.props.tags as string[]) || [];
        for (const t of tags) {
          tagSet.add(t);
        }
      }
    }
    return [...tagSet].sort();
  });

  // --- Read positions map (for reactivity tracking in unreadCounts) ---
  // Returns a Map<articleGuid, { readAt }> — only read state, no starred/archived
  let readPositions = $derived.by(() => {
    const map = new Map<string, { readAt: number; itemUrl?: string; itemTitle?: string }>();

    for (const [, lbl] of labelMap) {
      if (lbl.itemType !== 'article') continue;
      if (lbl.label !== 'read') continue;

      map.set(lbl.itemKey, {
        readAt: (lbl.props.readAt as number) || 0,
        itemUrl: lbl.props.itemUrl as string | undefined,
        itemTitle: lbl.props.itemTitle as string | undefined,
      });
    }

    return map;
  });

  // Saved count: purely from saves
  let savedCount = $derived(savesStore.articles.length);

  // Inbox count: saved but not archived
  let inboxCount = $derived.by(() => {
    let count = 0;
    for (const bm of savesStore.articles) {
      const key = bm.uri || bm.itemGuid || '';
      if (key && !hasLabel(key, 'archived')) count++;
    }
    return count;
  });

  // Archived count (saved + archived)
  let archivedCount = $derived.by(() => {
    let count = 0;
    for (const [itemKey, labels] of labelsByItem) {
      if (labels.has('archived')) {
        if (savesStore.isSaved(itemKey)) count++;
      }
    }
    return count;
  });

  // --- Article read/unread mutations ---

  function markAsRead(
    _subscriptionAtUri: string,
    articleGuid: string,
    articleUrl: string,
    articleTitle?: string
  ) {
    if (isRead(articleGuid)) return;
    if (pendingMarkRead.some((item) => item.articleGuid === articleGuid)) return;

    const now = Date.now();
    const readLabel: ItemLabel = {
      itemKey: articleGuid,
      itemType: 'article',
      label: 'read',
      props: { readAt: now, itemUrl: articleUrl, itemTitle: articleTitle },
      createdAt: now,
      updatedAt: now,
    };

    addToState(readLabel);
    triggerReactivity();
    safePut(db.itemLabels, readLabel);

    pendingMarkRead.push({ articleGuid, articleUrl, articleTitle });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPendingMarkRead, DEBOUNCE_MS);
  }

  async function markAllAsRead(
    articles: Array<{
      subscriptionRkey: string;
      articleGuid: string;
      articleUrl: string;
      articleTitle?: string;
    }>
  ) {
    const unreadArticles = articles.filter((a) => !isRead(a.articleGuid));
    if (unreadArticles.length === 0) return;

    const now = Date.now();
    const dbOps: ItemLabel[] = [];

    for (const article of unreadArticles) {
      const readLabel: ItemLabel = {
        itemKey: article.articleGuid,
        itemType: 'article',
        label: 'read',
        props: { readAt: now, itemUrl: article.articleUrl, itemTitle: article.articleTitle },
        createdAt: now,
        updatedAt: now,
      };
      addToState(readLabel);
      dbOps.push(readLabel);
    }
    triggerReactivity();

    if (dbOps.length > 0) {
      await safeBulkPut(db.itemLabels, dbOps);
    }

    if (syncStore.isOnline) {
      try {
        const bulkItems = unreadArticles.map((a) => ({
          itemGuid: a.articleGuid,
          itemUrl: a.articleUrl,
          itemTitle: a.articleTitle,
        }));
        for (let i = 0; i < bulkItems.length; i += BULK_BATCH_SIZE) {
          await api.markAsReadBulk(bulkItems.slice(i, i + BULK_BATCH_SIZE));
        }
      } catch (e) {
        console.error('Failed to mark all as read, queueing for retry:', e);
        for (const article of unreadArticles) {
          await syncQueue.enqueue('create', 'reading', article.articleGuid, {
            articleGuid: article.articleGuid,
            articleUrl: article.articleUrl,
            articleTitle: article.articleTitle,
          } as ReadingPayload);
        }
      }
    } else {
      for (const article of unreadArticles) {
        await syncQueue.enqueue('create', 'reading', article.articleGuid, {
          articleGuid: article.articleGuid,
          articleUrl: article.articleUrl,
          articleTitle: article.articleTitle,
        } as ReadingPayload);
      }
    }
  }

  async function markAsUnread(articleGuid: string) {
    if (!isRead(articleGuid)) return;

    removeFromState(articleGuid, 'read');
    triggerReactivity();

    try {
      await db.itemLabels.where('[itemKey+label]').equals([articleGuid, 'read']).delete();
    } catch (e) {
      console.error('Failed to remove read label from DB:', e);
    }

    if (syncStore.isOnline) {
      try {
        await api.markAsUnread(articleGuid);
      } catch (e) {
        console.error('Failed to mark as unread, queueing for retry:', e);
        await syncQueue.enqueue('delete', 'reading', articleGuid, {
          articleGuid,
        } as ReadingPayload);
      }
    } else {
      await syncQueue.enqueue('delete', 'reading', articleGuid, {
        articleGuid,
      } as ReadingPayload);
    }
  }

  // --- Save mutations (decoupled from read state) ---
  // All save operations now delegate to savesStore (saved_articles is the sole source of truth)

  type SaveMeta =
    | {
        type: 'article';
        guid: string;
        url: string;
        title?: string;
        author?: string;
        summary?: string;
        imageUrl?: string;
        publishedAt?: string;
      }
    | {
        type: 'share';
        recordUri: string;
        itemUrl: string;
        itemTitle?: string;
        itemAuthor?: string;
        itemDescription?: string;
        itemImage?: string;
        itemPublishedAt?: string;
      }
    | {
        type: 'document';
        recordUri: string;
        url: string;
        title?: string;
        description?: string;
        publishedAt?: string;
      };

  async function toggleSave(
    itemKey: string,
    _itemType: ItemLabelType = 'article',
    _itemUrl?: string,
    _itemTitle?: string,
    saveMeta?: SaveMeta
  ) {
    const wasSaved = isSaved(itemKey);

    if (!saveMeta) {
      // No metadata — can only unsave
      if (wasSaved) {
        await savesStore.unsaveByGuid(itemKey);
      }
      return;
    }

    if (saveMeta.type === 'article') {
      if (!wasSaved) {
        await savesStore.saveArticle(saveMeta);
      } else {
        await savesStore.unsaveByGuid(saveMeta.guid);
      }
    } else if (saveMeta.type === 'share') {
      if (!wasSaved) {
        await savesStore.saveShare(saveMeta);
      } else {
        await savesStore.unsaveByGuid(saveMeta.recordUri);
      }
    } else if (saveMeta.type === 'document') {
      if (!wasSaved) {
        await savesStore.saveDocument(saveMeta);
      } else {
        await savesStore.unsaveByGuid(saveMeta.recordUri);
      }
    }
  }

  // --- Archive mutations ---

  async function syncArchiveToBackend(
    itemKey: string,
    archived: boolean,
    itemType: ItemLabelType = 'article'
  ) {
    const payload: LabelPayload = {
      itemKey,
      itemType,
      label: 'archived',
      props: { archivedAt: Date.now() },
    };
    if (archived) {
      if (syncStore.isOnline) {
        try {
          await api.addLabel({
            itemKey,
            itemType: 'article',
            label: 'archived',
            props: payload.props,
          });
        } catch (e) {
          console.error('Failed to sync archive label, queueing for retry:', e);
          await syncQueue.enqueue('create', 'label', `${itemKey}\0archived`, payload);
        }
      } else {
        await syncQueue.enqueue('create', 'label', `${itemKey}\0archived`, payload);
      }
    } else {
      if (syncStore.isOnline) {
        try {
          await api.deleteLabel(itemKey, 'archived');
        } catch (e) {
          console.error('Failed to delete archive label, queueing for retry:', e);
          await syncQueue.enqueue('delete', 'label', `${itemKey}\0archived`, payload);
        }
      } else {
        await syncQueue.enqueue('delete', 'label', `${itemKey}\0archived`, payload);
      }
    }
  }

  async function toggleArchive(itemKey: string, itemType: ItemLabelType = 'article') {
    const wasArchived = isArchived(itemKey);
    const now = Date.now();

    if (wasArchived) {
      removeFromState(itemKey, 'archived');
      await deleteLabel(itemKey, 'archived');
    } else {
      const label: ItemLabel = {
        itemKey,
        itemType,
        label: 'archived',
        props: { archivedAt: now },
        createdAt: now,
        updatedAt: now,
      };
      addToState(label);
      await safePut(db.itemLabels, label);
    }
    triggerReactivity();

    await syncArchiveToBackend(itemKey, !wasArchived, itemType);
  }

  async function archiveItem(itemKey: string, itemType: ItemLabelType = 'article') {
    if (isArchived(itemKey)) return;
    const now = Date.now();
    const label: ItemLabel = {
      itemKey,
      itemType,
      label: 'archived',
      props: { archivedAt: now },
      createdAt: now,
      updatedAt: now,
    };
    addToState(label);
    triggerReactivity();
    await safePut(db.itemLabels, label);

    await syncArchiveToBackend(itemKey, true, itemType);
  }

  async function unarchiveItem(itemKey: string, itemType: ItemLabelType = 'article') {
    if (!isArchived(itemKey)) return;
    removeFromState(itemKey, 'archived');
    triggerReactivity();
    await deleteLabel(itemKey, 'archived');

    await syncArchiveToBackend(itemKey, false, itemType);
  }

  // --- Tag mutations ---

  async function syncTaggedLabel(itemKey: string, itemType: ItemLabelType, tags: string[]) {
    const payload: LabelPayload = {
      itemKey,
      itemType,
      label: 'tagged',
      props: { tags },
    };
    if (tags.length === 0) {
      // No tags left — delete the label
      if (syncStore.isOnline) {
        try {
          await api.deleteLabel(itemKey, 'tagged');
        } catch (e) {
          console.error('Failed to delete tagged label, queueing for retry:', e);
          await syncQueue.enqueue('delete', 'label', `${itemKey}\0tagged`, payload);
        }
      } else {
        await syncQueue.enqueue('delete', 'label', `${itemKey}\0tagged`, payload);
      }
    } else {
      // Upsert the tagged label with current tags
      if (syncStore.isOnline) {
        try {
          await api.addLabel({ itemKey, itemType, label: 'tagged', props: { tags } });
        } catch (e) {
          console.error('Failed to sync tagged label, queueing for retry:', e);
          await syncQueue.enqueue('create', 'label', `${itemKey}\0tagged`, payload);
        }
      } else {
        await syncQueue.enqueue('create', 'label', `${itemKey}\0tagged`, payload);
      }
    }
  }

  async function addTag(itemKey: string, itemType: ItemLabelType, tag: string) {
    const trimmed = tag.trim().slice(0, 64);
    if (!trimmed) return;
    if (hasTag(itemKey, trimmed)) return;

    // Max 10 tags per item
    const currentTags = getTagsForItem(itemKey);
    if (currentTags.length >= 10) return;

    const now = Date.now();
    const newTags = [...currentTags, trimmed];
    const existing = getLabel(itemKey, 'tagged');

    const label: ItemLabel = {
      itemKey,
      itemType: existing?.itemType || itemType,
      label: 'tagged',
      props: { tags: newTags },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    addToState(label);
    triggerReactivity();
    await safePut(db.itemLabels, label);

    await syncTaggedLabel(itemKey, label.itemType as ItemLabelType, newTags);
  }

  async function removeTag(itemKey: string, tag: string) {
    if (!hasTag(itemKey, tag)) return;

    const existing = getLabel(itemKey, 'tagged')!;
    const currentTags = (existing.props.tags as string[]) || [];
    const newTags = currentTags.filter((t) => t !== tag);
    const now = Date.now();

    if (newTags.length === 0) {
      removeFromState(itemKey, 'tagged');
      triggerReactivity();
      try {
        await db.itemLabels.where('[itemKey+label]').equals([itemKey, 'tagged']).delete();
      } catch (e) {
        console.error('Failed to delete tagged label from DB:', e);
      }
    } else {
      const label: ItemLabel = {
        ...existing,
        props: { tags: newTags },
        updatedAt: now,
      };
      addToState(label);
      triggerReactivity();
      await safePut(db.itemLabels, label);
    }

    await syncTaggedLabel(itemKey, existing.itemType as ItemLabelType, newTags);
  }

  async function toggleTag(itemKey: string, itemType: ItemLabelType, tag: string) {
    if (hasTag(itemKey, tag)) {
      await removeTag(itemKey, tag);
    } else {
      await addTag(itemKey, itemType, tag);
    }
  }

  async function deleteTagFromAll(tag: string) {
    // Find all items that have this tag
    const toUpdate: Array<{ itemKey: string; lbl: ItemLabel }> = [];
    for (const [, lbl] of labelMap) {
      if (lbl.label === 'tagged') {
        const tags = (lbl.props.tags as string[]) || [];
        if (tags.includes(tag)) {
          toUpdate.push({ itemKey: lbl.itemKey, lbl });
        }
      }
    }

    const now = Date.now();
    for (const { itemKey, lbl } of toUpdate) {
      const currentTags = (lbl.props.tags as string[]) || [];
      const newTags = currentTags.filter((t) => t !== tag);

      if (newTags.length === 0) {
        removeFromState(itemKey, 'tagged');
        try {
          await db.itemLabels.where('[itemKey+label]').equals([itemKey, 'tagged']).delete();
        } catch (e) {
          console.error('Failed to delete tagged label from DB:', e);
        }
      } else {
        const updated: ItemLabel = { ...lbl, props: { tags: newTags }, updatedAt: now };
        addToState(updated);
        await safePut(db.itemLabels, updated);
      }

      await syncTaggedLabel(itemKey, lbl.itemType as ItemLabelType, newTags);
    }

    triggerReactivity();
  }

  // --- Social reading mutations ---

  function isSocialRead(itemUri: string): boolean {
    return hasLabel(itemUri, 'read');
  }

  async function markSocialAsRead(
    type: SocialItemType,
    itemUri: string,
    authorDid: string,
    itemUrl: string,
    itemTitle?: string
  ) {
    if (isSocialRead(itemUri)) return;

    const rkey = generateTid();
    const now = Date.now();
    const nowIso = new Date().toISOString();

    const itemType: ItemLabelType = type === 'share' ? 'share' : 'document';
    const readLabel: ItemLabel = {
      itemKey: itemUri,
      itemType,
      label: 'read',
      props: {
        readAt: nowIso,
        rkey,
        authorDid,
        itemUrl,
        itemTitle,
      },
      createdAt: now,
      updatedAt: now,
    };

    addToState(readLabel);
    triggerReactivity();
    await safePut(db.itemLabels, readLabel);

    // Also update socialPositions for backward compat
    const position: SocialReadPosition = {
      rkey,
      type,
      itemUri,
      authorDid,
      itemUrl,
      itemTitle,
      readAt: nowIso,
    };
    socialPositions.set(itemUri, position);
    socialPositions = new Map(socialPositions);
    await safeAdd(db.socialReadPositions, position);

    const payload: SocialReadingPayload = {
      type,
      rkey,
      itemUri,
      authorDid,
      itemUrl:
        itemUrl && (itemUrl.startsWith('http://') || itemUrl.startsWith('https://'))
          ? itemUrl
          : undefined,
      itemTitle: itemTitle || undefined,
    };

    if (syncStore.isOnline) {
      try {
        await api.markSocialItemAsRead({
          type,
          rkey,
          itemUri,
          authorDid,
          itemUrl: payload.itemUrl,
          itemTitle: payload.itemTitle,
        });
      } catch (e) {
        console.error('Failed to mark social item as read, queueing for retry:', e);
        await syncQueue.enqueue('create', 'socialReading', itemUri, payload);
      }
    } else {
      await syncQueue.enqueue('create', 'socialReading', itemUri, payload);
    }
  }

  async function markAllSocialAsRead(
    items: Array<{
      type: SocialItemType;
      itemUri: string;
      authorDid: string;
      itemUrl: string;
      itemTitle?: string;
    }>
  ) {
    const unreadItems = items.filter((item) => !isSocialRead(item.itemUri));
    if (unreadItems.length === 0) return;

    const now = Date.now();
    const nowIso = new Date().toISOString();
    const itemsWithRkeys = unreadItems.map((item) => ({
      ...item,
      rkey: generateTid(),
    }));

    const dbOps: ItemLabel[] = [];

    for (const item of itemsWithRkeys) {
      const itemType: ItemLabelType = item.type === 'share' ? 'share' : 'document';
      const readLabel: ItemLabel = {
        itemKey: item.itemUri,
        itemType,
        label: 'read',
        props: {
          readAt: nowIso,
          rkey: item.rkey,
          authorDid: item.authorDid,
          itemUrl: item.itemUrl,
          itemTitle: item.itemTitle,
        },
        createdAt: now,
        updatedAt: now,
      };
      addToState(readLabel);
      dbOps.push(readLabel);

      const position: SocialReadPosition = {
        rkey: item.rkey,
        type: item.type,
        itemUri: item.itemUri,
        authorDid: item.authorDid,
        itemUrl: item.itemUrl,
        itemTitle: item.itemTitle,
        readAt: nowIso,
      };
      socialPositions.set(item.itemUri, position);
    }

    triggerReactivity();
    socialPositions = new Map(socialPositions);

    if (dbOps.length > 0) {
      await safeBulkPut(db.itemLabels, dbOps);
    }

    // Build API payloads
    const apiItems = itemsWithRkeys.map((item) => ({
      type: item.type,
      rkey: item.rkey,
      itemUri: item.itemUri,
      authorDid: item.authorDid,
      itemUrl:
        item.itemUrl && (item.itemUrl.startsWith('http://') || item.itemUrl.startsWith('https://'))
          ? item.itemUrl
          : undefined,
      itemTitle: item.itemTitle || undefined,
    }));

    if (syncStore.isOnline) {
      try {
        for (let i = 0; i < apiItems.length; i += BULK_BATCH_SIZE) {
          await api.markSocialItemsAsReadBulk(apiItems.slice(i, i + BULK_BATCH_SIZE));
        }
      } catch (e) {
        console.error('Failed to bulk mark social items as read, queueing for retry:', e);
        for (const item of apiItems) {
          await syncQueue.enqueue(
            'create',
            'socialReading',
            item.itemUri,
            item as SocialReadingPayload
          );
        }
      }
    } else {
      for (const item of apiItems) {
        await syncQueue.enqueue(
          'create',
          'socialReading',
          item.itemUri,
          item as SocialReadingPayload
        );
      }
    }
  }

  async function markSocialAsUnread(itemUri: string) {
    const readLabel = getLabel(itemUri, 'read');
    if (!readLabel) return;

    const rkey = readLabel.props.rkey as string;
    const type = readLabel.itemType as SocialItemType;
    const authorDid = readLabel.props.authorDid as string;

    removeFromState(itemUri, 'read');
    triggerReactivity();

    try {
      await db.itemLabels.where('[itemKey+label]').equals([itemUri, 'read']).delete();
    } catch (e) {
      console.error('Failed to remove social read label from DB:', e);
    }

    // Remove from socialPositions
    const position = socialPositions.get(itemUri);
    socialPositions.delete(itemUri);
    socialPositions = new Map(socialPositions);

    if (position?.id) {
      await db.socialReadPositions.delete(position.id);
    }

    if (!rkey) return;

    const payload: SocialReadingPayload = {
      type: type === 'share' ? 'share' : 'document',
      rkey,
      itemUri,
      authorDid,
    };

    if (syncStore.isOnline) {
      try {
        await api.markSocialItemAsUnread(rkey);
      } catch (e) {
        console.error('Failed to mark social item as unread, queueing for retry:', e);
        await syncQueue.enqueue('delete', 'socialReading', itemUri, payload);
      }
    } else {
      await syncQueue.enqueue('delete', 'socialReading', itemUri, payload);
    }
  }

  // --- Read progress tracking ---

  let readProgressDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const READ_PROGRESS_DEBOUNCE_MS = 500;

  function getReadProgress(
    itemKey: string
  ): { paragraphIndex: number; totalParagraphs: number } | null {
    const lbl = labelMap.get(makeKey(itemKey, 'readProgress'));
    if (!lbl) return null;
    return {
      paragraphIndex: lbl.props.paragraphIndex as number,
      totalParagraphs: lbl.props.totalParagraphs as number,
    };
  }

  function setReadProgress(
    itemKey: string,
    itemType: ItemLabelType,
    paragraphIndex: number,
    totalParagraphs: number
  ) {
    // Skip if position hasn't changed
    const current = getReadProgress(itemKey);
    if (current && paragraphIndex === current.paragraphIndex) return;

    // Debounce the actual persist
    if (readProgressDebounceTimer) clearTimeout(readProgressDebounceTimer);
    readProgressDebounceTimer = setTimeout(async () => {
      const now = Date.now();
      const lbl: ItemLabel = {
        itemKey,
        itemType,
        label: 'readProgress',
        props: { paragraphIndex, totalParagraphs, lastReadAt: now },
        createdAt: current
          ? (labelMap.get(makeKey(itemKey, 'readProgress'))?.createdAt ?? now)
          : now,
        updatedAt: now,
      };
      await putLabel(lbl);
      triggerReactivity();

      // Sync to backend
      const props = { paragraphIndex, totalParagraphs, lastReadAt: now };
      if (syncStore.isOnline) {
        try {
          await api.addLabel({ itemKey, itemType, label: 'readProgress', props });
        } catch (e) {
          console.error('Failed to sync read progress, queueing for retry:', e);
          await syncQueue.enqueue('create', 'label', `${itemKey}\0readProgress`, {
            itemKey,
            itemType,
            label: 'readProgress',
            props,
          } as LabelPayload);
        }
      } else {
        await syncQueue.enqueue('create', 'label', `${itemKey}\0readProgress`, {
          itemKey,
          itemType,
          label: 'readProgress',
          props,
        } as LabelPayload);
      }
    }, READ_PROGRESS_DEBOUNCE_MS);
  }

  // --- Highlight mutations ---

  function getHighlights(itemKey: string): Highlight[] {
    const lbl = getLabel(itemKey, 'highlights');
    if (!lbl) return [];
    return (lbl.props.highlights as Highlight[]) || [];
  }

  function hasHighlights(itemKey: string): boolean {
    const lbl = getLabel(itemKey, 'highlights');
    if (!lbl) return false;
    const highlights = (lbl.props.highlights as Highlight[]) || [];
    return highlights.length > 0;
  }

  async function addHighlight(itemKey: string, itemType: ItemLabelType, highlight: Highlight) {
    const existing = getLabel(itemKey, 'highlights');
    const currentHighlights = existing ? (existing.props.highlights as Highlight[]) || [] : [];
    const newHighlights = [...currentHighlights, highlight];
    const now = Date.now();

    const label: ItemLabel = {
      itemKey,
      itemType: existing?.itemType || itemType,
      label: 'highlights',
      props: { highlights: newHighlights },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    addToState(label);
    triggerReactivity();
    await safePut(db.itemLabels, label);
  }

  async function removeHighlight(itemKey: string, highlightId: string) {
    const existing = getLabel(itemKey, 'highlights');
    if (!existing) return;

    const currentHighlights = (existing.props.highlights as Highlight[]) || [];
    const newHighlights = currentHighlights.filter((h) => h.id !== highlightId);
    const now = Date.now();

    if (newHighlights.length === 0) {
      removeFromState(itemKey, 'highlights');
      triggerReactivity();
      try {
        await db.itemLabels.where('[itemKey+label]').equals([itemKey, 'highlights']).delete();
      } catch (e) {
        console.error('Failed to delete highlights label from DB:', e);
      }
    } else {
      const label: ItemLabel = {
        ...existing,
        props: { highlights: newHighlights },
        updatedAt: now,
      };
      addToState(label);
      triggerReactivity();
      await safePut(db.itemLabels, label);
    }
  }

  // --- Derived helpers ---

  function getSavedArticles(): SavedArticle[] {
    return savesStore.articles
      .filter((bm) => bm.source === 'feed' && bm.itemGuid)
      .map((bm) => ({
        articleGuid: bm.itemGuid!,
        articleUrl: bm.url || undefined,
        articleTitle: bm.title || undefined,
        readAt: new Date(bm.savedAt).getTime(),
      }));
  }

  /** Get all saved item keys grouped by source type */
  function getSavedItemKeys(): Map<ItemLabelType, Set<string>> {
    const result = new Map<ItemLabelType, Set<string>>();
    for (const bm of savesStore.articles) {
      const type: ItemLabelType =
        bm.source === 'share'
          ? 'share'
          : bm.source === 'document'
            ? 'document'
            : bm.source === 'feed'
              ? 'article'
              : 'saved';
      let set = result.get(type);
      if (!set) {
        set = new Set();
        result.set(type, set);
      }
      set.add(bm.itemGuid || bm.uri || bm.rkey);
    }
    return result;
  }

  async function getUnreadCount(subscriptionId: number): Promise<number> {
    try {
      const articles = await db.articles.where('subscriptionId').equals(subscriptionId).toArray();
      return articles.filter((a) => !isRead(a.guid)).length;
    } catch {
      return 0;
    }
  }

  return {
    // Backward-compat: readPositions map for feedViewStore/articlesStore
    get readPositions() {
      return readPositions;
    },
    get isLoading() {
      return isLoading;
    },
    get savedCount() {
      return inboxCount;
    },
    get archivedCount() {
      return archivedCount;
    },
    get inboxCount() {
      return inboxCount;
    },
    // Tags
    get allTags() {
      return allTags;
    },
    get tagsByItem() {
      return labelsByItem;
    },
    // Social positions (backward compat)
    get socialPositions() {
      return socialPositions;
    },
    // Lifecycle
    load,
    // Article read
    isRead,
    markAsRead,
    markAllAsRead,
    markAsUnread,
    // Article save (decoupled from read)
    isSaved,
    toggleSave,
    // Archive
    isArchived,
    toggleArchive,
    archiveItem,
    unarchiveItem,
    // Tags
    getTagsForItem,
    hasTag,
    addTag,
    removeTag,
    toggleTag,
    deleteTag: deleteTagFromAll,
    itemHasAnyTag,
    // Social reading
    isSocialRead,
    markSocialAsRead,
    markAllSocialAsRead,
    markSocialAsUnread,
    // Read progress
    getReadProgress,
    setReadProgress,
    // Highlights
    getHighlights,
    hasHighlights,
    addHighlight,
    removeHighlight,
    // Derived helpers
    getSavedArticles,
    getSavedItemKeys,
    getUnreadCount,
  };
}

export const itemLabelsStore = createItemLabelsStore();
