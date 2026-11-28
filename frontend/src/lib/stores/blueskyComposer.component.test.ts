// Named `.component.test.ts` so it runs in the project that compiles runes.
//
// Posting to Bluesky: for a highlight the dialog hands the cross-post the note
// as text and the passage as a quote; without one it's text over the link
// card. It remembers the post across a permission grant, and reopens it only
// for the account that asked.
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

const { blueskyComposerStore: store } = await import('./blueskyComposer.svelte');

const source = { url: 'https://example.com/post', title: 'A Post' };

describe('blueskyComposerStore', () => {
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

  it('posts just the text, for the link card, when there is no passage', async () => {
    store.open({ source });
    expect(store.session).toEqual({ source, quotes: [], offered: [] });
    await vi.waitFor(() => expect(store.access).toBe('granted'));

    store.text = 'Worth reading';
    store.post();

    expect(crossPostToBluesky).toHaveBeenCalledWith(
      source,
      [{ kind: 'text', text: 'Worth reading' }],
      expect.anything()
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
    expect(store.session).toMatchObject({ source, quotes: ['The passage.'] });
    expect(store.text).toBe('Half written');

    // One-shot: a second return doesn't reopen it.
    store.close();
    store.resumeAfterGrant('did:plc:reader');
    expect(store.session).toBeNull();
  });

  it('adds and removes passages, up to four, and posts them in order', async () => {
    store.open({ source, quote: 'First.', itemKey: 'guid-1' });
    expect(store.session).toMatchObject({
      quotes: ['First.'],
      offered: ['First.'],
      itemKey: 'guid-1',
    });
    for (const q of ['Second.', 'Third.', 'Fourth.', 'Fifth.']) store.toggleQuote(q);
    expect(store.session?.quotes).toEqual(['First.', 'Second.', 'Third.', 'Fourth.']);

    store.toggleQuote('First.');
    expect(store.session?.quotes).toEqual(['Second.', 'Third.', 'Fourth.']);
    // Taken out, what it opened with stays on offer.
    expect(store.session?.offered).toEqual(['First.']);

    store.text = 'Three good bits';
    store.post();
    expect(crossPostToBluesky).toHaveBeenCalledWith(
      source,
      [
        { kind: 'text', text: 'Three good bits' },
        { kind: 'quote', text: 'Second.' },
        { kind: 'quote', text: 'Third.' },
        { kind: 'quote', text: 'Fourth.' },
      ],
      expect.anything()
    );
  });

  it('keeps the access answer when a quote is ticked while it is checked', async () => {
    let answer: (v: unknown) => void = () => {};
    getIntegrationStatus.mockReturnValue(new Promise((r) => (answer = r)));
    store.open({ source, quote: 'One.' });
    store.toggleQuote('Two.');
    answer({ scopeStatus: {} });
    await vi.waitFor(() => expect(store.access).toBe('missing'));
  });

  it('opens without a blank passage', () => {
    store.open({ source, quote: '   ' });
    expect(store.session?.quotes).toEqual([]);
  });

  it('remembers every chosen passage across a grant', () => {
    store.open({ source, quote: 'First.', itemKey: 'guid-1' });
    store.toggleQuote('Second.');
    store.allowAccess('did:plc:reader');
    store.close();

    store.resumeAfterGrant('did:plc:reader');
    expect(store.session).toMatchObject({ quotes: ['First.', 'Second.'], itemKey: 'guid-1' });
  });

  it('resumes a grant asked for before posts carried several passages', () => {
    localStorage.setItem(
      'skyreader:grant-bluesky-highlight',
      JSON.stringify({ did: 'did:plc:reader', source, quote: 'Old one.', text: 'Hi' })
    );
    store.resumeAfterGrant('did:plc:reader');
    expect(store.session).toMatchObject({ quotes: ['Old one.'] });
    expect(store.text).toBe('Hi');
  });

  it('drops repeated or empty passages from a remembered post', () => {
    localStorage.setItem(
      'skyreader:grant-bluesky-highlight',
      JSON.stringify({ did: 'did:plc:reader', source, quotes: ['A.', 'A.', '', 7, 'B.'] })
    );
    store.resumeAfterGrant('did:plc:reader');
    expect(store.session?.quotes).toEqual(['A.', 'B.']);
  });

  it('opens on several passages at once, in place of a single quote, up to four', () => {
    store.open({ source, quote: 'Ignored.', quotes: ['A.', 'B.', 'C.', 'D.', 'E.'] });
    expect(store.session?.quotes).toEqual(['A.', 'B.', 'C.', 'D.']);
  });
});
