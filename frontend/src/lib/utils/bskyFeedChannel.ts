import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
import { bskyFeedsStore } from '$lib/stores/bskyFeeds.svelte';
import { bskyFeedSourceKey } from '$lib/utils/sourceKeys';
import type { BskyFeedSource, FilteredView } from '$lib/types';

// A Bluesky feed's channel (docs/plans/BLUESKY_FEEDS_PLAN.md): adding a feed as
// a source gives it an ordinary feed channel whose one source is the feed, so
// it gets a place in the sidebar and the river's list, keyboard and reader, and
// can be renamed, edited, mixed or deleted like any other. The follows channel
// (followsChannel.ts) is the precedent.

/** The channel that is just this feed, if there is one. */
export function findBskyFeedChannel(
  feedUri: string,
  views: FilteredView[] = filteredViewsStore.views
): FilteredView | undefined {
  const key = bskyFeedSourceKey(feedUri);
  return views.find(
    (v) =>
      v.mode !== 'saved' &&
      v.sourceMode === 'include' &&
      (v.sourceKeys ?? []).length === 1 &&
      v.sourceKeys?.[0] === key
  );
}

/** Add the feed as a source and make its channel (or find it). Returns the uuid. */
export async function addBskyFeedChannel(feedUri: string): Promise<string> {
  const feed: BskyFeedSource = await bskyFeedsStore.add(feedUri);
  const existing = findBskyFeedChannel(feed.uri);
  if (existing) return existing.uuid;
  return filteredViewsStore.create({
    name: feed.displayName,
    mode: 'feed',
    sourceMode: 'include',
    sourceKeys: [bskyFeedSourceKey(feed.uri)],
    // Posts have no read state, so "unread only" would mean nothing here.
    readFilter: 'all',
    sortOrder: 'newest',
  });
}

/**
 * Remove the feed as a source: its own channel goes, and other channels that
 * mixed it in drop it (a channel left with no sources goes too).
 */
export async function removeBskyFeedChannel(feedUri: string): Promise<void> {
  await bskyFeedsStore.remove(feedUri);
  const key = bskyFeedSourceKey(feedUri);
  for (const view of filteredViewsStore.views) {
    if (view.id === undefined || !(view.sourceKeys ?? []).includes(key)) continue;
    const rest = (view.sourceKeys ?? []).filter((k) => k !== key);
    if (rest.length === 0 && view.sourceMode === 'include') {
      await filteredViewsStore.remove(view.id);
    } else {
      await filteredViewsStore.update(view.id, { sourceKeys: rest });
    }
  }
}
