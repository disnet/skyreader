/**
 * @mention facets for linkblog shares — the interop lever.
 *
 * Mentions in a share's note are encoded the way Leaflet encodes them: a
 * `pub.leaflet.richtext.facet#didMention` feature on the note's
 * `pub.leaflet.blocks.text` block, byte-indexed into the block's plaintext.
 * Writing this exact shape means a mention authored in Skyreader is legible to
 * Leaflet's renderer and notifier (and to Constellation's backlink index), and
 * vice versa — the same facet lexicon flows both ways.
 *
 * Byte offsets are UTF-8 (atproto facet convention), NOT UTF-16 string indices,
 * so a multibyte char before a mention shifts the offsets correctly.
 */

export const MENTION_FACET_TYPE = 'pub.leaflet.richtext.facet#didMention';

const encoder = new TextEncoder();

/** UTF-8 byte length of a string (atproto facets index bytes, not code units). */
function byteLen(s: string): number {
  return encoder.encode(s).length;
}

// A handle token: `@` followed by a domain — at least two dot-separated labels,
// final label ≥2 letters. Requiring a dot avoids matching bare `@name` (not a
// resolvable atproto handle). Leading/trailing hyphens are excluded per the
// handle grammar. The preceding-char guard (start, whitespace, or an opening
// bracket/paren) keeps us from matching mid-word `foo@bar.com` email locals.
const HANDLE_RE =
  /(^|[\s(\[<])@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,})/g;

export interface HandleToken {
  /** Bare handle, no leading `@` (e.g. `alice.bsky.social`). */
  handle: string;
  /** UTF-8 byte offset of the `@`, inclusive. */
  byteStart: number;
  /** UTF-8 byte offset just past the last handle char. */
  byteEnd: number;
}

/**
 * Find `@handle.tld` tokens in `text` with their UTF-8 byte spans. The span
 * covers the leading `@` (matching atproto/Leaflet mention facets). Duplicate
 * handles are returned once per occurrence — each occurrence is its own facet.
 */
export function parseHandleTokens(text: string): HandleToken[] {
  const tokens: HandleToken[] = [];
  for (const m of text.matchAll(HANDLE_RE)) {
    const lead = m[1] ?? ''; // the boundary char (not part of the mention)
    const handle = m[2];
    const atIndex = (m.index ?? 0) + lead.length; // char index of `@`
    const byteStart = byteLen(text.slice(0, atIndex));
    const byteEnd = byteStart + byteLen(`@${handle}`);
    tokens.push({ handle, byteStart, byteEnd });
  }
  return tokens;
}

export interface MentionFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; did: string }>;
}

/** Build a single didMention facet over a byte span. */
export function buildMentionFacet(byteStart: number, byteEnd: number, did: string): MentionFacet {
  return {
    index: { byteStart, byteEnd },
    features: [{ $type: MENTION_FACET_TYPE, did }],
  };
}
