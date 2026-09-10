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
