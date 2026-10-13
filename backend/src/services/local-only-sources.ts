// Sources that exist only in Skyreader's D1, for one reader: email newsletters
// (services/newsletters.ts) and Bluesky likes / bookmarks
// (services/bsky-sources.ts). They are never crawled, never written to or
// mirrored from the PDS, and created only by their own feature, never by the
// generic subscription routes. Each guard that holds that line asks here.

import type { Env } from '../types';
import { isNewsletterFeedUrl, isNewsletterSubscription, ownsNewsletterFeed } from './newsletters';
import { isBskySourceFeedUrl, isBskySourceSubscription, ownsBskySourceFeed } from './bsky-sources';

// Spelled out rather than imported: routes/subscriptions.ts builds SQL from this
// list when its module loads, and both feature modules sit in an import cycle
// through routes/ingest.ts, so an imported constant can still be undefined then.
// test/bsky-sources.spec.ts checks it against NEWSLETTER_SOURCE_TYPE and the
// BSKY_*_SOURCE_TYPEs.
export const LOCAL_ONLY_SOURCE_TYPES = [
  'email.newsletter',
  'bsky.likes',
  'bsky.bookmarks',
] as const;

// Spelled out for the same reason; the same test checks them.
export const LOCAL_ONLY_FEED_URL_PREFIXES = [
  'newsletter:',
  'bsky-likes:',
  'bsky-bookmarks:',
] as const;

export function isLocalOnlySubscription(
  feedUrl: string | null | undefined,
  sourceType: string | null | undefined
): boolean {
  return (
    isNewsletterSubscription(feedUrl, sourceType) || isBskySourceSubscription(feedUrl, sourceType)
  );
}

/** SQL: this subscriptions_cache row is not a local-only source. */
export function notLocalOnlySql(alias = ''): string {
  const column = alias ? `${alias}.source_type` : 'source_type';
  const types = LOCAL_ONLY_SOURCE_TYPES.map((t) => `'${t}'`).join(', ');
  return `(${column} IS NULL OR ${column} NOT IN (${types}))`;
}

/** SQL: this subscriptions_cache row IS a local-only source, by type or feed url. */
export function localOnlySql(alias = ''): string {
  const feedUrl = alias ? `${alias}.feed_url` : 'feed_url';
  const prefixes = LOCAL_ONLY_FEED_URL_PREFIXES.map((p) => `${feedUrl} LIKE '${p}%'`).join(' OR ');
  return `(NOT ${notLocalOnlySql(alias)} OR ${prefixes})`;
}

/** A local-only feed's url, from any caller. */
export function isLocalOnlyFeedUrl(feedUrl: string | null | undefined): boolean {
  return isNewsletterFeedUrl(feedUrl) || isBskySourceFeedUrl(feedUrl);
}

/**
 * May this reader read this local-only feed? Only its owner. Every read path
 * that serves archive items by feed url asks this before a local-only one.
 */
export async function ownsLocalOnlyFeed(
  env: Env,
  viewerDid: string | null,
  feedUrl: string
): Promise<boolean> {
  if (isNewsletterFeedUrl(feedUrl)) return ownsNewsletterFeed(env, viewerDid, feedUrl);
  if (isBskySourceFeedUrl(feedUrl)) return ownsBskySourceFeed(viewerDid, feedUrl);
  return false;
}
