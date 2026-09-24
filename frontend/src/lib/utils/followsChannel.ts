import { auth } from '$lib/stores/auth.svelte';
import { followLinksStore } from '$lib/stores/followLinks.svelte';
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

/** A create still waiting on the store; two callers must not make two channels. */
let creating: Promise<string> | null = null;

/** The follows channel's uuid, creating the preset when no channel has the source. */
export async function ensureFollowsChannel(): Promise<string> {
  const existing = findFollowsChannel();
  if (existing) return existing.uuid;
  creating ??= filteredViewsStore
    .create({
      name: FOLLOWS_CHANNEL_NAME,
      mode: 'feed',
      sourceMode: 'include',
      sourceKeys: [FOLLOWS_SOURCE_KEY],
      readFilter: 'unread',
      sortOrder: 'newest',
    })
    .finally(() => (creating = null));
  return creating;
}

/** Set before leaving to ask for the permission; the account it was asked for. */
const GRANT_PENDING_KEY = 'skyreader:follows-grant-pending';

function readGrantPending(): string | null {
  try {
    return localStorage.getItem(GRANT_PENDING_KEY);
  } catch {
    return null;
  }
}

function clearGrantPending(): void {
  try {
    localStorage.removeItem(GRANT_PENDING_KEY);
  } catch {
    // Storage blocked: nothing was kept, so nothing to clear.
  }
}

/**
 * Finish a grant, wherever it came back to: once the permission is in, make the
 * follows channel so it's in the sidebar from the first visit. Only after a
 * grant, so a reader who deletes the channel doesn't get it back. Call once the
 * channel sync is done (a channel made on another device arrives with it).
 */
export async function completeFollowsGrant(): Promise<void> {
  const did = auth.user?.did;
  if (!did || auth.isGuest || readGrantPending() !== did) return;
  await followLinksStore.load(true);
  if (!followLinksStore.loaded) return; // Couldn't ask; try again next start.
  clearGrantPending();
  if (followLinksStore.scopeRequired) return; // Declined at the provider.
  await ensureFollowsChannel();
}

/**
 * Ask for the getTimeline permission (progressive scopes: the reader stays
 * signed in). By default the grant comes back to /following, which opens the
 * channel; Everything's first-run question brings you back to Everything.
 * Wherever it lands, completeFollowsGrant makes the channel.
 */
export async function grantFollowsAccess(returnUrl: string = FOLLOWING_PATH): Promise<void> {
  const did = auth.user?.did;
  if (did) {
    try {
      localStorage.setItem(GRANT_PENDING_KEY, did);
    } catch {
      // Storage blocked: /following still makes the channel; other returns don't.
    }
  }
  await auth.grantPermissions(['follows'], returnUrl);
}
