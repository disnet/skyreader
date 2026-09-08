import { describe, expect, it } from 'vitest';
import type { FeedbackPost } from '$lib/services/api';
import {
  DEFAULT_FEEDBACK_TYPES,
  UNTYPED,
  feedbackStatuses,
  feedbackTypes,
  filterFeedbackPosts,
  groupFeedbackPosts,
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
    // Upstream data outlives a board's tag config; dropping the type would hide
    // those posts behind a filter with no chip to select it.
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
  });

  it('lists only the statuses actually present, in triage order', () => {
    const posts = [
      post({ uri: 'a', status: 'implemented' }),
      post({ uri: 'b', status: null }),
      post({ uri: 'c', status: 'planned' }),
      post({ uri: 'd', status: 'something-new' }),
    ];
    expect(feedbackStatuses(posts)).toEqual(['open', 'planned', 'implemented', 'something-new']);
    expect(statusLabel('under-review')).toBe('Under review');
  });
});

describe('filterFeedbackPosts', () => {
  const posts = [
    post({ uri: 'bug-open', tags: ['bug'] }),
    post({ uri: 'bug-done', tags: ['bug'], status: 'implemented' }),
    post({ uri: 'untyped', status: 'implemented' }),
  ];

  it('filters by type and status independently and together', () => {
    expect(filterFeedbackPosts(posts, { type: null, status: null })).toHaveLength(3);
    expect(filterFeedbackPosts(posts, { type: 'bug', status: null }).map((p) => p.uri)).toEqual([
      'bug-open',
      'bug-done',
    ]);
    expect(
      filterFeedbackPosts(posts, { type: null, status: 'implemented' }).map((p) => p.uri)
    ).toEqual(['bug-done', 'untyped']);
    expect(
      filterFeedbackPosts(posts, { type: 'bug', status: 'implemented' }).map((p) => p.uri)
    ).toEqual(['bug-done']);
  });

  it('matches untyped posts only under the untyped bucket', () => {
    expect(filterFeedbackPosts(posts, { type: UNTYPED, status: null }).map((p) => p.uri)).toEqual([
      'untyped',
    ]);
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

describe('groupFeedbackPosts', () => {
  it('groups in vocabulary order, drops empty groups and puts untyped last', () => {
    const posts = [
      post({ uri: 'q', tags: ['question'] }),
      post({ uri: 'plain' }),
      post({ uri: 'b', tags: ['bug'] }),
    ];
    expect(
      groupFeedbackPosts(posts, DEFAULT_FEEDBACK_TYPES).map((g) => [
        g.label,
        g.posts.map((p) => p.uri),
      ])
    ).toEqual([
      ['Bug', ['b']],
      ['Question', ['q']],
      ['Other', ['plain']],
    ]);
  });

  it('keeps a post in exactly one group when it carries several tags', () => {
    const groups = groupFeedbackPosts(
      [post({ uri: 'multi', tags: ['bug', 'question'] })],
      DEFAULT_FEEDBACK_TYPES
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('bug');
  });
});
