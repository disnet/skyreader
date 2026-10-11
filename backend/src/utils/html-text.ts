/**
 * Plain text from an HTML body, for the full-text search index
 * (durable-objects/search-index.ts).
 *
 * Not a parser, and it doesn't need to be one: the output is only tokenized by
 * FTS5 and quoted back in short snippets, so the job is to keep the words and
 * drop the markup. Raw-text elements (script, style, …) lose their content, block
 * tags become line breaks so words either side never fuse, and the character
 * references a feed body actually uses are decoded.
 */

const DROPPED_ELEMENTS = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAG =
  /<\/?(?:p|div|br|hr|li|ul|ol|h[1-6]|blockquote|pre|section|article|aside|header|footer|figure|figcaption|table|tr|td|th|dl|dt|dd)\b[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/**
 * The text of `html`, whitespace collapsed (paragraph breaks kept as single
 * newlines), cut to at most `maxChars` characters at a word boundary.
 */
export function htmlToText(html: string, maxChars = Infinity): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(DROPPED_ELEMENTS, ' ')
    .replace(BLOCK_TAG, '\n')
    .replace(/<[^>]*>/g, ' ');
  text = stripControlChars(decodeEntities(text))
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ ?\n[\s]*/g, '\n')
    .trim();
  return truncateText(text, maxChars);
}

/**
 * `text` with control characters (other than tab and newline) replaced by
 * spaces. The search index marks snippet matches with \u0002/\u0003, so no
 * indexed field may contain them.
 */
export function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
}

/** Cut `text` to at most `maxChars`, backing up to a word boundary when one is near. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.search(/\s\S*$/);
  return lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut;
}
