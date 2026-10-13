import type { Subscription } from '$lib/types';

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

/** Sources whose items live in the D1 feed archive: RSS (the default) and newsletters. */
export function isArchiveFeedSource(sourceType: string | undefined): boolean {
  return !sourceType || sourceType === 'rss' || sourceType === NEWSLETTER_SOURCE_TYPE;
}

/** The sender address a newsletter subscription collects mail from. */
export function newsletterSender(feedUrl: string | undefined): string | null {
  if (!feedUrl?.startsWith('newsletter:')) return null;
  const slash = feedUrl.indexOf('/');
  return slash > 0 ? feedUrl.slice(slash + 1) || null : null;
}

/**
 * A channel's type filter splits the archive in two: 'rss' is the crawled
 * feeds, 'email.newsletter' the mail. They share one archive, so without this
 * an "RSS Feeds" filter let newsletters through. Returns null when the filter
 * keeps every archive item (no type filter, or both types); a filter naming
 * neither keeps none, which callers check first with `typeFilterShowsArchive`.
 */
export function archiveTypeFilter(
  typeFilter: readonly string[]
): ((sub: Pick<Subscription, 'sourceType' | 'feedUrl'> | undefined) => boolean) | null {
  const rss = typeFilter.length === 0 || typeFilter.includes('rss');
  const mail = typeFilter.length === 0 || typeFilter.includes(NEWSLETTER_SOURCE_TYPE);
  if (rss && mail) return null;
  // An item whose subscription is gone reads as a plain feed.
  return (sub) => (sub && isNewsletterSubscription(sub) ? mail : rss);
}

/** Does a type filter let any archive item (feed or newsletter) through? */
export function typeFilterShowsArchive(typeFilter: readonly string[]): boolean {
  return (
    typeFilter.length === 0 ||
    typeFilter.includes('rss') ||
    typeFilter.includes(NEWSLETTER_SOURCE_TYPE)
  );
}
