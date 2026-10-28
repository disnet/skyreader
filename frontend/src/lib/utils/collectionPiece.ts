// Shared helpers for a curated Collection (Standard Reader "edition") piece — a
// resolved preview (title/URL, no body) referenced by an edition. Both the river
// card (ArticleCard) and the fullscreen reader (SavedReader) save pieces, and the
// reader stack opens them; this keeps that logic in one place.
import { fetchCollectionDoc } from '$lib/utils/documentBody';
import { getDisplayContent } from '$lib/utils/displayItem';
import { itemLabelsStore } from '$lib/stores/itemLabels.svelte';
import type { ReaderCollectionItem, SocialDocument } from '$lib/types';

export { fetchCollectionDoc };

/** What a standard.site document is saved with (`savesStore.saveDocument`). */
export interface DocumentSave {
  recordUri: string;
  url: string;
  title?: string;
  description?: string;
  publishedAt?: string;
  content?: string;
}

/**
 * The save of document `uri`: its record's metadata and its rendered body, so
 * the saved reader has something to show, over what the caller already knows.
 * A failed fetch keeps the caller's fields and saves no body.
 */
export async function documentSave(
  uri: string,
  known: Omit<DocumentSave, 'recordUri' | 'content'>
): Promise<DocumentSave> {
  const meta: DocumentSave = { recordUri: uri, ...known };
  try {
    const doc = await fetchCollectionDoc(uri);
    if (doc) {
      meta.content =
        getDisplayContent({ type: 'document', item: doc, key: doc.recordUri }) || undefined;
      meta.url = doc.canonicalUrl || doc.path || meta.url;
      meta.title = doc.title || meta.title;
      meta.description = doc.description || meta.description;
      meta.publishedAt = doc.publishedAt || meta.publishedAt;
    }
  } catch (e) {
    console.error('Failed to fetch document for save:', e);
  }
  return meta;
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
  const meta = await documentSave(item.document, {
    url: item.canonicalUrl || '',
    title: item.title,
    description: item.description,
    publishedAt: item.publishedAt,
  });
  itemLabelsStore.toggleSave(meta.recordUri, 'document', meta.url, meta.title, {
    type: 'document',
    ...meta,
  });
}

export function isCollectionPieceSaved(item: ReaderCollectionItem): boolean {
  return itemLabelsStore.isSaved(item.document);
}
