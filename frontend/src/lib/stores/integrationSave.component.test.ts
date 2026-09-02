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
vi.mock('$lib/services/api', () => ({ api, ScopeUpgradeError }));

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
