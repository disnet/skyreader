import { db } from '$lib/services/db';
import { safeBulkPut } from '$lib/services/safeDb.svelte';
import { profileService } from '$lib/services/profiles';
import { reconcileDocuments, type DocumentScopeResult } from '$lib/services/documentSync';
import type { SocialDocument } from '$lib/types';

// The flat `textContent` duplicates the structured `content` body (the rendered
// path) and is only read for word count + a fallback when the content format
// isn't recognized. Drop it from the in-memory list, keeping a precomputed
// `wordCount`; the full text stays in IndexedDB and is pulled back per-document
// by getTextContent() when a card or the reader opens.
function toLightDocument(doc: SocialDocument): SocialDocument {
  // Word count uses the same `textContent || description` precedence as the
  // historical inline computation in getItemWordCount.
  const text = doc.textContent || doc.description || '';
  const trimmed = text.trim();
  const wordCount = doc.wordCount ?? (trimmed ? trimmed.split(/\s+/).length : 0);
  if (doc.textContent == null) {
    return doc.wordCount === wordCount ? doc : { ...doc, wordCount };
  }
  const { textContent: _textContent, ...rest } = doc;
  return { ...rest, wordCount };
}

function createSocialStore() {
  let documents = $state<SocialDocument[]>([]);
  let isLoadingFeed = $state(false);
  let error = $state<string | null>(null);

  // Documents are fetched lazily per-publication through the feed proxy (see
  // fetchAllDocuments) and applied via applyDocumentResults. loadFeed only
  // hydrates the cached set so it paints instantly on reset; the proxy refreshes
  // it on the same cycle as RSS feeds. (The old share read path is gone.)
  async function loadFeed(reset = false) {
    if (isLoadingFeed) return;
    if (!reset) return;

    isLoadingFeed = true;
    error = null;
    try {
      const cached = await db.socialDocuments.orderBy('publishedAt').reverse().toArray();
      documents = cached.map(toLightDocument);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load social feed';
    } finally {
      isLoadingFeed = false;
    }
  }

  /**
   * Apply freshly-fetched documents from the proxy. Each result is authoritative
   * for its (author, publication scope), so reconciling per scope makes edits and
   * deletes self-heal: in-scope documents the proxy no longer returns are dropped,
   * the rest upserted. Persists the full set to IndexedDB in one pass.
   */
  async function applyDocumentResults(results: DocumentScopeResult[]): Promise<void> {
    const ready = results.filter((r) => r.status === 'ready');
    if (ready.length === 0) return;

    // Reconcile against the FULL set in IndexedDB, not the light in-memory mirror,
    // so carried-forward documents keep their `textContent` on disk (the lazy-load
    // source). The in-memory and on-disk sets are always written together, so the
    // disk set is the same logical state — reconcile semantics are unchanged.
    try {
      const currentFull = await db.socialDocuments.toArray();
      const fullReconciled = reconcileDocuments(currentFull, ready);

      // Mirror to IndexedDB. The table uses an auto-increment id, so strip stale ids
      // and rewrite wholesale (counts are small — a few authors × ~100 docs).
      await db.socialDocuments.clear();
      await safeBulkPut(
        db.socialDocuments,
        fullReconciled.map(({ id: _id, ...rest }) => rest)
      );

      documents = fullReconciled.map(toLightDocument);
    } catch (e) {
      console.error('Failed to persist documents to IndexedDB:', e);
      // Disk path failed — still update the UI by reconciling the light set so the
      // new documents appear (their bodies just won't be lazy-loadable until the
      // next successful persist).
      documents = reconcileDocuments(documents, ready).map(toLightDocument);
    }

    // Prefetch author profiles (fire and forget).
    profileService.prefetch([...new Set(ready.map((r) => r.did))]);
  }

  function reset() {
    documents = [];
    error = null;
  }

  // Read a document's full flat text back from IndexedDB by recordUri. The
  // in-memory list drops `textContent` (see toLightDocument); the card/reader
  // calls this on open for documents whose body falls back to it.
  async function getTextContent(recordUri: string): Promise<string | null> {
    try {
      const row = await db.socialDocuments.where('recordUri').equals(recordUri).first();
      return row?.textContent ?? null;
    } catch {
      return null;
    }
  }

  return {
    get documents() {
      return documents;
    },
    get isLoading() {
      return isLoadingFeed;
    },
    get error() {
      return error;
    },
    loadFeed,
    applyDocumentResults,
    reset,
    getTextContent,
  };
}

export const socialStore = createSocialStore();
