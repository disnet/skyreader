// Account caches and guest data share one unscoped Dexie database. These tests
// pin the ownership boundary: entering guest mode and losing a verified session
// must both erase account-owned rows before logged-out code can read them.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  logout: vi.fn(async () => {}),
  getMe: vi.fn(),
  setOnUnauthorized: vi.fn(),
  setOnScopeUpgradeRequired: vi.fn(),
};

class SessionExpiredError extends Error {}
vi.mock('$lib/services/api', () => ({
  api,
  OfflineError: class OfflineError extends Error {},
  SessionExpiredError,
  SessionRefreshError: class SessionRefreshError extends Error {},
}));

const clearAllData = vi.fn(async (_options?: { holdSyncQueueFor?: string }) => {});
const releaseHeldSyncQueue = vi.fn(async () => 0);
const unregisterPeriodicSync = vi.fn(async () => {});
vi.mock('$lib/services/db', () => ({ clearAllData, releaseHeldSyncQueue }));
vi.mock('$lib/services/backgroundRefresh', () => ({ unregisterPeriodicSync }));

const { auth } = await import('./auth.svelte');

const user = {
  did: 'did:plc:account',
  handle: 'reader.example',
  displayName: 'Reader',
  tier: 'free',
  limits: { maxSubscriptions: 100 },
};

describe('auth local-data ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.exitGuestMode();
    auth.setUser(user as Parameters<typeof auth.setUser>[0]);
  });

  it('clears account data before enabling guest mode', async () => {
    await auth.logout();
    vi.clearAllMocks();

    await auth.enterGuestMode();

    expect(clearAllData).toHaveBeenCalledOnce();
    expect(unregisterPeriodicSync).toHaveBeenCalledOnce();
    expect(auth.isGuest).toBe(true);
  });

  it('clears account data when session verification fails definitively', async () => {
    api.getMe.mockRejectedValueOnce(new SessionExpiredError('expired'));

    await expect(auth.verifySession()).resolves.toBe(false);

    expect(auth.user).toBeNull();
    expect(clearAllData).toHaveBeenCalledOnce();
    expect(unregisterPeriodicSync).toHaveBeenCalledOnce();
    expect(localStorage.getItem('skyreader-auth')).toBeNull();
  });

  // verifySession runs on every window focus and polls during checkout, so a
  // backend blip must not be mistaken for a logout: that would wipe the whole
  // cached library over a few seconds of bad network.
  it.each([
    ['a network failure', new TypeError('Failed to fetch')],
    ['a server error', new Error('HTTP 500')],
  ])('keeps the session and the local library through %s', async (_label, error) => {
    api.getMe.mockRejectedValueOnce(error);

    await expect(auth.verifySession()).resolves.toBe(true);

    expect(auth.user).not.toBeNull();
    expect(clearAllData).not.toHaveBeenCalled();
    expect(localStorage.getItem('skyreader-auth')).not.toBeNull();
  });

  // An expiry the reader did not ask for must not take their unsynced writes
  // with it; the queue is parked against the departing DID and handed back when
  // that same account signs in again.
  it('holds the sync queue for the departing account on an involuntary expiry', async () => {
    api.getMe.mockRejectedValueOnce(new SessionExpiredError('expired'));

    await auth.verifySession();

    expect(clearAllData).toHaveBeenCalledWith({ holdSyncQueueFor: user.did });
  });

  it('does not hold the sync queue on an explicit logout', async () => {
    await auth.logout();

    expect(clearAllData).toHaveBeenCalledWith(undefined);
  });

  it('releases held writes when the same account signs back in', async () => {
    api.getMe.mockRejectedValueOnce(new SessionExpiredError('expired'));
    await auth.verifySession();
    vi.clearAllMocks();

    auth.setUser(user as Parameters<typeof auth.setUser>[0]);
    await vi.waitFor(() => expect(releaseHeldSyncQueue).toHaveBeenCalledWith(user.did));
  });

  it('clears the local library when a guest leaves guest mode', async () => {
    await auth.logout();
    await auth.enterGuestMode();
    auth.rememberStarterRkeys(['abcdefghijklm']);
    vi.clearAllMocks();

    await auth.leaveGuestMode();

    expect(auth.isGuest).toBe(false);
    expect(auth.hasGuestData).toBe(false);
    expect(auth.starterRkeys()).toEqual([]);
    expect(clearAllData).toHaveBeenCalledOnce();
    expect(unregisterPeriodicSync).toHaveBeenCalledOnce();
  });

  it('preserves a real guest library on a stray session verification', async () => {
    await auth.logout();
    await auth.enterGuestMode();
    vi.clearAllMocks();
    api.getMe.mockRejectedValueOnce(new SessionExpiredError('no session'));

    await expect(auth.verifySession()).resolves.toBe(false);

    expect(auth.isGuest).toBe(true);
    expect(clearAllData).not.toHaveBeenCalled();
    expect(unregisterPeriodicSync).not.toHaveBeenCalled();
  });
});
