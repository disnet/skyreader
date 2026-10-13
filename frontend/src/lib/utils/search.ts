// Full-text search, client side: who gets it, and how a hit opens.
//
// Search runs on the server (backend/src/routes/search.ts) over everything the
// reader has read, saved and highlighted — which reaches far past what this
// device holds. So a hit has to open whether or not its item is in the local
// stores: a feed article that aged out of Dexie still opens in the reader as a
// stub, and the reader fetches its body from the archive like any truncated item.

import type { SearchHit } from '$lib/services/api';
import type { FeedDisplayItem } from '$lib/stores/feedView.svelte';
import type { Article, User } from '$lib/types';
import { decodeEntities } from './entities';
import { domainFromUrl } from './highlightSource';
import { resolveReaderItem, type ReaderKeySources } from './readerLink';

/** Search is offered when the plan includes it and this environment has it on. */
export function canUseSearch(user: User | null | undefined): boolean {
  return Boolean(user?.limits?.fullTextSearch && user.searchEnabled);
}

export interface SearchHitSources extends ReaderKeySources {
  /** The reader's subscription id for a feed URL, if they still follow it. */
  subscriptionIdFor: (feedUrl: string) => number | undefined;
}

/**
 * The reader item for a hit: the local copy when this device has it (saves,
 * then articles, then documents — the same order a `?read=` link resolves in),
 * else a stub article for a feed the reader still follows. Null when neither
 * applies (a document never loaded here, an item from a feed since left); the
 * caller falls back to the hit's URL.
 */
export function resolveSearchHit(
  hit: SearchHit,
  sources: SearchHitSources,
  now = Date.now()
): FeedDisplayItem | null {
  const local = resolveReaderItem(hit.itemKey, sources);
  if (local) return local;

  if (hit.itemType !== 'article' || !hit.feedUrl || !hit.url) return null;
  const subscriptionId = sources.subscriptionIdFor(hit.feedUrl);
  if (subscriptionId === undefined) return null;

  const article: Article = {
    subscriptionId,
    guid: hit.itemKey,
    url: hit.url,
    title: hit.title,
    publishedAt: '',
    fetchedAt: now,
    // No body here: marking it truncated sends the reader to the archive's
    // stored copy, then to extraction, exactly as for a "Show older" item.
    contentTruncated: true,
  };
  return { type: 'article', item: article, key: article.guid };
}

/**
 * The title a hit shows. The index can come up empty for an item it only knows
 * through a highlight — an older highlight carries no source title, and the
 * item's feed or document may be out of the index's reach — so the copy on
 * this device fills in before the hit falls back to its domain.
 */
export function searchHitTitle(hit: SearchHit, sources: ReaderKeySources): string {
  if (hit.title) return hit.title;
  const local = resolveReaderItem(hit.itemKey, sources);
  const localTitle = decodeEntities(local?.item.title);
  if (localTitle) return localTitle;
  const localUrl = local
    ? local.type === 'document'
      ? local.item.canonicalUrl
      : local.item.url
    : null;
  return domainFromUrl(hit.url) || domainFromUrl(localUrl) || 'Untitled';
}

/** "3 results", "1,000+ results". */
export function formatResultCount(total: number, capped: boolean): string {
  const n = total.toLocaleString();
  return `${n}${capped ? '+' : ''} result${total === 1 && !capped ? '' : 's'}`;
}

/** The most recent thing the reader did with a hit, for its meta line. */
export function lastTouched(hit: SearchHit): { verb: string; at: number } | null {
  const touches = [
    { verb: 'Highlighted', at: hit.highlightedAt },
    { verb: 'Saved', at: hit.savedAt },
    { verb: 'Read', at: hit.readAt },
  ].filter((t): t is { verb: string; at: number } => typeof t.at === 'number' && t.at > 0);
  if (touches.length === 0) return null;
  return touches.reduce((latest, t) => (t.at > latest.at ? t : latest));
}
