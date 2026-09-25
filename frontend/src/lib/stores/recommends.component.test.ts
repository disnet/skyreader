// Named `.component.test.ts` so it runs in the project that compiles runes.
//
// The recommend button toggles optimistically, so what's pinned here is the
// rollback (a failed write must not leave the button lit), that URL spellings of
// one article share a state, and that one account's recommends don't stay lit
// for the next account to sign in on the same tab.
import { beforeEach, describe, expect, it, vi } from 'vitest';

class ScopeUpgradeError extends Error {}
const getRecommends = vi.fn(async () => ({
  recommends: [] as Array<{ url: string; createdAt: string }>,
}));
const recommend = vi.fn(async (_data: unknown) => ({ recommended: true }));
const unrecommend = vi.fn(async (_url: string) => ({ recommended: false }));
vi.mock('$lib/services/api', () => ({
  api: { getRecommends, recommend, unrecommend },
  ScopeUpgradeError,
}));

const toastUpdate = vi.fn();
vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { add: () => 1, update: toastUpdate },
}));

const authState: { user: { did: string } | null } = { user: { did: 'did:plc:a' } };
vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get user() {
      return authState.user;
    },
    get isGuest() {
      return false;
    },
  },
}));

const { recommendsStore, isRecommendable } = await import('./recommends.svelte');

const ARTICLE = 'https://Example.com/post/';

describe('recommendsStore', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    authState.user = { did: 'did:plc:a' };
    getRecommends.mockResolvedValueOnce({ recommends: [] });
    await recommendsStore.load();
  });

  it('lights up at once and writes the recommend', async () => {
    const done = recommendsStore.toggle({ url: ARTICLE, title: 'Post' });
    expect(recommendsStore.isRecommended(ARTICLE)).toBe(true);
    await done;
    expect(recommend).toHaveBeenCalledWith({ url: ARTICLE, title: 'Post', documentUri: undefined });
    // Host case, trailing slash and fragment don't make a different article.
    expect(recommendsStore.isRecommended('https://example.com/post#top')).toBe(true);
  });

  it('rolls back and says so when the write fails', async () => {
    recommend.mockRejectedValueOnce(new Error('pds down'));
    await recommendsStore.toggle({ url: ARTICLE });
    expect(recommendsStore.isRecommended(ARTICLE)).toBe(false);
    expect(toastUpdate).toHaveBeenCalledWith(1, 'error', 'Couldn’t recommend this');
  });

  it('rolls back quietly on a scope upgrade (the API client asks for access)', async () => {
    recommend.mockRejectedValueOnce(new ScopeUpgradeError());
    await recommendsStore.toggle({ url: ARTICLE });
    expect(recommendsStore.isRecommended(ARTICLE)).toBe(false);
    expect(toastUpdate).not.toHaveBeenCalled();
  });

  it('takes a recommend back', async () => {
    getRecommends.mockResolvedValueOnce({
      recommends: [{ url: ARTICLE, createdAt: '2026-01-01T00:00:00Z' }],
    });
    await recommendsStore.load();
    expect(recommendsStore.isRecommended(ARTICLE)).toBe(true);
    await recommendsStore.toggle({ url: ARTICLE });
    expect(unrecommend).toHaveBeenCalledWith(ARTICLE);
    expect(recommendsStore.isRecommended(ARTICLE)).toBe(false);
  });

  it("does not show one account's recommends to the next", async () => {
    await recommendsStore.toggle({ url: ARTICLE });
    expect(recommendsStore.isRecommended(ARTICLE)).toBe(true);
    authState.user = { did: 'did:plc:b' };
    expect(recommendsStore.isRecommended(ARTICLE)).toBe(false);
  });
});

describe('isRecommendable', () => {
  it('accepts only http(s) links', () => {
    expect(isRecommendable('https://example.com/a')).toBe(true);
    expect(isRecommendable('/relative/path')).toBe(false);
    expect(isRecommendable('at://did:plc:x/site.standard.document/1')).toBe(false);
    expect(isRecommendable(undefined)).toBe(false);
  });
});
