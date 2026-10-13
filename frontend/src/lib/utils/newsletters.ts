import type { Subscription } from '$lib/types';
import { bskySourceKind, isBskySource } from '$lib/utils/bskySources';

/**
 * Email newsletters (a Supporter feature). Mail sent to the reader's private
 * address lands server-side as one subscription per sender, with `feedUrl`
 * `newsletter:<inbox id>/<sender>` — not fetchable, never on the PDS, and
 * readable only by its owner. Its items sit in the same D1 archive as RSS, so
 * everything that reads that archive (timeline, unread counts, "Show older",
 * mark-all-read, channels) treats it like a feed; only fetching it from the
 * crawler makes no sense.
 */
export const NEWSLETTER_SOURCE_TYPE = 'email.newsletter';

export function isNewsletterSource(sourceType: string | undefined): boolean {
  return sourceType === NEWSLETTER_SOURCE_TYPE;
}

export function isNewsletterSubscription(
  sub: Pick<Subscription, 'sourceType' | 'feedUrl'>
): boolean {
  return isNewsletterSource(sub.sourceType) || !!sub.feedUrl?.startsWith('newsletter:');
}

/**
 * Sources whose items live in the D1 feed archive: RSS (the default),
 * newsletters, and Bluesky likes / bookmarks ($lib/utils/bskySources.ts).
 */
export function isArchiveFeedSource(sourceType: string | undefined): boolean {
  return (
    !sourceType ||
    sourceType === 'rss' ||
    sourceType === NEWSLETTER_SOURCE_TYPE ||
    isBskySource(sourceType)
  );
}

/** The sender address a newsletter subscription collects mail from. */
export function newsletterSender(feedUrl: string | undefined): string | null {
  if (!feedUrl?.startsWith('newsletter:')) return null;
  const slash = feedUrl.indexOf('/');
  return slash > 0 ? feedUrl.slice(slash + 1) || null : null;
}

/** The archive's types, as a channel's type filter names them. */
const ARCHIVE_TYPES = ['rss', NEWSLETTER_SOURCE_TYPE, 'bsky.likes', 'bsky.bookmarks'] as const;
type ArchiveType = (typeof ARCHIVE_TYPES)[number];

/** Which archive type a subscription's items count as for a type filter. */
function archiveTypeOf(sub: Pick<Subscription, 'sourceType' | 'feedUrl'> | undefined): ArchiveType {
  // An item whose subscription is gone reads as a plain feed.
  if (!sub) return 'rss';
  if (isNewsletterSubscription(sub)) return NEWSLETTER_SOURCE_TYPE;
  const bsky = bskySourceKind(sub);
  if (bsky) return bsky === 'likes' ? 'bsky.likes' : 'bsky.bookmarks';
  return 'rss';
}

/**
 * A channel's type filter splits the archive by type: 'rss' is the crawled
 * feeds, 'email.newsletter' the mail, 'bsky.likes' / 'bsky.bookmarks' the link
 * posts gathered from Bluesky. They share one archive, so without this an "RSS
 * Feeds" filter let the others through. Returns null when the filter keeps every
 * archive item (no type filter, or every archive type); a filter naming none
 * keeps none, which callers check first with `typeFilterShowsArchive`.
 */
export function archiveTypeFilter(
  typeFilter: readonly string[]
): ((sub: Pick<Subscription, 'sourceType' | 'feedUrl'> | undefined) => boolean) | null {
  if (typeFilter.length === 0 || ARCHIVE_TYPES.every((t) => typeFilter.includes(t))) return null;
  return (sub) => typeFilter.includes(archiveTypeOf(sub));
}

/** Does a type filter let any archive item (feed, newsletter, Bluesky) through? */
export function typeFilterShowsArchive(typeFilter: readonly string[]): boolean {
  return typeFilter.length === 0 || ARCHIVE_TYPES.some((t) => typeFilter.includes(t));
}
