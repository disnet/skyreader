// The full body of an archive item whose content was too big to ride the
// timeline. Ingest drops any body over the inline cap from the row (marking it
// `contentTruncated`) and stores it in R2 instead; this fetches it when the
// article is opened and writes it into the item's IndexedDB row, so the next
// open — and offline reading — needs no network.
//
// It sits in front of extraction, not beside it: a stored body is the feed
// author's own `content:encoded`, one cheap read against our own archive, and
// available to guests. Extraction scrapes the web page through the proxy, is
// account-only, and remains the fallback for items with no stored copy (bodies
// over the stored ceiling, rows ingested before storage existed).

import { api, ApiError } from './api';
import { db } from './db';
import type { Article } from '$lib/types';

type ArticleRef = Pick<Article, 'id' | 'guid' | 'subscriptionId'>;

// Per-session memo. A 404 is a stable answer for the session (the archive holds
// no copy), so it isn't asked again; any other failure (offline, rate limit) is
// not remembered, so a later open retries.
const misses = new Set<string>();
const inflight = new Map<string, Promise<string | null>>();

function memoKey(feedUrl: string, guid: string): string {
  return `${feedUrl}\n${guid}`;
}

async function persist(article: ArticleRef, content: string): Promise<void> {
  try {
    let row = article.id != null ? await db.articles.get(article.id) : undefined;
    if (!row && article.guid) {
      row = await db.articles
        .where('guid')
        .equals(article.guid)
        .filter((a) => a.subscriptionId === article.subscriptionId)
        .first();
    }
    if (row?.id != null && !row.content) await db.articles.update(row.id, { content });
  } catch (e) {
    // Only the offline copy is lost; the caller still has the body.
    console.warn('Failed to cache stored article body:', e);
  }
}

/**
 * Fetch `article`'s stored body. Resolves to the HTML, or null when the archive
 * has none (or it couldn't be reached) — the caller then falls back to
 * extraction. Never rejects.
 */
export function loadStoredBody(
  article: ArticleRef,
  feedUrl: string,
  options: { guest: boolean }
): Promise<string | null> {
  const key = memoKey(feedUrl, article.guid);
  if (misses.has(key)) return Promise.resolve(null);
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async () => {
    try {
      const { content } = await api.fetchItemBody(feedUrl, article.guid, options);
      if (!content) {
        misses.add(key);
        return null;
      }
      await persist(article, content);
      return content;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) misses.add(key);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, request);
  return request;
}
