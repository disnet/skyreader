import type { Subscription } from '$lib/types';
import { getFaviconUrl } from './favicon';

/**
 * Filter subscriptions by a search term against their title and feed URL.
 * Returns the input array unchanged if the term is empty.
 */
export function filterSubscriptionsBySearch(
  subscriptions: Subscription[],
  search: string
): Subscription[] {
  if (!search) return subscriptions;
  const term = search.toLowerCase();
  return subscriptions.filter(
    (sub) =>
      (sub.customTitle || sub.title).toLowerCase().includes(term) ||
      (sub.feedUrl?.toLowerCase().includes(term) ?? false)
  );
}

/**
 * Resolve the icon URL for a subscription, falling back through customIconUrl,
 * the site favicon, and the app default for atproto sources without a site URL.
 */
export function subscriptionIconUrl(sub: Subscription): string {
  if (sub.customIconUrl) return sub.customIconUrl;
  const isAtProto = sub.sourceType?.startsWith('atproto.') ?? false;
  if (isAtProto) {
    return sub.siteUrl ? getFaviconUrl(sub.siteUrl) : '/icons/icon-192.svg';
  }
  return getFaviconUrl(sub.siteUrl || sub.feedUrl || '');
}
