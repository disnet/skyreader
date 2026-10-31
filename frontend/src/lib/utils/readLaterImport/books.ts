/**
 * Books known only by their highlights: Kindle's "My Clippings.txt", and the
 * books in a Readwise highlights export. There's no URL, so a book is kept by
 * its title and author (bookKey, mirrored in backend services/book-highlights.ts),
 * and comes out as an ImportedSave of kind 'book' with its passages as highlights.
 *
 * Kept free of the DOM so it runs (and is tested) anywhere.
 */

import type { ImportedHighlight, ImportedSave, ImportSource } from './parsers';

/**
 * The key two imports of one book share: its title up to any subtitle, and its
 * author's surname, without case, accents or punctuation. Kindle writes
 * "Sapiens: A Brief History of Humankind (Harari, Yuval Noah)" where Readwise
 * writes "Sapiens" by "Yuval Noah Harari"; both come to "sapiens|harari".
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

/** Runs of whitespace as one space, as the passage will render. */
const passageText = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * One highlight per passage, in book order. Kindle keeps every version of a
 * highlight the reader extended or re-made, so a passage inside another is the
 * same highlight: the longer one stays, with the shorter's note if it has none.
 * The server does the same; this is so the counts shown before importing are right.
 */
export function mergePassages(passages: ImportedHighlight[]): ImportedHighlight[] {
  const bySize = passages
    .map((p, i) => ({ ...p, text: passageText(p.text), i }))
    .filter((p) => p.text)
    .sort((a, b) => b.text.length - a.text.length || a.i - b.i);
  const kept: (ImportedHighlight & { i: number })[] = [];
  for (const p of bySize) {
    const outer = kept.find((k) => k.text.includes(p.text));
    if (!outer) {
      kept.push(p);
      continue;
    }
    if (!outer.note && p.note) outer.note = p.note;
    outer.location ??= p.location;
    if (
      p.createdAt !== undefined &&
      (outer.createdAt === undefined || p.createdAt < outer.createdAt)
    )
      outer.createdAt = p.createdAt;
  }
  return kept
    .sort((a, b) => {
      if (a.location !== undefined && b.location !== undefined && a.location !== b.location)
        return a.location - b.location;
      if (a.location === undefined && b.location !== undefined) return 1;
      if (b.location === undefined && a.location !== undefined) return -1;
      return a.i - b.i;
    })
    .map(({ i: _i, ...p }) => p);
}

/** "Harari, Yuval Noah" as "Yuval Noah Harari"; anything else as it is. */
function authorName(raw: string | undefined): string | undefined {
  const author = raw?.trim();
  if (!author) return undefined;
  const parts = author.split(',').map((s) => s.trim());
  if (parts.length === 2 && parts[0] && parts[1] && !/[;&]/.test(author)) {
    return `${parts[1]} ${parts[0]}`;
  }
  return author;
}

/** A book, from its title, author and passages; when it was saved is its first highlight. */
export function bookSave(
  source: ImportSource,
  title: string,
  author: string | undefined,
  highlights: ImportedHighlight[],
  tags: string[] = []
): ImportedSave {
  const merged = mergePassages(highlights);
  const dates = merged.flatMap((h) => (h.createdAt !== undefined ? [h.createdAt] : []));
  return {
    source,
    kind: 'book',
    url: '',
    title,
    ...(author ? { author } : {}),
    ...(dates.length > 0 ? { savedAt: Math.min(...dates) } : {}),
    // Books with highlights are mostly ones already read: kept on the Shelf,
    // not waiting in the Inbox. The import dialog lets the reader choose.
    archived: true,
    tags,
    highlights: merged,
  };
}

// ─── Kindle: My Clippings.txt ────────────────────────────────────────────────

const SEPARATOR = /^==========\s*$/m;
// "- Your Highlight on page 12 | Location 170-172 | Added on Tuesday, March 3, 2020 10:15:42 PM"
// Older Kindles: "- Highlight Loc. 170-72 | Added on …". Only English is read.
const META = /^-\s*(?:Your\s+)?(Highlight|Note|Bookmark|Clip)\b(.*)$/i;
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** Whether this text is Kindle's clippings file. */
export function isKindleClippings(text: string): boolean {
  return SEPARATOR.test(text) && /^-\s*(?:Your\s+)?(Highlight|Note|Bookmark)\b/im.test(text);
}

/** A location range's numbers: "170-172", "170-72" (the end's last digits), or "170". */
function range(meta: string): { start: number; end: number } | undefined {
  const match =
    meta.match(/\b(?:location|loc\.?)\s*(\d+)(?:\s*-\s*(\d+))?/i) ??
    meta.match(/\bpage\s*(\d+)(?:\s*-\s*(\d+))?/i);
  if (!match) return undefined;
  const start = Number(match[1]);
  let end = match[2] ? Number(match[2]) : start;
  if (match[2] && match[2].length < match[1].length) {
    end = Number(match[1].slice(0, match[1].length - match[2].length) + match[2]);
  }
  return { start, end: Math.max(start, end) };
}

/** "Added on Tuesday, March 3, 2020 10:15:42 PM" or "Added on Tuesday, 3 March 2020 22:15:42", local time. */
export function kindleDate(meta: string): number | undefined {
  const added = meta.match(/Added on\s+(?:[A-Za-z]+,\s*)?(.+)$/i)?.[1]?.trim();
  if (!added) return undefined;
  const mdy = added.match(
    /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i
  );
  const dmy = added.match(
    /^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i
  );
  const parts = mdy
    ? { month: mdy[1], day: mdy[2], rest: mdy.slice(3) }
    : dmy
      ? { month: dmy[2], day: dmy[1], rest: dmy.slice(3) }
      : null;
  if (!parts) {
    const ms = Date.parse(added);
    return Number.isNaN(ms) ? undefined : ms;
  }
  const month = MONTHS.indexOf(parts.month.toLowerCase());
  if (month < 0) return undefined;
  const [year, h, m, s, ampm] = parts.rest;
  let hour = Number(h) % (ampm ? 12 : 24);
  if (ampm?.toUpperCase() === 'PM') hour += 12;
  const ms = new Date(
    Number(year),
    month,
    Number(parts.day),
    hour,
    Number(m),
    Number(s ?? 0)
  ).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** "Title (Author)": the last parenthesised part is the author. */
function titleAndAuthor(line: string): { title: string; author?: string } {
  const trimmed = line.replace(/^﻿/, '').trim();
  const match = trimmed.match(/^(.*\S)\s*\(([^()]*)\)$/);
  if (!match) return { title: trimmed };
  return { title: match[1].trim(), author: authorName(match[2]) };
}

export interface KindleLibrary {
  books: ImportedSave[];
  /** Notes Kindle kept with no highlight to attach them to. */
  looseNotes: number;
}

/**
 * Every book in a My Clippings.txt with its highlights, each note attached to
 * the highlight it was written on (the one whose range holds the note's
 * location). Bookmarks, and the passages Kindle cut off at the publisher's
 * clipping limit, are left out.
 */
export function kindleClippings(text: string): KindleLibrary {
  interface Clip {
    type: string;
    start?: number;
    end?: number;
    createdAt?: number;
    text: string;
  }
  const books = new Map<string, { title: string; author?: string; clips: Clip[] }>();
  for (const entry of text.split(SEPARATOR)) {
    const lines = entry.replace(/\r/g, '').split('\n');
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    if (lines.length < 2) continue;
    const meta = lines[1].trim().match(META);
    if (!meta) continue;
    const { title, author } = titleAndAuthor(lines[0]);
    if (!title) continue;
    const key = bookKey(title, author);
    let book = books.get(key);
    if (!book) books.set(key, (book = { title, author, clips: [] }));
    const body = lines.slice(2).join('\n').trim();
    const at = range(meta[2]);
    book.clips.push({
      type: meta[1].toLowerCase(),
      start: at?.start,
      end: at?.end,
      createdAt: kindleDate(meta[2]),
      text: body,
    });
  }

  let looseNotes = 0;
  const saves: ImportedSave[] = [];
  for (const book of books.values()) {
    const highlights: (ImportedHighlight & { start?: number; end?: number })[] = [];
    for (const clip of book.clips) {
      if (clip.type !== 'highlight' && clip.type !== 'clip') continue;
      if (!clip.text || /^<?You have reached the clipping limit/i.test(clip.text)) continue;
      highlights.push({
        text: clip.text,
        createdAt: clip.createdAt,
        location: clip.start,
        start: clip.start,
        end: clip.end,
      });
    }
    for (const note of book.clips) {
      if (note.type !== 'note' || !note.text) continue;
      const loc = note.start;
      // Kindle files a note at the end of its highlight; failing that, inside it.
      const target =
        loc === undefined
          ? undefined
          : (highlights.findLast((h) => h.end === loc) ??
            highlights.findLast(
              (h) => h.start !== undefined && h.end !== undefined && h.start <= loc && loc <= h.end
            ));
      if (!target) {
        looseNotes++;
        continue;
      }
      target.note = target.note ? `${target.note}\n\n${note.text}` : note.text;
    }
    if (highlights.length === 0) continue;
    saves.push(
      bookSave(
        'kindle',
        book.title,
        book.author,
        highlights.map(({ start: _s, end: _e, ...h }) => h)
      )
    );
  }
  return { books: saves, looseNotes };
}

export { authorName };
