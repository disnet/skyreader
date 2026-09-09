import type { FeedbackPost } from '$lib/services/api';

/**
 * The posts this browser wrote that the board hasn't started returning yet.
 *
 * userinput.app has no backend: a post is a record in the author's own repo, and
 * the board is an aggregation over backlinks to it. That aggregation lags by a
 * minute or so, which the page used to paper over with an in-memory row — good
 * until the reader reloaded, at which point their own post vanished. So the row
 * is kept here instead, and dropped the moment the board carries the real one.
 */

const STORAGE_KEY = 'skyreader-feedback-pending';

/**
 * How long an unindexed post is kept. Upstream takes a minute; a day is the
 * outside case (a record it never indexes at all), after which showing a row
 * nobody else can see is a lie rather than a courtesy.
 */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingFeedbackPost {
  /** The post in the board's own shape, so it renders as any other row. */
  post: FeedbackPost;
  /** When it was written, for the TTL above. */
  postedAt: number;
}

function isPending(value: unknown): value is PendingFeedbackPost {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as { post?: { uri?: unknown; author?: unknown }; postedAt?: unknown };
  return (
    typeof entry.postedAt === 'number' &&
    typeof entry.post?.uri === 'string' &&
    typeof entry.post?.author === 'object'
  );
}

export function readPendingPosts(): PendingFeedbackPost[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter(isPending) : [];
  } catch {
    return [];
  }
}

export function writePendingPosts(entries: PendingFeedbackPost[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (entries.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // A full or blocked store costs the reader the optimistic row, nothing else.
  }
}

/** Entries still worth holding: not yet on the board, and not yet stale. */
export function prunePendingPosts(
  entries: PendingFeedbackPost[],
  boardPosts: FeedbackPost[],
  now = Date.now()
): PendingFeedbackPost[] {
  const indexed = new Set(boardPosts.map((post) => post.uri));
  return entries.filter(
    (entry) => !indexed.has(entry.post.uri) && now - entry.postedAt < PENDING_TTL_MS
  );
}

/**
 * The board's posts plus this reader's unindexed ones. Scoped to their DID: a
 * shared browser shouldn't show one account's pending post to the next account.
 */
export function mergePendingPosts(
  boardPosts: FeedbackPost[],
  entries: PendingFeedbackPost[],
  did: string | undefined
): FeedbackPost[] {
  if (!did) return boardPosts;
  const indexed = new Set(boardPosts.map((post) => post.uri));
  const mine = entries
    .filter((entry) => entry.post.author.did === did && !indexed.has(entry.post.uri))
    .map((entry) => entry.post);
  return mine.length > 0 ? [...mine, ...boardPosts] : boardPosts;
}
