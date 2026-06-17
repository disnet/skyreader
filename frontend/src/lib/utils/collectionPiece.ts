// Shared helpers for a curated Collection (Standard Reader "edition") piece — a
// resolved preview (title/URL, no body) referenced by an edition. Both the river
// card (ArticleCard) and the fullscreen reader (SavedReader) save pieces, and the
// reader stack opens them; this keeps that logic in one place.
import { api } from '$lib/services/api';
import { getDisplayContent } from '$lib/utils/displayItem';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import type { ReaderCollectionItem, SocialDocument } from '$lib/types';

// Bounded memo of on-demand document fetches keyed by at:// URI. A curated piece
// is commonly fetched twice in quick succession (open then save, or save then
// open) and editions don't change mid-session, so we share the in-flight promise.
// Module-level so the feed and saved views dedupe against each other. Capped with
// simple LRU eviction (Map preserves insertion order) so a long session opening
// many editions can't pin every resolved document body forever. Failures aren't
// cached — a transient error shouldn't poison later retries.
const DOC_CACHE_MAX = 50;
const docCache = new Map<string, Promise<SocialDocument | null>>();

export function fetchCollectionDoc(uri: string): Promise<SocialDocument | null> {
  let pending = docCache.get(uri);
  if (pending) {
    // Touch: re-insert so it becomes the most-recently-used (last) entry.
    docCache.delete(uri);
    docCache.set(uri, pending);
    return pending;
  }
  pending = api.fetchDocumentV2(uri).catch((e) => {
    docCache.delete(uri);
    throw e;
  });
  docCache.set(uri, pending);
  // Evict the least-recently-used (first) entries past the cap.
  while (docCache.size > DOC_CACHE_MAX) {
    const oldest = docCache.keys().next().value;
    if (oldest === undefined) break;
    docCache.delete(oldest);
  }
  return pending;
}

// Save/unsave a curated edition piece (a referenced document) to the Saved list,
// keyed by its at:// URI. The item is only a resolved preview, so on save we fetch
// the full document and persist its rendered body — otherwise the saved reader has
// nothing to show (the in-app viewer fetches the same way).
export async function saveCollectionPiece(item: ReaderCollectionItem): Promise<void> {
  if (itemLabelsStore.isSaved(item.document)) {
    itemLabelsStore.toggleSave(item.document, 'document', item.canonicalUrl || '', item.title);
    return;
  }
  let content: string | undefined;
  const meta = {
    recordUri: item.document,
    url: item.canonicalUrl || '',
    title: item.title,
    description: item.description,
    publishedAt: item.publishedAt,
  };
  try {
    const doc = await fetchCollectionDoc(item.document);
    if (doc) {
      content = getDisplayContent({ type: 'document', item: doc, key: doc.recordUri }) || undefined;
      meta.url = doc.canonicalUrl || doc.path || meta.url;
      meta.title = doc.title || meta.title;
      meta.description = doc.description || meta.description;
      meta.publishedAt = doc.publishedAt || meta.publishedAt;
    }
  } catch (e) {
    console.error('Failed to fetch collection piece for save:', e);
  }
  itemLabelsStore.toggleSave(meta.recordUri, 'document', meta.url, meta.title, {
    type: 'document',
    ...meta,
    content,
  });
}

export function isCollectionPieceSaved(item: ReaderCollectionItem): boolean {
  return itemLabelsStore.isSaved(item.document);
}
