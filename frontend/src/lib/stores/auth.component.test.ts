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

vi.mock('$lib/services/api', () => ({
  api,
  OfflineError: class OfflineError extends Error {},
  SessionRefreshError: class SessionRefreshError extends Error {},
}));

const clearAllData = vi.fn(async () => {});
const unregisterPeriodicSync = vi.fn(async () => {});
vi.mock('$lib/services/db', () => ({ clearAllData }));
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
    api.getMe.mockRejectedValueOnce(new Error('expired'));

    await expect(auth.verifySession()).resolves.toBe(false);

    expect(auth.user).toBeNull();
    expect(clearAllData).toHaveBeenCalledOnce();
    expect(unregisterPeriodicSync).toHaveBeenCalledOnce();
    expect(localStorage.getItem('skyreader-auth')).toBeNull();
  });

  it('preserves a real guest library on a stray session verification', async () => {
    await auth.logout();
    await auth.enterGuestMode();
    vi.clearAllMocks();
    api.getMe.mockRejectedValueOnce(new Error('no session'));

    await expect(auth.verifySession()).resolves.toBe(false);

    expect(auth.isGuest).toBe(true);
    expect(clearAllData).not.toHaveBeenCalled();
    expect(unregisterPeriodicSync).not.toHaveBeenCalled();
  });
});
