import { describe, it, expect, vi } from 'vitest';

// followLinks.ts imports the store (and through it the api client); the pure
// helpers under test don't touch either.
vi.mock('$lib/stores/followLinks.svelte', () => ({ followLinksStore: {} }));
vi.mock('$lib/utils/roomArticle', () => ({ extractArticle: vi.fn() }));

import {
  bskyPostUrl,
  followLinkTitle,
  sharedByLabel,
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

  it('falls back to bsky.app for anything else', () => {
    expect(bskyPostUrl('at://did:plc:abc/app.bsky.feed.repost/3kxyz')).toBe('https://bsky.app');
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

  it('keeps the site for ids, short paths, and the root', () => {
    expect(titleFromUrl('https://meri.leaflet.pub/3mw3nb6ofps2n', 'meri.leaflet.pub')).toBe(
      'meri.leaflet.pub'
    );
    expect(titleFromUrl('https://a.example/about', 'a.example')).toBe('a.example');
    expect(titleFromUrl('https://a.example/', 'a.example')).toBe('a.example');
    expect(titleFromUrl('https://a.example/x/a1b2-c3d4-e5f6', 'a.example')).toBe('a.example');
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
