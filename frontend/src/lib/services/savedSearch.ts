// Pure helpers behind saved-article search. Deliberately dependency-free (no
// DOM, no stores) so they can be unit-tested in node and run over hundreds of
// article bodies without touching the document.
//
// Everything here works on *plain text*. Extracted article HTML is stripped to
// text once, when the body corpus is built, and the result is only ever
// compared against or rendered through Svelte text interpolation — never as
// HTML. See `savedSearch.svelte.ts` for the corpus itself.

/** Cap on how much of one article's text is indexed (characters, post-strip). */
export const MAX_INDEX_CHARS = 200_000;

/** Cap on the raw HTML we bother stripping for a single item. */
const MAX_HTML_CHARS = 1_000_000;

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
};

function decodeEntity(entity: string): string {
  if (entity.startsWith('#')) {
    const code =
      entity.startsWith('#x') || entity.startsWith('#X')
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return ' ';
      }
    }
    return ' ';
  }
  return NAMED_ENTITIES[entity.toLowerCase()] ?? ' ';
}

/**
 * Strip HTML to plain text for indexing. Regex-based rather than DOMParser:
 * this runs over every cached article body, and the output is only ever matched
 * against or rendered as text. Script/style bodies are dropped wholesale so
 * their contents can't produce phantom hits.
 */
export function htmlToText(html: string): string {
  if (!html) return '';
  const capped = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  return capped
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (_m, e: string) => decodeEntity(e))
    .replace(/\s+/g, ' ')
    .trim();
}

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Case- and diacritic-insensitive fold, so "Café" matches a query of "cafe".
 * NFKD splits accented letters into base + combining mark; dropping the marks
 * leaves the base letter.
 */
export function normalize(s: string): string {
  if (!s) return '';
  return s.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase();
}

/** Normalize an article body into the text stored in the search corpus. */
export function toIndexText(html: string | null | undefined): string {
  if (!html) return '';
  const text = normalize(htmlToText(html));
  return text.length > MAX_INDEX_CHARS ? text.slice(0, MAX_INDEX_CHARS) : text;
}

/**
 * Split a raw query into normalized terms. All terms must match (AND), each as
 * a substring — the same idiom the rest of the app's filter inputs use.
 */
export function parseQuery(q: string): string[] {
  const normalized = normalize(q).trim();
  if (!normalized) return [];
  return [...new Set(normalized.split(/\s+/).filter(Boolean))];
}

/** True when every term appears in an already-normalized haystack. */
export function matchesTerms(haystack: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  if (!haystack) return false;
  for (const term of terms) {
    if (!haystack.includes(term)) return false;
  }
  return true;
}

export const RANK_TITLE = 0;
export const RANK_METADATA = 1;
export const RANK_BODY = 2;

/** Tier of a match (lower sorts first), or null when the item doesn't match. */
export function searchRank(
  title: string,
  metadata: string,
  terms: string[],
  bodyMatchTerms: Map<string, Set<string>> | null,
  bodyKeys: () => string[]
): number | null {
  let rank = RANK_TITLE;
  let keys: string[] | null = null;

  for (const term of terms) {
    if (matchesTerms(title, [term])) continue;
    if (matchesTerms(metadata, [term])) {
      rank = Math.max(rank, RANK_METADATA);
      continue;
    }
    if (bodyMatchTerms === null) return null;
    keys ??= bodyKeys();
    if (!keys.some((key) => bodyMatchTerms.get(key)?.has(term) === true)) return null;
    rank = RANK_BODY;
  }

  return rank;
}

/**
 * Does one item satisfy the query, given its normalized metadata haystack and
 * the per-key term sets the body corpus matched?
 *
 * Every term must hit (AND), but each term picks its own source: one may come
 * from the title while another only appears in the article text. Checking the
 * two sources term-by-term rather than side-by-side is what makes
 * "ownership <word-only-in-the-body>" find the piece.
 *
 * `bodyKeys` is a thunk because most items match entirely on metadata: the keys
 * a save is indexed under are only built when a term misses the metadata.
 * A `null` `bodyMatchTerms` means no corpus yet (the first search runs before
 * it resolves) — the query then degrades to metadata-only AND.
 */
export function matchesSearch(
  metadata: string,
  terms: string[],
  bodyMatchTerms: Map<string, Set<string>> | null,
  bodyKeys: () => string[]
): boolean {
  return searchRank('', metadata, terms, bodyMatchTerms, bodyKeys) !== null;
}

/**
 * Fold `text` the way `normalize` does while keeping a per-character map back
 * to the original string, so a hit found in folded space can be sliced out of
 * the original (right case, right accents). ASCII takes a fast path — the
 * per-character `normalize()` call is what makes this expensive, and article
 * bodies are overwhelmingly ASCII.
 */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      folded += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i];
      map.push(i);
      continue;
    }
    const piece = normalize(text[i]);
    for (let j = 0; j < piece.length; j++) {
      folded += piece[j];
      map.push(i);
    }
  }
  return { folded, map };
}

/** Earliest hit of any term, in folded space. */
function firstHit(folded: string, terms: string[]): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (const term of terms) {
    if (!term) continue;
    const idx = folded.indexOf(term);
    if (idx === -1) continue;
    if (!best || idx < best.start) best = { start: idx, end: idx + term.length };
  }
  return best;
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
  /** True when text was elided at that edge (render as a leading/trailing ellipsis). */
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

/**
 * A window of `text` around the first term hit, split so the caller can wrap
 * `match` in a `<mark>` from its own template. Returns null when no term hits.
 */
export function makeSnippet(text: string, terms: string[], radius = 90): Snippet | null {
  if (!text || terms.length === 0) return null;
  const { folded, map } = foldWithMap(text);
  const hit = firstHit(folded, terms);
  if (!hit) return null;

  const start = map[hit.start] ?? 0;
  const end = (map[hit.end - 1] ?? start) + 1;

  let from = Math.max(0, start - radius);
  let to = Math.min(text.length, end + radius);
  // Don't start or end mid-word when we're cutting into the text.
  if (from > 0) {
    const space = text.indexOf(' ', from);
    if (space !== -1 && space < start) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(' ', to);
    if (space !== -1 && space > end) to = space;
  }

  return {
    before: text.slice(from, start),
    match: text.slice(start, end),
    after: text.slice(end, to),
    truncatedStart: from > 0,
    truncatedEnd: to < text.length,
  };
}

export interface HighlightPart {
  text: string;
  mark: boolean;
}

/**
 * Split short text (a title) into marked/unmarked runs for the same
 * template-side `<mark>` treatment. Non-overlapping, left to right.
 */
export function splitHighlights(text: string, terms: string[]): HighlightPart[] {
  if (!text || terms.length === 0) return [{ text, mark: false }];
  const { folded, map } = foldWithMap(text);

  // Collect every hit of every term, then merge overlaps.
  const hits: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    if (!term) continue;
    let idx = folded.indexOf(term);
    while (idx !== -1) {
      hits.push({ start: idx, end: idx + term.length });
      idx = folded.indexOf(term, idx + term.length);
    }
  }
  if (hits.length === 0) return [{ text, mark: false }];
  hits.sort((a, b) => a.start - b.start);

  // Merge overlapping/adjacent hits in folded space first, so two terms that
  // overlap ("read" and "reading") produce one run rather than a nested one.
  const merged: Array<{ start: number; end: number }> = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last && hit.start <= last.end) last.end = Math.max(last.end, hit.end);
    else merged.push({ ...hit });
  }

  const parts: HighlightPart[] = [];
  let cursor = 0; // index into the original string
  for (const hit of merged) {
    const start = map[hit.start] ?? 0;
    const end = (map[hit.end - 1] ?? start) + 1;
    if (end <= cursor) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), mark: false });
    parts.push({ text: text.slice(Math.max(cursor, start), end), mark: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), mark: false });
  return parts;
}
