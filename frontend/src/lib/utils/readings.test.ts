import { describe, expect, it } from 'vitest';
import type { Highlight } from '$lib/types';
import {
  READING_GAP_MS,
  coerceReadings,
  formatReadingWhen,
  mergeReadings,
  ordinal,
  readingIndexAt,
  readingLayers,
  readingName,
  readingTallies,
  readingsAfterOpening,
} from './readings';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 2, 1);

const hl = (id: string, createdAt: number, rereadAt?: number[]): Highlight =>
  ({
    id,
    selector: { type: 'TextQuoteSelector', exact: id },
    createdAt,
    ...(rereadAt ? { rereadAt } : {}),
  }) as Highlight;

describe('readings', () => {
  it('trusts only finite start times from synced props', () => {
    expect(coerceReadings(null)).toEqual([]);
    expect(coerceReadings({ readings: 'x' })).toEqual([]);
    expect(
      coerceReadings({
        readings: [{ startedAt: T0 + 30 * DAY }, { startedAt: 'x' }, null, { startedAt: T0 }],
      })
    ).toEqual([{ startedAt: T0 }, { startedAt: T0 + 30 * DAY }]);
  });

  it('merges lists, treating starts closer than the gap as one return', () => {
    expect(
      mergeReadings(
        [{ startedAt: T0 }, { startedAt: T0 + 20 * DAY }],
        [{ startedAt: T0 + 21 * DAY }]
      )
    ).toEqual([{ startedAt: T0 }, { startedAt: T0 + 20 * DAY }]);
  });

  it('starts a new reading only after the gap with nothing done', () => {
    const activity = { firstActivityAt: T0, lastActivityAt: T0 + DAY };
    // Never read: nothing to count yet.
    expect(readingsAfterOpening([], null, T0 + 60 * DAY)).toBeNull();
    // Inside the gap: the same reading.
    expect(readingsAfterOpening([], activity, T0 + DAY + READING_GAP_MS - 1)).toBeNull();
    // After it: the first reading began with the first activity.
    const now = T0 + DAY + READING_GAP_MS;
    expect(readingsAfterOpening([], activity, now)).toEqual([
      { startedAt: T0 },
      { startedAt: now },
    ]);
    // A reading just started counts as activity, so a reopen next day isn't a third.
    const two = [{ startedAt: T0 }, { startedAt: now }];
    expect(readingsAfterOpening(two, activity, now + DAY)).toBeNull();
    expect(readingsAfterOpening(two, activity, now + READING_GAP_MS)).toHaveLength(3);
  });

  it('places a moment in its reading', () => {
    const readings = [{ startedAt: T0 }, { startedAt: T0 + 30 * DAY }];
    expect(readingIndexAt(readings, T0 - DAY)).toBe(0);
    expect(readingIndexAt(readings, T0 + 29 * DAY)).toBe(0);
    expect(readingIndexAt(readings, T0 + 30 * DAY)).toBe(1);
  });

  it('sorts highlights into earlier, current and marked again', () => {
    const second = T0 + 30 * DAY;
    const readings = [{ startedAt: T0 }, { startedAt: second }];
    const layers = readingLayers(readings, [
      hl('old', T0 + DAY),
      hl('again', T0 + DAY, [second + DAY]),
      hl('new', second + DAY),
    ]);
    expect(layers.count).toBe(2);
    expect(layers.firstReadAt).toBe(T0);
    expect(layers.previousStartedAt).toBe(T0);
    expect([...layers.earlier]).toEqual(['old']);
    expect([...layers.current].sort()).toEqual(['again', 'new']);
    expect([...layers.markedAgain]).toEqual(['again']);

    // One reading: everything is current.
    const once = readingLayers([], [hl('a', T0)]);
    expect(once.count).toBe(1);
    expect([...once.earlier]).toEqual([]);
    expect([...once.current]).toEqual(['a']);
  });

  it('tallies each reading, counting a passage marked again in both', () => {
    const second = T0 + 30 * DAY;
    const readings = [{ startedAt: T0 }, { startedAt: second }];
    expect(
      readingTallies(readings, [
        hl('a', T0 + DAY),
        hl('b', T0 + DAY, [second + DAY, second + 2 * DAY]),
        hl('c', second + DAY),
      ])
    ).toEqual([
      { startedAt: T0, count: 2 },
      { startedAt: second, count: 2 },
    ]);
    expect(readingTallies([], [hl('a', T0)])).toEqual([]);
  });

  it('names readings', () => {
    expect(ordinal(2)).toBe('second');
    expect(ordinal(9)).toBe('9th');
    expect(readingName(1)).toBe('First reading');
    expect(formatReadingWhen(Date.UTC(2026, 2, 15))).toMatch(/2026/);
  });
});
