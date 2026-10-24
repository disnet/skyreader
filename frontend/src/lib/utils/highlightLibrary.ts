import type { Highlight, ItemLabelType, ReviewIntent } from '$lib/types';
import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';

// The highlights page is a library to manage, not a feed to scroll: every
// highlight is one row, and the reader narrows the set with a view, a tag, a
// source and a search. This is the pure part of that — rows in, rows out — so
// the page only wires it to the stores.

export interface HighlightSourceInfo {
  itemKey: string;
  itemType: ItemLabelType;
  title: string;
  url: string | null;
  domain: string | null;
  // The item to open in the in-app reader; null when the source isn't in the
  // local cache (e.g. an old article that's aged out) — then we fall back to
  // opening the external URL.
  displayItem: FeedDisplayItem | null;
}

export interface HighlightLibraryRow {
  id: string;
  text: string;
  note?: string;
  createdAt: number;
  pinnedAt?: number;
  tags: string[];
  isMargin: boolean;
  intent: ReviewIntent;
  highlight: Highlight;
  source: HighlightSourceInfo;
}

/** The fixed views down the side, each a question the reader asks of the set. */
export type HighlightView = 'all' | 'pinned' | 'notes' | 'published' | 'not-in-review';

export type HighlightSort = 'newest' | 'oldest' | 'source';

export interface HighlightFilter {
  view: HighlightView;
  tag: string | null;
  sourceKey: string | null;
  query: string;
}

export const EMPTY_FILTER: HighlightFilter = { view: 'all', tag: null, sourceKey: null, query: '' };

function matchesView(row: HighlightLibraryRow, view: HighlightView): boolean {
  switch (view) {
    case 'pinned':
      return row.pinnedAt !== undefined;
    case 'notes':
      return Boolean(row.note);
    case 'published':
      return row.isMargin;
    case 'not-in-review':
      return row.intent === 'never';
    default:
      return true;
  }
}

function sameTag(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Every whitespace-separated term must appear in the passage, note, source or a tag. */
function matchesQuery(row: HighlightLibraryRow, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [
    row.text,
    row.note ?? '',
    row.source.title,
    row.source.domain ?? '',
    ...row.tags,
  ]
    .join('\n')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function filterHighlights(
  rows: HighlightLibraryRow[],
  filter: HighlightFilter
): HighlightLibraryRow[] {
  const terms = queryTerms(filter.query);
  return rows.filter(
    (row) =>
      matchesView(row, filter.view) &&
      (filter.tag === null || row.tags.some((tag) => sameTag(tag, filter.tag!))) &&
      (filter.sourceKey === null || row.source.itemKey === filter.sourceKey) &&
      matchesQuery(row, terms)
  );
}

export function sortHighlights(
  rows: HighlightLibraryRow[],
  sort: HighlightSort
): HighlightLibraryRow[] {
  const out = [...rows];
  if (sort === 'oldest') {
    out.sort((a, b) => a.createdAt - b.createdAt);
  } else if (sort === 'source') {
    // Sources by their newest highlight, then the highlights inside a source in
    // reading order of when they were made.
    const latest = new Map<string, number>();
    for (const row of out) {
      latest.set(row.source.itemKey, Math.max(latest.get(row.source.itemKey) ?? 0, row.createdAt));
    }
    out.sort(
      (a, b) =>
        latest.get(b.source.itemKey)! - latest.get(a.source.itemKey)! ||
        a.source.itemKey.localeCompare(b.source.itemKey) ||
        a.createdAt - b.createdAt
    );
  } else {
    out.sort((a, b) => b.createdAt - a.createdAt);
  }
  return out;
}

/** Pinned rows, most recently pinned first. */
export function pinnedHighlights(rows: HighlightLibraryRow[]): HighlightLibraryRow[] {
  return rows.filter((row) => row.pinnedAt !== undefined).sort((a, b) => b.pinnedAt! - a.pinnedAt!);
}

export interface HighlightFacets {
  views: Record<HighlightView, number>;
  // Most-used first, then alphabetical. One entry per tag, case-insensitively,
  // spelled the way it was first seen.
  tags: { tag: string; count: number }[];
  // Most highlights first.
  sources: { source: HighlightSourceInfo; count: number }[];
}

export function highlightFacets(rows: HighlightLibraryRow[]): HighlightFacets {
  const views: Record<HighlightView, number> = {
    all: rows.length,
    pinned: 0,
    notes: 0,
    published: 0,
    'not-in-review': 0,
  };
  const tags = new Map<string, { tag: string; count: number }>();
  const sources = new Map<string, { source: HighlightSourceInfo; count: number }>();

  for (const row of rows) {
    if (matchesView(row, 'pinned')) views.pinned++;
    if (matchesView(row, 'notes')) views.notes++;
    if (matchesView(row, 'published')) views.published++;
    if (matchesView(row, 'not-in-review')) views['not-in-review']++;

    for (const tag of row.tags) {
      const key = tag.toLowerCase();
      const entry = tags.get(key);
      if (entry) entry.count++;
      else tags.set(key, { tag, count: 1 });
    }

    const source = sources.get(row.source.itemKey);
    if (source) source.count++;
    else sources.set(row.source.itemKey, { source: row.source, count: 1 });
  }

  return {
    views,
    tags: [...tags.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    sources: [...sources.values()].sort(
      (a, b) => b.count - a.count || a.source.title.localeCompare(b.source.title)
    ),
  };
}
