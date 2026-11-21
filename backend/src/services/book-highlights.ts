// A book known only by its highlights: what a Kindle "My Clippings.txt" or a
// Readwise highlights export brings in. There's no URL and no text of the book,
// so the save's body is made from the highlighted passages themselves, one
// paragraph each in book order. Each highlight then anchors to its own
// paragraph like any other, and the book reads, searches and reviews as a save.
//
// The body also remembers every passage ever imported: a passage still in the
// body but no longer highlighted is one the reader removed, so importing the
// file again (Kindle's file only ever grows) adds only passages that are new.
// It remembers the book's key too, so a book the reader renamed is still found.
//
// Pure functions; the writes are in routes/saved-import.ts. bookKey, bookStem
// and mergePassages are mirrored in frontend utils/readLaterImport/books.ts.

import { decodeEntities, escapeHtml } from '../utils/html-text';

export const BOOK_CONTENT_TYPE = 'book';
/** Passages kept per book: more than a page's highlights, as a book runs long. */
export const MAX_BOOK_PASSAGES = 1000;
/** Characters of passages and notes kept per book, well inside D1's 2 MB row value. */
export const MAX_BOOK_CHARS = 500_000;
/** Highest location kept: Kindle locations and pages are well under it. */
const MAX_LOCATION = 1e8;
/**
 * How far apart (in Kindle locations or pages) two passages, one inside the
 * other, can start and still be versions of one highlight. Kindle keeps the old
 * version when a highlight is extended or redone; a short passage that recurs
 * far away in the book is a highlight of its own.
 */
const SAME_PLACE = 20;
/** Context kept either side of a passage, so a repeated phrase anchors to its own paragraph. */
const CONTEXT_CHARS = 32;

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

/** A location worth keeping: a whole number in range, else none. */
export function bookLocation(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < MAX_LOCATION
    ? Math.floor(value)
    : undefined;
}

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * The first author's surname. "Harari, Yuval Noah" names it first (one word
 * before the comma); "Brian Christian, Tom Griffiths" is a list of names, as
 * is anything split by ";", "&" or "and".
 */
function surname(author: string): string {
  const first = author.split(/;|&| and /)[0].trim();
  const parts = first.split(',').map((p) => p.trim());
  if (parts.length > 1 && parts[0] && !parts[0].includes(' ')) return fold(parts[0]);
  return fold(parts[0]).split(' ').filter(Boolean).at(-1) ?? '';
}

/** A book's key: its whole title and first author's surname, without case, accents or punctuation. */
export function bookKey(title: string | null | undefined, author: string | null | undefined) {
  return `${fold(title ?? '')}|${surname(author ?? '')}`;
}

/**
 * A looser key: the title up to any subtitle or parenthesis. Kindle writes
 * "Sapiens: A Brief History of Humankind" where Readwise may write "Sapiens";
 * both stem to "sapiens|harari". Two volumes of a series stem alike too, so a
 * stem only matches when it names exactly one book.
 */
export function bookStem(title: string | null | undefined, author: string | null | undefined) {
  return `${fold((title ?? '').split(/[:(]/)[0])}|${surname(author ?? '')}`;
}

/** Whether two passages are versions of one highlight: one inside the other, in the same place. */
export function sameHighlight(a: BookPassage, b: BookPassage): boolean {
  if (!a.text.includes(b.text) && !b.text.includes(a.text)) return false;
  return (
    a.location === undefined ||
    b.location === undefined ||
    Math.abs(a.location - b.location) <= SAME_PLACE
  );
}

type Indexed = BookPassage & { i: number };

function byLocation(a: Indexed, b: Indexed) {
  if (a.location !== undefined && b.location !== undefined && a.location !== b.location)
    return a.location - b.location;
  // Passages with no location keep the export's order, after the located ones.
  if (a.location === undefined && b.location !== undefined) return 1;
  if (b.location === undefined && a.location !== undefined) return -1;
  return a.i - b.i;
}

/**
 * The passages worth keeping, in book order. Kindle keeps every version of a
 * highlight the reader extended or re-made: the longest version stays, with
 * the notes of all of them.
 */
export function mergePassages(passages: BookPassage[]): BookPassage[] {
  const bySize = passages
    .map((p, i) => ({ ...p, text: passageText(p.text), i }))
    .filter((p) => p.text)
    .sort((a, b) => b.text.length - a.text.length || a.i - b.i);
  const kept: Indexed[] = [];
  for (const p of bySize) {
    const outer = kept.find((k) => sameHighlight(k, p));
    if (!outer) {
      kept.push(p);
      continue;
    }
    if (p.note && !outer.note?.includes(p.note)) {
      outer.note = outer.note ? `${outer.note}\n\n${p.note}` : p.note;
    }
    if (outer.location === undefined) outer.location = p.location;
    if (
      p.createdAt !== undefined &&
      (outer.createdAt === undefined || p.createdAt < outer.createdAt)
    )
      outer.createdAt = p.createdAt;
  }
  return kept.sort(byLocation).map(({ i: _i, ...p }) => p);
}

/** Characters a list of passages holds, with their notes. */
export const passageChars = (passages: BookPassage[]) =>
  passages.reduce((n, p) => n + p.text.length + (p.note?.length ?? 0), 0);

/** The passages that fit a book's caps, given how much it already holds; the rest are counted. */
export function fitPassages(
  passages: BookPassage[],
  held: { count: number; chars: number } = { count: 0, chars: 0 }
): { kept: BookPassage[]; dropped: number } {
  const kept: BookPassage[] = [];
  let { count, chars } = held;
  for (const p of passages) {
    const size = p.text.length + (p.note?.length ?? 0);
    if (count >= MAX_BOOK_PASSAGES || chars + size > MAX_BOOK_CHARS) continue;
    kept.push(p);
    count++;
    chars += size;
  }
  return { kept, dropped: passages.length - kept.length };
}

/**
 * The save's body: an empty marker holding the book's key, then one paragraph
 * per passage with nothing between them, so the text a highlight is located in
 * is the passages end to end (see passageContext).
 */
export function buildBookBody(passages: BookPassage[], key: string): string {
  const marker = `<div class="book-import" data-book-key="${escapeHtml(key)}" hidden></div>`;
  const body = passages.map(
    (p) =>
      `<p class="book-passage"${p.location !== undefined ? ` data-location="${p.location}"` : ''}>${escapeHtml(p.text)}</p>`
  );
  return marker + body.join('');
}

/**
 * The text either side of passage `i` in the body, for its selector's prefix
 * and suffix: a short highlight whose words also turn up inside a longer
 * passage then anchors to its own paragraph, not the first place they occur.
 */
export function passageContext(
  passages: BookPassage[],
  i: number
): { prefix?: string; suffix?: string } {
  const before = passages
    .slice(0, i)
    .map((p) => p.text)
    .join('')
    .slice(-CONTEXT_CHARS);
  const after = passages
    .slice(i + 1)
    .map((p) => p.text)
    .join('')
    .slice(0, CONTEXT_CHARS);
  return { ...(before ? { prefix: before } : {}), ...(after ? { suffix: after } : {}) };
}

/** The key a body built by buildBookBody remembers, from its first few hundred characters. */
export function bookKeyOfBody(head: string | null | undefined): string | null {
  const match = head?.match(/^<div class="book-import" data-book-key="([^"]*)"/);
  return match ? decodeEntities(match[1]) : null;
}

/** The passages a body built by buildBookBody holds, in its order. */
export function parseBookBody(html: string | null | undefined): BookPassage[] {
  if (!html) return [];
  const out: BookPassage[] = [];
  const paragraph = /<p class="book-passage"(?: data-location="([^"]*)")?>([\s\S]*?)<\/p>/g;
  for (const match of html.matchAll(paragraph)) {
    const text = decodeEntities(match[2]);
    const location = match[1] ? bookLocation(Number(match[1])) : undefined;
    if (text) out.push({ text, ...(location !== undefined ? { location } : {}) });
  }
  return out;
}

/**
 * What a re-import adds to a book already saved: the passages that aren't
 * versions of any already in its body, which is every passage it ever imported
 * (the reader's removed highlights included, so they stay removed). The new
 * ones slot into book order with the old, within the book's caps; `added` is
 * what to highlight and `dropped` how many didn't fit.
 */
export function addPassages(
  existing: BookPassage[],
  incoming: BookPassage[]
): { all: BookPassage[]; added: BookPassage[]; dropped: number } {
  const fresh = mergePassages(incoming).filter((p) => !existing.some((e) => sameHighlight(e, p)));
  const { kept: added, dropped } = fitPassages(fresh, {
    count: existing.length,
    chars: passageChars(existing),
  });
  if (added.length === 0) return { all: existing, added, dropped };
  const all = [...existing, ...added]
    .map((p, i) => ({ ...p, i }))
    .sort(byLocation)
    .map(({ i: _i, ...p }) => p);
  return { all, added, dropped };
}

export function wordCount(passages: BookPassage[]): number {
  return passages.reduce((n, p) => n + p.text.split(' ').filter(Boolean).length, 0);
}
