import type { MyFeedbackPost } from '$lib/services/api';

/**
 * Noticing what happened to feedback the reader filed.
 *
 * userinput.app has no notifications of its own, and nothing pushes: the board
 * is an aggregation over records in other people's repos. So the client polls
 * its own posts and compares them with what it last saw. Two things are worth
 * telling someone about — the maintainer moved their post to a new status, and
 * somebody replied to it — and both are visible as a difference between two
 * snapshots.
 *
 * The difference is turned into *events* rather than recomputed on demand,
 * because a snapshot only holds the current state: once "planned" has been
 * recorded, nothing remembers that it used to be untriaged. Events are kept in
 * local storage, exactly like the read-state of the mention inbox they join.
 */

const SNAPSHOT_KEY = 'skyreader-feedback-snapshot';
const EVENTS_KEY = 'skyreader-feedback-events';

/** Kept small: this is a notification list, not a history of the board. */
export const MAX_EVENTS = 50;
/** After this, an unread notification is stale news rather than news. */
export const EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface FeedbackSnapshotEntry {
  status: string | null;
  replyCount: number;
}

/** The last-seen state of each of the reader's posts, keyed by post uri. */
export type FeedbackSnapshot = Record<string, FeedbackSnapshotEntry>;

export interface FeedbackEvent {
  /**
   * Derived from what changed, so the same change seen twice in quick
   * succession is the same event — which is what keeps read-state meaningful
   * across a re-poll. A change that recurs later gets its own id; mergeEvents
   * is where the two are told apart.
   */
  id: string;
  postUri: string;
  postUrl: string;
  title: string;
  kind: 'status' | 'reply';
  /** The status now set (kind: 'status'). */
  status?: string | null;
  /** How many replies arrived since the last look (kind: 'reply'). */
  newReplies?: number;
  /** When this client noticed. Upstream doesn't say when it happened. */
  createdAt: number;
}

function perDidKey(base: string, did: string): string {
  return `${base}:${did}`;
}

function read<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the reader loses a notification, not their feedback.
  }
}

/**
 * Null when this browser has never seen the reader's posts — which is not the
 * same as an empty snapshot, and is the difference between a first sync and one
 * where every post was deleted.
 */
export function loadSnapshot(did: string): FeedbackSnapshot | null {
  return read<FeedbackSnapshot | null>(perDidKey(SNAPSHOT_KEY, did), null);
}

export function saveSnapshot(did: string, snapshot: FeedbackSnapshot): void {
  write(perDidKey(SNAPSHOT_KEY, did), snapshot);
}

export function loadEvents(did: string): FeedbackEvent[] {
  const events = read<FeedbackEvent[]>(perDidKey(EVENTS_KEY, did), []);
  return Array.isArray(events) ? events.filter((event) => typeof event?.id === 'string') : [];
}

export function saveEvents(did: string, events: FeedbackEvent[]): void {
  write(perDidKey(EVENTS_KEY, did), events);
}

export function snapshotOf(posts: MyFeedbackPost[]): FeedbackSnapshot {
  const snapshot: FeedbackSnapshot = {};
  for (const post of posts) {
    snapshot[post.uri] = { status: post.status, replyCount: post.replyCount };
  }
  return snapshot;
}

/**
 * What changed since the last look.
 *
 * Two silences are deliberate. A browser with no snapshot yet reports nothing —
 * the first poll is the baseline, and treating it as news would greet a reader
 * with a notification for every post they ever filed. A post that wasn't in the
 * previous snapshot is silent for the same reason: it has just been written, or
 * has just become visible on the board, and its current state is where it
 * starts rather than something that happened.
 */
export function diffFeedback(
  previous: FeedbackSnapshot | null,
  posts: MyFeedbackPost[],
  now: number
): FeedbackEvent[] {
  if (!previous) return [];
  const events: FeedbackEvent[] = [];
  for (const post of posts) {
    const before = previous[post.uri];
    if (!before) continue;
    if (post.status !== before.status) {
      events.push({
        id: `${post.uri}#status:${post.status ?? 'open'}`,
        postUri: post.uri,
        postUrl: post.url,
        title: post.title,
        kind: 'status',
        status: post.status,
        createdAt: now,
      });
    }
    if (post.replyCount > before.replyCount) {
      events.push({
        // Keyed by the count it reached, so one reply noticed twice stays one
        // notification while a second reply is a new one. A count that comes
        // back around (a reply deleted, then another posted) repeats this id;
        // mergeEvents is what keeps that a second notification.
        id: `${post.uri}#replies:${post.replyCount}`,
        postUri: post.uri,
        postUrl: post.url,
        title: post.title,
        kind: 'reply',
        newReplies: post.replyCount - before.replyCount,
        createdAt: now,
      });
    }
  }
  return events;
}

/**
 * How long an id already in the list means "this is that same event again"
 * rather than "that happened a second time". Long enough to cover two polls
 * that overlap, short enough that nothing a person did is inside it.
 */
export const SAME_EVENT_WINDOW_MS = 60_000;

/** Existing events plus the new ones: newest last, deduped, capped and aged out. */
export function mergeEvents(
  existing: FeedbackEvent[],
  fresh: FeedbackEvent[],
  now: number
): FeedbackEvent[] {
  const byId = new Map(existing.map((event) => [event.id, event]));
  const added: FeedbackEvent[] = [];
  for (const event of fresh) {
    const seen = byId.get(event.id);
    // An id says what changed, not when — and the same change can happen twice.
    // A reply deleted and replaced puts the count back on a number it already
    // reached, and a post moved back to a status it once held reads identically;
    // dropping those as already-known is how a reader never hears about the new
    // reply. So a matching id only suppresses a fresh event while it is minutes
    // old, which is the case this is actually for: two polls in flight at once,
    // diffing the same change off the same snapshot. Later than that the change
    // really did happen again, and gets an id of its own so it carries its own
    // read state.
    if (seen && now - seen.createdAt < SAME_EVENT_WINDOW_MS) continue;
    const entry = seen ? { ...event, id: `${event.id}@${now}` } : event;
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
    added.push(entry);
  }
  const merged = [...existing, ...added];
  return merged.filter((event) => now - event.createdAt < EVENT_TTL_MS).slice(-MAX_EVENTS);
}
