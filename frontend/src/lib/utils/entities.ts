// Common named HTML entities that show up in feed titles. Numeric entities
// (decimal `&#8220;` and hex `&#x201c;`) are handled generically below, so this
// only needs the named ones feeds actually use.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
};

/**
 * Decode HTML entities in a short plain-text string (e.g. a feed title). Feeds
 * sometimes ship titles with raw entities like `&#8220;The...` or `&amp;`, which
 * would otherwise render literally. Handles decimal/hex numeric entities and the
 * common named ones. SSR-safe (pure string work, no DOM) and cheap enough to run
 * per-item in a derived. Unknown entities are left untouched.
 */
export function decodeEntities(input: string | null | undefined): string {
  if (!input) return '';
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}
