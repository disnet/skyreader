import type { FeedItem, Subscription } from '$lib/types';

/**
 * Pure helpers for the D1-served timeline sync. Extracted from feedFetcher
 * (which pulls in Svelte rune modules, untestable in plain vitest) so the
 * grouping, fallback and metadata-backfill rules can be unit-tested directly.
 * See timelineSync.test.ts.
 */

/** One item as the timeline serves it: the feed it belongs to + its archive seq. */
export type TimelineItem = FeedItem & { seq: number; feedUrl: string; read: boolean };

export interface TimelinePageShape {
  items: TimelineItem[];
  coldStart: boolean;
  // Server-authoritative: is this deployment's crawler pushing into the archive?
  // Absent on a backend that predates the flag.
  ingestActive?: boolean;
}

/** Feed metadata the timeline carries alongside a non-empty page. */
export interface TimelineFeedMeta {
  title?: string;
  siteUrl?: string;
  imageUrl?: string;
}

/** RSS subscriptions are the only ones the timeline serves; atproto.* sources
 * (standard.site documents, collections) ride their own digest sync. */
export function isRssSubscription(sub: Subscription): boolean {
  return !!sub.feedUrl && !(sub.sourceType && sub.sourceType.startsWith('atproto.'));
}

/** feedUrl → subscriptionId, for mapping timeline items back onto local subs. */
export function buildSubscriptionIndex(subscriptions: Subscription[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const sub of subscriptions) {
    if (!sub.id || !isRssSubscription(sub)) continue;
    index.set(sub.feedUrl!, sub.id);
  }
  return index;
}

export interface GroupedTimelinePage {
  // One entry per subscription that received items, ready for a single
  // mergeArticlesBatch call.
  toMerge: Array<{ subscriptionId: number; items: TimelineItem[] }>;
  // GUIDs the server flagged as already read, applied additively after the merge.
  readGuids: string[];
  // Feeds that delivered at least one item in this page.
  feedUrls: string[];
}

/**
 * Bucket a page by subscription. Items for feeds this client doesn't hold are
 * dropped — a race with an unsubscribe elsewhere is benign.
 */
export function groupTimelineItems(
  items: TimelineItem[],
  index: Map<string, number>
): GroupedTimelinePage {
  const byFeed = new Map<number, TimelineItem[]>();
  const readGuids: string[] = [];
  const feedUrls = new Set<string>();

  for (const item of items) {
    const subscriptionId = index.get(item.feedUrl);
    if (!subscriptionId) continue;
    feedUrls.add(item.feedUrl);
    const bucket = byFeed.get(subscriptionId);
    if (bucket) bucket.push(item);
    else byFeed.set(subscriptionId, [item]);
    if (item.read) readGuids.push(item.guid);
  }

  return {
    toMerge: [...byFeed.entries()].map(([subscriptionId, bucket]) => ({
      subscriptionId,
      items: bucket,
    })),
    readGuids,
    feedUrls: [...feedUrls],
  };
}

/**
 * Whether to abandon the timeline for this sync and use the legacy per-feed
 * batch path instead.
 *
 * The decisive signal is the server's own `ingestActive`: it is false until this
 * deployment's crawler has actually checked in, so a Worker whose proxy has no
 * `INGEST_URL` (the whole pre-rollout window) tells every client to stay on the
 * batch path — no cursor is committed, and nothing infers "healthy" from a page
 * that happened to carry items. Emptiness alone can't decide that: one
 * subscribe-time ingest is enough to make a cold start non-empty while the
 * user's other feeds are never crawled at all.
 *
 * The emptiness heuristic remains only for a backend that predates the flag.
 */
export function shouldFallBackToBatch(page: TimelinePageShape, subscriptionCount: number): boolean {
  if (page.ingestActive === false) return true;
  if (page.ingestActive === true) return false;
  return page.coldStart && page.items.length === 0 && subscriptionCount > 0;
}

/**
 * Subscriptions that need a one-off per-feed backfill.
 *
 * The timeline's cursor is global, so a subscription that arrives from ANOTHER
 * device (synced in from the backend/PDS) is already below it: the drain will
 * never deliver its existing items, and the reader would show it empty until the
 * crawler happens to publish something new. The add-feed and OPML paths call the
 * per-feed endpoint explicitly; this covers the remote-sync path.
 *
 * `attempted` holds the feed URLs already tried (persisted), so a genuinely empty
 * feed is fetched once rather than on every sync. Bounded per sync so a large
 * incoming subscription list doesn't turn into a request storm.
 */
export function selectBackfillTargets(
  subscriptions: Subscription[],
  attempted: Set<string>,
  hasArticles: (sub: Subscription) => boolean,
  max: number,
  afterFeedUrl?: string
): Subscription[] {
  if (subscriptions.length === 0 || max <= 0) return [];

  // Resume after the last feed selected on the previous sync. Failed feeds are
  // deliberately not marked complete, but rotating the starting point ensures
  // they cannot monopolize the per-sync budget and starve later subscriptions.
  const previousIndex = afterFeedUrl
    ? subscriptions.findIndex((sub) => sub.feedUrl === afterFeedUrl)
    : -1;
  const start = previousIndex >= 0 ? (previousIndex + 1) % subscriptions.length : 0;
  const targets: Subscription[] = [];
  for (let offset = 0; offset < subscriptions.length && targets.length < max; offset++) {
    const sub = subscriptions[(start + offset) % subscriptions.length];
    if (!sub.id || !isRssSubscription(sub)) continue;
    if (attempted.has(sub.feedUrl!) || hasArticles(sub)) continue;
    targets.push(sub);
  }
  return targets;
}

/**
 * Keep the attempted-backfill record to feeds the user still subscribes to, so
 * it can't grow without bound as feeds come and go.
 */
export function pruneAttemptedBackfills(
  attempted: Iterable<string>,
  subscriptions: Subscription[]
): string[] {
  const live = new Set(
    subscriptions.filter((s) => isRssSubscription(s)).map((s) => s.feedUrl as string)
  );
  return [...attempted].filter((url) => live.has(url));
}

/**
 * Whether a subscription's title should be updated from feed metadata.
 * Returns true when the current title is a fallback (URL, hostname, etc.)
 * and the feed provides a real title.
 */
export function shouldUpdateTitle(
  currentTitle: string,
  feedUrl: string | undefined,
  fetchedTitle: string
): boolean {
  if (!fetchedTitle || fetchedTitle === 'Untitled Feed') return false;
  if (currentTitle === fetchedTitle) return false;

  // Update if current title is the feed URL
  if (feedUrl && currentTitle === feedUrl) return true;

  // Update if current title is just a hostname
  try {
    const hostname = feedUrl ? new URL(feedUrl).hostname : '';
    if (currentTitle === hostname) return true;
  } catch {
    // ignore invalid URL
  }

  return false;
}

export interface SubscriptionMetaUpdate {
  title?: string;
  siteUrl?: string;
}

/**
 * The subscription fields worth backfilling from the archive's feed metadata, or
 * null when nothing changes. Title and siteUrl are independent: a sub added
 * before siteUrl tracking existed already has a real title, so gating the
 * siteUrl write on a title change would leave it siteUrl-less forever (which
 * hides it from cross-type duplicate detection).
 */
export function subscriptionMetaUpdate(
  sub: Pick<Subscription, 'title' | 'feedUrl' | 'siteUrl'>,
  meta: TimelineFeedMeta
): SubscriptionMetaUpdate | null {
  const updates: SubscriptionMetaUpdate = {};
  if (meta.title && shouldUpdateTitle(sub.title, sub.feedUrl, meta.title)) {
    updates.title = meta.title;
  }
  if (meta.siteUrl && meta.siteUrl !== sub.siteUrl) {
    updates.siteUrl = meta.siteUrl;
  }
  return updates.title !== undefined || updates.siteUrl !== undefined ? updates : null;
}
