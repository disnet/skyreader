import { describe, expect, it } from 'vitest';
import {
  buildDailyMagazine,
  localDateKey,
  magazineIssueSummary,
  magazineReadingMinutes,
  savedItemDisplayKey,
  type DailyMagazineCandidate,
} from './dailyMagazine';

interface TestItem {
  title: string;
}

function candidate(
  key: string,
  wordCount: number | null | undefined,
  opened = false
): DailyMagazineCandidate<TestItem> {
  return { item: { title: key }, key, wordCount, opened };
}

describe('daily magazine', () => {
  it('uses the existing 200 wpm convention and rejects invalid counts', () => {
    expect(magazineReadingMinutes(1)).toBe(1);
    expect(magazineReadingMinutes(299)).toBe(1);
    expect(magazineReadingMinutes(300)).toBe(2);
    expect(magazineReadingMinutes(2_000)).toBe(10);
    expect(magazineReadingMinutes(0)).toBeNull();
    expect(magazineReadingMinutes(-1)).toBeNull();
    expect(magazineReadingMinutes(Number.NaN)).toBeNull();
    expect(magazineReadingMinutes(null)).toBeNull();
  });

  it('uses local calendar fields for the issue key', () => {
    expect(localDateKey(new Date(2026, 6, 13, 23, 59))).toBe('2026-07-13');
  });

  it('is stable for the same day regardless of input order', () => {
    const date = new Date(2026, 6, 13, 9);
    const candidates = [
      candidate('alpha', 400),
      candidate('bravo', 400),
      candidate('charlie', 400),
      candidate('delta', 400),
    ];

    const first = buildDailyMagazine(candidates, 20, date);
    const second = buildDailyMagazine([...candidates].reverse(), 20, date);

    expect(second.items.map((item) => item.key)).toEqual(first.items.map((item) => item.key));
  });

  it('can rotate the stable ordering on another day', () => {
    const candidates = [
      candidate('alpha', 200),
      candidate('bravo', 200),
      candidate('charlie', 200),
      candidate('delta', 200),
      candidate('echo', 200),
    ];

    const first = buildDailyMagazine(candidates, 5, new Date(2026, 6, 13));
    const next = buildDailyMagazine(candidates, 5, new Date(2026, 6, 14));

    expect(next.items.map((item) => item.key)).not.toEqual(first.items.map((item) => item.key));
  });

  it('favors never-opened items before opened items', () => {
    const issue = buildDailyMagazine(
      [candidate('opened-a', 200, true), candidate('fresh', 200), candidate('opened-b', 200, true)],
      3,
      new Date(2026, 6, 13)
    );

    expect(issue.items[0].key).toBe('fresh');
  });

  it('filters invalid items and keeps scanning when an item does not fit', () => {
    const issue = buildDailyMagazine(
      [
        candidate('invalid', null),
        candidate('too-long', 4_000),
        candidate('short-a', 1_200),
        candidate('short-b', 800),
      ],
      10,
      new Date(2026, 6, 13)
    );

    expect(issue.items.map((item) => item.key)).not.toContain('invalid');
    expect(issue.items.map((item) => item.key)).not.toContain('too-long');
    expect(issue.items).toHaveLength(2);
    expect(issue.totalMinutes).toBe(10);
    expect(issue.totalMinutes).toBeLessThanOrEqual(issue.targetMinutes);
  });

  it('orders by newest and oldest save date when requested', () => {
    const candidates = [
      { ...candidate('older', 200), sortValue: 1_000 },
      { ...candidate('newest', 200), sortValue: 3_000 },
      { ...candidate('middle', 200), sortValue: 2_000 },
    ];
    const date = new Date(2026, 6, 13);

    const recent = buildDailyMagazine(candidates, 3, date, 'recent');
    expect(recent.items.map((item) => item.key)).toEqual(['newest', 'middle', 'older']);

    const oldest = buildDailyMagazine(candidates, 3, date, 'oldest');
    expect(oldest.items.map((item) => item.key)).toEqual(['older', 'middle', 'newest']);
  });

  it('formats a compact issue summary', () => {
    expect(magazineIssueSummary(1, 8)).toBe('1 article · 8 min');
    expect(magazineIssueSummary(3, 20)).toBe('3 articles · 20 min');
  });

  it('uses the standard saved-reader display key order', () => {
    const item = {
      uri: 'at://did:example/app.skyreader.feed.saved/one',
      itemGuid: 'article-guid',
      rkey: 'one',
      url: 'https://example.com/article',
    } as Parameters<typeof savedItemDisplayKey>[0];
    expect(savedItemDisplayKey(item)).toBe(item.uri);
    expect(savedItemDisplayKey({ ...item, uri: '' })).toBe(item.itemGuid);
    expect(savedItemDisplayKey({ ...item, uri: '', itemGuid: undefined })).toBe(item.rkey);
  });
});
