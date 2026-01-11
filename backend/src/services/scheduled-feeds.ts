import type { Env } from '../types';
import { parseFeed } from './feed-parser';

// Hash URL for cache key (same as feeds.ts)
function hashUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

interface FeedToFetch {
  feed_url: string;
  subscriber_count: number;
}

interface RefreshResult {
  fetched: number;
  skipped: number;
  errors: number;
}

const BATCH_SIZE = 10;
const DELAY_BETWEEN_BATCHES_MS = 1000;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const MAX_ERROR_COUNT = 10; // Skip feeds with too many consecutive errors

export async function refreshActiveFeeds(env: Env): Promise<RefreshResult> {
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - SEVEN_DAYS_SECONDS;

  // Query unique feeds from active users' subscriptions
  // Ordered by subscriber count so popular feeds are refreshed first
  const feedsResult = await env.DB.prepare(`
    SELECT DISTINCT sc.feed_url, COUNT(DISTINCT sc.user_did) as subscriber_count
    FROM subscriptions_cache sc
    INNER JOIN users u ON sc.user_did = u.did
    WHERE u.last_active_at > ?
    GROUP BY sc.feed_url
    ORDER BY subscriber_count DESC
  `).bind(sevenDaysAgo).all<FeedToFetch>();

  const feeds = feedsResult.results || [];
  console.log(`Scheduled refresh: found ${feeds.length} feeds to check`);

  if (feeds.length === 0) {
    return { fetched: 0, skipped: 0, errors: 0 };
  }

  let fetched = 0;
  let skipped = 0;
  let errors = 0;

  // Process in batches to avoid overwhelming external servers
  for (let i = 0; i < feeds.length; i += BATCH_SIZE) {
    const batch = feeds.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map((feed: FeedToFetch) => fetchAndCacheFeed(env, feed.feed_url, feed.subscriber_count))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.status === 'fetched') {
          fetched++;
        } else {
          skipped++;
        }
      } else {
        errors++;
        console.error('Feed fetch failed:', result.reason);
      }
    }

    // Delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < feeds.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }

  return { fetched, skipped, errors };
}

async function fetchAndCacheFeed(
  env: Env,
  feedUrl: string,
  subscriberCount: number
): Promise<{ status: 'fetched' | 'skipped' | 'not_modified' }> {
  const urlHash = hashUrl(feedUrl);
  const now = Math.floor(Date.now() / 1000);

  // Check if feed has too many errors - skip it
  const errorCheck = await env.DB.prepare(
    'SELECT error_count FROM feed_metadata WHERE feed_url = ?'
  ).bind(feedUrl).first<{ error_count: number }>();

  if (errorCheck && errorCheck.error_count >= MAX_ERROR_COUNT) {
    console.log(`Skipping ${feedUrl}: too many errors (${errorCheck.error_count})`);
    return { status: 'skipped' };
  }

  // Get existing metadata from D1 for conditional request
  const meta = await env.DB.prepare(
    'SELECT etag, last_modified FROM feed_cache WHERE url_hash = ?'
  ).bind(urlHash).first<{ etag: string | null; last_modified: string | null }>();

  const headers: HeadersInit = {
    'User-Agent': 'AT-RSS/1.0 (+https://at-rss.example.com)',
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  };

  if (meta?.etag) {
    headers['If-None-Match'] = meta.etag;
  }
  if (meta?.last_modified) {
    headers['If-Modified-Since'] = meta.last_modified;
  }

  const response = await fetch(feedUrl, {
    headers,
    cf: { cacheTtl: 0 }, // Bypass Cloudflare cache for fresh fetch
  });

  // Not modified - update metadata but don't re-parse
  if (response.status === 304) {
    await updateScheduledFetchTime(env, feedUrl, subscriberCount);
    // Update cache timestamp to keep it fresh
    await env.DB.prepare(
      'UPDATE feed_cache SET cached_at = ? WHERE url_hash = ?'
    ).bind(now, urlHash).run();
    return { status: 'not_modified' };
  }

  if (!response.ok) {
    await recordFetchError(env, feedUrl, `HTTP ${response.status}`);
    throw new Error(`Failed to fetch ${feedUrl}: ${response.status}`);
  }

  const xml = await response.text();
  const parsed = parseFeed(xml, feedUrl);

  // Cache in D1
  await env.DB.prepare(`
    INSERT INTO feed_cache (url_hash, feed_url, content, etag, last_modified, cached_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(url_hash) DO UPDATE SET
      content = excluded.content,
      etag = excluded.etag,
      last_modified = excluded.last_modified,
      cached_at = excluded.cached_at
  `).bind(
    urlHash,
    feedUrl,
    JSON.stringify(parsed),
    response.headers.get('ETag') || null,
    response.headers.get('Last-Modified') || null,
    now
  ).run();

  // Update feed metadata in D1
  await env.DB.prepare(`
    INSERT INTO feed_metadata (feed_url, title, site_url, description, last_fetched_at, last_scheduled_fetch_at, subscriber_count, etag, last_modified, fetch_error, error_count)
    VALUES (?, ?, ?, ?, unixepoch(), unixepoch(), ?, ?, ?, NULL, 0)
    ON CONFLICT(feed_url) DO UPDATE SET
      title = excluded.title,
      site_url = excluded.site_url,
      description = excluded.description,
      last_fetched_at = unixepoch(),
      last_scheduled_fetch_at = unixepoch(),
      subscriber_count = excluded.subscriber_count,
      etag = excluded.etag,
      last_modified = excluded.last_modified,
      fetch_error = NULL,
      error_count = 0
  `).bind(
    feedUrl,
    parsed.title,
    parsed.siteUrl || null,
    parsed.description || null,
    subscriberCount,
    response.headers.get('ETag') || null,
    response.headers.get('Last-Modified') || null
  ).run();

  // Notify RealtimeHub that new articles may be available
  await notifyRealtimeHub(env, {
    type: 'new_articles',
    payload: {
      feedUrl,
      feedTitle: parsed.title,
      newCount: parsed.items.length, // Total items in feed (client will determine which are new)
      timestamp: Date.now(),
    },
  });

  return { status: 'fetched' };
}

async function updateScheduledFetchTime(env: Env, feedUrl: string, subscriberCount: number): Promise<void> {
  await env.DB.prepare(`
    UPDATE feed_metadata
    SET last_scheduled_fetch_at = unixepoch(),
        subscriber_count = ?
    WHERE feed_url = ?
  `).bind(subscriberCount, feedUrl).run();
}

async function recordFetchError(env: Env, feedUrl: string, error: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO feed_metadata (feed_url, fetch_error, error_count, last_scheduled_fetch_at)
    VALUES (?, ?, 1, unixepoch())
    ON CONFLICT(feed_url) DO UPDATE SET
      fetch_error = excluded.fetch_error,
      error_count = error_count + 1,
      last_scheduled_fetch_at = unixepoch()
  `).bind(feedUrl, error).run();
}

async function notifyRealtimeHub(env: Env, message: object): Promise<void> {
  try {
    const hubId = env.REALTIME_HUB.idFromName('main');
    const hub = env.REALTIME_HUB.get(hubId);
    await hub.fetch('http://internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  } catch (error) {
    console.error('Failed to notify RealtimeHub:', error);
  }
}
