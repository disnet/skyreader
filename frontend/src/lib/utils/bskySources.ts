import type { Subscription } from '$lib/types';

/**
 * Bluesky likes and bookmarks as sources. The posts a reader liked or
 * bookmarked on Bluesky that carry a link are gathered server-side (see
 * backend/src/services/bsky-sources.ts) into one private subscription each,
 * `feedUrl` `bsky-likes:<did>` / `bsky-bookmarks:<did>`. Like a newsletter it
 * isn't fetchable and never on the PDS, and its items sit in the same D1
 * archive as RSS, so everything that reads the archive treats it like a feed.
 */
export type BskySourceKind = 'likes' | 'bookmarks';

export const BSKY_LIKES_SOURCE_TYPE = 'bsky.likes';
export const BSKY_BOOKMARKS_SOURCE_TYPE = 'bsky.bookmarks';

export function isBskySource(sourceType: string | undefined): boolean {
  return sourceType === BSKY_LIKES_SOURCE_TYPE || sourceType === BSKY_BOOKMARKS_SOURCE_TYPE;
}

export function isBskySourceSubscription(
  sub: Pick<Subscription, 'sourceType' | 'feedUrl'>
): boolean {
  return (
    isBskySource(sub.sourceType) ||
    !!sub.feedUrl?.startsWith('bsky-likes:') ||
    !!sub.feedUrl?.startsWith('bsky-bookmarks:')
  );
}

export function bskySourceKind(
  sub: Pick<Subscription, 'sourceType' | 'feedUrl'>
): BskySourceKind | null {
  if (sub.sourceType === BSKY_LIKES_SOURCE_TYPE || sub.feedUrl?.startsWith('bsky-likes:')) {
    return 'likes';
  }
  if (sub.sourceType === BSKY_BOOKMARKS_SOURCE_TYPE || sub.feedUrl?.startsWith('bsky-bookmarks:')) {
    return 'bookmarks';
  }
  return null;
}
