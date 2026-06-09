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

// A resolved @mention in a note: the UTF-8 byte range of the `@handle` token within
// the note plaintext, plus the DID it points at.
export interface MentionFacet {
  byteStart: number;
  byteEnd: number;
  did: string;
}

// Facet $types we treat as an @mention. Skyreader's writer emits `#didMention`; the
// others are accepted for interop with bsky/leaflet-native records.
const MENTION_FACET_TYPES = new Set([
  'pub.leaflet.richtext.facet#didMention',
  'pub.leaflet.richtext.facet#mention',
  'app.bsky.richtext.facet#mention',
]);

/**
 * The resolved @mention facets on a link post's note, byte-indexed into
 * getLinkPostNote(doc). Pulled from the same leading text block, so the offsets line
 * up with that string (the backend stores the note plaintext already trimmed).
 */
export function getLinkPostNoteMentions(doc: SocialDocument): MentionFacet[] {
  if (!doc.content || !isLeafletContent(doc.content)) return [];
  const content = doc.content as LeafletContent;
  for (const page of content.pages ?? []) {
    for (const wrapper of page.blocks ?? []) {
      if (wrapper.block?.$type === 'pub.leaflet.blocks.text' && wrapper.block.plaintext?.trim()) {
        const out: MentionFacet[] = [];
        for (const f of wrapper.block.facets ?? []) {
          const byteStart = f?.index?.byteStart;
          const byteEnd = f?.index?.byteEnd;
          if (
            typeof byteStart !== 'number' ||
            typeof byteEnd !== 'number' ||
            byteEnd <= byteStart
          ) {
            continue;
          }
          const did = (f.features ?? []).find(
            (ft) => ft && MENTION_FACET_TYPES.has(ft.$type ?? '') && ft.did?.startsWith('did:')
          )?.did;
          if (did) out.push({ byteStart, byteEnd, did });
        }
        return out;
      }
    }
  }
  return [];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Splice mention anchors over the @mention facets in a note. The facets carry UTF-8
 * byte ranges into the (trimmed) note plaintext — which is also its Markdown source —
 * so we edit in byte space, replacing each `@handle` token with an `<a>` tag that
 * Markdown passes through verbatim.
 *
 * The anchor carries `data-mention-did` so an in-app click can open the add-feed
 * dialog for that account (see ArticleCardView); the `href` to the Bluesky profile is
 * the fallback for any context without that handler. Apply right before Markdown
 * parsing — the output is still sanitized downstream (DOMPurify keeps class/data/href).
 */
export function linkifyNoteMentions(note: string, facets: MentionFacet[]): string {
  if (facets.length === 0) return note;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(note);
  const origLen = bytes.length;
  let result = bytes;
  // Apply from the end so earlier byte offsets stay valid as the splices grow the array.
  for (const f of [...facets].sort((a, b) => b.byteStart - a.byteStart)) {
    if (f.byteStart < 0 || f.byteEnd > origLen || f.byteStart >= f.byteEnd) continue;
    const label = escapeHtml(decoder.decode(result.slice(f.byteStart, f.byteEnd)));
    const href = `https://bsky.app/profile/${encodeURIComponent(f.did)}`;
    const anchor = encoder.encode(
      `<a class="mention" data-mention-did="${escapeHtml(f.did)}" href="${href}">${label}</a>`
    );
    const before = result.slice(0, f.byteStart);
    const after = result.slice(f.byteEnd);
    const merged = new Uint8Array(before.length + anchor.length + after.length);
    merged.set(before, 0);
    merged.set(anchor, before.length);
    merged.set(after, before.length + anchor.length);
    result = merged;
  }
  return decoder.decode(result);
}

/** The seeded quote is capped so it reads as a quotable snippet, not the whole
 *  article — the user can always trim it further before posting. */
const QUOTE_SEED_MAX_CHARS = 500;

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Format an article excerpt as a one-line Markdown blockquote (`> …`), ready to
 * seed a share composer. Strips any HTML the excerpt carries, decodes the common
 * entities, collapses whitespace to a clean snippet, and caps the length.
 * Returns undefined when there's no usable excerpt (so callers can fall back to
 * a bare, quote-less share).
 */
export function formatQuoteSeed(excerpt: string | null | undefined): string | undefined {
  if (!excerpt) return undefined;
  const text = excerpt
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g, (m) => NAMED_ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  const snippet =
    text.length > QUOTE_SEED_MAX_CHARS
      ? text.slice(0, QUOTE_SEED_MAX_CHARS - 1).trimEnd() + '…'
      : text;
  return `> ${snippet}`;
}

/**
 * Whether a note already carries a Markdown blockquote (a line starting with
 * `>`). When it does, the note itself renders the quote, so the card suppresses
 * the standalone excerpt blockquote to avoid showing the quote twice. Legacy
 * notes (commentary only) have none, and keep their separate excerpt quote.
 */
export function noteHasBlockquote(note: string | null | undefined): boolean {
  return note ? /^[ \t]*>/m.test(note) : false;
}
