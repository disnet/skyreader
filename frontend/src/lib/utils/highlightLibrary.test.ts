import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  filterHighlights,
  highlightFacets,
  pinnedHighlights,
  sortHighlights,
  type HighlightLibraryRow,
  type HighlightSourceInfo,
} from './highlightLibrary';

function source(itemKey: string, title = itemKey): HighlightSourceInfo {
  return {
    itemKey,
    itemType: 'article',
    title,
    url: null,
    domain: `${itemKey}.com`,
    displayItem: null,
  };
}

function row(
  id: string,
  createdAt: number,
  src: HighlightSourceInfo,
  extra: Partial<HighlightLibraryRow> = {}
): HighlightLibraryRow {
  return {
    id,
    text: `passage ${id}`,
    createdAt,
    tags: [],
    isMargin: false,
    intent: 'later',
    highlight: { id, selector: { type: 'TextQuoteSelector', exact: `passage ${id}` }, createdAt },
    source: src,
    ...extra,
  };
}

const a = source('a', 'Slow Reading');
const b = source('b', 'Digital Gardens');

const rows = [
  row('1', 10, a, { tags: ['Attention'], pinnedAt: 100, note: 'thesis' }),
  row('2', 20, a, { isMargin: true }),
  row('3', 30, b, { tags: ['attention', 'essay'], intent: 'never' }),
  row('4', 5, b, { pinnedAt: 200 }),
];

const ids = (list: HighlightLibraryRow[]) => list.map((r) => r.id);

describe('filterHighlights', () => {
  it('narrows by view', () => {
    expect(ids(filterHighlights(rows, { ...EMPTY_FILTER, view: 'pinned' }))).toEqual(['1', '4']);
    expect(ids(filterHighlights(rows, { ...EMPTY_FILTER, view: 'notes' }))).toEqual(['1']);
    expect(ids(filterHighlights(rows, { ...EMPTY_FILTER, view: 'published' }))).toEqual(['2']);
    expect(ids(filterHighlights(rows, { ...EMPTY_FILTER, view: 'not-in-review' }))).toEqual(['3']);
  });

  it('matches tags case-insensitively and combines with source', () => {
    expect(ids(filterHighlights(rows, { ...EMPTY_FILTER, tag: 'ATTENTION' }))).toEqual(['1', '3']);
    expect(
      ids(filterHighlights(rows, { ...EMPTY_FILTER, tag: 'attention', sourceKey: 'b' }))
    ).toEqual(['3']);
  });

  it('searches passage, note, source title and tags, requiring every term', () => {
    expect(ids(filterHighlights(rows, { ...EMPTY_FILTER, query: 'thesis' }))).toEqual(['1']);
    expect(ids(filterHighlights(rows, { ...EMPTY_FILTER, query: 'gardens' }))).toEqual(['3', '4']);
    expect(ids(filterHighlights(rows, { ...EMPTY_FILTER, query: 'essay passage' }))).toEqual(['3']);
    expect(ids(filterHighlights(rows, { ...EMPTY_FILTER, query: '   ' }))).toEqual(ids(rows));
  });
});

describe('sortHighlights', () => {
  it('sorts by time either way', () => {
    expect(ids(sortHighlights(rows, 'newest'))).toEqual(['3', '2', '1', '4']);
    expect(ids(sortHighlights(rows, 'oldest'))).toEqual(['4', '1', '2', '3']);
  });

  it('groups by source, newest source first, oldest highlight first inside it', () => {
    expect(ids(sortHighlights(rows, 'source'))).toEqual(['4', '3', '1', '2']);
  });
});

describe('pinnedHighlights', () => {
  it('lists pins most recently pinned first', () => {
    expect(ids(pinnedHighlights(rows))).toEqual(['4', '1']);
  });
});

describe('highlightFacets', () => {
  it('counts views, merges tag spellings and ranks sources', () => {
    const facets = highlightFacets(rows);
    expect(facets.views).toEqual({
      all: 4,
      pinned: 2,
      notes: 1,
      published: 1,
      'not-in-review': 1,
    });
    expect(facets.tags).toEqual([
      { tag: 'Attention', count: 2 },
      { tag: 'essay', count: 1 },
    ]);
    expect(facets.sources.map((s) => [s.source.itemKey, s.count])).toEqual([
      ['b', 2],
      ['a', 2],
    ]);
  });
});
