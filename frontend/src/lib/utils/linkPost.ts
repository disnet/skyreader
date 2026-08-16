import type { LeafletContent, SocialDocument } from '$lib/types';
import { isLeafletContent } from '$lib/utils/leaflet-renderer';
import { noteToLeafletBlocks, reconstructLinkPostNote } from '$lib/utils/linkPostNote';

/**
 * Link-post helpers (Linkblog Phase 2).
 *
 * A "link post" is a `site.standard.document` that points at an EXTERNAL article
 * rather than being the thing you read itself — the shape Skyreader writes when a
 * user shares an article to their `skyreader-links` publication (Phase 1). The
 * external URL lives in the document's `links` field; the user's commentary is the
 * leading text and blockquote blocks of the `pub.leaflet.content` body.
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

// The constant marker Skyreader stamps on the records it writes (publications and
// link posts alike). MUST match backend LINKBLOG_MARKER_URL.
export const LINKBLOG_MARKER_URL = 'https://skyreader.app/linkblog';
const DEFAULT_LINKBLOG_PUB_SUFFIX = '/site.standard.publication/skyreader-links';

/**
 * Whether SKYREADER wrote this document — the gate for every affordance that
 * mutates it (un-share/delete, in-place note edit, the "already shared" overlay).
 *
 * "Has an outbound link and lives in my linkblog" is not enough: a linkblog
 * connected to an existing publication shares that publication with everything
 * its home app publishes there, and an essay that happens to link out looks
 * identical. Deleting one of those is unrecoverable, so the test is the marker we
 * write, or the document living in the user's own Skyreader publication (where
 * everything is ours — including shares written before the marker existed).
 */
export function isSkyreaderShare(doc: SocialDocument): boolean {
  return (
    doc.skyreaderLinkblog === LINKBLOG_MARKER_URL ||
    (doc.siteUri?.endsWith(DEFAULT_LINKBLOG_PUB_SUFFIX) ?? false)
  );
}

/**
 * The document a just-written share looks like, before the PDS → indexer → proxy
 * round-trip surfaces the real one. Shaped to match what the link-post card
 * reads: the external URL in `links`, the note as leading native Leaflet blocks.
 *
 * It carries the marker because we just wrote the record with it. That matters
 * beyond the card: without it `isSkyreaderShare` rejects the optimistic document
 * (a connected publication's siteUri isn't the `skyreader-links` fallback), which
 * drops the share out of the cross-device overlay — and reconcile() would then
 * read "not on the server" and prune the local row while the write is still
 * being indexed.
 */
export function buildOptimisticLinkPost(
  did: string,
  input: {
    recordUri: string;
    siteUri: string;
    articleUrl: string;
    articleTitle?: string;
    publishedAt?: string;
    note?: string;
    createdAt: string;
  }
): SocialDocument {
  const note = input.note?.trim();
  return {
    authorDid: did,
    recordUri: input.recordUri,
    siteUri: input.siteUri,
    skyreaderLinkblog: LINKBLOG_MARKER_URL,
    title: input.articleTitle || input.articleUrl,
    publishedAt: input.publishedAt || input.createdAt,
    createdAt: input.createdAt,
    // New shares carry the quote inside the note (the body), not a top-level
    // `description` — leaving it unset so this optimistic doc renders exactly
    // like the pulled one (no standalone legacy quote, just the note body).
    description: undefined,
    links: [{ uri: input.articleUrl, rel: 'related' }],
    content: note
      ? {
          $type: 'pub.leaflet.content',
          pages: [
            {
              $type: 'pub.leaflet.pages.linearDocument',
              blocks: noteToLeafletBlocks(note),
            },
          ],
        }
      : undefined,
  };
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
 * The user's commentary on a link post, reconstructed from the native text and
 * blockquote blocks before the website card. Returns undefined when there's no note.
 *
 * A linkblog connected to an existing standard.site publication writes the same
 * shape in that publication's own content lexicon (pckt, Offprint, Markdown), so
 * all four are read here — otherwise the commentary, which is the point of a
 * linkblog, would render blank on every Skyreader surface.
 */
export function getLinkPostNote(doc: SocialDocument): string | undefined {
  if (!doc.content) return undefined;
  if (isLeafletContent(doc.content)) {
    const content = doc.content as LeafletContent;
    for (const page of content.pages ?? []) {
      const note = reconstructLinkPostNote(page.blocks ?? []).note;
      if (note) return note;
    }
    return undefined;
  }
  return foreignNote(doc.content, getExternalArticleLink(doc));
}

// ── Notes in a connected publication's own content lexicon ───────────────────
//
// pckt and Offprint share an `items` array of text/blockquote blocks; Markdown
// (at.markpub) stores one string. In each, the note leads and the shared article
// closes the post — as a native link card (pckt, Offprint) or a trailing Markdown
// link. Rendered back into the same small Markdown subset the Leaflet reader
// produces (`> ` for quotes).

interface ForeignBlock {
  $type?: string;
  plaintext?: string;
  content?: ForeignBlock[];
}

function blockText(block: ForeignBlock): string {
  if (typeof block.plaintext === 'string') return block.plaintext;
  return (block.content ?? []).map(blockText).filter(Boolean).join('\n');
}

function itemsNote(items: ForeignBlock[], prefix: string, articleUrl?: string): string | undefined {
  const parts: string[] = [];
  for (const item of items) {
    const isQuote = item?.$type === `${prefix}blockquote`;
    if (!isQuote && item?.$type !== `${prefix}text`) break;
    const text = blockText(item).trim();
    if (!text) continue;
    // A link card ends the note by not being a text block at all. Shares written
    // before Offprint's card was used put the article in a trailing text line
    // instead, so a text block carrying the URL ends it too.
    if (!isQuote && articleUrl && text.includes(articleUrl)) break;
    parts.push(
      isQuote
        ? text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : text
    );
  }
  const note = parts.join('\n\n').trim();
  return note || undefined;
}

function markdownNote(markdown: string, articleUrl?: string): string | undefined {
  const lines = markdown.split('\n');
  if (articleUrl) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(`](${articleUrl})`)) {
        lines.splice(i, 1);
        break;
      }
    }
  }
  const note = lines.join('\n').trim();
  return note || undefined;
}

function foreignNote(content: unknown, articleUrl?: string): string | undefined {
  const shape = content as { $type?: string; items?: ForeignBlock[]; text?: { markdown?: string } };
  switch (shape?.$type) {
    case 'blog.pckt.content':
      return itemsNote(shape.items ?? [], 'blog.pckt.block.', articleUrl);
    case 'app.offprint.content':
      return itemsNote(shape.items ?? [], 'app.offprint.block.', articleUrl);
    case 'at.markpub.markdown':
      return markdownNote(shape.text?.markdown ?? '', articleUrl);
    default:
      return undefined;
  }
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
/**
 * The resolved @mention facets on a link post's note, byte-indexed into
 * getLinkPostNote(doc). Block-local offsets are rebased over the reconstructed
 * Markdown, including the inserted `> ` markers and blank-line separators.
 */
export function getLinkPostNoteMentions(doc: SocialDocument): MentionFacet[] {
  if (!doc.content || !isLeafletContent(doc.content)) return [];
  const content = doc.content as LeafletContent;
  for (const page of content.pages ?? []) {
    const result = reconstructLinkPostNote(page.blocks ?? []);
    if (result.note) return result.mentions;
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
