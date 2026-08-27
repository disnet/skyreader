import { describe, expect, it } from 'vitest';
import type { Highlight } from '$lib/types';
import type { MarginImportOutcome } from './marginHighlightImport';
import {
  buildHighlightDeck,
  deckUntouched,
  describeHighlightSources,
  highlightDeckStatus,
  isReviewable,
  reviewPriority,
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

describe('review intent', () => {
  const NEVER = { reviewIntent: 'never' as const };

  it('never deals a highlight set to never', () => {
    const pool = [entry('kept'), entry('hidden', NEVER)];
    expect(ids(buildHighlightDeck(pool, 5, NOW).cards)).toEqual(['kept']);
  });

  it('keeps them out of an encore hand too', () => {
    const pool = [entry('hidden', { ...NEVER, lastReviewedAt: startOfLocalDay(NOW) + 60_000 })];
    const deck = buildHighlightDeck(pool, 5, NOW, { includeReviewedToday: true });
    expect(deck.cards).toHaveLength(0);
  });

  it('does not let a hidden highlight relax the freshness filter', () => {
    // The only seasoned highlight is hidden: the fresh one should still deal
    // (freshness relaxes) rather than the hidden one sneaking back in.
    const pool = [entry('hidden', NEVER), entry('fresh', { createdAt: NOW.getTime() - 60_000 })];
    expect(ids(buildHighlightDeck(pool, 5, NOW).cards)).toEqual(['fresh']);
  });

  it('reads an all-hidden corpus as empty, not as a finished session', () => {
    const pool = [entry('a', NEVER), entry('b', NEVER)];
    expect(buildHighlightDeck(pool, 5, NOW).status).toBe('empty');
    expect(summarizeHighlightDeck(pool, 5, NOW).status).toBe('empty');
    expect(highlightDeckStatus(pool, NOW)).toBe('empty');
  });

  it('still reads as completed when something in rotation was seen today', () => {
    const pool = [
      entry('hidden', NEVER),
      entry('seen', { lastReviewedAt: startOfLocalDay(NOW) + 60_000 }),
    ];
    expect(summarizeHighlightDeck(pool, 5, NOW).status).toBe('completed');
  });

  it('flags reviewability off the never setting alone', () => {
    expect(isReviewable(entry('a').highlight)).toBe(true);
    expect(isReviewable(entry('b', { reviewIntent: 'soon' }).highlight)).toBe(true);
    expect(isReviewable(entry('c', { reviewIntent: 'someday' }).highlight)).toBe(true);
    expect(isReviewable(entry('d', NEVER).highlight)).toBe(false);
  });

  it('treats an unset intent and an explicit later identically', () => {
    const at = NOW.getTime() - 5 * DAY;
    expect(reviewPriority(entry('a', { lastReviewedAt: at }).highlight)).toBe(
      reviewPriority(entry('b', { lastReviewedAt: at, reviewIntent: 'later' }).highlight)
    );
  });

  it('pulls soon ahead of the queue and sinks someday to the back', () => {
    const at = NOW.getTime() - 5 * DAY;
    const pool = [
      entry('someday', { lastReviewedAt: at, reviewIntent: 'someday' }),
      entry('default', { lastReviewedAt: at }),
      entry('soon', { lastReviewedAt: at, reviewIntent: 'soon' }),
    ];
    expect(ids(buildHighlightDeck(pool, 5, NOW).cards)).toEqual(['soon', 'default', 'someday']);
  });

  it('orders never-reviewed highlights by intent too', () => {
    const pool = [
      entry('someday', { reviewIntent: 'someday' }),
      entry('soon', { reviewIntent: 'soon' }),
      entry('default'),
    ];
    expect(ids(buildHighlightDeck(pool, 5, NOW).cards)).toEqual(['soon', 'default', 'someday']);
  });

  it('never lets intent lift a reviewed highlight above a never-reviewed one', () => {
    // Even the strongest pull forward loses to having never been seen, and even
    // the strongest push back keeps its place ahead of anything already seen.
    const pool = [
      entry('seen-soon', { lastReviewedAt: NOW.getTime() - 3650 * DAY, reviewIntent: 'soon' }),
      entry('unseen-someday', { reviewIntent: 'someday' }),
    ];
    expect(ids(buildHighlightDeck(pool, 5, NOW).cards)).toEqual(['unseen-someday', 'seen-soon']);
  });

  it('deals the same number of cards however the pool is tuned', () => {
    const tuned = ['a', 'b', 'c', 'd', 'e'].map((id) => entry(id, { reviewIntent: 'someday' }));
    const untuned = ['a', 'b', 'c', 'd', 'e'].map((id) => entry(id));
    expect(buildHighlightDeck(tuned, 3, NOW).cards).toHaveLength(
      buildHighlightDeck(untuned, 3, NOW).cards.length
    );
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
  const brought = (imported: number): MarginImportOutcome => ({
    status: 'imported',
    imported,
    truncated: false,
  });

  it('redeals when the open-time poll imported into an untouched deck', () => {
    expect(shouldRedealAfterImport(brought(2), { index: 0, interacted: false })).toBe(true);
  });

  it("doesn't redeal when the poll didn't run or brought nothing new", () => {
    expect(
      shouldRedealAfterImport(
        { status: 'skipped', reason: 'throttled' },
        { index: 0, interacted: false }
      )
    ).toBe(false);
    expect(shouldRedealAfterImport({ status: 'failed' }, { index: 0, interacted: false })).toBe(
      false
    );
    expect(
      shouldRedealAfterImport({ status: 'scope-expired' }, { index: 0, interacted: false })
    ).toBe(false);
    expect(shouldRedealAfterImport(brought(0), { index: 0, interacted: false })).toBe(false);
  });

  it('leaves a hand in progress alone — the dealt deck is fixed', () => {
    expect(shouldRedealAfterImport(brought(2), { index: 1, interacted: false })).toBe(false);
  });

  it('does not redeal after a removal while the import is still in flight', () => {
    expect(shouldRedealAfterImport(brought(2), { index: 0, interacted: true })).toBe(false);
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
