import { describe, expect, it } from 'vitest';
import { bookKey, kindleClippings, kindleDate, mergePassages } from './books';
import { parseExportFiles, type ImportFile } from './parsers';

const enc = new TextEncoder();
const file = (name: string, text: string): ImportFile => ({ name, bytes: enc.encode(text) });

// As a Kindle writes it: a BOM, CRLF line ends, one entry per clipping.
const clippings = [
  '﻿Sapiens: A Brief History of Humankind (Harari, Yuval Noah)',
  '- Your Highlight on page 12 | Location 170-172 | Added on Tuesday, March 3, 2020 10:15:42 PM',
  '',
  'The Cognitive Revolution',
  '==========',
  'Sapiens: A Brief History of Humankind (Harari, Yuval Noah)',
  '- Your Highlight on page 12 | Location 170-175 | Added on Tuesday, March 3, 2020 10:16:00 PM',
  '',
  'The Cognitive Revolution kicked off history.',
  '==========',
  'Sapiens: A Brief History of Humankind (Harari, Yuval Noah)',
  '- Your Note on page 12 | Location 175 | Added on Tuesday, March 3, 2020 10:17:00 PM',
  '',
  'Big claim.',
  '==========',
  'Sapiens: A Brief History of Humankind (Harari, Yuval Noah)',
  '- Your Highlight on Location 40-41 | Added on Monday, 2 March 2020 08:00:00',
  '',
  'Earlier in the book.',
  '==========',
  'Sapiens: A Brief History of Humankind (Harari, Yuval Noah)',
  '- Your Bookmark on Location 300 | Added on Tuesday, March 3, 2020 10:18:00 PM',
  '',
  '',
  '==========',
  'Sapiens: A Brief History of Humankind (Harari, Yuval Noah)',
  '- Your Note on Location 999 | Added on Tuesday, March 3, 2020 10:19:00 PM',
  '',
  'A note on nothing.',
  '==========',
  'The Odyssey (Penguin Classics) (Homer)',
  '- Highlight Loc. 1234-37 | Added on Friday, January 1, 2021 9:00:00 AM',
  '',
  'Sing to me of the man, Muse.',
  '==========',
  'Locked Book (Someone)',
  '- Your Highlight on Location 10-12 | Added on Friday, January 1, 2021 9:00:00 AM',
  '',
  '<You have reached the clipping limit for this item>',
  '==========',
  '',
].join('\r\n');

describe('Kindle My Clippings.txt', () => {
  it('reads each book with its highlights in book order, notes attached', () => {
    const { books, looseNotes } = kindleClippings(clippings);
    expect(books.map((b) => [b.source, b.kind, b.url, b.title, b.author, b.archived])).toEqual([
      ['kindle', 'book', '', 'Sapiens: A Brief History of Humankind', 'Yuval Noah Harari', true],
      ['kindle', 'book', '', 'The Odyssey (Penguin Classics)', 'Homer', true],
    ]);
    const [sapiens, odyssey] = books;
    // The shorter, earlier version of the extended highlight is the same one.
    expect(sapiens.highlights).toEqual([
      { text: 'Earlier in the book.', location: 40, createdAt: new Date(2020, 2, 2, 8).getTime() },
      {
        text: 'The Cognitive Revolution kicked off history.',
        note: 'Big claim.',
        location: 170,
        createdAt: new Date(2020, 2, 3, 22, 15, 42).getTime(),
      },
    ]);
    expect(sapiens.savedAt).toBe(new Date(2020, 2, 2, 8).getTime());
    expect(odyssey.highlights[0]).toMatchObject({
      text: 'Sing to me of the man, Muse.',
      location: 1234,
    });
    expect(looseNotes).toBe(1);
  });

  it('reads both date orders and the 12-hour clock', () => {
    expect(kindleDate('| Added on Tuesday, March 3, 2020 12:05:00 AM')).toBe(
      new Date(2020, 2, 3, 0, 5).getTime()
    );
    expect(kindleDate('| Added on Tuesday, 3 March 2020 12:05:00')).toBe(
      new Date(2020, 2, 3, 12, 5).getTime()
    );
    expect(kindleDate('| no date here')).toBeUndefined();
  });

  it('is recognised as an export, in a zip or on its own, with a warning for loose notes', async () => {
    const { saves, warnings } = await parseExportFiles([file('My Clippings.txt', clippings)]);
    expect(saves.map((s) => s.title)).toEqual([
      'Sapiens: A Brief History of Humankind',
      'The Odyssey (Penguin Classics)',
    ]);
    expect(warnings).toEqual(['1 Kindle note had no highlight to go with, so it was left out.']);
    // Some other text file isn't one.
    const other = await parseExportFiles([file('notes.txt', 'just some notes')]);
    expect(other.saves).toEqual([]);
    expect(other.warnings[0]).toMatch(/^Skipped a file/);
  });
});

describe('Readwise highlights CSV books', () => {
  const header =
    'Highlight,Book Title,Book Author,Amazon Book ID,Note,Color,Tags,Location Type,Location,Highlighted at,Document tags\n';

  it('makes books of the rows from books that match no article', async () => {
    const csv =
      header +
      'From the book,Sapiens,Yuval Noah Harari,B00ICN066A,Note here,yellow,,location,300,2021-01-01 10:00:00+00:00,"[\'history\']"\n' +
      'Earlier,Sapiens,Yuval Noah Harari,B00ICN066A,,yellow,,location,20,2021-01-02 10:00:00+00:00,\n' +
      'A page,Paper Book,Ann Author,,,,,page,4,,\n' +
      'An article bit,Some Article,,,,,,offset,10,,\n';
    const { saves, warnings } = await parseExportFiles([file('readwise-data.csv', csv)]);
    expect(saves.map((s) => [s.source, s.kind, s.title, s.author, s.tags])).toEqual([
      ['readwise-books', 'book', 'Sapiens', 'Yuval Noah Harari', ['history']],
      ['readwise-books', 'book', 'Paper Book', 'Ann Author', []],
    ]);
    expect(saves[0].highlights.map((h) => [h.text, h.location, h.note])).toEqual([
      ['Earlier', 20, undefined],
      ['From the book', 300, 'Note here'],
    ]);
    expect(warnings[0]).toMatch(/^1 highlight didn't match/);
  });

  it('merges a book that is in Kindle and Readwise both into one', async () => {
    const csv =
      header +
      'Only in Readwise,Sapiens,Yuval Noah Harari,B00ICN066A,,,,location,500,,\n' +
      'Earlier in the book.,Sapiens,Yuval Noah Harari,B00ICN066A,,,,location,40,,\n';
    const { saves } = await parseExportFiles([
      file('My Clippings.txt', clippings),
      file('readwise-data.csv', csv),
    ]);
    const sapiens = saves.filter((s) => s.title?.startsWith('Sapiens'));
    expect(sapiens).toHaveLength(1);
    expect(sapiens[0].source).toBe('kindle');
    expect(sapiens[0].highlights.map((h) => h.text)).toEqual([
      'Earlier in the book.',
      'The Cognitive Revolution kicked off history.',
      'Only in Readwise',
    ]);
  });
});

describe('bookKey', () => {
  it('matches a book across Kindle and Readwise spellings', () => {
    expect(bookKey('Sapiens: A Brief History of Humankind', 'Harari, Yuval Noah')).toBe(
      'sapiens|harari'
    );
    expect(bookKey('Sapiens', 'Yuval Noah Harari')).toBe('sapiens|harari');
    expect(bookKey('Café Society', 'Émile Zola; Someone')).toBe('cafe society|zola');
    expect(bookKey('Untitled', undefined)).toBe('untitled|');
  });
});

describe('mergePassages', () => {
  it('keeps the longest version of a passage, with a note from any version', () => {
    expect(
      mergePassages([
        { text: 'short', note: 'n' },
        { text: 'a short passage', location: 5 },
        { text: 'other', location: 1 },
      ])
    ).toEqual([
      { text: 'other', location: 1 },
      { text: 'a short passage', location: 5, note: 'n' },
    ]);
  });
});
