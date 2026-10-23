import { describe, it, expect, vi } from 'vitest';
import type { FollowingPublication } from '$lib/types';
import { findFollowFeeds, sharedHandleParents, siteCandidates, siteLabel } from './followSites';

const sites = (follow: { handle: string | null; description?: string }, parents?: Set<string>) =>
  siteCandidates(follow, parents).map((c) => `${c.source}:${c.site}`);

describe('siteCandidates', () => {
  it("offers a domain handle's own site", () => {
    expect(sites({ handle: 'strangeloopcanon.com' })).toEqual(['handle:strangeloopcanon.com']);
  });

  it('skips handles on a hosting provider', () => {
    expect(sites({ handle: 'someone.bsky.social' })).toEqual([]);
    expect(sites({ handle: 'someone.eurosky.social' })).toEqual([]);
    expect(sites({ handle: 'someone.mastodon.social.ap.brid.gy' })).toEqual([]);
    expect(sites({ handle: 'did:plc:abc' })).toEqual([]);
    expect(sites({ handle: null })).toEqual([]);
  });

  it('skips handles under a parent several follows share', () => {
    const parents = sharedHandleParents([
      { handle: 'a.community.social' },
      { handle: 'b.community.social' },
      { handle: 'c.community.social' },
      { handle: 'blog.someone.com' },
    ]);
    expect(parents).toEqual(new Set(['community.social']));
    expect(sites({ handle: 'd.community.social' }, parents)).toEqual([]);
    // People with their own domains under a country suffix aren't a provider.
    const uk = sharedHandleParents([
      { handle: 'alice.co.uk' },
      { handle: 'bob.co.uk' },
      { handle: 'carol.co.uk' },
    ]);
    expect(uk.size).toBe(0);
    expect(sites({ handle: 'dave.co.uk' }, uk)).toEqual(['handle:dave.co.uk']);
    // One account's own subdomain is still theirs.
    expect(sites({ handle: 'blog.someone.com' }, parents)).toEqual(['handle:blog.someone.com']);
  });

  it('finds blog links in a bio, with or without a scheme, at their root', () => {
    expect(
      sites({
        handle: 'someone.bsky.social',
        description:
          'I think, I write | Read essays here https://www.example.com/essays | newsletter: someone.substack.com.',
      })
    ).toEqual(['profile:example.com', 'profile:someone.substack.com']);
  });

  it('skips social profiles, handles, emails and file names in a bio', () => {
    expect(
      sites({
        handle: 'someone.bsky.social',
        description:
          '💕 @partner.bsky.social · me@mail.example · github.com/someone · https://hachyderm.io/@someone · I like Node.js · linktr.ee/someone',
      })
    ).toEqual([]);
  });

  it('keeps the path where the path is the blog', () => {
    expect(
      sites({ handle: 'someone.bsky.social', description: 'Writing at medium.com/@someone' })
    ).toEqual(['profile:medium.com/@someone']);
  });

  it("doesn't ask twice about the handle's own site, and caps bio links", () => {
    expect(
      sites({
        handle: 'cassidoo.co',
        description:
          'Subscribe to my newsletter! cassidoo.co/newslett · a.example · b.example · c.example',
      })
    ).toEqual(['handle:cassidoo.co', 'profile:a.example', 'profile:b.example']);
  });
});

describe('siteLabel', () => {
  it('reads like the site', () => {
    expect(siteLabel('https://www.example.com/')).toBe('example.com');
    expect(siteLabel('medium.com/@someone')).toBe('medium.com/@someone');
  });
});

describe('findFollowFeeds', () => {
  const writer = {
    did: 'did:plc:writer',
    handle: 'writer.example',
    displayName: 'Writer',
    description: 'Newsletter: writer.substack.com',
  };
  const friend = {
    did: 'did:plc:friend',
    handle: 'friend.bsky.social',
    description: 'writer.substack.com',
  };

  it('offers the first feed at each site, once per feed, asking once per site', async () => {
    const discover = vi.fn(
      async () =>
        new Map([
          ['writer.example', ['https://writer.example/feed.xml', 'https://writer.example/atom']],
          ['writer.substack.com', ['https://writer.substack.com/feed']],
        ])
    );
    const feeds = await findFollowFeeds([writer, friend], [], new Set(), discover);

    expect(discover).toHaveBeenCalledWith(['writer.example', 'writer.substack.com']);
    expect(feeds.map((f) => [f.did, f.publicationUri, f.siteSource, f.name])).toEqual([
      ['did:plc:writer', 'https://writer.example/feed.xml', 'handle', 'writer.example'],
      ['did:plc:writer', 'https://writer.substack.com/feed', 'profile', 'writer.substack.com'],
    ]);
    expect(feeds[0]).toMatchObject({ kind: 'feed', url: 'https://writer.example' });
  });

  it("skips a site that is already one of the account's publications", async () => {
    const publication = {
      did: 'did:plc:writer',
      url: 'https://www.writer.example/',
      publicationUri: 'at://did:plc:writer/site.standard.publication/self',
    } as FollowingPublication;
    const discover = vi.fn(async () => new Map<string, string[]>());
    await findFollowFeeds([writer], [publication], new Set(), discover);
    expect(discover).toHaveBeenCalledWith(['writer.substack.com']);
  });

  it('keeps the earlier feed for a site the lookup could not answer', async () => {
    const before = await findFollowFeeds(
      [writer],
      [],
      new Set(),
      async () => new Map([['writer.example', ['https://writer.example/feed.xml']]])
    );
    // This time the handle's site comes back unknown (null) and the bio's isn't
    // answered at all: the first is kept, the second was never found.
    const after = await findFollowFeeds(
      [writer],
      [],
      new Set(),
      async () => new Map([['writer.example', null]]),
      before
    );
    expect(after.map((f) => f.publicationUri)).toEqual(['https://writer.example/feed.xml']);

    // A real "no feed" answer does drop it.
    const gone = await findFollowFeeds(
      [writer],
      [],
      new Set(),
      async () => new Map([['writer.example', []]]),
      before
    );
    expect(gone).toEqual([]);
  });

  it("doesn't call the backend when no follow has a site", async () => {
    const discover = vi.fn();
    expect(
      await findFollowFeeds(
        [{ did: 'did:plc:x', handle: 'x.bsky.social' }],
        [],
        new Set(),
        discover
      )
    ).toEqual([]);
    expect(discover).not.toHaveBeenCalled();
  });
});

describe('links listed on Bluesky and Sifa profiles', () => {
  it('come first, and a listed feed needs no lookup', async () => {
    const follow = {
      did: 'did:plc:pro',
      handle: 'pro.example',
      profileLinks: [
        {
          source: 'sifa' as const,
          url: 'https://notes.pro.example/',
          feedUrl: 'https://notes.pro.example/rss',
          label: 'Notes',
        },
        { source: 'bluesky' as const, url: 'https://essays.example/' },
        { source: 'bluesky' as const, url: 'https://github.com/pro' },
      ],
    };
    expect(sites(follow)).toEqual([
      'sifa:notes.pro.example',
      'bluesky:essays.example',
      'handle:pro.example',
    ]);

    const discover = vi.fn(
      async () => new Map([['essays.example', ['https://essays.example/feed']]])
    );
    const feeds = await findFollowFeeds([follow], [], new Set(), discover);
    expect(discover).toHaveBeenCalledWith(['essays.example', 'pro.example']);
    expect(feeds.map((f) => [f.publicationUri, f.name, f.siteSource])).toEqual([
      ['https://notes.pro.example/rss', 'Notes', 'sifa'],
      ['https://essays.example/feed', 'essays.example', 'bluesky'],
    ]);
  });
});
