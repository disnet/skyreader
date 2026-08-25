import { describe, it, expect } from 'vitest';
import { byEngagement, newestFirst } from './discussionSort';
import type { LanePersonVM } from '$lib/components/articleCardView.types';

function entry(
  did: string,
  hoursAgo: number | null,
  likeCount: number | null = null
): LanePersonVM {
  return {
    did,
    handle: `${did}.test`,
    displayName: null,
    avatar: null,
    createdAt: hoursAgo === null ? null : new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    note: null,
    url: null,
    collections: [],
    verb: null,
    quote: null,
    likeCount,
  };
}

const order = (entries: LanePersonVM[]) => [...entries].sort(byEngagement).map((e) => e.did);

describe('byEngagement', () => {
  it('leads with the most-liked reference, not the newest', () => {
    expect(order([entry('fresh', 1, 0), entry('carried', 40, 12)])).toEqual(['carried', 'fresh']);
  });

  it('keeps entries with no metric newest-first among themselves', () => {
    // Every lane but Bluesky is null by nature — the order they had before.
    expect(order([entry('old', 40), entry('new', 2), entry('mid', 20)])).toEqual([
      'new',
      'mid',
      'old',
    ]);
  });

  it('breaks a tie in likes by recency', () => {
    expect(order([entry('older', 30, 5), entry('newer', 3, 5)])).toEqual(['newer', 'older']);
  });

  it('treats a missing count as zero, so an old payload keeps its place', () => {
    // A payload cached before the field existed: `likeCount` is simply absent.
    const stale = { ...entry('stale', 2) } as LanePersonVM;
    delete (stale as Partial<LanePersonVM>).likeCount;
    expect(order([entry('liked', 40, 3), stale, entry('zero', 30, 0)])).toEqual([
      'liked',
      'stale',
      'zero',
    ]);
  });

  it('sorts an undated reference last rather than pretending it is new', () => {
    expect(order([entry('undated', null), entry('dated', 40)])).toEqual(['dated', 'undated']);
  });

  it('still ranks an undated reference by its likes', () => {
    expect(order([entry('undated', null, 9), entry('dated', 1, 2)])).toEqual(['undated', 'dated']);
  });
});

describe('newestFirst', () => {
  it('ignores likes entirely — it is only the tiebreak', () => {
    const entries = [entry('old', 40, 99), entry('new', 1, 0)];
    expect([...entries].sort(newestFirst).map((e) => e.did)).toEqual(['new', 'old']);
  });
});
