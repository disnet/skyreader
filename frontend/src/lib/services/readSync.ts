import type { SocialReadingPayload } from './sync-queue';

// The shape the unified /api/reading writers (markAsRead / markAsReadBulk) accept
// for a document read.
export interface UnifiedReadItem {
  itemGuid: string;
  itemType: 'document';
  rkey: string;
  authorDid: string;
  itemUrl?: string;
  itemTitle?: string;
}

function isHttpUrl(url: string | undefined): url is string {
  return !!url && (url.startsWith('http://') || url.startsWith('https://'));
}

/**
 * Map a queued document-read payload onto the unified read-writer shape.
 *
 * Document reads were folded onto the article read path, so the offline-retry
 * queue replays them through /api/reading instead of the deleted social-reading
 * routes. The only non-trivial bit is the URL guard: only http(s) URLs are
 * forwarded (an `at://` uri or empty string becomes undefined), and an empty
 * title collapses to undefined — matching what the article writer stores.
 */
export function toUnifiedReadItem(payload: SocialReadingPayload): UnifiedReadItem {
  return {
    itemGuid: payload.itemUri,
    itemType: 'document',
    rkey: payload.rkey,
    authorDid: payload.authorDid,
    itemUrl: isHttpUrl(payload.itemUrl) ? payload.itemUrl : undefined,
    itemTitle: payload.itemTitle || undefined,
  };
}
