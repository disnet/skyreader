import { auth } from '$lib/stores/auth.svelte';
import { filteredViewsStore } from '$lib/stores/filteredViews.svelte';
import { FOLLOWS_SOURCE_KEY, isFollowsSource } from '$lib/utils/sourceKeys';
import type { FilteredView } from '$lib/types';

// The follows channel: the preset that gives "From your follows" its place in
// the sidebar. It's an ordinary feed channel whose one source is
// FOLLOWS_SOURCE_KEY, so it gets the river's list, filters, read state and
// reader for free, and can be renamed, edited or deleted like any other.
// See docs/plans/FOLLOWS_LINKS_PLAN.md.

export const FOLLOWS_CHANNEL_NAME = 'From your follows';

/** Where the follows surface lives. Resolves to the channel (making it if
 *  there isn't one) or, without the permission, to the ask on Manage Sources. */
export const FOLLOWING_PATH = '/following';

/** The first feed channel that includes the follows source, if any. */
export function findFollowsChannel(
  views: FilteredView[] = filteredViewsStore.views
): FilteredView | undefined {
  return views.find(
    (v) =>
      v.mode !== 'saved' && v.sourceMode === 'include' && (v.sourceKeys ?? []).some(isFollowsSource)
  );
}

/** The follows channel's uuid, creating the preset when no channel has the source. */
export async function ensureFollowsChannel(): Promise<string> {
  const existing = findFollowsChannel();
  if (existing) return existing.uuid;
  return filteredViewsStore.create({
    name: FOLLOWS_CHANNEL_NAME,
    mode: 'feed',
    sourceMode: 'include',
    sourceKeys: [FOLLOWS_SOURCE_KEY],
    readFilter: 'unread',
    sortOrder: 'newest',
  });
}

/**
 * Ask for the getTimeline permission (progressive scopes: the reader stays
 * signed in). By default the grant comes back to /following, which makes the
 * channel and opens it; Everything's first-run question brings you back to
 * Everything.
 */
export async function grantFollowsAccess(returnUrl: string = FOLLOWING_PATH): Promise<void> {
  await auth.grantPermissions(['follows'], returnUrl);
}
