import { beforeEach, describe, expect, it } from 'vitest';
import type { MyFeedbackPost } from '$lib/services/api';
import {
  EVENT_TTL_MS,
  MAX_EVENTS,
  SAME_EVENT_WINDOW_MS,
  diffFeedback,
  loadEvents,
  loadSnapshot,
  mergeEvents,
  saveEvents,
  saveSnapshot,
  snapshotOf,
  type FeedbackEvent,
} from './feedbackNotifications';

// The unit project runs in node, whose own `localStorage` stays undefined
// without --localstorage-file (see test/setup/browser-storage.ts).
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

const DID = 'did:plc:reader';
const NOW = Date.parse('2026-09-08T12:00:00Z');

function post(overrides: Partial<MyFeedbackPost> & { uri: string }): MyFeedbackPost {
  return {
    url: `https://userinput.app/d/${DID}/${overrides.uri}`,
    title: 'A quieter reading mode',
    status: null,
    replyCount: 0,
    ...overrides,
  };
}

beforeEach(() => localStorage.clear());

describe('diffFeedback', () => {
  it('says nothing on the first sight of a board', () => {
    // Otherwise signing in on a new browser greets the reader with a
    // notification for every post they have ever filed.
    const posts = [post({ uri: 'a', status: 'planned', replyCount: 3 })];
    expect(diffFeedback(null, posts, NOW)).toEqual([]);
  });

  it('says nothing about a post it has never seen before', () => {
    // A post the reader just wrote: its state is where it starts, not news.
    const previous = snapshotOf([post({ uri: 'a' })]);
    const posts = [post({ uri: 'a' }), post({ uri: 'fresh', status: 'planned', replyCount: 1 })];
    expect(diffFeedback(previous, posts, NOW)).toEqual([]);
  });

  it('reports a status change, including one back to untriaged', () => {
    const previous = snapshotOf([post({ uri: 'a' })]);
    const [event] = diffFeedback(previous, [post({ uri: 'a', status: 'planned' })], NOW);
    expect(event).toMatchObject({
      id: 'a#status:planned',
      kind: 'status',
      status: 'planned',
      postUri: 'a',
      createdAt: NOW,
    });

    const back = diffFeedback(
      snapshotOf([post({ uri: 'a', status: 'planned' })]),
      [post({ uri: 'a', status: null })],
      NOW
    );
    expect(back[0]).toMatchObject({ id: 'a#status:open', status: null });
  });

  it('reports new replies, and counts how many arrived', () => {
    const previous = snapshotOf([post({ uri: 'a', replyCount: 1 })]);
    const [event] = diffFeedback(previous, [post({ uri: 'a', replyCount: 3 })], NOW);
    expect(event).toMatchObject({ id: 'a#replies:3', kind: 'reply', newReplies: 2 });
  });

  it('stays quiet when a reply is deleted', () => {
    // A count going down is moderation or a deletion, not something to
    // announce — and it must not re-fire the next time it climbs back.
    const previous = snapshotOf([post({ uri: 'a', replyCount: 3 })]);
    expect(diffFeedback(previous, [post({ uri: 'a', replyCount: 2 })], NOW)).toEqual([]);
  });

  it('reports both when a post is answered and moved at once', () => {
    const previous = snapshotOf([post({ uri: 'a' })]);
    const events = diffFeedback(
      previous,
      [post({ uri: 'a', status: 'implemented', replyCount: 1 })],
      NOW
    );
    expect(events.map((event) => event.kind)).toEqual(['status', 'reply']);
  });
});

describe('mergeEvents', () => {
  function event(id: string, createdAt = NOW): FeedbackEvent {
    return { id, postUri: 'a', postUrl: 'u', title: 't', kind: 'status', createdAt };
  }

  it('keeps one copy of a change seen twice', () => {
    // Re-polling before the snapshot moved would otherwise stack duplicates,
    // each of them separately unread.
    const merged = mergeEvents([event('a#status:planned')], [event('a#status:planned')], NOW);
    expect(merged).toHaveLength(1);
  });

  it('tells a change that happened again from the same change seen again', () => {
    // An id names what changed, not when. A reply deleted and replaced puts the
    // count back on one it already reached, and a post moved back to a status it
    // once held reads the same way; suppressing those as already-known is how a
    // reader never hears about the second one.
    const first = event('a#replies:2', NOW - SAME_EVENT_WINDOW_MS - 1);
    const merged = mergeEvents([first], [event('a#replies:2', NOW)], NOW);
    expect(merged).toHaveLength(2);
    // The later one carries its own id, so marking one read leaves the other.
    expect(new Set(merged.map((entry) => entry.id)).size).toBe(2);

    // A third time, against a list that now holds both.
    const again = mergeEvents(merged, [event('a#replies:2', NOW + 1)], NOW + 1);
    expect(again).toHaveLength(3);
    expect(new Set(again.map((entry) => entry.id)).size).toBe(3);
  });

  it('still collapses two polls that overlap', () => {
    // The case the dedupe is for: both in flight, both diffing the same change
    // off the same snapshot, seconds apart.
    const merged = mergeEvents(
      [event('a#status:planned', NOW)],
      [event('a#status:planned', NOW + 200)],
      NOW + 200
    );
    expect(merged).toHaveLength(1);
  });

  it('ages events out and caps the list', () => {
    const stale = event('old', NOW - EVENT_TTL_MS - 1);
    expect(mergeEvents([stale], [event('new')], NOW).map((e) => e.id)).toEqual(['new']);

    const many = Array.from({ length: MAX_EVENTS + 10 }, (_, index) => event(`e${index}`));
    const capped = mergeEvents(many, [], NOW);
    expect(capped).toHaveLength(MAX_EVENTS);
    // The newest survive: the tail is what a notification list is for.
    expect(capped.at(-1)?.id).toBe(`e${MAX_EVENTS + 9}`);
  });
});

describe('storage', () => {
  it('tells an empty board apart from a board never seen', () => {
    expect(loadSnapshot(DID)).toBeNull();
    saveSnapshot(DID, {});
    expect(loadSnapshot(DID)).toEqual({});
  });

  it('keeps one account’s events off another’s', () => {
    saveEvents(DID, [
      { id: 'x', postUri: 'a', postUrl: 'u', title: 't', kind: 'reply', createdAt: NOW },
    ]);
    expect(loadEvents(DID)).toHaveLength(1);
    expect(loadEvents('did:plc:someone-else')).toEqual([]);
  });

  it('ignores a corrupt value rather than throwing', () => {
    localStorage.setItem(`skyreader-feedback-events:${DID}`, 'not json');
    expect(loadEvents(DID)).toEqual([]);
    localStorage.setItem(`skyreader-feedback-events:${DID}`, JSON.stringify([{ nope: true }]));
    expect(loadEvents(DID)).toEqual([]);
  });
});
