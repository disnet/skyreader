import type { FeedbackPost, FeedbackType } from '$lib/services/api';

/**
 * The feedback board's vocabulary and its one filter.
 *
 * A post's *type* is a tag on the discussion record (userinput.app calls the
 * board's vocabulary its space tags) and is only ever a label here — the page
 * shows every type. Its *status* is the board owner's verdict (`planned`,
 * `implemented`, …), absent until they set one, and is what the page filters
 * on. Both are upstream's data, so everything here is defensive: a post can
 * carry a tag the board no longer lists, several tags, or none at all.
 */

/** What the composer offers when the board itself lists no types. */
export const DEFAULT_FEEDBACK_TYPES: FeedbackType[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature request' },
  { value: 'question', label: 'Question' },
];

/**
 * A status of `null` is upstream's "nobody has triaged this", which reads as
 * open on userinput.app too.
 */
export const OPEN_STATUS = 'open';

/**
 * The statuses that mean the board is done with a post. Everything else — the
 * untriaged default, and the states a post passes through on the way — is open,
 * including any status upstream invents later: a state we don't recognize is
 * shown rather than quietly filed away as finished.
 */
export const CLOSED_STATUSES = new Set(['implemented', 'declined', 'duplicate']);

/** Which half of the board a reader is looking at. */
export type StatusScope = 'open' | 'closed' | 'all';

export function isPostClosed(post: FeedbackPost): boolean {
  return CLOSED_STATUSES.has(postStatus(post));
}

function titleCase(value: string): string {
  const words = value.replaceAll('-', ' ').trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : value;
}

/**
 * The type vocabulary to render: what the board configured (or our defaults),
 * plus any type a post actually carries that the board no longer lists. Ordered
 * board-first so the board's own ordering survives.
 */
export function feedbackTypes(
  configured: FeedbackType[] | undefined,
  posts: FeedbackPost[]
): FeedbackType[] {
  const types = (configured?.length ? configured : DEFAULT_FEEDBACK_TYPES).map((type) => ({
    value: type.value,
    label: type.label || titleCase(type.value),
  }));
  const known = new Set(types.map((type) => type.value));
  for (const tag of posts.flatMap((post) => post.tags)) {
    if (tag && !known.has(tag)) {
      known.add(tag);
      types.push({ value: tag, label: titleCase(tag) });
    }
  }
  return types;
}

/**
 * The author DID and record key inside a post's `at://` uri — how a thread is
 * addressed. Null for anything that isn't one, so a malformed uri costs the row
 * its replies rather than throwing under the whole list.
 */
export function postRef(uri: string): { did: string; rkey: string } | null {
  const match = /^at:\/\/([^/]+)\/[^/]+\/([^/]+)$/.exec(uri);
  return match ? { did: match[1], rkey: match[2] } : null;
}

/** A post's status, with upstream's untriaged `null` reported as open. */
export function postStatus(post: FeedbackPost): string {
  return post.status ?? OPEN_STATUS;
}

/**
 * Whether the board holds anything closed at all. A board that has never
 * finished anything gets no open/closed switch: it would be a control with one
 * side, over a list it can't change.
 */
export function hasClosedPosts(posts: FeedbackPost[]): boolean {
  return posts.some(isPostClosed);
}

export function statusLabel(status: string): string {
  return titleCase(status);
}

/** The half of the board a reader is looking at. */
export function filterByStatusScope(posts: FeedbackPost[], scope: StatusScope): FeedbackPost[] {
  if (scope === 'all') return posts;
  return posts.filter((post) => isPostClosed(post) === (scope === 'closed'));
}

export function sortFeedbackPosts(posts: FeedbackPost[], sort: 'top' | 'new'): FeedbackPost[] {
  return [...posts].sort((a, b) =>
    sort === 'top'
      ? b.votes.net - a.votes.net || Date.parse(b.createdAt) - Date.parse(a.createdAt)
      : Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
}
