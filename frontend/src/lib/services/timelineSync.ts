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
 * A cold start that finds nothing while the user has subscriptions means the
 * server-side archive isn't populated for them yet — the environment's crawler
 * isn't pushing into D1. Showing an empty reader would be wrong; falling back
 * (without committing a cursor) keeps the reader working until ingest catches up.
 */
export function shouldFallBackToBatch(page: TimelinePageShape, subscriptionCount: number): boolean {
  return page.coldStart && page.items.length === 0 && subscriptionCount > 0;
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
