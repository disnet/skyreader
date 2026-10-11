/**
 * Strings in code point order, which is UTF-8 byte order: what SQLite's BINARY
 * collation sorts by. JS `<` compares UTF-16 units, which disagrees once a
 * string holds a character past U+FFFF. Mirrors the backend's, which pages
 * every follows link by it (backend/src/services/follow-links-store.ts).
 */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return codePointRank(x) - codePointRank(y);
  }
  return a.length - b.length;
}

/** Surrogates (U+D800–DFFF) above the rest of the BMP, as their code points sort. */
function codePointRank(unit: number): number {
  return unit < 0xd800 ? unit : unit < 0xe000 ? unit + 0x2000 : unit - 0x800;
}
