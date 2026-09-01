// Named `.component.test.ts` so it runs in the project that compiles runes.
//
// A guest's sync queue is the sign-in migration, not a backlog: draining it
// replays every entry against a session-gated API, each replay 401s, and a 401
// is non-retryable — the entry is marked permanently failed and the read or
// save it carried never reaches the future account. triggerSync must therefore
// hold the queue while auth.isGuest, and release it the moment a user is set
// (isGuest is false then, even while the guest marker survives for migration).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const processQueue = vi.fn(async () => ({ processed: 0, failed: 0 }));
vi.mock('$lib/services/sync-queue', () => ({
  syncQueue: {
    processQueue,
    getPendingCount: async () => 0,
    setOnPendingCountChange: () => {},
    registerBackgroundSync: () => {},
  },
}));

const authState = { isGuest: true };
vi.mock('./auth.svelte', () => ({
  auth: {
    get isGuest() {
      return authState.isGuest;
    },
  },
}));

const { syncStore } = await import('./sync.svelte');

describe('syncStore.triggerSync', () => {
  beforeEach(() => {
    processQueue.mockClear();
  });

  it('holds the queue while in guest mode', async () => {
    authState.isGuest = true;
    await syncStore.triggerSync();
    expect(processQueue).not.toHaveBeenCalled();
  });

  it('drains it once a user is signed in', async () => {
    authState.isGuest = false;
    await syncStore.triggerSync();
    expect(processQueue).toHaveBeenCalledTimes(1);
  });
});
