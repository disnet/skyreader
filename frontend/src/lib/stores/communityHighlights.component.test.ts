// Named `.component.test.ts` so it runs in the project that compiles runes.
//
// Community highlights are public Atmosphere data, but the /api/v2 path is
// session-gated: calling it without a session 401s, and the api client answers a
// 401 by probing /api/auth/me, which 401s too and logs a logout that never
// happens. A guest therefore reads the same answer from the guest twin.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchCommunityHighlights = vi.fn(async () => ({ notes: [], capped: false }));
const fetchGuestCommunityHighlights = vi.fn(async () => ({ notes: [], capped: false }));
vi.mock('$lib/services/api', () => ({
  api: { fetchCommunityHighlights, fetchGuestCommunityHighlights },
}));

const authState: { user: { did: string } | null } = { user: null };
vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get user() {
      return authState.user;
    },
  },
}));

const { communityHighlightsStore } = await import('./communityHighlights.svelte');

describe('communityHighlightsStore.load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the guest route when there is no session', async () => {
    authState.user = null;

    communityHighlightsStore.load('https://example.com/guest-article');
    await vi.waitFor(() => expect(fetchGuestCommunityHighlights).toHaveBeenCalledOnce());
    expect(fetchCommunityHighlights).not.toHaveBeenCalled();
  });

  it('reads the account route once signed in', async () => {
    authState.user = { did: 'did:plc:reader' };

    communityHighlightsStore.load('https://example.com/account-article');
    await vi.waitFor(() => expect(fetchCommunityHighlights).toHaveBeenCalledOnce());
    expect(fetchGuestCommunityHighlights).not.toHaveBeenCalled();
  });
});
