// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// What's covered here is the half of the inbox that has no push behind it: the
// reader's own feedback, noticed by polling and diffing. The mention half is
// stubbed to nothing so each case is about the diff reaching the badge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyFeedbackPost } from '$lib/services/api';

// A mention source, as the badge poll resolves it. The rkey is a real TID, so
// the store can date it without fetching the record.
interface Source {
  sourceUri: string;
  actorDid: string;
  rkey: string;
}
let mentionSources: Source[] = [];
let myPosts: MyFeedbackPost[] = [];
let feedbackFails = false;
const getMyFeedback = vi.fn(async () => {
  if (feedbackFails) throw new Error('board is down');
  return { posts: structuredClone(myPosts) };
});

vi.mock('$lib/services/api', () => ({ api: { getMyFeedback: () => getMyFeedback() } }));
vi.mock('$lib/services/mentions', () => ({
  fetchMentionSources: vi.fn(async () => structuredClone(mentionSources)),
  enrichMention: vi.fn(async (source: Source) => ({
    ...source,
    actorHandle: 'alice.test',
    actorDisplayName: 'Alice',
    actorAvatar: null,
    title: 'A shared article',
    canonicalUrl: 'https://alice.example/post',
    createdAt: 0,
  })),
}));
vi.mock('$lib/stores/auth.svelte', () => ({
  auth: {
    get user() {
      return { did: 'did:plc:reader', handle: 'reader.test' };
    },
  },
}));

const { notificationsStore } = await import('./notifications.svelte');

// The store's own feedback cadence; the tests step the clock by exactly it.
const FEEDBACK_POLL_INTERVAL_MS = 15 * 60_000;

function post(overrides: Partial<MyFeedbackPost> & { uri: string }): MyFeedbackPost {
  return {
    url: `https://userinput.app/d/did:plc:reader/${overrides.uri}`,
    title: 'A quieter reading mode',
    status: null,
    replyCount: 0,
    ...overrides,
  };
}

/** Boot the inbox and let its first poll settle. */
async function boot() {
  notificationsStore.start();
  await vi.advanceTimersByTimeAsync(0);
}

/** The next scheduled poll. */
async function poll() {
  await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_INTERVAL_MS);
}

/** A new tab: nothing in memory, everything from storage. */
async function reboot() {
  notificationsStore.stop();
  await boot();
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mentionSources = [];
  myPosts = [];
  feedbackFails = false;
  getMyFeedback.mockClear();
});

afterEach(() => {
  notificationsStore.stop();
  vi.useRealTimers();
});

/** A mention whose record key encodes `when` — what a real TID rkey does. */
function mention(id: string, when: number): Source {
  return {
    sourceUri: `at://did:plc:alice/site.standard.document/${id}`,
    actorDid: 'did:plc:alice',
    rkey: tidAt(when),
  };
}

const S32 = '234567abcdefghijklmnopqrstuvwxyz';
function tidAt(millis: number): string {
  const value = (BigInt(millis) * 1000n) << 10n;
  let tid = '';
  for (let shift = 60n; shift >= 0n; shift -= 5n) tid += S32[Number((value >> shift) & 31n)];
  return tid;
}

describe('the mention baseline', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it('starts mentions older than a week read, and recent ones unread', async () => {
    // The second-device case: read-state doesn't travel, so a browser meeting
    // this account for the first time shouldn't light up with old news.
    const now = Date.now();
    mentionSources = [mention('old', now - WEEK - 1000), mention('recent', now - 60_000)];
    await boot();

    expect(notificationsStore.unreadCount).toBe(1);
    await notificationsStore.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(notificationsStore.notifications.find((n) => n.id.endsWith('old'))?.seen).toBe(true);
    expect(notificationsStore.notifications.find((n) => n.id.endsWith('recent'))?.seen).toBe(false);
  });

  it('leaves a mention it cannot date unread', async () => {
    // A record key is only a timestamp when the lexicon says so; an unread
    // notification is a smaller mistake than a silent one.
    mentionSources = [
      {
        sourceUri: 'at://did:plc:alice/site.standard.document/self',
        actorDid: 'did:plc:alice',
        rkey: 'self',
      },
    ];
    await boot();
    expect(notificationsStore.unreadCount).toBe(1);
  });

  it('grants the grace once, not on every later sync', async () => {
    // Otherwise a mention that ages past a week while the reader ignores it
    // would silently mark itself read.
    const now = Date.now();
    mentionSources = [mention('recent', now - 60_000)];
    await boot();
    expect(notificationsStore.unreadCount).toBe(1);

    notificationsStore.stop();
    vi.setSystemTime(now + WEEK + 60_000);
    await boot();
    expect(notificationsStore.unreadCount).toBe(1);
  });
});

describe('feedback notifications', () => {
  it('takes the first poll as the baseline and says nothing', async () => {
    myPosts = [post({ uri: 'a', status: 'planned', replyCount: 2 })];
    await boot();
    expect(notificationsStore.unreadCount).toBe(0);
    expect(notificationsStore.notifications).toEqual([]);
  });

  it('raises a badge when a post is moved, and says what it moved to', async () => {
    myPosts = [post({ uri: 'a' })];
    await boot();

    myPosts = [post({ uri: 'a', status: 'planned' })];
    await poll();

    expect(notificationsStore.unreadCount).toBe(1);
    expect(notificationsStore.notifications[0]).toMatchObject({
      type: 'feedback-status',
      detail: 'Now planned',
      title: 'A quieter reading mode',
      // Back into the app, where the reader's own posts are pinned at the top.
      canonicalUrl: '/feedback',
      seen: false,
    });
  });

  it('raises one for replies, counting only what is new', async () => {
    myPosts = [post({ uri: 'a', replyCount: 1 })];
    await boot();

    myPosts = [post({ uri: 'a', replyCount: 3 })];
    await poll();
    expect(notificationsStore.notifications[0]).toMatchObject({
      type: 'feedback-reply',
      detail: '2 new replies',
    });

    // Polling again with nothing new must not stack a second copy.
    await poll();
    expect(notificationsStore.notifications).toHaveLength(1);
    expect(notificationsStore.unreadCount).toBe(1);
  });

  it('keeps an unread event through a poll that fails', async () => {
    myPosts = [post({ uri: 'a' })];
    await boot();
    myPosts = [post({ uri: 'a', status: 'implemented' })];
    await poll();

    feedbackFails = true;
    await poll();
    expect(notificationsStore.unreadCount).toBe(1);
  });

  it('shows stored events on a page that never started the poll', async () => {
    // The static pages render the bell without the shell behind it, so opening
    // the panel is the only thing that ever asks.
    myPosts = [post({ uri: 'a' })];
    await boot();
    myPosts = [post({ uri: 'a', status: 'planned' })];
    await poll();
    notificationsStore.stop();

    await notificationsStore.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(notificationsStore.notifications).toHaveLength(1);
    expect(notificationsStore.unreadCount).toBe(1);
  });

  it('marks them seen, and stays seen after a reload', async () => {
    myPosts = [post({ uri: 'a' })];
    await boot();
    myPosts = [post({ uri: 'a', status: 'planned' })];
    await poll();

    notificationsStore.markAllSeen();
    expect(notificationsStore.unreadCount).toBe(0);

    // stop() drops every in-memory trace, so this is the next boot reading back
    // what was persisted: the event is still listed, and still read.
    await reboot();
    expect(notificationsStore.notifications).toHaveLength(1);
    expect(notificationsStore.notifications[0].seen).toBe(true);
    expect(notificationsStore.unreadCount).toBe(0);
  });
});
