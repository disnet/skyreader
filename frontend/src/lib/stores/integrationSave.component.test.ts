// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// Saving out to Semble or Margin writes a record to the reader's own atproto
// repo, and the picker lists collections read from it. For a guest the dialog
// would open empty and the save behind it could only queue an entry that never
// drains — no session, no granted scope. Every surface hides the action; this
// pins the store's backstop.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  createMarginBookmark: vi.fn(async () => {}),
  createSembleCard: vi.fn(async () => {}),
};
class ScopeUpgradeError extends Error {}
class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}
class OfflineError extends Error {}
class RateLimitError extends Error {}
class SessionRefreshError extends Error {}
vi.mock('$lib/services/api', () => ({
  api,
  ApiError,
  OfflineError,
  RateLimitError,
  ScopeUpgradeError,
  SessionRefreshError,
}));
vi.mock('$lib/services/permissions', () => ({
  permissionToast: () => ({ message: 'Allow access', action: { label: 'Allow' } }),
}));

const enqueue = vi.fn(async () => {});
vi.mock('$lib/services/sync-queue', () => ({ syncQueue: { enqueue } }));

vi.mock('$lib/stores/sync.svelte', () => ({ syncStore: { isOnline: true } }));

const toastStore = { add: vi.fn(() => 1), update: vi.fn() };
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore }));

vi.mock('$lib/stores/collections.svelte', () => ({ collectionsStore: { markUsed: vi.fn() } }));

const authState = { isGuest: true };
vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get isGuest() {
      return authState.isGuest;
    },
  },
}));

const { integrationSaveStore } = await import('./integrationSave.svelte');

const TARGET = { url: 'https://example.com/piece', title: 'A Piece' };

describe('the integration save picker is account-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isGuest = true;
    integrationSaveStore.close();
  });

  it('never opens for a guest', () => {
    integrationSaveStore.openPicker('margin', TARGET);
    expect(integrationSaveStore.open).toBe(false);
  });

  it('offers the guest somewhere to go rather than failing silently', () => {
    integrationSaveStore.openPicker('semble', TARGET);
    expect(toastStore.update).toHaveBeenCalledWith(
      1,
      'error',
      undefined,
      expect.objectContaining({ href: expect.stringContaining('/auth/login') })
    );
  });

  it('leaves no queue entry behind — one could never drain for a guest', async () => {
    integrationSaveStore.openPicker('margin', TARGET);
    // Even if a confirm somehow arrives, there is no target to act on.
    await integrationSaveStore.confirm({ mode: 'create', collections: [] });
    expect(enqueue).not.toHaveBeenCalled();
    expect(api.createMarginBookmark).not.toHaveBeenCalled();
  });

  it('opens for an account', () => {
    authState.isGuest = false;
    integrationSaveStore.openPicker('margin', TARGET);
    expect(integrationSaveStore.open).toBe(true);
    expect(integrationSaveStore.integration).toBe('margin');
  });
});

// A save that fails used to be queued behind a "Queued save" success toast no
// matter why it failed — so a refusal the PDS would repeat on every drain read
// as done and then never happened.
describe('a failed save says so unless a retry can fix it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isGuest = false;
    integrationSaveStore.close();
  });

  async function saveTo(kind: 'semble' | 'margin') {
    integrationSaveStore.openPicker(kind, TARGET);
    await integrationSaveStore.confirm({ mode: 'create', collections: [] });
  }

  it('reports a refusal as an error and queues nothing', async () => {
    api.createSembleCard.mockRejectedValueOnce(new ApiError('InvalidRecord', 502));
    await saveTo('semble');
    expect(enqueue).not.toHaveBeenCalled();
    expect(toastStore.update).toHaveBeenLastCalledWith(1, 'error', "Couldn't save to Semble");
  });

  it('asks for permission when the scope is missing', async () => {
    api.createMarginBookmark.mockRejectedValueOnce(new ScopeUpgradeError());
    await saveTo('margin');
    expect(enqueue).not.toHaveBeenCalled();
    expect(toastStore.update).toHaveBeenLastCalledWith(1, 'error', 'Allow access', {
      label: 'Allow',
    });
  });

  it('queues a failure a retry can fix', async () => {
    api.createMarginBookmark.mockRejectedValueOnce(new ApiError('timeout', 503));
    await saveTo('margin');
    expect(enqueue).toHaveBeenCalledOnce();
    expect(toastStore.update).toHaveBeenLastCalledWith(1, 'success', 'Queued save to Margin');
  });

  it('queues a request that never got an answer', async () => {
    api.createSembleCard.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await saveTo('semble');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('says so when a collection could not be added', async () => {
    api.createSembleCard.mockResolvedValueOnce({
      uri: 'at://x',
      cid: 'c',
      collectionResults: [{ uri: 'at://col', error: 'nope' }],
    } as never);
    integrationSaveStore.openPicker('semble', TARGET);
    await integrationSaveStore.confirm({
      mode: 'create',
      collections: [{ uri: 'at://col', cid: 'c' }],
    } as never);
    expect(toastStore.update).toHaveBeenLastCalledWith(
      1,
      'error',
      "Saved to Semble, but 1 collection couldn't be added"
    );
  });
});
