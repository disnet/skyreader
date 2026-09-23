import { describe, it, expect } from 'vitest';
import {
  extractLinkShare,
  extractLinkShares,
  SHARE_TEXT_MAX,
  type TimelineItem,
} from '../src/services/follow-links';

// From your follows (docs/plans/FOLLOWS_LINKS_PLAN.md): which Following-timeline
// items count as a link share, and who gets credit for it.
//
// What matters here:
//  - Reposts credit the reposter, not the author, and use the repost's time.
//  - Replies, pins, the viewer's own posts, and links back into Bluesky are skipped.
//  - The link card wins over a facet; a facet is the fallback when there's no card.
//  - A link card inside recordWithMedia still counts, and makes the post a quote.
//  - Quoting someone else's link post shares that link; the quoter is the sharer.

const VIEWER = 'did:plc:viewer';
const MAYA = { did: 'did:plc:maya', handle: 'maya.bsky.social', displayName: 'Maya' };
const BEN = { did: 'did:plc:ben', handle: 'ben.example.com' };

function linkPost(overrides: Partial<NonNullable<TimelineItem['post']>> = {}): TimelineItem {
  return {
    post: {
      uri: 'at://did:plc:maya/app.bsky.feed.post/3aaa',
      author: MAYA,
      record: { text: 'Worth your time.' },
      embed: {
        $type: 'app.bsky.embed.external#view',
        external: {
          uri: 'https://example.com/essay?utm_source=bsky',
          title: 'An essay',
          description: 'About reading',
          thumb: 'https://cdn.example/thumb.jpg',
        },
      },
      indexedAt: '2026-09-20T10:00:00.000Z',
      ...overrides,
    },
  };
}

describe('extractLinkShare', () => {
  it('takes a link-card post, crediting its author', () => {
    const share = extractLinkShare(linkPost(), VIEWER);
    expect(share).toMatchObject({
      kind: 'post',
      sharer: { did: MAYA.did, handle: MAYA.handle },
      url: 'https://example.com/essay?utm_source=bsky',
      urlNormalized: 'https://example.com/essay',
      text: 'Worth your time.',
      card: { title: 'An essay' },
      sharedAt: '2026-09-20T10:00:00.000Z',
    });
  });

  it('credits a repost to the reposter at the repost time', () => {
    const item: TimelineItem = {
      ...linkPost(),
      reason: {
        $type: 'app.bsky.feed.defs#reasonRepost',
        by: BEN,
        indexedAt: '2026-09-21T08:00:00.000Z',
      },
    };
    expect(extractLinkShare(item, VIEWER)).toMatchObject({
      kind: 'repost',
      sharer: { did: BEN.did },
      sharedAt: '2026-09-21T08:00:00.000Z',
    });
  });

  it('skips a pinned-post reason', () => {
    const item: TimelineItem = { ...linkPost(), reason: { $type: 'app.bsky.feed.defs#reasonPin' } };
    expect(extractLinkShare(item, VIEWER)).toBeNull();
  });

  it('skips replies', () => {
    const item = linkPost({ record: { text: 'see this', reply: { root: {}, parent: {} } } });
    expect(extractLinkShare(item, VIEWER)).toBeNull();
  });

  it("skips the viewer's own posts and reposts", () => {
    expect(extractLinkShare(linkPost({ author: { did: VIEWER } }), VIEWER)).toBeNull();
    const ownRepost: TimelineItem = {
      ...linkPost(),
      reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: { did: VIEWER } },
    };
    expect(extractLinkShare(ownRepost, VIEWER)).toBeNull();
  });

  it('falls back to the first link facet when there is no card', () => {
    const item = linkPost({
      embed: undefined,
      record: {
        text: 'read this and that',
        facets: [
          { features: [{ $type: 'app.bsky.richtext.facet#mention' }] },
          { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://a.example/one' }] },
          { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://b.example/two' }] },
        ],
      },
    });
    expect(extractLinkShare(item, VIEWER)).toMatchObject({
      url: 'https://a.example/one',
      card: null,
    });
  });

  it('prefers the card over a facet link', () => {
    const item = linkPost({
      record: {
        text: 'x',
        facets: [
          { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://other.example' }] },
        ],
      },
    });
    expect(extractLinkShare(item, VIEWER)?.url).toBe('https://example.com/essay?utm_source=bsky');
  });

  it('reads a card inside recordWithMedia, as a quote', () => {
    const item = linkPost({
      embed: {
        $type: 'app.bsky.embed.recordWithMedia#view',
        media: {
          $type: 'app.bsky.embed.external#view',
          external: { uri: 'https://example.com/quoted-link' },
        },
      },
    });
    expect(extractLinkShare(item, VIEWER)).toMatchObject({
      kind: 'quote',
      url: 'https://example.com/quoted-link',
    });
  });

  it('marks a quote post whose link is a facet as a quote', () => {
    const item = linkPost({
      embed: { $type: 'app.bsky.embed.record#view' },
      record: {
        text: 'agree, and see',
        facets: [
          { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://c.example' }] },
        ],
      },
    });
    expect(extractLinkShare(item, VIEWER)?.kind).toBe('quote');
  });

  it('counts quoting a link post as sharing its link, with the quoter as sharer', () => {
    const item = linkPost({
      record: { text: 'This is the one to read.' },
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          $type: 'app.bsky.embed.record#viewRecord',
          embeds: [
            {
              $type: 'app.bsky.embed.external#view',
              external: { uri: 'https://example.com/quoted-card', title: 'Quoted card' },
            },
          ],
        },
      },
    });
    expect(extractLinkShare(item, VIEWER)).toMatchObject({
      kind: 'quote',
      sharer: { did: MAYA.did },
      url: 'https://example.com/quoted-card',
      text: 'This is the one to read.',
      card: { title: 'Quoted card' },
    });
  });

  it('finds the quoted card through recordWithMedia too', () => {
    const item = linkPost({
      embed: {
        $type: 'app.bsky.embed.recordWithMedia#view',
        media: { $type: 'app.bsky.embed.images#view' },
        record: {
          record: {
            embeds: [
              {
                $type: 'app.bsky.embed.external#view',
                external: { uri: 'https://example.com/deep' },
              },
            ],
          },
        },
      },
    });
    expect(extractLinkShare(item, VIEWER)?.url).toBe('https://example.com/deep');
  });

  it("prefers the quoter's own facet link over the quoted card", () => {
    const item = linkPost({
      record: {
        text: 'see also',
        facets: [
          { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://own.example' }] },
        ],
      },
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          embeds: [
            {
              $type: 'app.bsky.embed.external#view',
              external: { uri: 'https://example.com/quoted-card' },
            },
          ],
        },
      },
    });
    expect(extractLinkShare(item, VIEWER)).toMatchObject({
      url: 'https://own.example',
      card: null,
    });
  });

  it('skips links back into Bluesky and Skyreader', () => {
    for (const uri of [
      'https://bsky.app/profile/maya/post/3aaa',
      'https://maya.bsky.social',
      'https://go.bsky.app/abc',
      'https://linkblogs.skyreader.app/maya',
    ]) {
      const item = linkPost({
        embed: { $type: 'app.bsky.embed.external#view', external: { uri } },
      });
      expect(extractLinkShare(item, VIEWER), uri).toBeNull();
    }
  });

  it('skips posts with no link, and non-http links', () => {
    expect(extractLinkShare(linkPost({ embed: undefined }), VIEWER)).toBeNull();
    const item = linkPost({
      embed: { $type: 'app.bsky.embed.external#view', external: { uri: 'mailto:a@b.c' } },
    });
    expect(extractLinkShare(item, VIEWER)).toBeNull();
  });

  it('skips malformed items instead of throwing', () => {
    expect(extractLinkShare({}, VIEWER)).toBeNull();
    expect(extractLinkShare({ post: { uri: 'at://x' } }, VIEWER)).toBeNull();
  });

  it('truncates long text', () => {
    const share = extractLinkShare(linkPost({ record: { text: 'a'.repeat(1000) } }), VIEWER);
    expect(share?.text).toHaveLength(SHARE_TEXT_MAX);
  });
});

describe('extractLinkShares', () => {
  it('keeps only the shares, in order', () => {
    const shares = extractLinkShares(
      [linkPost(), linkPost({ embed: undefined }), linkPost({ author: BEN })],
      VIEWER
    );
    expect(shares.map((s) => s.sharer.did)).toEqual([MAYA.did, BEN.did]);
  });
});
