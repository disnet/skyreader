// Readings: the passes a reader has made through one piece. Coming back to a
// piece after READING_GAP_MS with no reading activity on it starts a new
// reading; marks made before it then show as an earlier layer, dated, and
// what's marked now forms the new one. Synced as the `readings` item label
// (`props.readings`, a list of start times); no label means one reading.
// A highlight belongs to the reading whose window holds its `createdAt`.
// Pure, so the rules are tested without the reader. See docs/plans/REREADING.md.

import type { Highlight } from '$lib/types';

export const READING_GAP_MS = 14 * 24 * 60 * 60 * 1000;

export interface Reading {
  /** When this pass began (epoch ms). The first reading's is its first activity. */
  startedAt: number;
}

/** Synced props are user data: keep only finite start times, in order. */
export function coerceReadings(value: unknown): Reading[] {
  const list = (value as { readings?: unknown } | null)?.readings;
  if (!Array.isArray(list)) return [];
  const starts = list
    .map((r) => (r as { startedAt?: unknown } | null)?.startedAt)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  return mergeReadings(starts.map((startedAt) => ({ startedAt })));
}

/**
 * One list from several (two devices, or alias rows), in order. Two starts
 * closer than the gap are the same return seen twice, so the earlier stands.
 */
export function mergeReadings(...lists: Reading[][]): Reading[] {
  const starts = lists
    .flat()
    .map((r) => r.startedAt)
    .sort((a, b) => a - b);
  const out: Reading[] = [];
  for (const startedAt of starts) {
    const prev = out[out.length - 1];
    if (prev && startedAt - prev.startedAt < READING_GAP_MS) continue;
    out.push({ startedAt });
  }
  return out;
}

/**
 * The readings once this opening is counted: a new list when opening now
 * starts a new reading, or null when it doesn't (never read before, or read
 * within the gap). `lastActivityAt` and `firstActivityAt` are what the piece
 * already shows: read progress, a read mark, a highlight.
 */
export function readingsAfterOpening(
  readings: Reading[],
  activity: { firstActivityAt: number; lastActivityAt: number } | null,
  now: number
): Reading[] | null {
  if (!activity) return null;
  const last = Math.max(activity.lastActivityAt, readings[readings.length - 1]?.startedAt ?? 0);
  if (now - last < READING_GAP_MS) return null;
  const base = readings.length > 0 ? readings : [{ startedAt: activity.firstActivityAt }];
  return [...base, { startedAt: now }];
}

/** Which reading (0 for the first) a moment falls in. */
export function readingIndexAt(readings: Reading[], at: number): number {
  let index = 0;
  for (let i = 1; i < readings.length; i++) {
    if (at >= readings[i].startedAt) index = i;
  }
  return index;
}

export interface ReadingLayers {
  /** 1 for a first reading. */
  count: number;
  /** When the piece was first read. */
  firstReadAt: number | null;
  /** When the reading before this one began, for "then" in Then and now. */
  previousStartedAt: number | null;
  /** Highlights made in an earlier reading and not marked again in this one. */
  earlier: Set<string>;
  /** Highlights made, or marked again (`rereadAt`), in this reading. */
  current: Set<string>;
  /** Of the earlier ones, those marked again in this reading. */
  markedAgain: Set<string>;
}

/** Sort the piece's highlights into this reading and the ones before it. */
export function readingLayers(readings: Reading[], highlights: Highlight[]): ReadingLayers {
  const count = Math.max(1, readings.length);
  const currentStart = readings.length > 1 ? readings[readings.length - 1].startedAt : -Infinity;
  const earlier = new Set<string>();
  const current = new Set<string>();
  const markedAgain = new Set<string>();
  for (const h of highlights) {
    if (h.createdAt >= currentStart) {
      current.add(h.id);
    } else if ((h.rereadAt ?? []).some((t) => t >= currentStart)) {
      current.add(h.id);
      markedAgain.add(h.id);
    } else {
      earlier.add(h.id);
    }
  }
  return {
    count,
    firstReadAt: readings[0]?.startedAt ?? null,
    previousStartedAt: readings.length > 1 ? readings[readings.length - 2].startedAt : null,
    earlier,
    current,
    markedAgain,
  };
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];

/** "second", "third", … then "9th". */
export function ordinal(n: number): string {
  return ORDINALS[n - 1] ?? `${n}th`;
}

/** "March 2026": when an earlier reading was. */
export function formatReadingWhen(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export interface ReadingTally {
  startedAt: number;
  /** Highlights made in this reading, or marked again in it. */
  count: number;
}

/**
 * Then and now: how many highlights each reading has. One marked in the first
 * reading and again ("Still matters") in the third counts in both.
 */
export function readingTallies(readings: Reading[], highlights: Highlight[]): ReadingTally[] {
  if (readings.length === 0) return [];
  const counts = readings.map(() => 0);
  for (const h of highlights) {
    const ids = new Set([
      readingIndexAt(readings, h.createdAt),
      ...(h.rereadAt ?? []).map((t) => readingIndexAt(readings, t)),
    ]);
    for (const i of ids) counts[i]++;
  }
  return readings.map((r, i) => ({ startedAt: r.startedAt, count: counts[i] }));
}

/** "Second reading": a highlight's reading, as a label. */
export function readingName(n: number): string {
  const word = ordinal(n);
  return `${word[0].toUpperCase()}${word.slice(1)} reading`;
}
