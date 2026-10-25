import { describe, expect, it } from 'vitest';
import type { SavedItem } from '$lib/types';
import {
  collectionRow,
  continueReading,
  filterShelf,
  isInProgress,
  progressFraction,
  pushRecent,
  shelfKind,
  sortShelf,
  type ShelfEntry,
} from './shelf';

function save(overrides: Partial<SavedItem>): SavedItem {
  return {
    rkey: overrides.rkey ?? 'r',
    uri: '',
    url: '',
    title: null,
    author: null,
    description: null,
    content: null,
    contentType: null,
    domain: null,
    image: null,
    wordCount: null,
    publishedAt: null,
    savedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function entry(
  overrides: Partial<SavedItem>,
  extra: Partial<Omit<ShelfEntry, 'save'>> = {}
): ShelfEntry {
  return { save: save(overrides), lastActivityAt: 0, progress: null, ...extra };
}

const titles = (entries: ShelfEntry[]) => entries.map((e) => e.save.title);

describe('shelfKind', () => {
  it('maps content types to kinds', () => {
    expect(shelfKind({ contentType: 'epub' })).toBe('book');
    expect(shelfKind({ contentType: 'pdf' })).toBe('pdf');
    expect(shelfKind({ contentType: 'webpage' })).toBe('article');
    expect(shelfKind({ contentType: null })).toBe('article');
  });
});

describe('progressFraction', () => {
  it('ignores missing and sentinel progress', () => {
    expect(progressFraction(null)).toBeNull();
    expect(progressFraction({ paragraphIndex: -1, totalParagraphs: 0 })).toBeNull();
    expect(progressFraction({ paragraphIndex: 3, totalParagraphs: 0 })).toBeNull();
  });

  it('counts the current paragraph as read and caps at 1', () => {
    expect(progressFraction({ paragraphIndex: 0, totalParagraphs: 4 })).toBe(0.25);
    expect(progressFraction({ paragraphIndex: 9, totalParagraphs: 4 })).toBe(1);
  });
});

describe('isInProgress', () => {
  it('is started and not read through', () => {
    expect(isInProgress(0.4)).toBe(true);
    expect(isInProgress(0.96)).toBe(true);
  });

  it('excludes never-opened, the opened sentinel and finished', () => {
    expect(isInProgress(null)).toBe(false);
    expect(isInProgress(0)).toBe(false);
    expect(isInProgress(0.97)).toBe(false);
    expect(isInProgress(1)).toBe(false);
  });
});

describe('filterShelf', () => {
  const entries = [
    entry({
      title: 'The Art of Computer Programming',
      author: 'Donald Knuth',
      contentType: 'epub',
    }),
    entry({ title: 'Attention Is All You Need', domain: 'arxiv.org', contentType: 'pdf' }),
    entry({ title: 'A blog post', domain: 'example.com' }),
  ];

  it('filters by kind', () => {
    expect(titles(filterShelf(entries, 'pdf', ''))).toEqual(['Attention Is All You Need']);
    expect(filterShelf(entries, 'all', '')).toHaveLength(3);
  });

  it('needs every word to match somewhere', () => {
    expect(titles(filterShelf(entries, 'all', 'knuth art'))).toEqual([
      'The Art of Computer Programming',
    ]);
    expect(filterShelf(entries, 'all', 'knuth arxiv')).toHaveLength(0);
    expect(titles(filterShelf(entries, 'all', 'ARXIV'))).toEqual(['Attention Is All You Need']);
  });
});

describe('sortShelf', () => {
  it('sorts by title ignoring a leading article', () => {
    const sorted = sortShelf(
      [entry({ title: 'The Zebra' }), entry({ title: 'An Apple' }), entry({ title: 'Mango' })],
      'title'
    );
    expect(titles(sorted)).toEqual(['An Apple', 'Mango', 'The Zebra']);
  });

  it('sorts by surname, with no author last', () => {
    const sorted = sortShelf(
      [
        entry({ title: 'none' }),
        entry({ title: 'k', author: 'Donald Knuth' }),
        entry({ title: 'a', author: 'Abelson, Harold' }),
        entry({ title: 'd', author: 'Edsger Dijkstra' }),
      ],
      'author'
    );
    expect(titles(sorted)).toEqual(['a', 'd', 'k', 'none']);
  });

  it('puts recent activity first, then newest saves', () => {
    const sorted = sortShelf(
      [
        entry({ title: 'old save', savedAt: '2025-01-01T00:00:00Z' }),
        entry({ title: 'opened', savedAt: '2024-01-01T00:00:00Z' }, { lastActivityAt: 5 }),
        entry({ title: 'new save', savedAt: '2026-01-01T00:00:00Z' }),
      ],
      'activity'
    );
    expect(titles(sorted)).toEqual(['opened', 'new save', 'old save']);
  });

  it('puts the most recently connected first, then recent activity', () => {
    const sorted = sortShelf(
      [
        entry({ title: 'unconnected' }, { lastActivityAt: 9 }),
        entry({ title: 'older edge' }, { connectedAt: 100 }),
        entry({ title: 'newer edge' }, { connectedAt: 200 }),
        entry({ title: 'unconnected, never opened' }),
      ],
      'connected'
    );
    expect(titles(sorted)).toEqual([
      'newer edge',
      'older edge',
      'unconnected',
      'unconnected, never opened',
    ]);
  });

  it('keeps the given order for a collection', () => {
    const list = [entry({ title: 'b' }), entry({ title: 'a' })];
    expect(titles(sortShelf(list, 'collection'))).toEqual(['b', 'a']);
  });
});

describe('continueReading', () => {
  it('keeps started, unfinished items, most recent first', () => {
    const result = continueReading([
      entry({ title: 'unopened' }),
      entry({ title: 'finished' }, { progress: 1, lastActivityAt: 9 }),
      entry({ title: 'older' }, { progress: 0.3, lastActivityAt: 2 }),
      entry({ title: 'newer' }, { progress: 0.5, lastActivityAt: 4 }),
    ]);
    expect(titles(result)).toEqual(['newer', 'older']);
  });
});

describe('collectionRow', () => {
  const c = (id: string, pinned = false) => ({ id, pinned });
  const all = [c('a'), c('b'), c('c', true), c('d'), c('e'), c('f', true), c('g')];
  const ids = (row: { id: string }[]) => row.map((x) => x.id);

  it('leads with the pinned ones, then fills with the recent, shown in order', () => {
    expect(ids(collectionRow(all, ['g', 'e']))).toEqual(['c', 'f', 'a', 'e', 'g']);
  });

  it('fills from the reader order with nothing recent', () => {
    expect(ids(collectionRow(all, []))).toEqual(['c', 'f', 'a', 'b', 'd']);
  });

  it('skips recent ids that are gone or already pinned', () => {
    expect(ids(collectionRow(all, ['zz', 'c', 'g'], null, 4))).toEqual(['c', 'f', 'a', 'g']);
  });

  it('never cuts a pin to fit, and always shows the open collection', () => {
    const pins = [c('a', true), c('b', true), c('c', true), c('d')];
    expect(ids(collectionRow(pins, [], null, 2))).toEqual(['a', 'b', 'c']);
    expect(ids(collectionRow(pins, ['d'], 'd', 2))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps its order when a chip already on it is opened', () => {
    const before = ids(collectionRow(all, ['e', 'a']));
    expect(ids(collectionRow(all, ['a', 'e'], 'a'))).toEqual(before);
  });

  it('shows everything when there are fewer than the row holds', () => {
    expect(ids(collectionRow([c('a'), c('b')], ['b']))).toEqual(['a', 'b']);
  });
});

describe('pushRecent', () => {
  it('moves the id to the front without duplicates, capped', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
  });
});
