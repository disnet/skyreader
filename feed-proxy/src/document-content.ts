/**
 * Format-aware text extraction from a `site.standard.document` body.
 *
 * standard.site is an interop container: the `content` embed can be authored in
 * any of several block formats — Skyreader/leaflet (`pub.leaflet.content`),
 * pckt.blog (`blog.pckt.content`), offprint (`app.offprint.content`), greengale
 * (`app.greengale.document`, plain markdown), or markpub (`at.markpub.markdown`).
 * Each nests its text differently (leaflet under `pages[].blocks[].block`,
 * pckt/offprint under a flat `items[]` with container blocks holding inner
 * `.content[]`, greengale as one markdown string, markpub under `text.markdown`).
 *
 * The discussion control pulls a short note/snippet from these records (the
 * linker's commentary). It used to walk only the leaflet shape, so a pckt or
 * offprint linkblog post silently yielded no snippet. `extractContentText` reads
 * the leading text from whichever format the `content` embed declares — its
 * `$type` is the discriminator — so the snippet reads the same regardless of
 * which Atmospheric app published the post.
 */

// A text-bearing block: leaflet/pckt/offprint all spell the body text `plaintext`.
interface TextishBlock {
  $type?: string;
  plaintext?: string;
  // pckt/offprint container blocks (blockquote, list item, table cell, …) hold
  // their text in a nested block array rather than a top-level `plaintext`.
  content?: unknown;
}

// The text block `$type` per format. Headers/callouts are deliberately excluded —
// a snippet is the linker's prose, mirroring the original leaflet-only behavior.
const TEXT_BLOCK_TYPES = new Set([
  'pub.leaflet.blocks.text',
  'blog.pckt.block.text',
  'app.offprint.block.text',
]);

// Quoted passages. A share's note usually opens with one — the composer seeds the
// selected passage and drops the cursor under it — so taking the first text in
// document order would make the snippet the article's own words rather than the
// linker's. They're a FALLBACK instead: `firstTextInBlocks` runs once skipping
// quotes, and only if the note is nothing but a quote does a second pass take one
// (better than the caller's `textContent`, which still carries the `> ` marker).
//
// Leaflet needs the type listed here because its blockquote carries text in a
// top-level `plaintext`; pckt/offprint spell theirs as a container holding inner
// text blocks, so listing it is what stops the descent reaching in.
const QUOTE_BLOCK_TYPES = new Set([
  'pub.leaflet.blocks.blockquote',
  'blog.pckt.block.blockquote',
  'app.offprint.block.blockquote',
]);

// Bound the descent into nested container blocks (a lead quote/list still yields
// text) without chasing pathologically deep trees.
const MAX_DEPTH = 4;

// Skyreader's opt-in "posted from" line (backend ATTRIBUTION_TEXT). It's a plain
// text block in every format, so without this the snippet for a bare share —
// no commentary, just a quote and the line — would read as the linker's prose.
// Keep in sync with the backend constant.
const ATTRIBUTION_TEXT = 'Posted from skyreader.app';

function isAttributionText(text: string): boolean {
  return text === ATTRIBUTION_TEXT;
}

function firstTextInBlocks(blocks: unknown, depth: number, quotes: 'skip' | 'take'): string | null {
  if (depth > MAX_DEPTH || !Array.isArray(blocks)) return null;
  for (const entry of blocks) {
    if (!entry || typeof entry !== 'object') continue;
    // leaflet wraps each block as `{ block: {...} }`; pckt/offprint list its
    // blocks directly. Handle both by unwrapping a `.block` if present.
    const block = ('block' in entry ? (entry as { block?: unknown }).block : entry) as
      TextishBlock | undefined;
    if (!block || typeof block !== 'object') continue;
    const isQuote = typeof block.$type === 'string' && QUOTE_BLOCK_TYPES.has(block.$type);
    if (isQuote && quotes === 'skip') continue;
    if (isQuote || (typeof block.$type === 'string' && TEXT_BLOCK_TYPES.has(block.$type))) {
      const text = block.plaintext?.trim();
      if (text && !isAttributionText(text)) return text;
    }
    // Descend into container blocks (blockquote / list item / table cell).
    const nested = firstTextInBlocks(block.content, depth + 1, quotes);
    if (nested) return nested;
  }
  return null;
}

// The linker's own prose if the note has any, otherwise whatever they quoted.
function firstSnippetInBlocks(blocks: unknown): string | null {
  return firstTextInBlocks(blocks, 0, 'skip') ?? firstTextInBlocks(blocks, 0, 'take');
}

// A line that is nothing but a markdown link — the shared article's own link
// line in a markpub link post, which can now lead the body rather than close it
// (see the card-position preference). It's the link, not the linker's words, and
// as a snippet it would read as an empty label.
const BARE_LINK_LINE = /^\[[^\]]*\]\([^)]*\)$/;

// The first non-empty markdown line, stripped of leading heading/quote/list
// markers. Shared by the markdown-bodied formats (greengale, markpub).
function firstMarkdownLine(markdown: unknown): string | null {
  if (typeof markdown !== 'string') return null;
  for (const line of markdown.split('\n')) {
    const cleaned = line.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+)/, '').trim();
    if (cleaned && !isAttributionText(cleaned) && !BARE_LINK_LINE.test(cleaned)) return cleaned;
  }
  return null;
}

/**
 * The leading body text of a standard.site document's `content` embed, across
 * every supported authoring format. Returns null when the format is unknown or
 * carries no extractable text (the caller falls back to description/textContent).
 */
export function extractContentText(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const type = (content as { $type?: string }).$type;

  switch (type) {
    case 'pub.leaflet.content': {
      const pages = (content as { pages?: Array<{ blocks?: unknown }> }).pages ?? [];
      // Prose anywhere in the document beats a quote on the first page, so the
      // skip pass runs across every page before the take pass does.
      for (const quotes of ['skip', 'take'] as const) {
        for (const page of pages) {
          const text = firstTextInBlocks(page?.blocks, 0, quotes);
          if (text) return text;
        }
      }
      return null;
    }
    case 'blog.pckt.content':
    case 'app.offprint.content':
      return firstSnippetInBlocks((content as { items?: unknown }).items);
    case 'app.greengale.document': {
      const markdown = (content as { markdown?: string }).markdown;
      return firstMarkdownLine(markdown);
    }
    case 'at.markpub.markdown': {
      // markpub (https://markpub.at/) nests its body one level deeper, under
      // `text.markdown`.
      const markdown = (content as { text?: { markdown?: string } }).text?.markdown;
      return firstMarkdownLine(markdown);
    }
    default:
      return null;
  }
}
