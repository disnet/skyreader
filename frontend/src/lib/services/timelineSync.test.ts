import { describe, it, expect } from 'vitest';
import {
  buildSubscriptionIndex,
  groupTimelineItems,
  isRssSubscription,
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
  it('falls back when a cold start finds nothing for a subscribed user', () => {
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
