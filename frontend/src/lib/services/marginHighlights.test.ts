// Saving a highlight to Margin writes an `at.margin.note` record to the
// reader's own atproto repo. Unlike a local highlight — where the offline queue
// IS the migration on sign-in — a queued Margin note could never drain without
// both a session and a granted Margin scope, so for a guest the queue would be
// a false promise. The surfaces hide the action; this pins the backstop.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Highlight } from '$lib/types';

const api = {
  createMarginNote: vi.fn(async () => ({ uri: 'at://uri', rkey: 'rk' })),
  deleteMarginNote: vi.fn(async () => {}),
  updateMarginNote: vi.fn(async () => {}),
};
class ScopeUpgradeError extends Error {}
vi.mock('$lib/services/api', () => ({ api, ScopeUpgradeError }));

const enqueue = vi.fn(async () => {});
const cancelPending = vi.fn(async () => {});
vi.mock('$lib/services/sync-queue', () => ({ syncQueue: { enqueue, cancelPending } }));

const syncState = { isOnline: true };
vi.mock('$lib/stores/sync.svelte', () => ({
  syncStore: {
    get isOnline() {
      return syncState.isOnline;
    },
  },
}));

const toastStore = { add: vi.fn(() => 1), update: vi.fn() };
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore }));

vi.mock('$lib/stores/itemLabels.svelte', () => ({
  itemLabelsStore: { setHighlightMargin: vi.fn(async () => {}) },
}));

const authState = { isGuest: true };
vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get isGuest() {
      return authState.isGuest;
    },
  },
}));

const { saveHighlightToMargin } = await import('./marginHighlights');

const HIGHLIGHT = {
  id: 'h1',
  selector: { exact: 'a passage' },
  createdAt: 0,
} as unknown as Highlight;
const SOURCE = 'https://example.com/piece';

describe('saveHighlightToMargin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isGuest = true;
    syncState.isOnline = true;
  });

  it('refuses for a guest without queueing a note that could never drain', async () => {
    const ok = await saveHighlightToMargin('item-1', HIGHLIGHT, SOURCE, 'A Piece');
    expect(ok).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(api.createMarginNote).not.toHaveBeenCalled();
  });

  it('offers the guest somewhere to go rather than failing silently', async () => {
    await saveHighlightToMargin('item-1', HIGHLIGHT, SOURCE);
    expect(toastStore.update).toHaveBeenCalledWith(
      1,
      'error',
      undefined,
      expect.objectContaining({ href: expect.stringContaining('/auth/login') })
    );
  });

  it('writes to Margin for an account', async () => {
    authState.isGuest = false;
    const ok = await saveHighlightToMargin('item-1', HIGHLIGHT, SOURCE, 'A Piece');
    expect(ok).toBe(true);
    expect(api.createMarginNote).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still queues for an offline account — that entry can drain', async () => {
    authState.isGuest = false;
    syncState.isOnline = false;
    const ok = await saveHighlightToMargin('item-1', HIGHLIGHT, SOURCE, 'A Piece');
    expect(ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(api.createMarginNote).not.toHaveBeenCalled();
  });
});
