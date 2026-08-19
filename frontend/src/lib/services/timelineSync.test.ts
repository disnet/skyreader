import { describe, it, expect } from 'vitest';
import {
  buildSubscriptionIndex,
  groupTimelineItems,
  isCircuitOpen,
  isRssSubscription,
  pruneAttemptedBackfills,
  reconcileFeedHealth,
  selectBackfillTargets,
  shouldFallBackToBatch,
  shouldUpdateTitle,
  subscriptionMetaUpdate,
  type TimelineItem,
} from './timelineSync';
import type { Subscription } from '$lib/types';

const FEED_A = 'https://a.example/feed.xml';
const FEED_B = 'https://b.example/feed.xml';

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 1,
    title: 'Feed A',
    feedUrl: FEED_A,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Subscription;
}

function tItem(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    seq: 1,
    feedUrl: FEED_A,
    read: false,
    guid: 'g1',
    url: 'https://a.example/g1',
    title: 'Item',
    publishedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isRssSubscription', () => {
  it('accepts RSS subs and rejects every atproto source', () => {
    expect(isRssSubscription(sub())).toBe(true);
    expect(isRssSubscription(sub({ sourceType: 'rss' }))).toBe(true);
    expect(isRssSubscription(sub({ sourceType: 'atproto.documents' }))).toBe(false);
    expect(isRssSubscription(sub({ sourceType: 'atproto.collection' }))).toBe(false);
    expect(isRssSubscription(sub({ feedUrl: '' }))).toBe(false);
  });
});

describe('buildSubscriptionIndex', () => {
  it('maps feed URLs to subscription ids, skipping non-RSS and unsaved subs', () => {
    const index = buildSubscriptionIndex([
      sub({ id: 1, feedUrl: FEED_A }),
      sub({ id: 2, feedUrl: FEED_B }),
      sub({ id: 3, feedUrl: 'at://did:plc:x/pub', sourceType: 'atproto.documents' }),
      sub({ id: undefined, feedUrl: 'https://c.example/feed.xml' }),
    ]);
    expect([...index.entries()]).toEqual([
      [FEED_A, 1],
      [FEED_B, 2],
    ]);
  });
});

describe('groupTimelineItems', () => {
  const index = new Map([
    [FEED_A, 1],
    [FEED_B, 2],
  ]);

  it('buckets items per subscription and collects read guids', () => {
    const grouped = groupTimelineItems(
      [
        tItem({ seq: 1, guid: 'a1', feedUrl: FEED_A, read: true }),
        tItem({ seq: 2, guid: 'b1', feedUrl: FEED_B }),
        tItem({ seq: 3, guid: 'a2', feedUrl: FEED_A }),
      ],
      index
    );

    expect(grouped.toMerge).toEqual([
      {
        subscriptionId: 1,
        items: [expect.objectContaining({ guid: 'a1' }), expect.objectContaining({ guid: 'a2' })],
      },
      { subscriptionId: 2, items: [expect.objectContaining({ guid: 'b1' })] },
    ]);
    expect(grouped.readGuids).toEqual(['a1']);
    expect(grouped.feedUrls.sort()).toEqual([FEED_A, FEED_B]);
  });

  it('drops items for feeds this client no longer holds', () => {
    const grouped = groupTimelineItems(
      [tItem({ guid: 'gone', feedUrl: 'https://gone.example/feed.xml' })],
      index
    );
    expect(grouped.toMerge).toEqual([]);
    expect(grouped.feedUrls).toEqual([]);
  });
});

describe('shouldFallBackToBatch', () => {
  it('falls back whenever the server says nothing is ingesting, however full the page', () => {
    // The rollout window: one subscribe-time ingest is enough to make a cold
    // start non-empty while nothing crawls the user's other feeds.
    expect(
      shouldFallBackToBatch({ items: [tItem()], coldStart: true, ingestActive: false }, 3)
    ).toBe(true);
    expect(
      shouldFallBackToBatch({ items: [tItem()], coldStart: false, ingestActive: false }, 3)
    ).toBe(true);
  });

  it('stays on the timeline once the crawler is live, even on an empty page', () => {
    expect(shouldFallBackToBatch({ items: [], coldStart: true, ingestActive: true }, 3)).toBe(
      false
    );
    expect(shouldFallBackToBatch({ items: [], coldStart: false, ingestActive: true }, 3)).toBe(
      false
    );
  });

  it('falls back when a cold start finds nothing for a subscribed user (pre-flag backend)', () => {
    expect(shouldFallBackToBatch({ items: [], coldStart: true }, 3)).toBe(true);
  });

  it('does not fall back for a user with no RSS subscriptions', () => {
    expect(shouldFallBackToBatch({ items: [], coldStart: true }, 0)).toBe(false);
  });

  it('does not fall back once the archive delivers anything', () => {
    expect(shouldFallBackToBatch({ items: [tItem()], coldStart: true }, 3)).toBe(false);
  });

  it('does not fall back on an empty incremental page (steady state)', () => {
    expect(shouldFallBackToBatch({ items: [], coldStart: false }, 3)).toBe(false);
  });
});

describe('selectBackfillTargets', () => {
  const subA = sub({ id: 1, feedUrl: FEED_A });
  const subB = sub({ id: 2, feedUrl: FEED_B, title: 'Feed B' });
  const none = () => false;

  it('picks subscriptions that hold no articles yet', () => {
    expect(selectBackfillTargets([subA, subB], new Set(), none, 10)).toEqual([subA, subB]);
  });

  it('skips feeds already tried, feeds with articles, and non-RSS sources', () => {
    const atproto = sub({ id: 3, feedUrl: 'at://did:plc:x/pub', sourceType: 'atproto.documents' });
    const targets = selectBackfillTargets(
      [subA, subB, atproto],
      new Set([FEED_A]),
      (s) => s.id === 2,
      10
    );
    expect(targets).toEqual([]);
  });

  it('caps how many it returns per sync', () => {
    expect(selectBackfillTargets([subA, subB], new Set(), none, 1)).toEqual([subA]);
  });

  it('rotates past a failed first batch so later subscriptions get a turn', () => {
    const subscriptions = Array.from({ length: 15 }, (_, index) =>
      sub({ id: index + 1, feedUrl: `https://feed-${index + 1}.example/rss` })
    );

    const first = selectBackfillTargets(subscriptions, new Set(), none, 10);
    const second = selectBackfillTargets(subscriptions, new Set(), none, 10, first.at(-1)!.feedUrl);

    expect(first.map((subscription) => subscription.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(second.slice(0, 5).map((subscription) => subscription.id)).toEqual([11, 12, 13, 14, 15]);
  });
});

describe('pruneAttemptedBackfills', () => {
  it('keeps only feeds still subscribed', () => {
    expect(pruneAttemptedBackfills([FEED_A, FEED_B], [sub({ feedUrl: FEED_A })])).toEqual([FEED_A]);
  });
});

describe('reconcileFeedHealth', () => {
  const broken = { errorCount: 3, error: 'Failed to fetch (HTTP 404)' };

  it('flags every subscribed feed the crawler reports broken', () => {
    const decisions = reconcileFeedHealth(
      { 'https://a.example/f': broken },
      ['https://a.example/f'],
      () => false
    );
    expect(decisions).toEqual([{ feedUrl: 'https://a.example/f', kind: 'error', health: broken }]);
  });

  it('clears a feed that has dropped out of the report', () => {
    const decisions = reconcileFeedHealth({}, ['https://a.example/f'], () => true);
    expect(decisions).toEqual([{ feedUrl: 'https://a.example/f', kind: 'recovered' }]);
  });

  it('leaves a healthy feed with no error alone, so pending never becomes a fake success', () => {
    expect(reconcileFeedHealth({}, ['https://a.example/f'], () => false)).toEqual([]);
  });

  it('ignores broken feeds the caller does not subscribe to', () => {
    const decisions = reconcileFeedHealth(
      { 'https://other.example/f': broken },
      ['https://a.example/f'],
      () => false
    );
    expect(decisions).toEqual([]);
  });

  it('handles a mixed report in one pass', () => {
    const decisions = reconcileFeedHealth(
      { 'https://a.example/f': broken },
      ['https://a.example/f', 'https://b.example/f', 'https://c.example/f'],
      (url) => url === 'https://b.example/f'
    );
    expect(decisions).toEqual([
      { feedUrl: 'https://a.example/f', kind: 'error', health: broken },
      { feedUrl: 'https://b.example/f', kind: 'recovered' },
    ]);
  });
});

describe('isCircuitOpen', () => {
  const now = 1_770_000_000_000;

  it('treats nextRetryAt as milliseconds, not seconds', () => {
    // The crawler sends `Date.now() + backoff`. Rescaling this by 1000 (the old
    // behaviour) put the retry ~50,000 years out and retired the feed for good.
    expect(isCircuitOpen(now + 600_000, now)).toBe(true);
    expect(isCircuitOpen(now - 600_000, now)).toBe(false);
    expect(isCircuitOpen(Math.floor(now / 1000), now)).toBe(false);
  });

  it('is closed when there is no retry time at all', () => {
    expect(isCircuitOpen(undefined, now)).toBe(false);
    expect(isCircuitOpen(0, now)).toBe(false);
  });
});

describe('shouldUpdateTitle', () => {
  it('replaces a URL or hostname placeholder with a real title', () => {
    expect(shouldUpdateTitle(FEED_A, FEED_A, 'Real Title')).toBe(true);
    expect(shouldUpdateTitle('a.example', FEED_A, 'Real Title')).toBe(true);
  });

  it('leaves a real title alone', () => {
    expect(shouldUpdateTitle('Curated Name', FEED_A, 'Real Title')).toBe(false);
    expect(shouldUpdateTitle(FEED_A, FEED_A, 'Untitled Feed')).toBe(false);
    expect(shouldUpdateTitle(FEED_A, FEED_A, '')).toBe(false);
  });
});

describe('subscriptionMetaUpdate', () => {
  it('backfills title and siteUrl independently', () => {
    expect(
      subscriptionMetaUpdate({ title: FEED_A, feedUrl: FEED_A }, { title: 'Real Title' })
    ).toEqual({ title: 'Real Title' });

    expect(
      subscriptionMetaUpdate(
        { title: 'Curated Name', feedUrl: FEED_A },
        { title: 'Real Title', siteUrl: 'https://a.example' }
      )
    ).toEqual({ siteUrl: 'https://a.example' });
  });

  it('returns null when nothing changes', () => {
    expect(
      subscriptionMetaUpdate(
        { title: 'Curated Name', feedUrl: FEED_A, siteUrl: 'https://a.example' },
        { title: 'Real Title', siteUrl: 'https://a.example' }
      )
    ).toBeNull();
  });
});
