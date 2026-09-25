// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// What the wire actually carries: the attribution flag handed to
// `linkblogStore.shareLink` must obey the Settings kill-switch, whether the
// offer was disabled before the composer opened or while the draft sat open
// with the checkbox already hidden.
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const shareLink = vi.fn();
vi.mock('$lib/stores/linkblog.svelte', () => ({
  linkblogStore: {
    shareLink: (...args: unknown[]) => shareLink(...args),
    setNote: vi.fn(),
    unshare: vi.fn(),
  },
}));

// The real drafts store persists to IndexedDB; the composer only needs these.
vi.mock('$lib/stores/shareDrafts.svelte', () => ({
  shareDraftsStore: {
    load: () => Promise.resolve(),
    get: () => undefined,
    save: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  },
}));

// The cross-post runs after the share; the composer's job is only to hand it
// the right draft. getIntegrationStatus answers the access check on open.
const crossPostToBluesky = vi.fn();
vi.mock('$lib/services/blueskyCrossPost', () => ({
  crossPostToBluesky: (...args: unknown[]) => crossPostToBluesky(...args),
}));
vi.mock('$lib/services/api', () => ({
  api: { getIntegrationStatus: () => Promise.resolve({ scopeStatus: { bluesky: true } }) },
}));

const ARTICLE = {
  subscriptionId: 0,
  guid: 'https://example.test/post',
  url: 'https://example.test/post',
  title: 'The Post',
  publishedAt: '2026-01-01T00:00:00.000Z',
  fetchedAt: 0,
};

// Both stores restore module-level $state on import; give every test a fresh
// pair wired to a clean localStorage.
async function freshStores() {
  vi.resetModules();
  const { preferences } = await import('./preferences.svelte');
  const { shareComposerStore: shareComposer } = await import('./shareComposer.svelte');
  return { preferences, shareComposer };
}

async function openCreate(shareComposer: { open: (o: { article: typeof ARTICLE }) => void }) {
  shareComposer.open({ article: ARTICLE });
  // open() resolves the drafts store before seeding the session.
  await Promise.resolve();
}

beforeEach(() => {
  localStorage.clear();
  shareLink.mockReset().mockResolvedValue('shared');
  crossPostToBluesky.mockReset().mockResolvedValue(true);
});

describe('share composer attribution', () => {
  it('posts the sticky ticked value while the offer is on', async () => {
    const { preferences, shareComposer } = await freshStores();
    preferences.setLinkblogAttributionOffered(true);
    preferences.setLinkblogAttributionOn(true);

    await openCreate(shareComposer);
    expect(shareComposer.attribution).toBe(true);
    await shareComposer.post();

    expect(shareLink).toHaveBeenCalledWith(ARTICLE, undefined, undefined, true);
  });

  it('disable-after-checked: a new composer neither seeds nor posts attribution', async () => {
    const { preferences, shareComposer } = await freshStores();
    preferences.setLinkblogAttributionOffered(true);
    preferences.setLinkblogAttributionOn(true);
    preferences.setLinkblogAttributionOffered(false);

    await openCreate(shareComposer);
    expect(shareComposer.attribution).toBe(false);
    await shareComposer.post();

    expect(shareLink).toHaveBeenCalledWith(ARTICLE, undefined, undefined, false);
  });

  it('disabling the offer while a draft is open suppresses the hidden true', async () => {
    const { preferences, shareComposer } = await freshStores();
    preferences.setLinkblogAttributionOffered(true);
    preferences.setLinkblogAttributionOn(true);

    await openCreate(shareComposer);
    expect(shareComposer.attribution).toBe(true);
    // The checkbox vanishes from the UI at this point; its stale true must
    // not reach the record.
    preferences.setLinkblogAttributionOffered(false);
    await shareComposer.post();

    expect(shareLink).toHaveBeenCalledWith(ARTICLE, undefined, undefined, false);
  });
});

describe('share composer: also on Bluesky', () => {
  it('cross-posts the draft after the share when ticked, and remembers the choice', async () => {
    const { preferences, shareComposer } = await freshStores();
    await openCreate(shareComposer);
    shareComposer.appendQuote('A passage.');
    shareComposer.setBluesky(true);
    shareComposer.setTextShots(false);
    expect(preferences.blueskyCrossPost).toBe(true);
    expect(preferences.blueskyTextShots).toBe(false);

    expect(await shareComposer.post()).toBe(true);
    expect(shareLink).toHaveBeenCalled();
    expect(crossPostToBluesky).toHaveBeenCalledWith(
      ARTICLE,
      [
        { kind: 'quote', text: 'A passage.' },
        { kind: 'text', text: '' },
      ],
      { textShots: false }
    );

    // The next draft starts ticked.
    await openCreate(shareComposer);
    expect(shareComposer.bluesky).toBe(true);
  });

  it('does not cross-post when unticked', async () => {
    const { shareComposer } = await freshStores();
    await openCreate(shareComposer);
    await shareComposer.post();
    expect(crossPostToBluesky).not.toHaveBeenCalled();
  });

  it('does not cross-post when the linkblog share fails', async () => {
    const { shareComposer } = await freshStores();
    shareLink.mockResolvedValue('failed');
    await openCreate(shareComposer);
    shareComposer.setBluesky(true);
    expect(await shareComposer.post()).toBe(false);
    expect(crossPostToBluesky).not.toHaveBeenCalled();
  });

  it('is not offered when editing a posted share', async () => {
    const { preferences, shareComposer } = await freshStores();
    preferences.setBlueskyCrossPost(true);
    shareComposer.open({ article: ARTICLE, mode: 'edit', initialNote: 'hi' } as never);
    await Promise.resolve();
    expect(shareComposer.blueskyOffered).toBe(false);
    expect(shareComposer.bluesky).toBe(false);
  });
});
