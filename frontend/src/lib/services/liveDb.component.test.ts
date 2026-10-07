import { describe, it, expect, vi } from 'vitest';

// An IndexedDB that can't be read or written (private mode, quota, corruption).
vi.mock('./db', () => ({
  db: {
    subscriptions: {
      toArray: async () => {
        throw new Error('IDB blocked');
      },
      clear: async () => {
        throw new Error('IDB blocked');
      },
    },
  },
}));

const { liveDb } = await import('./liveDb.svelte');

describe('liveDb subscriptions with an unusable cache', () => {
  it('still finishes loading, so nothing waits on it all session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await liveDb.loadSubscriptions()).toEqual([]);
    expect(liveDb.subscriptionsLoaded).toBe(true);
  });

  it('keeps a synced list in memory when it cannot be cached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sub = { id: 1, rkey: '3kaaaaaaaaaaa', feedUrl: 'https://a.example/feed' };
    await liveDb.replaceSubscriptions([sub] as never);
    expect(liveDb.subscriptions).toEqual([sub]);
  });
});
