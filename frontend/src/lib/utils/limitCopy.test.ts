import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { saveLimitLine, mergeNotices, syncNoticeLine } from './limitCopy';
import type { SyncLimitNotice } from '$lib/services/api';

describe('saveLimitLine', () => {
  // Pinned west of UTC on purpose: on a UTC runner the bug this guards against
  // is invisible, because there local time and UTC name the same day.
  const realTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles';
  });
  afterAll(() => {
    process.env.TZ = realTz;
  });

  // The backend picks UTC midnight on the 1st. Formatted in local time that
  // reads as the *previous* day to everyone west of UTC, so the reader is told
  // their saves reset on a date that has already gone by.
  it('names the reset day in UTC, not the reader’s timezone', () => {
    const line = saveLimitLine(100, '2026-09-01T00:00:00.000Z');
    expect(line).toContain('Resets September 1');
    expect(line).not.toContain('August 31');
  });

  it('states the ceiling alone when there is no reset date', () => {
    expect(saveLimitLine(100)).toBe("You've used all 100 saves this month.");
  });

  it('falls back to the ceiling when the date is unparseable', () => {
    expect(saveLimitLine(100, 'not-a-date')).toBe("You've used all 100 saves this month.");
  });
});

describe('mergeNotices', () => {
  const parked = (count: number): SyncLimitNotice => ({
    kind: 'feeds',
    subject: 'feeds',
    count,
    limit: 100,
    message: `${count} feeds ... were parked`,
  });

  // A full sync is a loop of batch calls and each batch counts only its own
  // share, so the per-batch sentences never match and deduping on the string
  // leaves the reader a stack of numbers, none of them the total.
  it('sums the counts of a batched sync into one line', () => {
    const merged = mergeNotices([parked(20), parked(30)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].count).toBe(50);
    expect(merged[0].message).toContain('50 feeds');
    expect(merged[0].message).not.toContain('20 feeds');
  });

  it('keeps different caps apart', () => {
    const merged = mergeNotices([
      parked(20),
      { kind: 'mirror', subject: 'feeds', count: 5, limit: 1000, message: 'dropped' },
    ]);
    expect(merged.map((n) => n.kind)).toEqual(['feeds', 'mirror']);
  });

  it('keeps feeds and followed linkblogs apart — they are different things', () => {
    const merged = mergeNotices([
      parked(20),
      { kind: 'feeds', subject: 'linkblogs', count: 3, limit: 100, message: 'linkblogs parked' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[1].message).toContain('followed linkblogs');
  });

  it('passes through a countless notice from an older backend', () => {
    const legacy: SyncLimitNotice = { kind: 'feeds', message: 'some feeds were parked' };
    expect(mergeNotices([legacy, legacy])).toEqual([legacy]);
  });
});

describe('syncNoticeLine', () => {
  it('agrees in number for a single feed', () => {
    const line = syncNoticeLine({
      kind: 'feeds',
      subject: 'feeds',
      count: 1,
      limit: 100,
      message: '',
    });
    expect(line).toContain('1 feed over');
    expect(line).toContain('was parked');
  });

  // Nothing is destroyed at a cap, and copy that implies otherwise tells the
  // reader to throw away data they still have.
  it('never tells the reader to remove anything', () => {
    for (const subject of ['feeds', 'linkblogs'] as const) {
      for (const kind of ['feeds', 'mirror'] as const) {
        const line = syncNoticeLine({ kind, subject, count: 7, limit: 100, message: '' });
        expect(line.toLowerCase()).not.toContain('remove');
        expect(line.toLowerCase()).not.toContain('delete');
      }
    }
  });
});
