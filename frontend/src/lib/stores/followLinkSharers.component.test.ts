// Named `.component.test.ts` so it runs in the project that compiles runes.
//
// Who you follow shared an article: an answer is reused for a few minutes, then
// opening the article again asks again, so a share the timeline refresh found
// after the first look still reaches the Discussion panel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowLinkSharer } from '$lib/types';

const auth = vi.hoisted(() => ({
  user: { did: 'did:plc:me' } as { did: string } | null,
  isGuest: false,
}));
const getFollowLinkSharers = vi.fn();
vi.mock('$lib/services/api', () => ({
  api: { getFollowLinkSharers: (...a: unknown[]) => getFollowLinkSharers(...a) },
}));
vi.mock('./auth.svelte', () => ({ auth }));

const URL_A = 'https://a.example/x';

function sharer(did: string): FollowLinkSharer {
  return {
    did,
    handle: null,
    name: null,
    avatar: null,
    kind: 'post',
    postUri: `at://${did}/app.bsky.feed.post/1`,
    text: null,
    sharedAt: 0,
  };
}

async function freshStore() {
  vi.resetModules();
  return (await import('./followLinkSharers.svelte')).followLinkSharersStore;
}

beforeEach(() => {
  getFollowLinkSharers.mockReset();
  auth.user = { did: 'did:plc:me' };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('followLinkSharersStore', () => {
  it('reuses a fresh answer, and asks again once it goes stale', async () => {
    const store = await freshStore();
    getFollowLinkSharers.mockResolvedValueOnce({ scopeRequired: false, sharers: [] });
    store.load(URL_A);
    await vi.waitFor(() => expect(store.get(URL_A).loading).toBe(false));
    store.load(URL_A);
    expect(getFollowLinkSharers).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6 * 60 * 1000);
    getFollowLinkSharers.mockResolvedValueOnce({
      scopeRequired: false,
      sharers: [sharer('did:plc:maya')],
    });
    store.load(URL_A);
    await vi.waitFor(() => expect(store.get(URL_A).sharers).toHaveLength(1));
    expect(getFollowLinkSharers).toHaveBeenCalledTimes(2);
  });

  it('stops asking for the session once the permission is missing', async () => {
    const store = await freshStore();
    getFollowLinkSharers.mockResolvedValue({ scopeRequired: true, sharers: [] });
    store.load(URL_A);
    await vi.waitFor(() => expect(store.get(URL_A).loading).toBe(false));
    vi.advanceTimersByTime(6 * 60 * 1000);
    store.load(URL_A);
    store.load('https://b.example/y');
    expect(getFollowLinkSharers).toHaveBeenCalledTimes(1);
  });
});
