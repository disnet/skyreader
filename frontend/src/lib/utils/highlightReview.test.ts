import { describe, expect, it } from 'vitest';
import type { Highlight } from '$lib/types';
import {
  buildHighlightDeck,
  highlightDeckStatus,
  shouldRedealAfterImport,
  startOfLocalDay,
  type HighlightEntry,
} from './highlightReview';

const NOW = new Date('2026-08-25T10:00:00');
const DAY = 24 * 60 * 60 * 1000;
// Old enough to clear the 24 h freshness filter.
const SEASONED = NOW.getTime() - 30 * DAY;

function entry(id: string, extra: Partial<Highlight> = {}): HighlightEntry {
  return {
    itemKey: `item-${id}`,
    itemType: 'article',
    highlight: {
      id,
      selector: { type: 'TextQuoteSelector', exact: `quote ${id}` },
      createdAt: SEASONED,
      ...extra,
    },
  };
}

function ids(entries: HighlightEntry[]): string[] {
  return entries.map((e) => e.highlight.id);
}

describe('buildHighlightDeck', () => {
  it('is deterministic for a given day and pool', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => entry(id));
    const first = buildHighlightDeck(pool, 3, NOW);
    const second = buildHighlightDeck([...pool].reverse(), 3, NOW);
    expect(ids(first.cards)).toEqual(ids(second.cards));
    expect(first.cards).toHaveLength(3);
  });

  it('rotates the tie-break ordering on a different day', () => {
    const pool = Array.from({ length: 30 }, (_, i) => entry(`h${i}`));
    const today = ids(buildHighlightDeck(pool, 5, NOW).cards);
    const later = ids(buildHighlightDeck(pool, 5, new Date('2026-09-14T10:00:00')).cards);
    expect(later).not.toEqual(today);
  });

  it('orders least-recently-reviewed first, never-reviewed ahead of all', () => {
    const pool = [
      entry('recent', { lastReviewedAt: NOW.getTime() - 2 * DAY }),
      entry('ancient', { lastReviewedAt: NOW.getTime() - 90 * DAY }),
      entry('never'),
    ];
    expect(ids(buildHighlightDeck(pool, 3, NOW).cards)).toEqual(['never', 'ancient', 'recent']);
  });

  it('excludes highlights already reviewed today', () => {
    const pool = [
      entry('done', { lastReviewedAt: startOfLocalDay(NOW) + 60_000 }),
      entry('due', { lastReviewedAt: NOW.getTime() - 5 * DAY }),
    ];
    const deck = buildHighlightDeck(pool, 5, NOW);
    expect(ids(deck.cards)).toEqual(['due']);
    expect(deck.poolSize).toBe(1);
  });

  it('reports "completed" once every highlight was reviewed today', () => {
    const pool = [entry('done', { lastReviewedAt: startOfLocalDay(NOW) + 60_000 })];
    const deck = buildHighlightDeck(pool, 5, NOW);
    expect(deck.status).toBe('completed');
    expect(deck.cards).toEqual([]);
  });

  it('reports "empty" with no highlights at all', () => {
    expect(buildHighlightDeck([], 5, NOW).status).toBe('empty');
  });

  it('skips highlights created in the last 24 h when older ones exist', () => {
    const pool = [entry('fresh', { createdAt: NOW.getTime() - 60_000 }), entry('old')];
    expect(ids(buildHighlightDeck(pool, 5, NOW).cards)).toEqual(['old']);
  });

  it('relaxes the freshness filter rather than showing an empty deck', () => {
    const pool = [entry('fresh', { createdAt: NOW.getTime() - 60_000 })];
    const deck = buildHighlightDeck(pool, 5, NOW);
    expect(deck.status).toBe('available');
    expect(ids(deck.cards)).toEqual(['fresh']);
  });

  it('caps the deck at the requested count', () => {
    const pool = Array.from({ length: 12 }, (_, i) => entry(`h${i}`));
    expect(buildHighlightDeck(pool, 3, NOW).cards).toHaveLength(3);
    expect(buildHighlightDeck(pool, 10, NOW).cards).toHaveLength(10);
    expect(buildHighlightDeck(pool, 10, NOW).poolSize).toBe(12);
  });
});

describe('highlightDeckStatus', () => {
  it('matches the deck it summarizes', () => {
    expect(highlightDeckStatus([], NOW)).toBe('empty');
    expect(highlightDeckStatus([entry('a')], NOW)).toBe('available');
    expect(
      highlightDeckStatus([entry('a', { lastReviewedAt: startOfLocalDay(NOW) + 1 })], NOW)
    ).toBe('completed');
  });
});

describe('shouldRedealAfterImport', () => {
  it('redeals when the open-time poll imported into an untouched deck', () => {
    expect(shouldRedealAfterImport({ imported: 2 }, { index: 0, reviewed: 0 })).toBe(true);
  });

  it("doesn't redeal when the poll didn't run or brought nothing new", () => {
    expect(shouldRedealAfterImport(null, { index: 0, reviewed: 0 })).toBe(false);
    expect(shouldRedealAfterImport({ imported: 0 }, { index: 0, reviewed: 0 })).toBe(false);
  });

  it('leaves a session in progress alone — the dealt deck is fixed', () => {
    expect(shouldRedealAfterImport({ imported: 2 }, { index: 1, reviewed: 1 })).toBe(false);
    expect(shouldRedealAfterImport({ imported: 2 }, { index: 0, reviewed: 3 })).toBe(false);
  });
});
