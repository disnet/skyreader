import { describe, it, expect } from 'vitest';
import {
  dedupeSubscriptionsByRkey,
  dedupeSubscriptionsByFeed,
  dedupeRemoteSubscriptionRecords,
  subscriptionDedupKey,
  createInFlightGuard,
  DuplicateInFlightError,
  normalizeSiteHost,
  findCrossTypeDuplicates,
  crossTypePairsForHost,
} from './subscriptionDedup';
import type { Subscription } from '$lib/types';

function sub(overrides: Partial<Subscription>): Subscription {
  return {
    rkey: 'rkey1',
    title: 'Test',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Subscription;
}

/**
 * Bug 1: same-rkey duplicates.
 *
 * The user's own add() and a background sync (e.g. on tab refocus) could both
 * insert the same record off stale snapshots, producing two rows with an
 * identical rkey. dedupeSubscriptionsByRkey heals existing rows and backs the
 * idempotency of liveDb.addSubscription.
 */
describe('dedupeSubscriptionsByRkey', () => {
  it('keeps a single subscription untouched', () => {
    const subs = [sub({ id: 1, rkey: 'a' })];
    const { kept, dupeIds } = dedupeSubscriptionsByRkey(subs);
    expect(kept).toHaveLength(1);
    expect(dupeIds).toEqual([]);
  });

  it('drops later rows that share an rkey, keeping the first', () => {
    const subs = [
      sub({ id: 1, rkey: 'a', title: 'first' }),
      sub({ id: 2, rkey: 'a', title: 'dup' }),
      sub({ id: 3, rkey: 'b' }),
    ];
    const { kept, dupeIds } = dedupeSubscriptionsByRkey(subs);
    expect(kept.map((s) => s.id)).toEqual([1, 3]);
    expect(kept[0].title).toBe('first'); // kept the first occurrence
    expect(dupeIds).toEqual([2]);
  });

  it('collapses multiple duplicates of the same rkey', () => {
    const subs = [sub({ id: 1, rkey: 'a' }), sub({ id: 2, rkey: 'a' }), sub({ id: 3, rkey: 'a' })];
    const { kept, dupeIds } = dedupeSubscriptionsByRkey(subs);
    expect(kept.map((s) => s.id)).toEqual([1]);
    expect(dupeIds).toEqual([2, 3]);
  });

  it('never merges rows that lack an rkey', () => {
    const subs = [sub({ id: 1, rkey: undefined }), sub({ id: 2, rkey: undefined })];
    const { kept, dupeIds } = dedupeSubscriptionsByRkey(subs);
    expect(kept).toHaveLength(2);
    expect(dupeIds).toEqual([]);
  });

  it('omits ids that are missing from the delete list', () => {
    const subs = [sub({ id: undefined, rkey: 'a' }), sub({ id: undefined, rkey: 'a' })];
    const { kept, dupeIds } = dedupeSubscriptionsByRkey(subs);
    expect(kept).toHaveLength(1);
    expect(dupeIds).toEqual([]); // can't delete what has no id
  });
});

/**
 * Bug 2: same-feed / different-rkey duplicates.
 *
 * Two records pointing at one feed each carry a distinct rkey, so they slip
 * past dedupeSubscriptionsByRkey. dedupeSubscriptionsByFeed heals the local
 * cache; dedupeRemoteSubscriptionRecords heals the PDS during sync.
 */
describe('dedupeSubscriptionsByFeed', () => {
  it('keeps the oldest of two RSS rows that share a feed url', () => {
    const subs = [
      sub({
        id: 1,
        rkey: 'a',
        feedUrl: 'https://x.com/feed',
        createdAt: '2026-01-02T00:00:00Z',
      }),
      sub({
        id: 2,
        rkey: 'b',
        feedUrl: 'https://x.com/feed',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ];
    const { kept, dupeIds } = dedupeSubscriptionsByFeed(subs);
    expect(kept.map((s) => s.id)).toEqual([2]); // older createdAt wins
    expect(dupeIds).toEqual([1]);
  });

  it('matches feed urls case-insensitively', () => {
    const subs = [
      sub({ id: 1, rkey: 'a', feedUrl: 'https://x.com/Feed' }),
      sub({ id: 2, rkey: 'b', feedUrl: 'https://x.com/feed' }),
    ];
    const { dupeIds } = dedupeSubscriptionsByFeed(subs);
    expect(dupeIds).toEqual([2]);
  });

  it('preserves original order of the kept rows', () => {
    const subs = [
      sub({ id: 1, rkey: 'a', feedUrl: 'https://a.com/feed' }),
      sub({
        id: 2,
        rkey: 'b',
        feedUrl: 'https://x.com/feed',
        createdAt: '2026-01-02T00:00:00Z',
      }),
      sub({ id: 3, rkey: 'c', feedUrl: 'https://b.com/feed' }),
      sub({
        id: 4,
        rkey: 'd',
        feedUrl: 'https://x.com/feed',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ];
    const { kept } = dedupeSubscriptionsByFeed(subs);
    expect(kept.map((s) => s.id)).toEqual([1, 3, 4]); // the older x.com row (id 4) survives in place
  });

  it('collapses atproto streams by sourceType + subjectDid + uri', () => {
    const subs = [
      sub({
        id: 1,
        rkey: 'a',
        sourceType: 'atproto.collection',
        subjectDid: 'did:plc:abc',
        feedUrl: 'at://did:plc:abc/app.bsky.feed/1',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      sub({
        id: 2,
        rkey: 'b',
        sourceType: 'atproto.collection',
        subjectDid: 'did:plc:abc',
        feedUrl: 'at://did:plc:abc/app.bsky.feed/1',
        createdAt: '2026-01-02T00:00:00Z',
      }),
    ];
    const { kept, dupeIds } = dedupeSubscriptionsByFeed(subs);
    expect(kept.map((s) => s.id)).toEqual([1]);
    expect(dupeIds).toEqual([2]);
  });

  it('does not merge different feeds', () => {
    const subs = [
      sub({ id: 1, rkey: 'a', feedUrl: 'https://a.com/feed' }),
      sub({ id: 2, rkey: 'b', feedUrl: 'https://b.com/feed' }),
    ];
    const { kept, dupeIds } = dedupeSubscriptionsByFeed(subs);
    expect(kept).toHaveLength(2);
    expect(dupeIds).toEqual([]);
  });

  it('leaves rows without a feed identity untouched', () => {
    const subs = [
      sub({ id: 1, rkey: 'a', feedUrl: undefined }),
      sub({ id: 2, rkey: 'b', feedUrl: undefined }),
    ];
    const { kept, dupeIds } = dedupeSubscriptionsByFeed(subs);
    expect(kept).toHaveLength(2);
    expect(dupeIds).toEqual([]);
  });
});

describe('dedupeRemoteSubscriptionRecords', () => {
  const rec = (rkey: string, feedUrl: string, createdAt?: string) => ({
    rkey,
    value: { feedUrl, createdAt },
  });

  it('reports the newer of two same-feed records for deletion', () => {
    const { duplicateRkeys } = dedupeRemoteSubscriptionRecords([
      rec('a', 'https://x.com/feed', '2026-01-02T00:00:00Z'),
      rec('b', 'https://x.com/feed', '2026-01-01T00:00:00Z'),
    ]);
    expect(duplicateRkeys).toEqual(['a']); // 'b' is older → kept
  });

  it('breaks createdAt ties deterministically by ascending rkey', () => {
    const ts = '2026-01-01T00:00:00Z';
    const { duplicateRkeys } = dedupeRemoteSubscriptionRecords([
      rec('zzz', 'https://x.com/feed', ts),
      rec('aaa', 'https://x.com/feed', ts),
    ]);
    expect(duplicateRkeys).toEqual(['zzz']); // 'aaa' < 'zzz' → kept
  });

  it('keeps distinct feeds and reports nothing', () => {
    const { duplicateRkeys } = dedupeRemoteSubscriptionRecords([
      rec('a', 'https://a.com/feed'),
      rec('b', 'https://b.com/feed'),
    ]);
    expect(duplicateRkeys).toEqual([]);
  });
});

describe('subscriptionDedupKey', () => {
  it('keys RSS feeds by case-insensitive URL', () => {
    const a = subscriptionDedupKey({ feedUrl: 'https://example.com/Feed.xml' });
    const b = subscriptionDedupKey({ feedUrl: 'https://example.com/feed.xml' });
    expect(a).toBe(b);
  });

  it('distinguishes different RSS feeds', () => {
    const a = subscriptionDedupKey({ feedUrl: 'https://a.com/feed.xml' });
    const b = subscriptionDedupKey({ feedUrl: 'https://b.com/feed.xml' });
    expect(a).not.toBe(b);
  });

  it('keys atproto streams by sourceType + subjectDid + uri', () => {
    const a = subscriptionDedupKey({
      sourceType: 'atproto.feed',
      subjectDid: 'did:plc:abc',
      feedUrl: 'at://did:plc:abc/app.bsky.feed/1',
    });
    const b = subscriptionDedupKey({
      sourceType: 'atproto.feed',
      subjectDid: 'did:plc:abc',
      feedUrl: 'at://did:plc:abc/app.bsky.feed/1',
    });
    expect(a).toBe(b);
    expect(a.startsWith('atproto:')).toBe(true);
  });

  it('does not collide an atproto stream with an RSS feed', () => {
    const atproto = subscriptionDedupKey({
      sourceType: 'atproto.feed',
      subjectDid: 'did:plc:abc',
    });
    const rss = subscriptionDedupKey({
      feedUrl: 'https://example.com/feed.xml',
    });
    expect(atproto).not.toBe(rss);
  });
});

describe('createInFlightGuard', () => {
  it('runs a single operation and releases the key', async () => {
    const guard = createInFlightGuard();
    const result = await guard.run('k', 'dup', async () => 42);
    expect(result).toBe(42);
    expect(guard.isInFlight('k')).toBe(false);
  });

  it('rejects a second concurrent op with the same key before side effects', async () => {
    const guard = createInFlightGuard();
    let runs = 0;
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));

    // First add is in flight and blocked on the gate.
    const first = guard.run('k', 'dup', async () => {
      runs++;
      await gate;
      return 'first';
    });

    // Second add for the same key while the first is still running.
    await expect(
      guard.run('k', 'dup', async () => {
        runs++;
        return 'second';
      })
    ).rejects.toBeInstanceOf(DuplicateInFlightError);

    release!();
    expect(await first).toBe('first');
    expect(runs).toBe(1); // the second op's body never executed
  });

  it('allows concurrent ops with different keys', async () => {
    const guard = createInFlightGuard();
    const [a, b] = await Promise.all([
      guard.run('a', 'dup', async () => 'a'),
      guard.run('b', 'dup', async () => 'b'),
    ]);
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('releases the key after a failure so the feed can be retried', async () => {
    const guard = createInFlightGuard();
    await expect(
      guard.run('k', 'dup', async () => {
        throw new Error('backend down');
      })
    ).rejects.toThrow('backend down');
    expect(guard.isInFlight('k')).toBe(false);

    // A retry after the failure is allowed.
    const retry = await guard.run('k', 'dup', async () => 'ok');
    expect(retry).toBe('ok');
  });
});

describe('normalizeSiteHost', () => {
  it('lowercases the host and strips a leading www.', () => {
    expect(normalizeSiteHost('https://WWW.Example.com/feed')).toBe('example.com');
    expect(normalizeSiteHost('https://example.com')).toBe('example.com');
  });

  it('keeps non-www subdomains distinct', () => {
    expect(normalizeSiteHost('https://foo.substack.com')).toBe('foo.substack.com');
    expect(normalizeSiteHost('https://bar.substack.com')).toBe('bar.substack.com');
  });

  it('returns null for missing or unparseable URLs', () => {
    expect(normalizeSiteHost(undefined)).toBeNull();
    expect(normalizeSiteHost('')).toBeNull();
    expect(normalizeSiteHost('not a url')).toBeNull();
  });
});

/**
 * Cross-type duplicates: the same publication followed once by RSS and once as
 * a standard.site (atproto.documents) stream. They share no feed identity, so
 * only the website host (siteUrl) can relate them.
 */
describe('findCrossTypeDuplicates', () => {
  it('pairs an RSS sub and a standard.site stream on the same host', () => {
    const rss = sub({
      id: 1,
      rkey: 'r',
      feedUrl: 'https://blog.example.com/feed.xml',
      siteUrl: 'https://blog.example.com',
    });
    const std = sub({
      id: 2,
      rkey: 's',
      sourceType: 'atproto.documents',
      subjectDid: 'did:plc:abc',
      feedUrl: 'at://did:plc:abc/site.standard.publication/blog',
      siteUrl: 'https://www.blog.example.com',
    });
    const pairs = findCrossTypeDuplicates([rss, std]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].rss.id).toBe(1);
    expect(pairs[0].standard.id).toBe(2);
    expect(pairs[0].host).toBe('blog.example.com');
  });

  it('does not pair subs on different hosts', () => {
    const rss = sub({ id: 1, sourceType: 'rss', siteUrl: 'https://a.com' });
    const std = sub({
      id: 2,
      sourceType: 'atproto.documents',
      subjectDid: 'd',
      siteUrl: 'https://b.com',
    });
    expect(findCrossTypeDuplicates([rss, std])).toEqual([]);
  });

  it('does not pair subdomain-per-author hosts (shared platforms)', () => {
    const rss = sub({ id: 1, siteUrl: 'https://foo.substack.com' });
    const std = sub({
      id: 2,
      sourceType: 'atproto.documents',
      subjectDid: 'd',
      siteUrl: 'https://bar.substack.com',
    });
    expect(findCrossTypeDuplicates([rss, std])).toEqual([]);
  });

  it('pairs an RSS sub with no resolved siteUrl via its feedUrl host', () => {
    // A feed subscribed before siteUrl tracking existed has no siteUrl; its
    // feedUrl host is the only bridge, and it's the same host the add screen
    // matches on. It must still surface as a cross-type duplicate.
    const rss = sub({ id: 1, feedUrl: 'https://blog.example.com/feed.xml', siteUrl: undefined });
    const std = sub({
      id: 2,
      sourceType: 'atproto.documents',
      subjectDid: 'd',
      siteUrl: 'https://blog.example.com',
    });
    const pairs = findCrossTypeDuplicates([rss, std]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].rss.id).toBe(1);
    expect(pairs[0].host).toBe('blog.example.com');
  });

  it('skips RSS subs with neither a siteUrl nor a usable feedUrl host', () => {
    const rss = sub({ id: 1, feedUrl: undefined, siteUrl: undefined });
    const std = sub({
      id: 2,
      sourceType: 'atproto.documents',
      subjectDid: 'd',
      siteUrl: 'https://blog.example.com',
    });
    expect(findCrossTypeDuplicates([rss, std])).toEqual([]);
  });

  it('pairs the standard.site stream with the oldest matching RSS sub', () => {
    const older = sub({
      id: 1,
      rkey: 'old',
      createdAt: '2026-01-01T00:00:00.000Z',
      siteUrl: 'https://x.com',
    });
    const newer = sub({
      id: 2,
      rkey: 'new',
      createdAt: '2026-02-01T00:00:00.000Z',
      siteUrl: 'https://x.com',
    });
    const std = sub({
      id: 3,
      sourceType: 'atproto.documents',
      subjectDid: 'd',
      siteUrl: 'https://x.com',
    });
    const pairs = findCrossTypeDuplicates([newer, older, std]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].rss.id).toBe(1);
  });

  it('does not relate two RSS subs or two standard.site streams', () => {
    const rssA = sub({ id: 1, siteUrl: 'https://x.com' });
    const rssB = sub({ id: 2, siteUrl: 'https://x.com' });
    const stdA = sub({
      id: 3,
      sourceType: 'atproto.documents',
      subjectDid: 'd1',
      siteUrl: 'https://y.com',
    });
    const stdB = sub({
      id: 4,
      sourceType: 'atproto.documents',
      subjectDid: 'd2',
      siteUrl: 'https://y.com',
    });
    // Two RSS on x.com (no atproto): no cross-type pair. Two standard.site on
    // y.com (no RSS): no cross-type pair.
    expect(findCrossTypeDuplicates([rssA, rssB, stdA, stdB])).toEqual([]);
  });
});

/**
 * crossTypePairsForHost is the add-time counterpart: the just-added sub may not
 * have a resolved siteUrl yet (a fresh RSS row), so the host is passed in
 * explicitly rather than read off the row.
 */
describe('crossTypePairsForHost', () => {
  it('pairs a freshly-added RSS sub (no siteUrl) with an existing standard.site on the host', () => {
    const std = sub({
      id: 1,
      sourceType: 'atproto.documents',
      subjectDid: 'did:plc:abc',
      siteUrl: 'https://blog.example.com',
    });
    const addedRss = sub({ id: 2, sourceType: 'rss', siteUrl: undefined });
    const pairs = crossTypePairsForHost([std, addedRss], addedRss, 'blog.example.com');
    expect(pairs).toHaveLength(1);
    expect(pairs[0].rss.id).toBe(2);
    expect(pairs[0].standard.id).toBe(1);
    expect(pairs[0].host).toBe('blog.example.com');
  });

  it('pairs a freshly-added standard.site sub with an existing RSS on the host', () => {
    const rss = sub({ id: 1, sourceType: 'rss', siteUrl: 'https://www.example.com' });
    const addedStd = sub({
      id: 2,
      sourceType: 'atproto.documents',
      subjectDid: 'd',
      siteUrl: 'https://example.com',
    });
    const pairs = crossTypePairsForHost([rss, addedStd], addedStd, 'example.com');
    expect(pairs).toHaveLength(1);
    expect(pairs[0].rss.id).toBe(1);
    expect(pairs[0].standard.id).toBe(2);
  });

  it('excludes the added sub itself and same-type subs on the host', () => {
    const addedRss = sub({ id: 1, sourceType: 'rss', siteUrl: 'https://example.com' });
    const otherRss = sub({ id: 2, sourceType: 'rss', siteUrl: 'https://example.com' });
    // Only same-type rows on the host: no opposite type to pair with.
    expect(crossTypePairsForHost([addedRss, otherRss], addedRss, 'example.com')).toEqual([]);
  });

  it('returns nothing when no existing sub shares the host', () => {
    const std = sub({
      id: 1,
      sourceType: 'atproto.documents',
      subjectDid: 'd',
      siteUrl: 'https://other.com',
    });
    const addedRss = sub({ id: 2, sourceType: 'rss', siteUrl: undefined });
    expect(crossTypePairsForHost([std, addedRss], addedRss, 'example.com')).toEqual([]);
  });
});
