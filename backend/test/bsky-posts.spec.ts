import { describe, it, expect } from 'vitest';
import {
  detectFacets,
  graphemeLength,
  normalizeFeedItem,
  resolveMentions,
  segmentText,
} from '../src/services/bsky-posts';
import { savedFeedUris } from '../src/routes/bsky';

// Bluesky feeds as sources (docs/plans/BLUESKY_FEEDS_PLAN.md): the pure half.
// Facets index UTF-8 bytes; a post shaped wrong is skipped, not thrown on.

const enc = new TextEncoder();
const span = (text: string, part: string) => {
  const start = enc.encode(text.slice(0, text.indexOf(part))).length;
  return { byteStart: start, byteEnd: start + enc.encode(part).length };
};

describe('segmentText', () => {
  it('splits text at its facets, by UTF-8 byte offsets', () => {
    const text = 'café → see example.com and @bob.test';
    const segs = segmentText(text, [
      {
        index: span(text, 'example.com'),
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }],
      },
      {
        index: span(text, '@bob.test'),
        features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:bob' }],
      },
    ]);
    expect(segs).toEqual([
      { text: 'café → see ' },
      { text: 'example.com', link: 'https://example.com' },
      { text: ' and ' },
      { text: '@bob.test', mention: 'did:plc:bob' },
    ]);
  });

  it('drops overlapping, out-of-range and unknown facets', () => {
    const text = 'hello world';
    const segs = segmentText(text, [
      { index: { byteStart: 0, byteEnd: 5 }, features: [{ $type: 'x#unknown' }] },
      {
        index: { byteStart: 0, byteEnd: 5 },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'hello' }],
      },
      {
        index: { byteStart: 3, byteEnd: 8 },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'overlap' }],
      },
      {
        index: { byteStart: 6, byteEnd: 99 },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'range' }],
      },
    ]);
    expect(segs).toEqual([{ text: 'hello', tag: 'hello' }, { text: ' world' }]);
  });
});

describe('normalizeFeedItem', () => {
  const author = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice' };

  it('keeps the post, its link card, counts and the reader’s like', () => {
    const post = normalizeFeedItem({
      post: {
        uri: 'at://did:plc:alice/app.bsky.feed.post/3abc',
        cid: 'bafyreiaaaaaaaa',
        author,
        record: { text: 'read this', createdAt: '2026-09-01T00:00:00Z' },
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: { uri: 'https://example.com/a', title: 'A', description: 'about a' },
        },
        likeCount: 4,
        indexedAt: '2026-09-01T00:00:01Z',
        viewer: { like: 'at://did:plc:me/app.bsky.feed.like/1' },
      },
    });
    expect(post).toMatchObject({
      url: 'https://bsky.app/profile/alice.test/post/3abc',
      text: 'read this',
      external: { uri: 'https://example.com/a', title: 'A' },
      likeCount: 4,
      replyCount: 0,
      viewer: { like: 'at://did:plc:me/app.bsky.feed.like/1' },
      sortAt: '2026-09-01T00:00:01Z',
      replyRef: {
        root: { uri: 'at://did:plc:alice/app.bsky.feed.post/3abc', cid: 'bafyreiaaaaaaaa' },
        parent: { uri: 'at://did:plc:alice/app.bsky.feed.post/3abc', cid: 'bafyreiaaaaaaaa' },
      },
    });
  });

  it('points a reply at the thread root, and says who it replies to', () => {
    const root = { uri: 'at://did:plc:root/app.bsky.feed.post/r', cid: 'bafyreiroot0000' };
    const post = normalizeFeedItem({
      post: {
        uri: 'at://did:plc:alice/app.bsky.feed.post/3abc',
        cid: 'bafyreiaaaaaaaa',
        author,
        record: { text: 'agreed', reply: { root, parent: root } },
      },
      reply: {
        parent: {
          uri: root.uri,
          author: { did: 'did:plc:root', handle: 'root.test' },
          record: { text: 'the original' },
        },
      },
    });
    expect(post?.replyRef?.root).toEqual(root);
    expect(post?.replyParent).toEqual({
      author: { did: 'did:plc:root', handle: 'root.test' },
      text: 'the original',
    });
  });

  it('dates a repost by the repost and names the reposter', () => {
    const post = normalizeFeedItem({
      post: {
        uri: 'at://did:plc:alice/app.bsky.feed.post/3abc',
        cid: 'bafyreiaaaaaaaa',
        author,
        record: { text: 'old' },
        indexedAt: '2026-01-01T00:00:00Z',
      },
      reason: {
        $type: 'app.bsky.feed.defs#reasonRepost',
        by: { did: 'did:plc:bob', handle: 'bob.test' },
        indexedAt: '2026-09-01T00:00:00Z',
      },
    });
    expect(post?.repostedBy).toEqual({ did: 'did:plc:bob', handle: 'bob.test' });
    expect(post?.sortAt).toBe('2026-09-01T00:00:00Z');
  });

  it('reads a quote with media, and marks an unavailable quote', () => {
    const withMedia = normalizeFeedItem({
      post: {
        uri: 'at://did:plc:alice/app.bsky.feed.post/q',
        cid: 'bafyreiaaaaaaaa',
        author,
        record: { text: 'look' },
        embed: {
          $type: 'app.bsky.embed.recordWithMedia#view',
          media: {
            $type: 'app.bsky.embed.images#view',
            images: [{ thumb: 't', fullsize: 'f', alt: 'a cat' }],
          },
          record: {
            record: {
              $type: 'app.bsky.embed.record#viewRecord',
              uri: 'at://did:plc:bob/app.bsky.feed.post/b',
              author: { did: 'did:plc:bob', handle: 'bob.test' },
              value: { text: 'quoted', createdAt: '2026-09-01T00:00:00Z' },
            },
          },
        },
      },
    });
    expect(withMedia?.images).toEqual([{ thumb: 't', fullsize: 'f', alt: 'a cat' }]);
    expect(withMedia?.quote).toMatchObject({
      url: 'https://bsky.app/profile/bob.test/post/b',
      text: 'quoted',
    });

    const blocked = normalizeFeedItem({
      post: {
        uri: 'at://did:plc:alice/app.bsky.feed.post/q2',
        cid: 'bafyreiaaaaaaaa',
        author,
        record: { text: 'x' },
        embed: {
          $type: 'app.bsky.embed.record#view',
          record: { $type: 'app.bsky.embed.record#viewBlocked' },
        },
      },
    });
    expect(blocked?.quote).toEqual({ unavailable: 'blocked' });
  });

  it('hides labeled media behind a warning', () => {
    const post = normalizeFeedItem({
      post: {
        uri: 'at://did:plc:alice/app.bsky.feed.post/n',
        cid: 'bafyreiaaaaaaaa',
        author,
        record: { text: '' },
        labels: [{ val: 'graphic-media' }],
      },
    });
    expect(post?.mediaWarning).toBe('graphic-media');
  });

  it('skips an item with no post, uri, cid or author', () => {
    expect(normalizeFeedItem({})).toBeNull();
    expect(normalizeFeedItem({ post: { uri: 'at://x', author } })).toBeNull();
  });
});

describe('detectFacets', () => {
  it('finds links, mentions and tags with byte spans', () => {
    const text = 'ça: https://example.com/a?b=1. cc @bob.test #reading';
    const { facets, handles } = detectFacets(text);
    expect(handles).toEqual(['bob.test']);
    const resolved = resolveMentions(facets, new Map([['bob.test', 'did:plc:bob']]));
    expect(resolved).toEqual([
      {
        index: span(text, 'https://example.com/a?b=1'),
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/a?b=1' }],
      },
      {
        index: span(text, '@bob.test'),
        features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:bob' }],
      },
      {
        index: span(text, '#reading'),
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'reading' }],
      },
    ]);
  });

  it('keeps a paren that belongs to the URL, drops one that closes the sentence', () => {
    const inner = detectFacets('see https://en.wikipedia.org/wiki/Foo_(bar)').facets[0];
    expect(inner).toMatchObject({ features: [{ uri: 'https://en.wikipedia.org/wiki/Foo_(bar)' }] });
    const outer = detectFacets('(see https://example.com/x)').facets[0];
    expect(outer).toMatchObject({ features: [{ uri: 'https://example.com/x' }] });
  });

  it('does not tag a number, or mention inside a URL', () => {
    const { facets } = detectFacets('#1 https://example.com/@bob.test#frag');
    expect(facets).toHaveLength(1);
    expect(facets[0]).toMatchObject({ features: [{ $type: 'app.bsky.richtext.facet#link' }] });
  });

  it('leaves an unresolved mention as plain text', () => {
    const { facets } = detectFacets('hi @nobody.test');
    expect(resolveMentions(facets, new Map())).toEqual([]);
  });
});

describe('graphemeLength', () => {
  it('counts graphemes, not code units', () => {
    expect(graphemeLength('👩‍👩‍👧 é')).toBe(3);
  });
});

describe('savedFeedUris', () => {
  const gen = (n: string) => `at://did:plc:creator/app.bsky.feed.generator/${n}`;

  it('reads v2 prefs, pinned first, timeline as following, lists left out', () => {
    expect(
      savedFeedUris([
        { $type: 'app.bsky.actor.defs#adultContentPref', enabled: false },
        {
          $type: 'app.bsky.actor.defs#savedFeedsPrefV2',
          items: [
            { type: 'feed', value: gen('saved'), pinned: false },
            { type: 'timeline', value: 'following', pinned: true },
            { type: 'list', value: 'at://did:plc:x/app.bsky.graph.list/l', pinned: true },
            { type: 'feed', value: gen('pinned'), pinned: true },
          ],
        },
      ])
    ).toEqual(['following', gen('pinned'), gen('saved')]);
  });

  it('falls back to v1 prefs', () => {
    expect(
      savedFeedUris([
        {
          $type: 'app.bsky.actor.defs#savedFeedsPref',
          pinned: [gen('a')],
          saved: [gen('a'), gen('b')],
        },
      ])
    ).toEqual([gen('a'), gen('b')]);
  });
});
