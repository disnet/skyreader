/**
 * The opening of an HTML body, cut to a byte budget at a safe boundary.
 *
 * Used at ingest for bodies over the inline cap (routes/ingest.ts): the full
 * body goes to R2, and the row keeps this lead so the feed's collapsed card can
 * show the article's real opening — not a one-line <description> — without a
 * request per card.
 *
 * Not a parser, and it doesn't need to be one. It only has to avoid cutting
 * inside a tag, comment, raw-text element, or character reference; the reader
 * sanitizes the lead through DOMParser like any feed body, and the parser closes
 * whatever elements the cut left open. It prefers, in order, a cut where the
 * top-level element just closed, one after a closing block tag, then any tag or
 * word boundary — each only if it keeps at least a quarter of the budget, so a
 * post wrapped in one big <div> still yields a useful lead.
 */

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// Their content is text, not markup: a `<` inside is not a tag.
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dl',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);

function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Index just past the `>` that ends the tag opened at `start`, honouring quoted attributes. */
function tagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
  }
  return html.length;
}

function hasVisibleText(html: string): boolean {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<[^>]*>/g, '')
      .trim().length > 0
  );
}

/**
 * The longest safe prefix of `html` within `maxBytes` (UTF-8), or undefined when
 * that prefix would carry no visible text. Returns `html` unchanged if it fits.
 */
export function htmlLead(html: string, maxBytes: number): string | undefined {
  const minBytes = maxBytes / 4;
  // Each candidate: [index into html, bytes before it].
  let topLevel: [number, number] = [0, 0];
  let block: [number, number] = [0, 0];
  let anywhere: [number, number] = [0, 0];

  let bytes = 0;
  let depth = 0;
  let i = 0;
  let fits = true;
  while (i < html.length) {
    const ch = html[i];
    // Markup only where a browser would read it as such: `<` then a letter, `/`,
    // `!` or `?`. A bare `<` (`x <3`, `a < b`, unescaped in plenty of feeds) is
    // text, and scanning it as a tag would run on to the next `>` — or, past an
    // apostrophe, to the end of the body — collapsing the lead to a few words.
    if (ch === '<' && /[a-zA-Z/!?]/.test(html[i + 1] ?? '')) {
      anywhere = [i, bytes];
      let end: number;
      let name = '';
      let closing = false;
      if (html.startsWith('<!--', i)) {
        const close = html.indexOf('-->', i + 4);
        end = close < 0 ? html.length : close + 3;
      } else {
        end = tagEnd(html, i);
        const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(i, Math.min(end, i + 64)));
        if (match) {
          closing = match[1] === '/';
          name = match[2].toLowerCase();
          if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
            const closer = new RegExp(`</${name}`, 'gi');
            closer.lastIndex = end;
            const close = closer.exec(html)?.index ?? -1;
            end = close < 0 ? html.length : tagEnd(html, close);
          }
        }
      }
      bytes += utf8Length(html.slice(i, end));
      i = end;
      if (bytes > maxBytes) {
        fits = false;
        break;
      }
      if (!name) continue;
      if (closing) {
        depth = Math.max(0, depth - 1);
        if (depth === 0) topLevel = [i, bytes];
        if (BLOCK_ELEMENTS.has(name)) block = [i, bytes];
      } else if (RAW_TEXT_ELEMENTS.has(name) || VOID_ELEMENTS.has(name)) {
        // Raw-text elements were consumed whole above; void ones have no content.
        if (depth === 0) topLevel = [i, bytes];
      } else if (html[i - 2] !== '/') {
        // Not self-closed (`<x/>`).
        depth++;
      }
      continue;
    }

    const code = html.charCodeAt(i);
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : 3;
    // A word boundary is outside any character reference (those hold no spaces).
    if (ch === ' ' || ch === '\n' || ch === '\t') anywhere = [i, bytes];
    if (bytes + width > maxBytes) {
      fits = false;
      break;
    }
    bytes += width;
    i += width === 4 ? 2 : 1;
  }

  if (fits) return html;
  const [cut] = topLevel[1] >= minBytes ? topLevel : block[1] >= minBytes ? block : anywhere;
  const lead = html.slice(0, cut).trimEnd();
  return lead && hasVisibleText(lead) ? lead : undefined;
}
