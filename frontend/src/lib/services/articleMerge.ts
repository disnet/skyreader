import type { Article, FeedItem } from '$lib/types';

/**
 * K — the canonical per-feed window. Must equal `ARTICLE_WINDOW_PER_FEED` in
 * `backend/src/config/window.ts`: the server cold-starts a device with exactly
 * this many per feed and computes its unread counts over exactly this many, so
 * a mismatch here is a device that counts over a different set than every other
 * device — which is the whole cross-device divergence bug. Change both or
 * neither.
 */
export const MAX_ARTICLES_PER_FEED = 100;

/**
 * Pure helpers backing liveDb's article merge. Kept free of Dexie and Svelte
 * runes so the dedup and per-feed limit semantics can be unit-tested directly.
 *
 * GUIDs are only unique within a feed, so identity is the (subscriptionId, guid)
 * pair throughout.
 */

function feedKey(subscriptionId: number, guid: string): string {
  return `${subscriptionId} ${guid}`;
}

/**
 * Derive the cheap body stats (char length + word count) from an article's
 * content/summary. Matches the historical `content || summary` precedence so
 * the values are identical to what the inline computations produced before the
 * content was stripped from memory.
 */
export function computeContentStats(
  content?: string,
  summary?: string
): { contentLength: number; wordCount: number } {
  const text = content || summary || '';
  const trimmed = text.trim();
  return {
    contentLength: text.length,
    wordCount: trimmed ? trimmed.split(/\s+/).length : 0,
  };
}

/**
 * Return a memory-light copy of an article: the full `content` HTML is dropped
 * and replaced by precomputed `contentLength`/`wordCount`. `summary` (the short
 * RSS description) is kept — it's small and still used for previews, share
 * quotes, and the save path. The full body remains in IndexedDB and is
 * lazy-loaded on expand (see ArticleCard). Idempotent: re-lightening a row that
 * already has stats and no content just recomputes the same numbers.
 */
export function toLightArticle(a: Article): Article {
  const { contentLength, wordCount } = computeContentStats(a.content, a.summary);
  // Explicitly drop `content` rather than spread-and-overwrite so the large
  // string isn't retained by the new object.
  const { content: _content, ...rest } = a;
  return { ...rest, contentLength, wordCount };
}

/**
 * Select the items not already present and convert them to Articles.
 *
 * Dedupes against `existing` and against earlier items in the same call (a feed
 * payload can repeat a GUID). Returns the new articles plus the set of
 * subscription ids they belong to, so callers know which feeds to re-check
 * against the per-feed limit.
 */
export function selectNewArticles(
  existing: Pick<Article, 'subscriptionId' | 'guid'>[],
  feeds: Array<{ subscriptionId: number; items: FeedItem[] }>,
  now: number
): { newArticles: Article[]; affected: Set<number> } {
  const seen = new Set<string>();
  for (const a of existing) seen.add(feedKey(a.subscriptionId, a.guid));

  const newArticles: Article[] = [];
  const affected = new Set<number>();

  for (const { subscriptionId, items } of feeds) {
    for (const item of items) {
      const key = feedKey(subscriptionId, item.guid);
      if (seen.has(key)) continue;
      seen.add(key);
      affected.add(subscriptionId);
      newArticles.push({
        subscriptionId,
        guid: item.guid,
        url: item.url,
        title: item.title,
        author: item.author,
        content: item.content,
        summary: item.summary,
        imageUrl: item.imageUrl,
        publishedAt: item.publishedAt,
        fetchedAt: now,
        // Carried through so the reader knows to extract the full text on open
        // (the archive dropped an oversized body at ingest).
        contentTruncated: item.contentTruncated || undefined,
      });
    }
  }

  return { newArticles, affected };
}

/**
 * Compute which articles to drop to keep each affected feed within
 * `maxPerFeed`. Articles the reader has invested something in — starred (guid
 * in `savedGuids`), tagged, or highlighted (`isLabeled`) — are always kept;
 * among the rest the newest are kept.
 *
 * Eviction from a cache is fine. Eviction that orphans a highlight or a tag is
 * not: the annotation survives in the label store with nothing left to attach
 * it to. Read/unread stays recency-governed on purpose — exempting unread items
 * would let a device's local set grow without bound and diverge from every
 * other device's, which is precisely what the canonical window exists to stop.
 * Older items are not lost either way; D1 never prunes, and the feed view pages
 * back into it on demand.
 *
 * `articles` must be sorted newest-first — each feed's slice inherits that
 * order, so keeping the head keeps the newest.
 *
 * Returns the IndexedDB ids to delete and, per feed, the set of GUIDs dropped
 * (for updating an in-memory array that may include rows without an id yet).
 */
export function computeArticleLimitDeletions(
  articles: Article[],
  subscriptionIds: Set<number>,
  savedGuids: Set<string>,
  maxPerFeed: number = MAX_ARTICLES_PER_FEED,
  isLabeled: (guid: string) => boolean = () => false
): { ids: number[]; dropByFeed: Map<number, Set<string>> } {
  const byFeed = new Map<number, Article[]>();
  for (const a of articles) {
    if (!subscriptionIds.has(a.subscriptionId)) continue;
    let arr = byFeed.get(a.subscriptionId);
    if (!arr) {
      arr = [];
      byFeed.set(a.subscriptionId, arr);
    }
    arr.push(a);
  }

  const ids: number[] = [];
  const dropByFeed = new Map<number, Set<string>>();

  for (const [subscriptionId, feedArticles] of byFeed) {
    if (feedArticles.length <= maxPerFeed) continue;

    const isPinned = (a: Article) => savedGuids.has(a.guid) || isLabeled(a.guid);
    const pinned = feedArticles.filter(isPinned);
    const evictable = feedArticles.filter((a) => !isPinned(a));

    const keepCount = Math.max(0, maxPerFeed - pinned.length);
    const toKeep = new Set([
      ...pinned.map((a) => a.guid),
      ...evictable.slice(0, keepCount).map((a) => a.guid),
    ]);

    const drop = feedArticles.filter((a) => !toKeep.has(a.guid));
    if (drop.length === 0) continue;

    for (const a of drop) {
      if (a.id !== undefined) ids.push(a.id);
    }
    dropByFeed.set(subscriptionId, new Set(drop.map((a) => a.guid)));
  }

  return { ids, dropByFeed };
}
