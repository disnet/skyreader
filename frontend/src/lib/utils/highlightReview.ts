import type { Highlight, ItemLabelType } from '$lib/types';
import { dailyScore, localDateKey } from '$lib/utils/dailyMagazine';

// The review deck: "revisit a handful of your highlights." Deliberately NOT a
// durable issue like the daily magazine — a session is a few minutes over a
// handful of cards, so the deck is derived at open and repeat-avoidance comes
// from the per-highlight `lastReviewedAt` stamp that syncs with the highlight
// itself. Same day + same pool => same deck, so opening the deck twice on one
// device doesn't reshuffle mid-session.

export const HIGHLIGHT_REVIEW_COUNT_OPTIONS = [3, 5, 10] as const;
export type HighlightReviewCount = (typeof HIGHLIGHT_REVIEW_COUNT_OPTIONS)[number];
export const HIGHLIGHT_REVIEW_COUNT_DEFAULT: HighlightReviewCount = 5;

/** Reviewing something you highlighted minutes ago is noise, not a review. */
export const HIGHLIGHT_REVIEW_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/** One entry of the flattened highlight corpus (matches `itemLabelsStore.allHighlights`). */
export interface HighlightEntry {
  itemKey: string;
  itemType: ItemLabelType;
  highlight: Highlight;
}

export type HighlightDeckStatus =
  | 'available' // there are cards to review right now
  | 'completed' // the pool is non-empty but everything eligible was reviewed today
  | 'empty'; // no highlights at all (or only ones too fresh to review)

export function startOfLocalDay(date: Date): number {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function reviewedToday(highlight: Highlight, dayStart: number): boolean {
  return typeof highlight.lastReviewedAt === 'number' && highlight.lastReviewedAt >= dayStart;
}

/**
 * Rank the eligible pool: least-recently-reviewed first, never-reviewed ahead of
 * everything, ties broken by a date-seeded hash so the ordering is stable for
 * the whole day but rotates tomorrow.
 */
function rankPool(pool: HighlightEntry[], dateKey: string): HighlightEntry[] {
  return [...pool].sort((a, b) => {
    const aReviewed = a.highlight.lastReviewedAt;
    const bReviewed = b.highlight.lastReviewedAt;
    const aNever = typeof aReviewed !== 'number';
    const bNever = typeof bReviewed !== 'number';
    if (aNever !== bNever) return aNever ? -1 : 1;
    if (!aNever && !bNever && aReviewed !== bReviewed) {
      return (aReviewed as number) - (bReviewed as number);
    }
    const byScore = dailyScore(dateKey, a.highlight.id) - dailyScore(dateKey, b.highlight.id);
    return byScore || a.highlight.id.localeCompare(b.highlight.id);
  });
}

export interface HighlightDeck {
  dateKey: string;
  status: HighlightDeckStatus;
  cards: HighlightEntry[];
  /** Size of the eligible pool the deck was drawn from (>= cards.length). */
  poolSize: number;
}

/**
 * Build today's deck from the whole highlight corpus.
 *
 * Eligibility: not already reviewed today, and not created in the last 24 h. The
 * freshness filter RELAXES when it would empty an otherwise non-empty pool — a
 * reader whose only highlights are from this morning still gets a deck rather
 * than a confusing "nothing to review."
 */
export function buildHighlightDeck(
  entries: HighlightEntry[],
  count: number,
  now: Date = new Date()
): HighlightDeck {
  const dateKey = localDateKey(now);
  const size = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  const dayStart = startOfLocalDay(now);
  const nowMs = now.getTime();

  const unreviewedToday = entries.filter((entry) => !reviewedToday(entry.highlight, dayStart));
  const seasoned = unreviewedToday.filter(
    (entry) => nowMs - entry.highlight.createdAt >= HIGHLIGHT_REVIEW_FRESHNESS_MS
  );
  const pool = seasoned.length > 0 ? seasoned : unreviewedToday;

  if (pool.length === 0) {
    return {
      dateKey,
      status: entries.length > 0 ? 'completed' : 'empty',
      cards: [],
      poolSize: 0,
    };
  }

  return {
    dateKey,
    status: 'available',
    cards: rankPool(pool, dateKey).slice(0, size),
    poolSize: pool.length,
  };
}

/**
 * Should the open-time Margin poll redeal the deck it raced?
 *
 * The deck deals from the local pool the moment the stores hydrate — a network
 * round-trip must never stand between the reader and their first card — so the
 * poll can land after the deal. When it imported something and the reader hasn't
 * touched a card yet, redealing is free and makes the poll count for this
 * session. Once a card has been reviewed or dropped, the fixed deck wins:
 * reshuffling mid-session pulls the ground out from under the reader.
 */
export function shouldRedealAfterImport(
  result: { imported: number } | null,
  progress: { index: number; reviewed: number; interacted: boolean }
): boolean {
  if (!result || result.imported <= 0) return false;
  return !progress.interacted && progress.index === 0 && progress.reviewed === 0;
}

/** Cheap status probe for entry points that only need "is there a deck?". */
export function highlightDeckStatus(
  entries: HighlightEntry[],
  now: Date = new Date()
): HighlightDeckStatus {
  return buildHighlightDeck(entries, 1, now).status;
}
