import type { Subscription } from '$lib/types';

/**
 * Push feeds: feeds the reader fills themselves, from an AI app or a script
 * (backend/src/services/push-feeds.ts). One subscription per named feed, with
 * `feedUrl` `push:<did>/<key>`. Like a newsletter it isn't fetchable, never on
 * the PDS and readable only by its owner, and its items sit in the same D1
 * archive as RSS, so everything that reads the archive treats it like a feed.
 */
export const PUSH_SOURCE_TYPE = 'push';

export function isPushSource(sourceType: string | undefined): boolean {
  return sourceType === PUSH_SOURCE_TYPE;
}

export function isPushSubscription(sub: Pick<Subscription, 'sourceType' | 'feedUrl'>): boolean {
  return isPushSource(sub.sourceType) || !!sub.feedUrl?.startsWith('push:');
}
