import { describe, it, expect, vi } from 'vitest';

// followLinks.ts (for bskyPostUrl) imports the store and the api client.
vi.mock('$lib/stores/itemLabels.svelte', () => ({ itemLabelsStore: {} }));
vi.mock('$lib/utils/roomArticle', () => ({ extractArticle: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: {} }));

import { byFollowedThenEngagement, followExtras, followShareEntry } from './discussionFollows';
import type { DiscussionEntryVM } from '$lib/components/articleCardView.types';
import type { FollowLinkSharer } from '$lib/types';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-23T12:00:00Z');

function sharer(over: Partial<FollowLinkSharer> = {}): FollowLinkSharer {
  return {
    did: 'did:plc:maya',
    handle: 'maya.bsky.social',
    name: 'Maya',
    avatar: null,
    kind: 'post',
    postUri: 'at://did:plc:maya/app.bsky.feed.post/3abc',
    text: 'Worth your whole afternoon.',
    sharedAt: NOW - HOUR,
    ...over,
  };
}

function row(over: Partial<DiscussionEntryVM>): DiscussionEntryVM {
  return {
    did: 'did:plc:x',
    handle: null,
    displayName: null,
    avatar: null,
    createdAt: null,
    note: null,
    url: null,
    collections: [],
    verb: null,
    quote: null,
    likeCount: null,
    key: 'k',
    lane: 'bluesky',
    laneLabel: 'Bluesky',
    laneIcon: 'bluesky',
    headVerb: 'posted',
    relativeTime: null,
    isoTime: null,
    cleanNote: null,
    ...over,
  };
}

describe('followShareEntry', () => {
  it('is a followed Bluesky row linking to the post', () => {
    expect(followShareEntry(sharer(), [])).toMatchObject({
      followed: true,
      lane: 'bluesky',
      headVerb: 'posted',
      url: 'https://bsky.app/profile/did:plc:maya/post/3abc',
      cleanNote: 'Worth your whole afternoon.',
    });
  });

  it("drops a repost's text: those are the original author's words", () => {
    const entry = followShareEntry(sharer({ kind: 'repost', text: 'Someone else said this' }), []);
    expect(entry).toMatchObject({ headVerb: 'reposted', note: null, cleanNote: null });
  });
});

describe('followExtras', () => {
  const maya = sharer();
  const ben = sharer({ did: 'did:plc:ben', name: 'Ben', kind: 'repost' });

  it('adds every follow share while no lane has resolved them', () => {
    expect(followExtras([maya, ben], new Set(), []).map((e) => e.did)).toEqual([
      'did:plc:maya',
      'did:plc:ben',
    ]);
  });

  it('skips a follow a lane already carries', () => {
    expect(followExtras([maya, ben], new Set(['did:plc:maya']), []).map((e) => e.did)).toEqual([
      'did:plc:ben',
    ]);
  });

  it('lists each person once', () => {
    const again = sharer({ postUri: 'at://did:plc:maya/app.bsky.feed.post/3def' });
    expect(followExtras([maya, again], new Set(), [])).toHaveLength(1);
  });
});

describe('byFollowedThenEngagement', () => {
  it('leads with followed rows, newest first, then the rest by likes', () => {
    const rows = [
      row({ key: 'popular', likeCount: 900, createdAt: new Date(NOW - 5 * HOUR).toISOString() }),
      row({ key: 'old-follow', followed: true, createdAt: new Date(NOW - 9 * HOUR).toISOString() }),
      row({ key: 'quiet', likeCount: 2, createdAt: new Date(NOW - HOUR).toISOString() }),
      row({
        key: 'new-follow',
        followed: true,
        likeCount: 0,
        createdAt: new Date(NOW).toISOString(),
      }),
    ];
    expect(rows.sort(byFollowedThenEngagement).map((r) => r.key)).toEqual([
      'new-follow',
      'old-follow',
      'popular',
      'quiet',
    ]);
  });
});
