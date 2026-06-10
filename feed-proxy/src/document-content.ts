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

// Bound the descent into nested container blocks (a lead quote/list still yields
// text) without chasing pathologically deep trees.
const MAX_DEPTH = 4;

function firstTextInBlocks(blocks: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH || !Array.isArray(blocks)) return null;
  for (const entry of blocks) {
    if (!entry || typeof entry !== 'object') continue;
    // leaflet wraps each block as `{ block: {...} }`; pckt/offprint list its
    // blocks directly. Handle both by unwrapping a `.block` if present.
    const block = ('block' in entry ? (entry as { block?: unknown }).block : entry) as
      | TextishBlock
      | undefined;
    if (!block || typeof block !== 'object') continue;
    if (typeof block.$type === 'string' && TEXT_BLOCK_TYPES.has(block.$type)) {
      const text = block.plaintext?.trim();
      if (text) return text;
    }
    // Descend into container blocks (blockquote / list item / table cell).
    const nested = firstTextInBlocks(block.content, depth + 1);
    if (nested) return nested;
  }
  return null;
}

// The first non-empty markdown line, stripped of leading heading/quote/list
// markers. Shared by the markdown-bodied formats (greengale, markpub).
function firstMarkdownLine(markdown: unknown): string | null {
  if (typeof markdown !== 'string') return null;
  for (const line of markdown.split('\n')) {
    const cleaned = line.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+)/, '').trim();
    if (cleaned) return cleaned;
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
      for (const page of pages) {
        const text = firstTextInBlocks(page?.blocks, 0);
        if (text) return text;
      }
      return null;
    }
    case 'blog.pckt.content':
    case 'app.offprint.content':
      return firstTextInBlocks((content as { items?: unknown }).items, 0);
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
