// The reader body of a standard.site document save, rendered from its record.
// A document saved from a list arrives without one (the list holds documents
// light, with no body to pass), and the saves store's other fallbacks can't
// help: the server keeps no text for it and there's no page to extract. Without
// this the saved reader shows only the description, while the same document
// opened as itself (the Queue does) renders in full.
import { api } from '$lib/services/api';
import { getDisplayContent } from '$lib/utils/displayItem';
import { hasReadableContent } from '$lib/utils/saveAnywhere';

/** The rendered body of document `recordUri`, or null when it can't be had. */
export async function documentBody(recordUri: string | null | undefined): Promise<string | null> {
  if (!recordUri?.startsWith('at://')) return null;
  const doc = await api.fetchDocumentV2(recordUri).catch(() => null);
  if (!doc) return null;
  const body = getDisplayContent({ type: 'document', item: doc, key: doc.recordUri });
  return hasReadableContent(body) ? body : null;
}
