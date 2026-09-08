import type { FeedbackPost, FeedbackType } from '$lib/services/api';

/**
 * The feedback board's grouping and filtering rules.
 *
 * A post's *type* is a tag on the discussion record (userinput.app calls the
 * board's vocabulary its space tags); its *status* is the board owner's verdict
 * (`planned`, `implemented`, …) and is absent until they set one. Both are
 * upstream's data, so everything here is defensive: a post can carry a tag the
 * board no longer lists, several tags, or none at all.
 */

/** What the composer offers when the board itself lists no types. */
export const DEFAULT_FEEDBACK_TYPES: FeedbackType[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature request' },
  { value: 'question', label: 'Question' },
];

/** The bucket for a post with no type — its own group, never a fake one. */
export const UNTYPED = 'untyped';

/**
 * A status of `null` is upstream's "nobody has triaged this", which reads as
 * open on userinput.app too.
 */
export const OPEN_STATUS = 'open';

export interface FeedbackGroup {
  type: string;
  label: string;
  posts: FeedbackPost[];
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

/** A post's type: its first tag, or the untyped bucket. */
export function postType(post: FeedbackPost): string {
  return post.tags.find((tag) => tag.length > 0) ?? UNTYPED;
}

/** A post's status, with upstream's untriaged `null` reported as open. */
export function postStatus(post: FeedbackPost): string {
  return post.status ?? OPEN_STATUS;
}

/** The statuses present on the board, open first, so the filter row is honest. */
export function feedbackStatuses(posts: FeedbackPost[]): string[] {
  const present = new Set(posts.map(postStatus));
  const ordered = [
    OPEN_STATUS,
    'under-review',
    'backlog',
    'planned',
    'in-progress',
    'implemented',
    'declined',
    'duplicate',
  ].filter((status) => present.has(status));
  const extra = [...present].filter((status) => !ordered.includes(status)).sort();
  return [...ordered, ...extra];
}

export function statusLabel(status: string): string {
  return titleCase(status);
}

export function filterFeedbackPosts(
  posts: FeedbackPost[],
  filters: { type: string | null; status: string | null }
): FeedbackPost[] {
  return posts.filter(
    (post) =>
      (!filters.type || postType(post) === filters.type) &&
      (!filters.status || postStatus(post) === filters.status)
  );
}

export function sortFeedbackPosts(posts: FeedbackPost[], sort: 'top' | 'new'): FeedbackPost[] {
  return [...posts].sort((a, b) =>
    sort === 'top'
      ? b.votes.net - a.votes.net || Date.parse(b.createdAt) - Date.parse(a.createdAt)
      : Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
}

/**
 * Posts grouped by type, in the vocabulary's order, with untyped posts last.
 * Empty groups are dropped — a board with no questions shouldn't show a
 * "Questions" heading over nothing.
 */
export function groupFeedbackPosts(posts: FeedbackPost[], types: FeedbackType[]): FeedbackGroup[] {
  const groups: FeedbackGroup[] = [];
  for (const type of types) {
    const matching = posts.filter((post) => postType(post) === type.value);
    if (matching.length > 0) groups.push({ type: type.value, label: type.label, posts: matching });
  }
  const untyped = posts.filter((post) => postType(post) === UNTYPED);
  if (untyped.length > 0) groups.push({ type: UNTYPED, label: 'Other', posts: untyped });
  return groups;
}
