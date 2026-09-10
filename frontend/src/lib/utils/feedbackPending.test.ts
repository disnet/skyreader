import { beforeEach, describe, expect, it } from 'vitest';
import type { FeedbackPost } from '$lib/services/api';
import {
  PENDING_TTL_MS,
  mergePendingPosts,
  prunePendingPosts,
  readPendingPosts,
  writePendingPosts,
  type PendingFeedbackPost,
} from './feedbackPending';

function post(uri: string, did = 'did:plc:reader'): FeedbackPost {
  return {
    uri,
    url: `https://userinput.app/d/${did}/${uri}`,
    author: { did, handle: 'reader.test', displayName: null, avatar: null },
    title: `Post ${uri}`,
    body: '',
    tags: ['bug'],
    createdAt: '2026-09-08T12:00:00Z',
    votes: { up: 1, down: 0, net: 1 },
    replyCount: 0,
    status: null,
  };
}

function pending(uri: string, postedAt = Date.now(), did?: string): PendingFeedbackPost {
  return { post: post(uri, did), postedAt };
}

// The unit project runs in node, and Node's own `localStorage` global stays
// undefined without --localstorage-file (see test/setup/browser-storage.ts). The
// module reads storage lazily, so an in-memory one defined here is enough.
const entries = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
    clear: () => entries.clear(),
  },
});

beforeEach(() => localStorage.clear());

describe('prunePendingPosts', () => {
  it('drops an entry the board now carries', () => {
    const entries = [pending('a'), pending('b')];
    expect(prunePendingPosts(entries, [post('a')])).toEqual([entries[1]]);
  });

  it('drops an entry upstream never indexed', () => {
    // A row only this browser can see stops being a courtesy at some point.
    const now = Date.now();
    const entries = [pending('old', now - PENDING_TTL_MS - 1), pending('new', now)];
    expect(prunePendingPosts(entries, [], now)).toEqual([entries[1]]);
  });
});

describe('mergePendingPosts', () => {
  it('puts the reader’s unindexed posts alongside the board’s', () => {
    expect(mergePendingPosts([post('b')], [pending('a')], 'did:plc:reader')).toEqual([
      post('a'),
      post('b'),
    ]);
  });

  it('never duplicates one the board already returns', () => {
    expect(mergePendingPosts([post('a')], [pending('a')], 'did:plc:reader')).toEqual([post('a')]);
  });

  it('keeps another account’s leftovers off a shared browser', () => {
    const other = pending('a', Date.now(), 'did:plc:someone-else');
    expect(mergePendingPosts([], [other], 'did:plc:reader')).toEqual([]);
    expect(mergePendingPosts([], [pending('a')], undefined)).toEqual([]);
  });
});

describe('storage', () => {
  it('round-trips, and clears the key when nothing is pending', () => {
    // One entry, not two calls to `pending`: its default `postedAt` is `Date.now()`,
    // so a millisecond tick between the write and the expectation fails the compare.
    const entry = pending('a');
    writePendingPosts([entry]);
    expect(readPendingPosts()).toEqual([entry]);
    writePendingPosts([]);
    expect(readPendingPosts()).toEqual([]);
    expect(localStorage.getItem('skyreader-feedback-pending')).toBeNull();
  });

  it('ignores a corrupt or foreign value rather than throwing', () => {
    localStorage.setItem('skyreader-feedback-pending', 'not json');
    expect(readPendingPosts()).toEqual([]);
    localStorage.setItem('skyreader-feedback-pending', JSON.stringify([{ nope: true }, 7]));
    expect(readPendingPosts()).toEqual([]);
  });
});
