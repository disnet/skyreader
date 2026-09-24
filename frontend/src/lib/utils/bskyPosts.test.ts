import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/roomArticle', () => ({ extractArticle: vi.fn() }));
vi.mock('$lib/utils/followLinks', () => ({ openOutside: vi.fn() }));

import { bskyPostLink, compactCount, graphemeLength, relativeTime } from './bskyPosts';
import type { BskyPost } from '$lib/types';

function post(over: Partial<BskyPost>): BskyPost {
  return {
    uri: 'at://did:plc:a/app.bsky.feed.post/p',
    cid: 'c',
    url: 'https://bsky.app/profile/a.test/post/p',
    author: { did: 'did:plc:a', handle: 'a.test' },
    text: '',
    segments: [],
    createdAt: '',
    indexedAt: '',
    replyCount: 0,
    repostCount: 0,
    likeCount: 0,
    quoteCount: 0,
    viewer: {},
    sortAt: '',
    ...over,
  };
}

describe('bskyPostLink', () => {
  it('prefers the link card, then a link in the text, then the quoted card', () => {
    const card = { uri: 'https://a.example/card', title: 'Card', description: '' };
    const quote = {
      uri: 'at://q',
      url: 'https://bsky.app/q',
      author: { did: 'did:plc:q', handle: 'q.test' },
      text: '',
      segments: [],
      createdAt: '',
      external: { uri: 'https://a.example/quoted', title: 'Q', description: '' },
    };
    const facets = [{ text: 'see ' }, { text: 'a.example/text', link: 'https://a.example/text' }];
    expect(bskyPostLink(post({ external: card, segments: facets, quote }))?.url).toBe(
      'https://a.example/card'
    );
    expect(bskyPostLink(post({ segments: facets, quote }))?.url).toBe('https://a.example/text');
    expect(bskyPostLink(post({ quote }))?.url).toBe('https://a.example/quoted');
  });

  it('skips links back to Bluesky itself', () => {
    const segments = [{ text: 'x', link: 'https://bsky.app/profile/b.test/post/1' }];
    expect(bskyPostLink(post({ segments }))).toBeNull();
  });
});

describe('formatting', () => {
  it('dates a post the way Bluesky does', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(relativeTime('2026-09-24T11:59:30Z', now)).toBe('30s');
    expect(relativeTime('2026-09-24T11:15:00Z', now)).toBe('45m');
    expect(relativeTime('2026-09-24T07:00:00Z', now)).toBe('5h');
    expect(relativeTime('2026-09-21T12:00:00Z', now)).toBe('3d');
    expect(relativeTime('not a date', now)).toBe('');
  });

  it('shortens counts', () => {
    expect(compactCount(999)).toBe('999');
    expect(compactCount(1234)).toBe('1.2K');
    expect(compactCount(12_400)).toBe('12K');
    expect(compactCount(3_400_000)).toBe('3.4M');
  });

  it('counts graphemes', () => {
    expect(graphemeLength('👩‍👩‍👧 é')).toBe(3);
  });
});
