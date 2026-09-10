// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// Regression suite for the "Posted from Skyreader" kill-switch: disabling the
// offer in Settings must actually stop the attribution line, even when the
// checkbox was ticked (and persisted sticky) beforehand. See the review finding
// on the linkblog-formatting change: the sticky on-value used to outlive the
// offer, seed a fresh composer to a hidden `true`, and keep publishing.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'skyreader-preferences';
const DID = 'did:plc:reader';

vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get user() {
      return {
        did: DID,
        handle: 'reader.bsky.social',
        displayName: 'The Reader',
        avatarUrl: null,
        pdsUrl: 'https://pds.test',
      };
    },
  },
}));

// The store restores from localStorage at module-init, so every test seeds
// storage first and imports a fresh copy.
async function freshPreferences() {
  vi.resetModules();
  const { preferences } = await import('./preferences.svelte');
  return preferences;
}

function storedDids(key: 'linkblogAttributionOfferedDids' | 'linkblogAttributionOnDids'): string[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw)[key] ?? []) : [];
}

beforeEach(() => {
  localStorage.clear();
});

describe('linkblog attribution kill-switch', () => {
  it('disabling the offer after the box was ticked turns attribution off', async () => {
    const preferences = await freshPreferences();
    preferences.setLinkblogAttributionOffered(true);
    preferences.setLinkblogAttributionOn(true);
    expect(preferences.linkblogAttributionOn).toBe(true);

    preferences.setLinkblogAttributionOffered(false);

    expect(preferences.linkblogAttributionOffered).toBe(false);
    expect(preferences.linkblogAttributionOn).toBe(false);
    // The sticky value is gone from storage too, not merely masked: a fresh
    // session (or a later re-enable) must start from an unticked box.
    expect(storedDids('linkblogAttributionOnDids')).not.toContain(DID);
  });

  it('re-enabling the offer starts from an unticked box', async () => {
    const preferences = await freshPreferences();
    preferences.setLinkblogAttributionOffered(true);
    preferences.setLinkblogAttributionOn(true);
    preferences.setLinkblogAttributionOffered(false);

    preferences.setLinkblogAttributionOffered(true);

    expect(preferences.linkblogAttributionOffered).toBe(true);
    expect(preferences.linkblogAttributionOn).toBe(false);
  });

  it('a persisted ticked state never reads as on while the offer is off', async () => {
    // What a build without the clearing fix left behind: ticked, offer off.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ linkblogAttributionOfferedDids: [], linkblogAttributionOnDids: [DID] })
    );
    const preferences = await freshPreferences();

    expect(preferences.linkblogAttributionOffered).toBe(false);
    expect(preferences.linkblogAttributionOn).toBe(false);
  });
});
