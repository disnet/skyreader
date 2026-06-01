import type { LeafletContent, SocialDocument } from '$lib/types';
import { isLeafletContent } from '$lib/utils/leaflet-renderer';

/**
 * Link-post helpers (Linkblog Phase 2).
 *
 * A "link post" is a `site.standard.document` that points at an EXTERNAL article
 * rather than being the thing you read itself — the shape Skyreader writes when a
 * user shares an article to their `skyreader-links` publication (Phase 1). The
 * external URL lives in the document's `links` field; the user's commentary is the
 * leading text block of the `pub.leaflet.content` body.
 *
 * The rule lives here so the feed card, the reader, save/Semble/Margin metadata,
 * and content normalization all agree on "is this a link post, and what's its URL".
 */

/**
 * The external article URL a link post points at: the first `links` entry with an
 * http(s) uri. (`at://` repost refs are Phase 3 quote-reshares — ignored here.)
 */
export function getExternalArticleLink(doc: SocialDocument): string | undefined {
  return doc.links?.find((l) => /^https?:\/\//i.test(l.uri))?.uri;
}

/** Whether a document should render as a link post (primary = external article). */
export function isLinkPost(doc: SocialDocument): boolean {
  return Boolean(getExternalArticleLink(doc));
}

/**
 * The URL a document effectively represents for opening/saving/reading:
 * - link post → the external article
 * - normal document → its own canonical/permalink URL
 */
export function getDocumentEffectiveUrl(doc: SocialDocument): string {
  return getExternalArticleLink(doc) || doc.canonicalUrl || doc.path || '';
}

/**
 * The user's commentary on a link post: the plaintext of the first
 * `pub.leaflet.blocks.text` block (Skyreader writes the note as the leading text
 * block, before the website card). Returns undefined when there's no note.
 */
export function getLinkPostNote(doc: SocialDocument): string | undefined {
  if (!doc.content || !isLeafletContent(doc.content)) return undefined;
  const content = doc.content as LeafletContent;
  for (const page of content.pages ?? []) {
    for (const wrapper of page.blocks ?? []) {
      if (wrapper.block?.$type === 'pub.leaflet.blocks.text') {
        const text = wrapper.block.plaintext?.trim();
        if (text) return text;
      }
    }
  }
  return undefined;
}
