// A book known only by its highlights: what a Kindle "My Clippings.txt" or a
// Readwise highlights export brings in. There's no URL and no text of the book,
// so the save's body is made from the highlighted passages themselves, one
// paragraph each in book order. Each highlight then anchors to its own
// paragraph like any other, and the book reads, searches and reviews as a save.
//
// The body also remembers every passage ever imported: a passage still in the
// body but no longer highlighted is one the reader removed, so importing the
// file again (Kindle's file only ever grows) adds only passages that are new.
//
// Pure functions; the writes are in routes/saved-import.ts.

import { decodeEntities, escapeHtml } from '../utils/html-text';

export const BOOK_CONTENT_TYPE = 'book';

export interface BookPassage {
  text: string;
  note?: string;
  createdAt?: number;
  /** Where it sits in the book (a Kindle location or page), for ordering. */
  location?: number;
}

/** Runs of whitespace as one space, so a passage reads exactly as it renders. */
export function passageText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The key two imports of one book share: its title up to any subtitle, and its
 * author's surname, without case, accents or punctuation. Kindle writes
 * "Sapiens: A Brief History of Humankind (Harari, Yuval Noah)" where Readwise
 * writes "Sapiens" by "Yuval Noah Harari"; both come to "sapiens|harari".
 * Mirrored in frontend utils/readLaterImport/parsers.ts.
 */
export function bookKey(title: string | null | undefined, author: string | null | undefined) {
  const fold = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const main = (title ?? '').split(/[:(]/)[0];
  const first = (author ?? '').split(/;|&| and /)[0].trim();
  // "Harari, Yuval Noah" names the surname first.
  const surname = first.includes(',')
    ? first.split(',')[0]
    : (fold(first).split(' ').filter(Boolean).at(-1) ?? '');
  return `${fold(main)}|${fold(surname)}`;
}

/**
 * The passages worth keeping, in book order. Kindle keeps every version of a
 * highlight the reader extended or re-made, so a passage that sits inside
 * another is the same highlight: the longer one stays, taking the shorter's
 * note if it has none. Leaving no passage inside another is also what lets
 * each highlight anchor to its own paragraph.
 */
export function mergePassages(passages: BookPassage[]): BookPassage[] {
  const bySize = passages
    .map((p, i) => ({ ...p, text: passageText(p.text), i }))
    .filter((p) => p.text)
    .sort((a, b) => b.text.length - a.text.length || a.i - b.i);
  const kept: (BookPassage & { i: number })[] = [];
  for (const p of bySize) {
    const outer = kept.find((k) => k.text.includes(p.text));
    if (!outer) {
      kept.push(p);
      continue;
    }
    if (!outer.note && p.note) outer.note = p.note;
    if (outer.location === undefined) outer.location = p.location;
    if (
      p.createdAt !== undefined &&
      (outer.createdAt === undefined || p.createdAt < outer.createdAt)
    )
      outer.createdAt = p.createdAt;
  }
  return kept.sort(byLocation).map(({ i: _i, ...p }) => p);
}

function byLocation(a: { location?: number; i: number }, b: { location?: number; i: number }) {
  if (a.location !== undefined && b.location !== undefined && a.location !== b.location)
    return a.location - b.location;
  // Passages with no location keep the export's order, after the located ones.
  if (a.location === undefined && b.location !== undefined) return 1;
  if (b.location === undefined && a.location !== undefined) return -1;
  return a.i - b.i;
}

const SOURCE_LINE: Record<string, string> = {
  kindle: 'Kindle',
  'readwise-books': 'Readwise',
};

/** The save's body: an opening line, then one paragraph per passage. */
export function buildBookBody(passages: BookPassage[], source: string): string {
  const from = SOURCE_LINE[source] ?? 'another app';
  const intro =
    `<p class="book-import-note"><em>Your highlights from this book, imported from ${from}, ` +
    `in the order they appear. The rest of the book isn't in Skyreader.</em></p>`;
  const body = passages.map(
    (p) =>
      `<p class="book-passage"${p.location !== undefined ? ` data-location="${p.location}"` : ''}>${escapeHtml(p.text)}</p>`
  );
  return [intro, ...body].join('\n');
}

/** The passages a body built by buildBookBody holds, in its order. */
export function parseBookBody(html: string | null | undefined): BookPassage[] {
  if (!html) return [];
  const out: BookPassage[] = [];
  const paragraph = /<p class="book-passage"(?: data-location="(\d+(?:\.\d+)?)")?>([\s\S]*?)<\/p>/g;
  for (const match of html.matchAll(paragraph)) {
    const text = decodeEntities(match[2]);
    if (text) out.push({ text, ...(match[1] ? { location: Number(match[1]) } : {}) });
  }
  return out;
}

/**
 * What a re-import adds to a book already saved: the passages that overlap
 * none already in its body, which is every passage it ever imported (the
 * reader's removed highlights included, so they stay removed). The new ones
 * slot into book order with the old, and `added` is what to highlight.
 */
export function addPassages(
  existing: BookPassage[],
  incoming: BookPassage[]
): { all: BookPassage[]; added: BookPassage[] } {
  const added = mergePassages(incoming).filter(
    (p) => !existing.some((e) => e.text.includes(p.text) || p.text.includes(e.text))
  );
  if (added.length === 0) return { all: existing, added };
  const all = [...existing, ...added]
    .map((p, i) => ({ ...p, i }))
    .sort(byLocation)
    .map(({ i: _i, ...p }) => p);
  return { all, added };
}

export function wordCount(passages: BookPassage[]): number {
  return passages.reduce((n, p) => n + p.text.split(' ').filter(Boolean).length, 0);
}
