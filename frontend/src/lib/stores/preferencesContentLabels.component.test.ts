// Content-label choices are account-wide: the server's copy wins on refresh, and
// each change is sent there. Named `.component.test.ts` so the runes compile.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSettings = vi.fn();
const updateSettings = vi.fn();

vi.mock('$lib/stores/auth.svelte', () => ({
  auth: { isAuthenticated: true, isGuest: false, user: { did: 'did:plc:reader' } },
}));
vi.mock('$lib/services/api', () => ({
  api: {
    getSettings: (...args: unknown[]) => getSettings(...args),
    updateSettings: (...args: unknown[]) => updateSettings(...args),
  },
}));

async function freshPreferences() {
  vi.resetModules();
  const { preferences } = await import('./preferences.svelte');
  return preferences;
}

beforeEach(() => {
  localStorage.clear();
  getSettings.mockReset();
  updateSettings.mockReset().mockResolvedValue({});
});

describe('content label preferences', () => {
  it('sends the whole map to the account on each change', async () => {
    const preferences = await freshPreferences();
    preferences.setContentLabelPreference('ai-generated', 'hide');
    preferences.setContentLabelPreference('sexual', 'show');
    expect(updateSettings).toHaveBeenLastCalledWith({
      contentLabels: { 'ai-generated': 'hide', sexual: 'show' },
    });
  });

  it("adopts the account's choices on refresh", async () => {
    const preferences = await freshPreferences();
    getSettings.mockResolvedValue({ contentLabels: { 'ai-generated': 'hide', bogus: 'hide' } });
    await preferences.syncContentLabels();
    expect(preferences.contentLabels).toEqual({ 'ai-generated': 'hide' });
  });

  it('keeps a change made while the refresh was in flight', async () => {
    const preferences = await freshPreferences();
    let resolve!: (v: unknown) => void;
    getSettings.mockReturnValue(new Promise((r) => (resolve = r)));
    const sync = preferences.syncContentLabels();
    preferences.setContentLabelPreference('nudity', 'hide');
    resolve({ contentLabels: {} });
    await sync;
    expect(preferences.contentLabels).toEqual({ nudity: 'hide' });
  });

  it("keeps this device's choices when the server has no field", async () => {
    const preferences = await freshPreferences();
    preferences.setContentLabelPreference('porn', 'hide');
    getSettings.mockResolvedValue({ pdsSyncEnabled: false });
    await preferences.syncContentLabels();
    expect(preferences.contentLabels).toEqual({ porn: 'hide' });
  });
});
