import { describe, expect, it } from 'vitest';
import type { FeedbackPost } from '$lib/services/api';
import {
  DEFAULT_FEEDBACK_TYPES,
  feedbackTypes,
  filterByStatusScope,
  hasClosedPosts,
  isPostClosed,
  postStatus,
  sortFeedbackPosts,
  statusLabel,
} from './feedbackBoard';

function post(overrides: Partial<FeedbackPost> & { uri: string }): FeedbackPost {
  return {
    url: `https://userinput.app/d/did:plc:alice/${overrides.uri}`,
    author: { did: 'did:plc:alice', handle: 'alice.test', displayName: null, avatar: null },
    title: 'A post',
    body: '',
    tags: [],
    createdAt: '2026-09-01T12:00:00Z',
    votes: { up: 0, down: 0, net: 0 },
    replyCount: 0,
    status: null,
    ...overrides,
  };
}

describe('feedbackTypes', () => {
  it('falls back to the default vocabulary for a board with no types', () => {
    expect(feedbackTypes(undefined, [])).toEqual(DEFAULT_FEEDBACK_TYPES);
  });

  it('keeps the board’s own order and labels', () => {
    const configured = [
      { value: 'defect', label: 'Defect' },
      { value: 'idea', label: 'Idea' },
    ];
    expect(feedbackTypes(configured, [])).toEqual(configured);
  });

  it('keeps a type a post carries but the board no longer lists', () => {
    // Upstream data outlives a board's tag config; dropping the type would
    // leave that post's pill labelled with a raw slug.
    const types = feedbackTypes(
      [{ value: 'defect', label: 'Defect' }],
      [post({ uri: 'a', tags: ['retired-tag'] })]
    );
    expect(types).toEqual([
      { value: 'defect', label: 'Defect' },
      { value: 'retired-tag', label: 'Retired tag' },
    ]);
  });
});

describe('statuses', () => {
  it('reports an untriaged post as open', () => {
    expect(postStatus(post({ uri: 'a' }))).toBe('open');
    expect(statusLabel('under-review')).toBe('Under review');
  });

  it('counts only a settled status as closed', () => {
    // A status nobody here has heard of is open: it is a state the board is
    // passing a post through, and hiding it by default would lose it.
    expect(isPostClosed(post({ uri: 'a', status: 'implemented' }))).toBe(true);
    expect(isPostClosed(post({ uri: 'b', status: 'declined' }))).toBe(true);
    expect(isPostClosed(post({ uri: 'c', status: 'planned' }))).toBe(false);
    expect(isPostClosed(post({ uri: 'd', status: null }))).toBe(false);
    expect(isPostClosed(post({ uri: 'e', status: 'something-new' }))).toBe(false);
  });

  it('knows whether the board has closed anything at all', () => {
    expect(hasClosedPosts([post({ uri: 'a' }), post({ uri: 'b', status: 'planned' })])).toBe(false);
    expect(hasClosedPosts([post({ uri: 'a' }), post({ uri: 'b', status: 'duplicate' })])).toBe(
      true
    );
  });
});

describe('filterByStatusScope', () => {
  const posts = [
    post({ uri: 'live' }),
    post({ uri: 'shipped', status: 'implemented' }),
    post({ uri: 'planned', status: 'planned' }),
  ];

  it('splits the board in two, and hands back all of it on request', () => {
    expect(filterByStatusScope(posts, 'open').map((entry) => entry.uri)).toEqual([
      'live',
      'planned',
    ]);
    expect(filterByStatusScope(posts, 'closed').map((entry) => entry.uri)).toEqual(['shipped']);
    expect(filterByStatusScope(posts, 'all')).toEqual(posts);
  });
});

describe('sortFeedbackPosts', () => {
  const older = post({
    uri: 'older',
    createdAt: '2026-09-01T12:00:00Z',
    votes: { up: 9, down: 0, net: 9 },
  });
  const newer = post({
    uri: 'newer',
    createdAt: '2026-09-05T12:00:00Z',
    votes: { up: 1, down: 0, net: 1 },
  });

  it('orders by net votes, then recency', () => {
    expect(sortFeedbackPosts([newer, older], 'top').map((p) => p.uri)).toEqual(['older', 'newer']);
    expect(sortFeedbackPosts([older, newer], 'new').map((p) => p.uri)).toEqual(['newer', 'older']);
  });

  it('does not mutate the input', () => {
    const input = [newer, older];
    sortFeedbackPosts(input, 'top');
    expect(input.map((p) => p.uri)).toEqual(['newer', 'older']);
  });
});
