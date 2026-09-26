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
//
// It can also run ahead of the open: `prefetchStoredBody` fetches a body as its
// card nears the screen (the card previews the archive's `contentLead`
// meanwhile), so expanding is instant. A prefetch never extracts, never holds
// the body in the card — it lands in IndexedDB (or the small `recent` cache for
// an item with no row there) and `loadStoredBody` picks it up from there.

import { api, ApiError } from './api';
import { db } from './db';
import type { Article } from '$lib/types';

type ArticleRef = Pick<Article, 'id' | 'guid' | 'subscriptionId'>;

// What the archive said. `missing` is a real answer (it holds no copy), so the
// caller can settle on extraction; `unavailable` means the question went
// unanswered (offline, rate limit, 5xx) and is worth asking again later.
export type StoredBodyResult =
  { status: 'found'; content: string } | { status: 'missing' } | { status: 'unavailable' };

// Per-session memo. A 404 is a stable answer for the session (the archive holds
// no copy), so it isn't asked again; any other failure is not remembered, so a
// later open retries.
const misses = new Set<string>();
const inflight = new Map<string, Promise<StoredBodyResult>>();

function memoKey(feedUrl: string, guid: string): string {
  return `${feedUrl}\n${guid}`;
}

// Bodies found this session that have no IndexedDB row to live in (a guest's
// or an archive page's item), so a prefetch isn't thrown away before the open
// it was for. Small and LRU: it bridges prefetch → expand, nothing more.
const RECENT_MAX = 12;
const recent = new Map<string, string>();

function remember(key: string, content: string): void {
  recent.delete(key);
  recent.set(key, content);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as string);
}

async function findRow(article: ArticleRef): Promise<Article | undefined> {
  let row = article.id != null ? await db.articles.get(article.id) : undefined;
  if (!row && article.guid) {
    row = await db.articles
      .where('guid')
      .equals(article.guid)
      .filter((a) => a.subscriptionId === article.subscriptionId)
      .first();
  }
  return row;
}

/** Write the body into the article's row. False when there's no row to hold it. */
async function persist(article: ArticleRef, content: string): Promise<boolean> {
  try {
    const row = await findRow(article);
    if (row?.id == null) return false;
    if (!row.content) await db.articles.update(row.id, { content });
    return true;
  } catch (e) {
    // Only the offline copy is lost; the caller still has the body.
    console.warn('Failed to cache stored article body:', e);
    return false;
  }
}

/** A body already fetched — by a prefetch, or an earlier open — without the network. */
async function cachedBody(article: ArticleRef, key: string): Promise<string | undefined> {
  const hit = recent.get(key);
  if (hit) return hit;
  try {
    return (await findRow(article))?.content || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch `article`'s stored body. Never rejects: resolves `missing` when the
 * archive has none (the caller falls back to extraction for good) and
 * `unavailable` when it couldn't be reached (fall back for now, retry later).
 */
export function loadStoredBody(
  article: ArticleRef,
  feedUrl: string,
  options: { guest: boolean }
): Promise<StoredBodyResult> {
  const key = memoKey(feedUrl, article.guid);
  if (misses.has(key)) return Promise.resolve({ status: 'missing' });
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async (): Promise<StoredBodyResult> => {
    try {
      const cached = await cachedBody(article, key);
      if (cached) return { status: 'found', content: cached };
      const { content } = await api.fetchItemBody(feedUrl, article.guid, options);
      if (!content) {
        misses.add(key);
        return { status: 'missing' };
      }
      if (!(await persist(article, content))) remember(key, content);
      return { status: 'found', content };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        misses.add(key);
        return { status: 'missing' };
      }
      return { status: 'unavailable' };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, request);
  return request;
}

// Prefetches run a couple at a time, behind whatever the reader explicitly
// opens (which calls loadStoredBody directly and never queues). Scrolling past a
// run of long posts queues them rather than firing a burst at the per-user rate
// limit; a failure (offline, 429, 5xx) pauses the queue so it can't hammer a
// struggling endpoint — the card still falls back to its lead, and expanding
// asks again.
const PREFETCH_CONCURRENCY = 2;
const PREFETCH_PAUSE_MS = 60_000;
let prefetchActive = 0;
let prefetchPausedUntil = 0;
const prefetchQueue: Array<() => void> = [];

function drainPrefetchQueue(): void {
  while (prefetchActive < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
    prefetchQueue.shift()!();
  }
}

/**
 * Fetch `article`'s stored body ahead of the open, without handing it back.
 * Resolves with what the archive said — `missing` is the same final answer
 * loadStoredBody gives — or `skipped` when the queue is paused after a failure.
 * Never rejects.
 */
export function prefetchStoredBody(
  article: ArticleRef,
  feedUrl: string,
  options: { guest: boolean }
): Promise<StoredBodyResult['status'] | 'skipped'> {
  const key = memoKey(feedUrl, article.guid);
  if (misses.has(key)) return Promise.resolve('missing');
  if (recent.has(key)) return Promise.resolve('found');
  return new Promise((resolve) => {
    prefetchQueue.push(() => {
      if (Date.now() < prefetchPausedUntil) {
        resolve('skipped');
        return;
      }
      prefetchActive++;
      loadStoredBody(article, feedUrl, options)
        .then((result) => {
          if (result.status === 'unavailable') prefetchPausedUntil = Date.now() + PREFETCH_PAUSE_MS;
          resolve(result.status);
        })
        .finally(() => {
          prefetchActive--;
          drainPrefetchQueue();
        });
    });
    drainPrefetchQueue();
  });
}

/** Test hook: clear the prefetch queue's pause. */
export function resetPrefetchForTests(): void {
  prefetchPausedUntil = 0;
}
