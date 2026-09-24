// Named `.component.test.ts` for jsdom's localStorage.
//
// Granting the follows permission makes the "From your follows" channel,
// wherever the grant comes back to; nothing else does, so a reader who deletes
// the channel doesn't get it back. And two callers never make two channels.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilteredView } from '$lib/types';

const state = vi.hoisted(() => ({
  did: 'did:plc:reader' as string | null,
  views: [] as Partial<FilteredView>[],
  loaded: true,
  scopeRequired: false,
  create: vi.fn(),
  grant: vi.fn(),
}));

vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get user() {
      return state.did ? { did: state.did } : null;
    },
    isGuest: false,
    grantPermissions: state.grant,
  },
}));
vi.mock('$lib/stores/filteredViews.svelte', () => ({
  filteredViewsStore: {
    get views() {
      return state.views;
    },
    create: state.create,
  },
}));
vi.mock('$lib/stores/followLinks.svelte', () => ({
  followLinksStore: {
    load: async () => {},
    get loaded() {
      return state.loaded;
    },
    get scopeRequired() {
      return state.scopeRequired;
    },
  },
}));

const { completeFollowsGrant, ensureFollowsChannel, grantFollowsAccess } =
  await import('./followsChannel');
const { FOLLOWS_SOURCE_KEY } = await import('./sourceKeys');

describe('the follows channel after a grant', () => {
  beforeEach(() => {
    localStorage.clear();
    state.did = 'did:plc:reader';
    state.views = [];
    state.loaded = true;
    state.scopeRequired = false;
    state.create.mockReset().mockImplementation(async (view: Partial<FilteredView>) => {
      state.views = [...state.views, { ...view, uuid: 'new-uuid' }];
      return 'new-uuid';
    });
    state.grant.mockReset();
  });

  it('is made once the grant comes back, and only once', async () => {
    await grantFollowsAccess('/feeds');
    expect(state.grant).toHaveBeenCalledWith(['follows'], '/feeds');

    await completeFollowsGrant();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.create.mock.calls[0][0]).toMatchObject({
      sourceMode: 'include',
      sourceKeys: [FOLLOWS_SOURCE_KEY],
    });

    // Deleted later: a later start doesn't bring it back.
    state.views = [];
    await completeFollowsGrant();
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it('is not made without a grant', async () => {
    await completeFollowsGrant();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('is not made when the permission was declined', async () => {
    await grantFollowsAccess();
    state.scopeRequired = true;
    await completeFollowsGrant();
    expect(state.create).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('waits for an answer before deciding', async () => {
    await grantFollowsAccess();
    state.loaded = false;
    await completeFollowsGrant();
    expect(state.create).not.toHaveBeenCalled();

    state.loaded = true;
    await completeFollowsGrant();
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it('is not made for another account signed in on this device', async () => {
    await grantFollowsAccess();
    state.did = 'did:plc:someone-else';
    await completeFollowsGrant();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('is made once when two callers ask at the same time', async () => {
    const [a, b] = await Promise.all([ensureFollowsChannel(), ensureFollowsChannel()]);
    expect(a).toBe('new-uuid');
    expect(b).toBe('new-uuid');
    expect(state.create).toHaveBeenCalledTimes(1);
  });
});
