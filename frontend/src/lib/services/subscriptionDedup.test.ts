import { describe, it, expect } from 'vitest';
import {
  dedupeSubscriptionsByRkey,
  subscriptionDedupKey,
  createInFlightGuard,
  DuplicateInFlightError,
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
 * Bug 2: same-feed / different-rkey duplicates from concurrent adds.
 */
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
    const rss = subscriptionDedupKey({ feedUrl: 'https://example.com/feed.xml' });
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
