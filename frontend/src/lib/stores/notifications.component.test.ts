// Named `.component.test.ts` so it runs in the project that compiles runes —
// the store is a `.svelte.ts` module and `$state` needs the Svelte plugin.
//
// What's covered here is the half of the inbox that has no push behind it: the
// reader's own feedback, noticed by polling and diffing. The mention half is
// stubbed to nothing so each case is about the diff reaching the badge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevLogUpdate, MyFeedbackPost } from '$lib/services/api';

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

// The account's read-state as the backend holds it: one copy, shared by every
// "device" (every reboot with localStorage cleared).
let server: { ids: Set<string>; primed: boolean } = { ids: new Set(), primed: false };
let serverDown = false;
let devLog: DevLogUpdate[] = [];
const markNotificationsSeen = vi.fn(async (ids: string[], primed = false) => {
  if (serverDown) throw new Error('backend is down');
  for (const id of ids) server.ids.add(id);
  if (primed) server.primed = true;
  return { success: true };
});

vi.mock('$lib/services/api', () => ({
  api: {
    getMyFeedback: () => getMyFeedback(),
    getNotificationSeen: async () => {
      if (serverDown) throw new Error('backend is down');
      return { ids: [...server.ids], primed: server.primed };
    },
    markNotificationsSeen: (ids: string[], primed?: boolean) => markNotificationsSeen(ids, primed),
    getUpdates: async () => ({ updates: structuredClone(devLog) }),
  },
}));
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
  server = { ids: new Set(), primed: false };
  serverDown = false;
  devLog = [];
  markNotificationsSeen.mockClear();
});

/** Another device: same account, nothing in this browser's storage. */
async function otherDevice() {
  notificationsStore.stop();
  localStorage.clear();
  await boot();
}

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

describe('read-state across devices', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it('carries what was read on one device to the next', async () => {
    const now = Date.now();
    mentionSources = [mention('a', now - 60_000), mention('b', now - 30_000)];
    await boot();
    expect(notificationsStore.unreadCount).toBe(2);

    notificationsStore.markAllSeen();
    await vi.advanceTimersByTimeAsync(0);
    expect(notificationsStore.unreadCount).toBe(0);

    await otherDevice();
    expect(notificationsStore.unreadCount).toBe(0);
  });

  it('clears the badge on an open device when another one reads', async () => {
    const now = Date.now();
    mentionSources = [mention('a', now - 60_000)];
    await boot();
    expect(notificationsStore.unreadCount).toBe(1);

    // Read elsewhere; this tab finds out on its next poll.
    server.ids.add(mentionSources[0].sourceUri);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notificationsStore.unreadCount).toBe(0);
  });

  it('primes the account once, not once per device', async () => {
    // The first device starts week-old mentions read. A mention that ages past a
    // week unread must not be silently read by a second device's first sync.
    const now = Date.now();
    mentionSources = [mention('recent', now - 60_000)];
    await boot();
    expect(server.primed).toBe(true);

    vi.setSystemTime(now + WEEK + 60_000);
    await otherDevice();
    expect(notificationsStore.unreadCount).toBe(1);
  });

  it('uploads what this browser read before the account kept read state', async () => {
    const now = Date.now();
    const old = mention('a', now - 60_000);
    localStorage.setItem('skyreader-mentions-seen:did:plc:reader', JSON.stringify([old.sourceUri]));
    mentionSources = [old];
    await boot();

    expect(notificationsStore.unreadCount).toBe(0);
    expect(server.ids.has(old.sourceUri)).toBe(true);
    expect(server.primed).toBe(true);
  });

  it('keeps working from the local copy while the backend is down', async () => {
    const now = Date.now();
    mentionSources = [mention('a', now - 60_000)];
    await boot();
    serverDown = true;
    notificationsStore.markAllSeen();
    await vi.advanceTimersByTimeAsync(0);
    expect(notificationsStore.unreadCount).toBe(0);

    // Back up: the next poll sends what the failed write didn't.
    serverDown = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.ids.has(mentionSources[0].sourceUri)).toBe(true);
  });
});

describe('read-state traffic', () => {
  it('sends what the server lacks once per load, not on every poll', async () => {
    // The server caps its copy; if the browser re-sent everything it held, the
    // two would trade the overflow back and forth every minute.
    const now = Date.now();
    const a = mention('a', now - 60_000);
    localStorage.setItem('skyreader-mentions-seen:did:plc:reader', JSON.stringify([a.sourceUri]));
    mentionSources = [a];
    await boot();
    expect(markNotificationsSeen).toHaveBeenCalledTimes(1);

    server.ids.delete(a.sourceUri); // evicted by the server's cap
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(markNotificationsSeen).toHaveBeenCalledTimes(1);
  });
});

describe('New in Skyreader', () => {
  const update: DevLogUpdate = {
    uri: 'at://did:plc:devlog/site.standard.document/3mxqxx7jvec2h',
    title: 'Skyreader update - Newsletters and Search',
    description: 'Read newsletters in Skyreader.',
    url: 'https://skyreader-dev.leaflet.pub/3mxqxx7jvec2h',
    publishedAt: new Date().toISOString(),
  };

  it('shows a Dev Log post unread until it is seen, on every device', async () => {
    devLog = [update];
    await boot();
    expect(notificationsStore.unreadCount).toBe(1);
    expect(notificationsStore.notifications[0]).toMatchObject({
      type: 'update',
      title: update.title,
      detail: update.description,
      canonicalUrl: update.url,
      seen: false,
    });

    notificationsStore.markAllSeen();
    await vi.advanceTimersByTimeAsync(0);
    await otherDevice();
    expect(notificationsStore.unreadCount).toBe(0);
    expect(notificationsStore.notifications[0].seen).toBe(true);
  });

  it('shows a post that is both an update and a mention once', async () => {
    devLog = [update];
    mentionSources = [
      {
        sourceUri: update.uri,
        actorDid: 'did:plc:devlog',
        rkey: tidAt(Date.now() - 60_000),
      },
    ];
    await boot();
    expect(notificationsStore.unreadCount).toBe(1);
    await notificationsStore.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(notificationsStore.notifications.filter((n) => n.id === update.uri)).toHaveLength(1);
  });
});
