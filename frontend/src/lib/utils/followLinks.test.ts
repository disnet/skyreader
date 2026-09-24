import { describe, it, expect, vi } from 'vitest';

// followLinks.ts imports the label store (and through it the api client); the
// pure helpers under test don't touch either.
vi.mock('$lib/stores/itemLabels.svelte', () => ({ itemLabelsStore: {} }));
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: {} }));
vi.mock('$lib/utils/roomArticle', () => ({ extractArticle: vi.fn() }));

import {
  bskyPostUrl,
  followLinkArticle,
  followLinkSaid,
  followLinkTitle,
  sharedByLabel,
  sharedByPill,
  sharedByShort,
  titleFromUrl,
} from './followLinks';

describe('sharedByLabel', () => {
  const maya = { name: 'Maya', handle: 'maya.bsky.social' };
  const ben = { name: null, handle: 'ben.example.com' };
  const nobody = { name: '  ', handle: null };

  it('names one or two sharers, then counts the rest', () => {
    expect(sharedByLabel([maya])).toBe('Maya shared this');
    expect(sharedByLabel([maya, ben])).toBe('Maya and ben.example.com shared this');
    expect(sharedByLabel([maya, ben, nobody, ben])).toBe('Maya and 3 others shared this');
  });

  it('falls back to the handle, then to "Someone"', () => {
    expect(sharedByLabel([nobody])).toBe('Someone shared this');
  });

  it('is empty for no sharers', () => {
    expect(sharedByLabel([])).toBe('');
  });
});

describe('bskyPostUrl', () => {
  it('maps a post at-uri to its bsky.app page', () => {
    expect(bskyPostUrl('at://did:plc:abc/app.bsky.feed.post/3kxyz')).toBe(
      'https://bsky.app/profile/did:plc:abc/post/3kxyz'
    );
  });

  it("falls back to the author's profile, then to bsky.app", () => {
    expect(bskyPostUrl('at://did:plc:abc/app.bsky.feed.repost/3kxyz')).toBe(
      'https://bsky.app/profile/did:plc:abc'
    );
    expect(bskyPostUrl('not a uri')).toBe('https://bsky.app');
  });
});

describe('titleFromUrl', () => {
  it('reads a word slug as a title', () => {
    expect(
      titleFromUrl(
        'https://www.garbageday.email/p/microdramas-are-the-death-rattle-of-hollywood',
        'garbageday.email'
      )
    ).toBe('Microdramas are the death rattle of hollywood');
    expect(titleFromUrl('https://a.example/2026/09/on_slow_reading.html', 'a.example')).toBe(
      'On slow reading'
    );
  });

  it('allows plain numbers among the words, and keeps an acronym', () => {
    expect(titleFromUrl('https://a.example/p/best-books-of-2026', 'a.example')).toBe(
      'Best books of 2026'
    );
    expect(titleFromUrl('https://a.example/p/what-AI-reads-for', 'a.example')).toBe(
      'What AI reads for'
    );
  });

  it('keeps the site for ids, short paths, and the root', () => {
    expect(titleFromUrl('https://meri.leaflet.pub/3mw3nb6ofps2n', 'meri.leaflet.pub')).toBe(
      'meri.leaflet.pub'
    );
    expect(titleFromUrl('https://a.example/about', 'a.example')).toBe('a.example');
    expect(titleFromUrl('https://a.example/', 'a.example')).toBe('a.example');
    expect(titleFromUrl('https://a.example/x/a1b2-c3d4-e5f6', 'a.example')).toBe('a.example');
    expect(titleFromUrl('https://a.example/x/2026-09-24', 'a.example')).toBe('a.example');
    expect(titleFromUrl('https://a.example/x/top-10', 'a.example')).toBe('a.example');
  });
});

describe('followLinkTitle', () => {
  it('prefers the card title', () => {
    expect(
      followLinkTitle({ title: 'Card &amp; title', url: 'https://a.example/x', site: 'a.example' })
    ).toBe('Card & title');
  });
});

describe('sharedByShort', () => {
  it('fits a lane tile: first name for one, a count for more', () => {
    expect(sharedByShort([{ name: 'Maya Ortiz', handle: 'maya.bsky.social' }])).toBe('Maya shared');
    expect(sharedByShort([{ name: null, handle: 'ben.example.com' }])).toBe(
      'ben.example.com shared'
    );
    expect(
      sharedByShort([
        { name: 'A', handle: null },
        { name: 'B', handle: null },
        { name: 'C', handle: null },
      ])
    ).toBe('3 shared');
  });
});

describe('sharedByPill', () => {
  it('names the latest sharer and counts the rest', () => {
    expect(sharedByPill([{ name: 'Maya Ortiz', handle: 'maya.bsky.social' }])).toBe('Maya Ortiz');
    expect(
      sharedByPill([
        { name: null, handle: 'ben.example.com' },
        { name: 'A', handle: null },
        { name: 'B', handle: null },
      ])
    ).toBe('ben.example.com +2');
    expect(sharedByPill([])).toBe('');
  });
});

describe('followLinkArticle', () => {
  it('renders a link as an article: keyed by its normalized URL, dated by its first share', () => {
    const article = followLinkArticle({
      url: 'https://a.example/on-slow-reading-well?utm_source=bsky',
      urlNormalized: 'https://a.example/on-slow-reading-well',
      site: 'a.example',
      title: null,
      description: 'A &amp; B',
      thumb: 'https://cdn.example/t.jpg',
      sharers: [],
      sharerCount: 0,
      firstSharedAt: Date.UTC(2026, 8, 20),
      lastSharedAt: Date.UTC(2026, 8, 22),
    });
    expect(article).toMatchObject({
      guid: 'https://a.example/on-slow-reading-well',
      url: 'https://a.example/on-slow-reading-well?utm_source=bsky',
      title: 'On slow reading well',
      summary: 'A & B',
      imageUrl: 'https://cdn.example/t.jpg',
      publishedAt: '2026-09-20T00:00:00.000Z',
      subscriptionId: -1,
    });
  });
});

describe('followLinkSaid', () => {
  const base = {
    url: 'https://a.example/x',
    urlNormalized: 'https://a.example/x',
    site: 'a.example',
    title: null,
    description: null,
    thumb: null,
    sharerCount: 2,
    firstSharedAt: 0,
    lastSharedAt: 0,
  };
  const sharer = (over: Partial<import('$lib/types').FollowLinkSharer>) => ({
    did: 'did:plc:x',
    handle: 'x.bsky.social',
    name: null,
    avatar: null,
    kind: 'post' as const,
    postUri: 'at://did:plc:x/app.bsky.feed.post/1',
    text: null,
    sharedAt: 0,
    ...over,
  });

  it('takes the most-liked worded share, the latest on a tie', () => {
    const said = (likes: (number | null)[]) =>
      followLinkSaid({
        ...base,
        sharers: likes.map((likeCount, i) =>
          sharer({ name: `S${i}`, text: `words ${i}`, likeCount })
        ),
      })?.name;
    expect(said([2, 40, 7])).toBe('S1');
    expect(said([5, 5])).toBe('S0');
    // Unknown counts (older rows) read as none, so the latest one wins.
    expect(said([null, null])).toBe('S0');
    expect(said([null, 1])).toBe('S1');
  });

  it('never quotes a repost, however liked', () => {
    expect(
      followLinkSaid({
        ...base,
        sharers: [
          sharer({ kind: 'repost', name: 'Ben', text: 'not his words', likeCount: 99 }),
          sharer({ name: 'Maya', text: 'mine', likeCount: 0 }),
        ],
      })
    ).toEqual({ text: 'mine', name: 'Maya' });
  });

  it('takes the latest sharer who said something, skipping bare reposts', () => {
    expect(
      followLinkSaid({
        ...base,
        sharers: [
          sharer({ kind: 'repost', name: 'Ben', text: 'ignored' }),
          sharer({ name: 'Maya', text: '  Read this  ' }),
        ],
      })
    ).toEqual({ text: 'Read this', name: 'Maya' });
  });

  it('is null when nobody said anything', () => {
    expect(followLinkSaid({ ...base, sharers: [sharer({ kind: 'repost' })] })).toBeNull();
  });
});
