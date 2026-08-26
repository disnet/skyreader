import { describe, expect, it } from 'vitest';
import type { Highlight } from '$lib/types';
import {
  buildHighlightDeck,
  deckUntouched,
  describeHighlightSources,
  highlightDeckStatus,
  isReviewable,
  shouldRedealAfterImport,
  startOfLocalDay,
  summarizeHighlightDeck,
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

describe('retired highlights', () => {
  const RETIRED = { reviewRetiredAt: NOW.getTime() - DAY };

  it('never deals a retired highlight', () => {
    const pool = [entry('kept'), entry('retired', RETIRED)];
    expect(ids(buildHighlightDeck(pool, 5, NOW).cards)).toEqual(['kept']);
  });

  it('keeps them out of an encore hand too', () => {
    const pool = [entry('retired', { ...RETIRED, lastReviewedAt: startOfLocalDay(NOW) + 60_000 })];
    const deck = buildHighlightDeck(pool, 5, NOW, { includeReviewedToday: true });
    expect(deck.cards).toHaveLength(0);
  });

  it('does not let a retired highlight relax the freshness filter', () => {
    // The only seasoned highlight is retired: the fresh one should still deal
    // (freshness relaxes) rather than the retired one sneaking back in.
    const pool = [entry('retired', RETIRED), entry('fresh', { createdAt: NOW.getTime() - 60_000 })];
    expect(ids(buildHighlightDeck(pool, 5, NOW).cards)).toEqual(['fresh']);
  });

  it('reads an all-retired corpus as empty, not as a finished session', () => {
    const pool = [entry('a', RETIRED), entry('b', RETIRED)];
    expect(buildHighlightDeck(pool, 5, NOW).status).toBe('empty');
    expect(summarizeHighlightDeck(pool, 5, NOW).status).toBe('empty');
    expect(highlightDeckStatus(pool, NOW)).toBe('empty');
  });

  it('still reads as completed when something in rotation was seen today', () => {
    const pool = [
      entry('retired', RETIRED),
      entry('seen', { lastReviewedAt: startOfLocalDay(NOW) + 60_000 }),
    ];
    expect(summarizeHighlightDeck(pool, 5, NOW).status).toBe('completed');
  });

  it('flags reviewability off the retired stamp alone', () => {
    expect(isReviewable(entry('a').highlight)).toBe(true);
    expect(isReviewable(entry('b', RETIRED).highlight)).toBe(false);
  });
});

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
    expect(shouldRedealAfterImport({ imported: 2 }, { index: 0, interacted: false })).toBe(true);
  });

  it("doesn't redeal when the poll didn't run or brought nothing new", () => {
    expect(shouldRedealAfterImport(null, { index: 0, interacted: false })).toBe(false);
    expect(shouldRedealAfterImport({ imported: 0 }, { index: 0, interacted: false })).toBe(false);
  });

  it('leaves a hand in progress alone — the dealt deck is fixed', () => {
    expect(shouldRedealAfterImport({ imported: 2 }, { index: 1, interacted: false })).toBe(false);
  });

  it('does not redeal after a removal while the import is still in flight', () => {
    expect(shouldRedealAfterImport({ imported: 2 }, { index: 0, interacted: true })).toBe(false);
  });
});

describe('summarizeHighlightDeck', () => {
  it('counts what the deck would deal, capped by deck size', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => entry(id));
    expect(summarizeHighlightDeck(pool, 5, NOW)).toEqual({
      status: 'available',
      dueCount: 5,
      poolSize: 7,
    });
    expect(summarizeHighlightDeck(pool.slice(0, 2), 5, NOW).dueCount).toBe(2);
  });

  it('agrees with the deck it summarizes', () => {
    const pool = ['a', 'b', 'c'].map((id) => entry(id));
    for (const size of [1, 3, 10]) {
      const summary = summarizeHighlightDeck(pool, size, NOW);
      const deck = buildHighlightDeck(pool, size, NOW);
      expect(summary.dueCount).toBe(deck.cards.length);
      expect(summary.status).toBe(deck.status);
      expect(summary.poolSize).toBe(deck.poolSize);
    }
  });

  it('goes quiet once everything eligible was reviewed today', () => {
    const reviewed = entry('a', { lastReviewedAt: startOfLocalDay(NOW) + 60_000 });
    expect(summarizeHighlightDeck([reviewed], 5, NOW)).toEqual({
      status: 'completed',
      dueCount: 0,
      poolSize: 0,
    });
    expect(summarizeHighlightDeck([], 5, NOW).status).toBe('empty');
  });
});

describe('deckUntouched', () => {
  it('is true only before the reader has done anything with the hand', () => {
    expect(deckUntouched({ index: 0, interacted: false })).toBe(true);
    expect(deckUntouched({ index: 1, interacted: false })).toBe(false);
    // Opening the article or the note editor counts, even with no card advanced.
    expect(deckUntouched({ index: 0, interacted: true })).toBe(false);
  });
});

describe('describeHighlightSources', () => {
  it("names the articles, and only counts what it can't fit", () => {
    expect(describeHighlightSources([])).toBe('');
    expect(describeHighlightSources(['One Essay'])).toBe('One Essay');
    expect(describeHighlightSources(['One Essay', 'Two Essay'])).toBe('One Essay and Two Essay');
    // Exactly one over the cap is named rather than counted: "and 1 more" costs
    // the same room as the title it hides.
    expect(describeHighlightSources(['A', 'B', 'C'])).toBe('A, B and C');
    expect(describeHighlightSources(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
    expect(describeHighlightSources(['A', 'B', 'C', 'D'], 3)).toBe('A, B, C and D');
  });
});

describe("reviewing more than the day's portion", () => {
  it('deals nothing once everything eligible was reviewed today', () => {
    const pool = ['a', 'b'].map((id) =>
      entry(id, { lastReviewedAt: startOfLocalDay(NOW) + 60_000 })
    );
    expect(buildHighlightDeck(pool, 5, NOW).cards).toHaveLength(0);
    expect(summarizeHighlightDeck(pool, 5, NOW).status).toBe('completed');
  });

  it('lifts the daily filter when the reader asks to keep going', () => {
    const pool = ['a', 'b'].map((id) =>
      entry(id, { lastReviewedAt: startOfLocalDay(NOW) + 60_000 })
    );
    const encore = buildHighlightDeck(pool, 5, NOW, { includeReviewedToday: true });
    expect(ids(encore.cards).sort()).toEqual(['a', 'b']);
    expect(summarizeHighlightDeck(pool, 5, NOW, { includeReviewedToday: true }).dueCount).toBe(2);
  });

  it('brings back what was seen earliest, not what was seen last', () => {
    const dayStart = startOfLocalDay(NOW);
    const pool = [
      entry('late', { lastReviewedAt: dayStart + 5 * 60 * 60 * 1000 }),
      entry('early', { lastReviewedAt: dayStart + 60_000 }),
    ];
    const encore = buildHighlightDeck(pool, 1, NOW, { includeReviewedToday: true });
    expect(ids(encore.cards)).toEqual(['early']);
  });

  it('still prefers what is genuinely due over a repeat', () => {
    const pool = [
      entry('fresh-eyes'),
      entry('seen', { lastReviewedAt: startOfLocalDay(NOW) + 60_000 }),
    ];
    // Never-reviewed sorts ahead of everything, encore or not.
    expect(ids(buildHighlightDeck(pool, 1, NOW, { includeReviewedToday: true }).cards)).toEqual([
      'fresh-eyes',
    ]);
  });
});
