// Named `.component.test.ts` so it runs in the project that compiles runes.
//
// Posting a highlight to Bluesky: the dialog hands the cross-post the note as
// text and the passage as a quote, remembers the post across a permission
// grant, and reopens it only for the account that asked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const grantPermissions = vi.fn();
vi.mock('$lib/services/permissions', () => ({
  grantPermissions: (...args: unknown[]) => grantPermissions(...args),
}));

const crossPostToBluesky = vi.fn();
vi.mock('$lib/services/blueskyCrossPost', () => ({
  crossPostToBluesky: (...args: unknown[]) => crossPostToBluesky(...args),
}));

const getIntegrationStatus = vi.fn();
vi.mock('$lib/services/api', () => ({
  api: { getIntegrationStatus: () => getIntegrationStatus() },
}));

const setBlueskyTextShots = vi.fn();
vi.mock('$lib/stores/preferences.svelte', () => ({
  preferences: {
    blueskyTextShots: true,
    setBlueskyTextShots: (v: boolean) => setBlueskyTextShots(v),
  },
}));

const { blueskyHighlightStore: store } = await import('./blueskyHighlight.svelte');

const source = { url: 'https://example.com/post', title: 'A Post' };

describe('blueskyHighlightStore', () => {
  beforeEach(() => {
    store.close();
    localStorage.clear();
    grantPermissions.mockReset();
    crossPostToBluesky.mockReset();
    getIntegrationStatus.mockReset();
    getIntegrationStatus.mockResolvedValue({ scopeStatus: { blueskyPost: true } });
  });

  it('seeds the text from the note and posts it with the passage as a quote', async () => {
    store.open({ source, quote: 'The passage.', note: '  My note  ' });
    expect(store.text).toBe('My note');
    await vi.waitFor(() => expect(store.access).toBe('granted'));

    store.text = 'Worth reading';
    store.post();

    expect(store.session).toBeNull();
    expect(crossPostToBluesky).toHaveBeenCalledWith(
      source,
      [
        { kind: 'text', text: 'Worth reading' },
        { kind: 'quote', text: 'The passage.' },
      ],
      expect.objectContaining({ textShots: store.textShots })
    );
  });

  it('asks for access when the account lacks the permission', async () => {
    getIntegrationStatus.mockResolvedValue({ scopeStatus: {} });
    store.open({ source, quote: 'The passage.' });
    await vi.waitFor(() => expect(store.access).toBe('missing'));
  });

  it('reopens the post after a grant, for the same account only', () => {
    store.open({ source, quote: 'The passage.' });
    store.text = 'Half written';
    store.allowAccess('did:plc:reader');
    expect(grantPermissions).toHaveBeenCalledWith(['blueskyPost'], expect.any(String));
    store.close();

    store.resumeAfterGrant('did:plc:someone-else');
    expect(store.session).toBeNull();

    store.allowAccess(undefined); // nothing open: remembers nothing
    store.open({ source, quote: 'The passage.' });
    store.text = 'Half written';
    store.allowAccess('did:plc:reader');
    store.close();

    store.resumeAfterGrant('did:plc:reader');
    expect(store.session).toEqual({ source, quote: 'The passage.' });
    expect(store.text).toBe('Half written');

    // One-shot: a second return doesn't reopen it.
    store.close();
    store.resumeAfterGrant('did:plc:reader');
    expect(store.session).toBeNull();
  });
});
