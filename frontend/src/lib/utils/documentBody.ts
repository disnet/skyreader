// The reader body of a standard.site document save, rendered from its record.
// A document saved from a list arrives without one (the list holds documents
// light, with no body to pass), and the saves store's other fallbacks can't
// help: the server keeps no text for it and there's no page to extract. Without
// this the saved reader shows only the description, while the same document
// opened as itself (the Queue does) renders in full.
import { api } from '$lib/services/api';
import { getDisplayContent } from '$lib/utils/displayItem';
import { isLinkPost } from '$lib/utils/linkPost';
import { renderPlaintextBody } from '$lib/utils/plaintext';
import type { SocialDocument } from '$lib/types';

// Bounded memo of on-demand document fetches keyed by at:// URI. A document is
// commonly fetched twice in quick succession (save then open, or a curated
// piece opened then saved) and records don't change mid-session, so we share
// the in-flight promise. Module-level so every surface dedupes against the
// others. Capped with simple LRU eviction (Map preserves insertion order) so a
// long session can't pin every resolved document body forever. Failures aren't
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

/**
 * The rendered body of document `recordUri`, or null when it can't be had.
 * Kept bodies are permanent (the store never re-reads a save that has one), so
 * anything short of the document's own text is refused: a render that fell back
 * to the description (a record with no body, a stub not yet inflated) is what
 * the save already shows. A link post's body is the sharer's note, not the
 * article it links to, which the reader fetches itself.
 */
export async function documentBody(recordUri: string | null | undefined): Promise<string | null> {
  if (!recordUri?.startsWith('at://')) return null;
  const doc = await fetchCollectionDoc(recordUri).catch(() => null);
  if (!doc || isLinkPost(doc)) return null;
  const body = getDisplayContent({ type: 'document', item: doc, key: doc.recordUri });
  if (!body || body === renderPlaintextBody(doc.description ?? '')) return null;
  return body;
}
