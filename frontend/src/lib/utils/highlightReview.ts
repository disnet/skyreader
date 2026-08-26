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

function deckSize(count: number): number {
  return Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
}

export interface DeckOptions {
  /**
   * Deal past the day's portion, from highlights already reviewed today.
   *
   * This is only ever the reader asking to keep going after the deck ran out
   * ("Review more"), never something the app does on its own — the daily filter
   * is what stops the deck nagging. Ranking is unchanged, so an encore brings
   * back what was seen earliest, not what was seen last.
   */
  includeReviewedToday?: boolean;
}

/**
 * The pool today's deck deals from: not already reviewed today, and not created
 * in the last 24 h. The freshness filter RELAXES when it would empty an
 * otherwise non-empty pool — a reader whose only highlights are from this
 * morning still gets a deck rather than a confusing "nothing to review."
 */
function eligiblePool(
  entries: HighlightEntry[],
  now: Date,
  options: DeckOptions = {}
): HighlightEntry[] {
  const dayStart = startOfLocalDay(now);
  const nowMs = now.getTime();

  const due = options.includeReviewedToday
    ? entries
    : entries.filter((entry) => !reviewedToday(entry.highlight, dayStart));
  const seasoned = due.filter(
    (entry) => nowMs - entry.highlight.createdAt >= HIGHLIGHT_REVIEW_FRESHNESS_MS
  );
  return seasoned.length > 0 ? seasoned : due;
}

export interface HighlightDeckSummary {
  status: HighlightDeckStatus;
  /** Cards today's deck would deal right now — what the nav badge counts. */
  dueCount: number;
  /** Size of the eligible pool (>= dueCount). */
  poolSize: number;
}

/**
 * What today's deck holds, without paying to rank it. Entry points that only
 * show a count or a presence use this; only the deck itself needs the order.
 */
export function summarizeHighlightDeck(
  entries: HighlightEntry[],
  count: number,
  now: Date = new Date(),
  options: DeckOptions = {}
): HighlightDeckSummary {
  const pool = eligiblePool(entries, now, options);
  if (pool.length === 0) {
    return { status: entries.length > 0 ? 'completed' : 'empty', dueCount: 0, poolSize: 0 };
  }
  return {
    status: 'available',
    dueCount: Math.min(pool.length, deckSize(count)),
    poolSize: pool.length,
  };
}

/**
 * Build today's deck from the whole highlight corpus. Eligibility is
 * `eligiblePool`; order is least-recently-reviewed first.
 */
export function buildHighlightDeck(
  entries: HighlightEntry[],
  count: number,
  now: Date = new Date(),
  options: DeckOptions = {}
): HighlightDeck {
  const dateKey = localDateKey(now);
  const pool = eligiblePool(entries, now, options);

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
    cards: rankPool(pool, dateKey).slice(0, deckSize(count)),
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
  progress: DeckProgress
): boolean {
  if (!result || result.imported <= 0) return false;
  return deckUntouched(progress);
}

export interface DeckProgress {
  index: number;
  interacted: boolean;
}

/**
 * A deck the reader hasn't started yet is free to redeal — nothing is pulled out
 * from under them. Once a card has been advanced, opened or annotated, the deck
 * they were dealt is the deck they keep, and a change (a Margin import, a new
 * deck size) applies to the next hand instead.
 *
 * Per hand, not per session: a reader who asks for another hand after finishing
 * one is back at an untouched deck, whatever they've already reviewed today.
 */
export function deckUntouched(progress: DeckProgress): boolean {
  return !progress.interacted && progress.index === 0;
}

/**
 * Name the articles a deck draws from: "A", "A and B", "A, B and C", then
 * "A, B and 3 more". The overflow only kicks in past `max + 1`, because "and 1
 * more" costs the same room as the title it's hiding.
 */
export function describeHighlightSources(titles: string[], max = 2): string {
  if (titles.length === 0) return '';
  if (titles.length === 1) return titles[0];
  if (titles.length <= max + 1) {
    return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
  }
  return `${titles.slice(0, max).join(', ')} and ${titles.length - max} more`;
}

/** Cheap status probe for entry points that only need "is there a deck?". */
export function highlightDeckStatus(
  entries: HighlightEntry[],
  now: Date = new Date()
): HighlightDeckStatus {
  return summarizeHighlightDeck(entries, 1, now).status;
}
