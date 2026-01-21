import type { Env, FeedItem } from '../types';
import { parseFeed, discoverFeeds } from '../services/feed-parser';

const MAX_ITEM_CONTENT_SIZE = 100000; // 100KB per item
const MAX_INITIAL_ITEMS = 50; // Limit items on initial feed import
const MAX_ITEMS_PER_FEED = 30; // Rolling limit - keep only most recent items per feed
const MAX_SQL_PARAMS = 90; // Conservative limit for D1 (empirically lower than SQLite's 999)
const BATCH_INSERT_SIZE = 90; // 90 items × 10 params = 900, under 999 limit

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

export interface StoreItemsResult {
  newCount: number;
  isInitialImport: boolean;
}

// Store individual feed items in D1 using batched inserts
export async function storeItems(env: Env, feedUrl: string, items: FeedItem[]): Promise<StoreItemsResult> {
  if (items.length === 0) {
    return { newCount: 0, isInitialImport: false };
  }

  // Check if this is an initial import (no existing items for this feed)
  const existingCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM feed_items WHERE feed_url = ?'
  ).bind(feedUrl).first<{ count: number }>();

  const isInitialImport = !existingCount || existingCount.count === 0;

  let itemsToStore = items;
  if (isInitialImport && items.length > MAX_INITIAL_ITEMS) {
    // For initial import, limit to most recent items
    itemsToStore = [...items]
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, MAX_INITIAL_ITEMS);
  }

  // Get existing guids to determine which items are truly new
  // Use batched queries to avoid exceeding SQL variable limit
  const guids = itemsToStore.map(item => item.guid);
  const existingGuids = new Set<string>();

  if (guids.length > 0) {
    const chunks = chunkArray(guids, MAX_SQL_PARAMS - 1); // -1 for feedUrl param
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => '?').join(',');
      const existing = await env.DB.prepare(
        `SELECT guid FROM feed_items WHERE feed_url = ? AND guid IN (${placeholders})`
      ).bind(feedUrl, ...chunk).all<{ guid: string }>();

      for (const row of existing.results) {
        existingGuids.add(row.guid);
      }
    }
  }

  // Count new items
  let newCount = 0;
  for (const item of itemsToStore) {
    if (!existingGuids.has(item.guid)) {
      newCount++;
    }
  }

  // Build batch of prepared statements
  const statements = itemsToStore.map(item => {
    const publishedTs = Math.floor(new Date(item.publishedAt).getTime() / 1000);

    // Truncate content if too large
    let content = item.content || null;
    if (content && content.length > MAX_ITEM_CONTENT_SIZE) {
      content = content.substring(0, MAX_ITEM_CONTENT_SIZE) + '...[truncated]';
    }

    // Simple content hash for change detection
    const contentHash = content ? simpleHash(content) : null;

    return env.DB.prepare(`
      INSERT INTO feed_items (feed_url, guid, url, title, author, summary, content, image_url, published_at, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_url, guid) DO UPDATE SET
        url = excluded.url,
        title = excluded.title,
        author = excluded.author,
        summary = excluded.summary,
        content = excluded.content,
        image_url = excluded.image_url,
        published_at = excluded.published_at,
        fetched_at = unixepoch(),
        content_hash = excluded.content_hash
    `).bind(
      feedUrl,
      item.guid,
      item.url,
      item.title,
      item.author || null,
      item.summary || null,
      content,
      item.imageUrl || null,
      publishedTs,
      contentHash
    );
  });

  // Execute inserts in batches to avoid SQL variable limit
  // Each INSERT has 10 params; D1 limit is 999 per batch
  const statementChunks = chunkArray(statements, BATCH_INSERT_SIZE);
  for (const chunk of statementChunks) {
    await env.DB.batch(chunk);
  }

  // Trim to MAX_ITEMS_PER_FEED most recent items to bound storage
  await env.DB.prepare(`
    DELETE FROM feed_items
    WHERE feed_url = ?
    AND id NOT IN (
      SELECT id FROM feed_items
      WHERE feed_url = ?
      ORDER BY published_at DESC
      LIMIT ?
    )
  `).bind(feedUrl, feedUrl, MAX_ITEMS_PER_FEED).run();

  return { newCount, isInitialImport };
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// Hash URL for cache key
function hashUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

const CACHE_TTL_SECONDS = 900; // 15 minutes

interface FeedItemRow {
  id: number;
  feed_url: string;
  guid: string;
  url: string;
  title: string;
  author: string | null;
  summary: string | null;
  content: string | null;
  image_url: string | null;
  published_at: number;
}

function mapRowToFeedItem(row: FeedItemRow): FeedItem {
  return {
    guid: row.guid,
    url: row.url,
    title: row.title,
    author: row.author || undefined,
    summary: row.summary || undefined,
    content: row.content || undefined,
    imageUrl: row.image_url || undefined,
    publishedAt: new Date(row.published_at * 1000).toISOString(),
  };
}

// Get items from feed_items table
async function getItemsFromDb(env: Env, feedUrl: string, limit = 100): Promise<FeedItem[]> {
  const results = await env.DB.prepare(`
    SELECT id, feed_url, guid, url, title, author, summary, content, image_url, published_at
    FROM feed_items
    WHERE feed_url = ?
    ORDER BY published_at DESC
    LIMIT ?
  `).bind(feedUrl, limit).all<FeedItemRow>();

  return results.results.map(mapRowToFeedItem);
}

// Check if we have fresh items in feed_items table
async function hasFreshItems(env: Env, feedUrl: string): Promise<boolean> {
  const urlHash = hashUrl(feedUrl);
  const now = Math.floor(Date.now() / 1000);

  const cached = await env.DB.prepare(
    'SELECT cached_at FROM feed_cache WHERE url_hash = ? AND cached_at > ?'
  ).bind(urlHash, now - CACHE_TTL_SECONDS).first<{ cached_at: number }>();

  if (!cached) return false;

  // Also verify we have items
  const itemCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM feed_items WHERE feed_url = ?'
  ).bind(feedUrl).first<{ count: number }>();

  return itemCount !== null && itemCount.count > 0;
}

// Fetch a feed and cache it - can be called from other modules
export async function fetchAndCacheFeed(env: Env, feedUrl: string): Promise<void> {
  const urlHash = hashUrl(feedUrl);
  const now = Math.floor(Date.now() / 1000);

  const response = await fetch(feedUrl, {
    headers: {
      'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch feed: ${response.status}`);
  }

  const xml = await response.text();
  const parsed = parseFeed(xml, feedUrl);

  // Store individual items in feed_items table
  await storeItems(env, feedUrl, parsed.items);

  // Update feed_cache for TTL tracking (content no longer needed)
  await env.DB.prepare(`
    INSERT INTO feed_cache (url_hash, feed_url, content, etag, last_modified, cached_at)
    VALUES (?, ?, '{}', ?, ?, ?)
    ON CONFLICT(url_hash) DO UPDATE SET
      content = '{}',
      etag = excluded.etag,
      last_modified = excluded.last_modified,
      cached_at = excluded.cached_at
  `).bind(
    urlHash,
    feedUrl,
    response.headers.get('ETag') || null,
    response.headers.get('Last-Modified') || null,
    now
  ).run();

  // Update feed metadata
  await env.DB.prepare(`
    INSERT INTO feed_metadata (feed_url, title, site_url, description, last_fetched_at, etag, last_modified, fetch_error, error_count)
    VALUES (?, ?, ?, ?, unixepoch(), ?, ?, NULL, 0)
    ON CONFLICT(feed_url) DO UPDATE SET
      title = excluded.title,
      site_url = excluded.site_url,
      description = excluded.description,
      last_fetched_at = unixepoch(),
      etag = excluded.etag,
      last_modified = excluded.last_modified,
      fetch_error = NULL,
      error_count = 0
  `).bind(
    feedUrl,
    parsed.title,
    parsed.siteUrl || null,
    parsed.description || null,
    response.headers.get('ETag') || null,
    response.headers.get('Last-Modified') || null
  ).run();
}

interface CachedFeed {
  url_hash: string;
  feed_url: string;
  content: string;
  etag: string | null;
  last_modified: string | null;
  cached_at: number;
}

// Cache-only feed fetch - no external requests
export async function handleCachedFeedFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const feedUrl = url.searchParams.get('url');

  if (!feedUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate URL
  try {
    new URL(feedUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const urlHash = hashUrl(feedUrl);

  // Check if we have cached data
  const cached = await env.DB.prepare(
    'SELECT cached_at FROM feed_cache WHERE url_hash = ?'
  ).bind(urlHash).first<{ cached_at: number }>();

  if (cached) {
    // Read items from feed_items table
    const items = await getItemsFromDb(env, feedUrl);

    // Get feed metadata
    const metadata = await env.DB.prepare(
      'SELECT title, site_url, description, image_url FROM feed_metadata WHERE feed_url = ?'
    ).bind(feedUrl).first<{ title: string; site_url: string | null; description: string | null; image_url: string | null }>();

    const response = {
      title: metadata?.title || 'Unknown Feed',
      description: metadata?.description,
      siteUrl: metadata?.site_url,
      imageUrl: metadata?.image_url,
      items,
      fetchedAt: cached.cached_at * 1000,
    };

    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'HIT',
        'X-Cached-At': String(cached.cached_at),
      },
    });
  }

  // Not in cache - return empty feed structure
  return new Response(JSON.stringify({
    title: 'Loading...',
    items: [],
    fetchedAt: Date.now(),
    cached: false,
  }), {
    headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
  });
}

export async function handleFeedFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const feedUrl = url.searchParams.get('url');
  const force = url.searchParams.get('force') === 'true';

  if (!feedUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate URL
  try {
    new URL(feedUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const urlHash = hashUrl(feedUrl);
  const now = Math.floor(Date.now() / 1000);

  // Check D1 cache unless force refresh
  if (!force) {
    const cached = await env.DB.prepare(
      'SELECT cached_at FROM feed_cache WHERE url_hash = ? AND cached_at > ?'
    ).bind(urlHash, now - CACHE_TTL_SECONDS).first<{ cached_at: number }>();

    if (cached) {
      // Read items from feed_items table
      const items = await getItemsFromDb(env, feedUrl);

      // Get feed metadata
      const metadata = await env.DB.prepare(
        'SELECT title, site_url, description, image_url FROM feed_metadata WHERE feed_url = ?'
      ).bind(feedUrl).first<{ title: string; site_url: string | null; description: string | null; image_url: string | null }>();

      const responseData = {
        title: metadata?.title || 'Unknown Feed',
        description: metadata?.description,
        siteUrl: metadata?.site_url,
        imageUrl: metadata?.image_url,
        items,
        fetchedAt: cached.cached_at * 1000,
      };

      return new Response(JSON.stringify(responseData), {
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }
  }

  try {
    const headers: HeadersInit = {
      'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    };

    // Get metadata for conditional request (even if cache expired)
    if (!force) {
      const meta = await env.DB.prepare(
        'SELECT etag, last_modified FROM feed_cache WHERE url_hash = ?'
      ).bind(urlHash).first<{ etag: string | null; last_modified: string | null }>();

      if (meta?.etag) {
        headers['If-None-Match'] = meta.etag;
      }
      if (meta?.last_modified) {
        headers['If-Modified-Since'] = meta.last_modified;
      }
    }

    const response = await fetch(feedUrl, { headers });

    // If not modified, update cache timestamp and return existing content from feed_items
    if (response.status === 304) {
      // Update cached_at to extend the cache
      await env.DB.prepare(
        'UPDATE feed_cache SET cached_at = ? WHERE url_hash = ?'
      ).bind(now, urlHash).run();

      // Read items from feed_items table
      const items = await getItemsFromDb(env, feedUrl);

      // Get feed metadata
      const metadata = await env.DB.prepare(
        'SELECT title, site_url, description, image_url FROM feed_metadata WHERE feed_url = ?'
      ).bind(feedUrl).first<{ title: string; site_url: string | null; description: string | null; image_url: string | null }>();

      const responseData = {
        title: metadata?.title || 'Unknown Feed',
        description: metadata?.description,
        siteUrl: metadata?.site_url,
        imageUrl: metadata?.image_url,
        items,
        fetchedAt: now * 1000,
      };

      return new Response(JSON.stringify(responseData), {
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }

    if (!response.ok) {
      // Update error count in metadata
      await env.DB.prepare(`
        INSERT INTO feed_metadata (feed_url, fetch_error, error_count, last_fetched_at)
        VALUES (?, ?, 1, unixepoch())
        ON CONFLICT(feed_url) DO UPDATE SET
          fetch_error = excluded.fetch_error,
          error_count = error_count + 1,
          last_fetched_at = unixepoch()
      `).bind(feedUrl, `HTTP ${response.status}`).run();

      return new Response(
        JSON.stringify({ error: `Failed to fetch feed: ${response.status}` }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const xml = await response.text();
    const parsed = parseFeed(xml, feedUrl);

    // Store individual items in feed_items table
    await storeItems(env, feedUrl, parsed.items);

    const parsedJson = JSON.stringify(parsed);

    // Update feed_cache for TTL tracking (content no longer needed)
    await env.DB.prepare(`
      INSERT INTO feed_cache (url_hash, feed_url, content, etag, last_modified, cached_at)
      VALUES (?, ?, '{}', ?, ?, ?)
      ON CONFLICT(url_hash) DO UPDATE SET
        content = '{}',
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        cached_at = excluded.cached_at
    `).bind(
      urlHash,
      feedUrl,
      response.headers.get('ETag') || null,
      response.headers.get('Last-Modified') || null,
      now
    ).run();

    // Update feed metadata in D1
    await env.DB.prepare(`
      INSERT INTO feed_metadata (feed_url, title, site_url, description, last_fetched_at, etag, last_modified, fetch_error, error_count)
      VALUES (?, ?, ?, ?, unixepoch(), ?, ?, NULL, 0)
      ON CONFLICT(feed_url) DO UPDATE SET
        title = excluded.title,
        site_url = excluded.site_url,
        description = excluded.description,
        last_fetched_at = unixepoch(),
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        fetch_error = NULL,
        error_count = 0
    `).bind(
      feedUrl,
      parsed.title,
      parsed.siteUrl || null,
      parsed.description || null,
      response.headers.get('ETag') || null,
      response.headers.get('Last-Modified') || null
    ).run();

    return new Response(parsedJson, {
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  } catch (error) {
    console.error('Feed fetch error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to fetch feed' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export async function handleArticleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const feedUrl = url.searchParams.get('feedUrl');
  const guid = url.searchParams.get('guid');
  const itemUrl = url.searchParams.get('itemUrl');

  if (!feedUrl || !guid) {
    return new Response(JSON.stringify({ error: 'Missing feedUrl or guid parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate URL
  try {
    new URL(feedUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid feedUrl' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const urlHash = hashUrl(feedUrl);
  const now = Math.floor(Date.now() / 1000);

  try {
    // Check feed_items table first
    let article = await env.DB.prepare(`
      SELECT id, feed_url, guid, url, title, author, summary, content, image_url, published_at
      FROM feed_items
      WHERE feed_url = ? AND guid = ?
    `).bind(feedUrl, guid).first<FeedItemRow>();

    // If not found by guid and we have itemUrl, try by URL
    if (!article && itemUrl) {
      article = await env.DB.prepare(`
        SELECT id, feed_url, guid, url, title, author, summary, content, image_url, published_at
        FROM feed_items
        WHERE feed_url = ? AND url = ?
      `).bind(feedUrl, itemUrl).first<FeedItemRow>();
    }

    if (article) {
      return new Response(JSON.stringify({ article: mapRowToFeedItem(article) }), {
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }

    // Fetch the feed
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: `Failed to fetch feed: ${response.status}` }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const xml = await response.text();
    const parsed = parseFeed(xml, feedUrl);

    // Store individual items in feed_items table
    await storeItems(env, feedUrl, parsed.items);

    // Update feed_cache for TTL tracking (content no longer needed)
    await env.DB.prepare(`
      INSERT INTO feed_cache (url_hash, feed_url, content, etag, last_modified, cached_at)
      VALUES (?, ?, '{}', ?, ?, ?)
      ON CONFLICT(url_hash) DO UPDATE SET
        content = '{}',
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        cached_at = excluded.cached_at
    `).bind(
      urlHash,
      feedUrl,
      response.headers.get('ETag') || null,
      response.headers.get('Last-Modified') || null,
      now
    ).run();

    // Find the article by guid first, then by URL (more stable across parses)
    let foundArticle = parsed.items.find(item => item.guid === guid);
    if (!foundArticle && itemUrl) {
      foundArticle = parsed.items.find(item => item.url === itemUrl);
    }
    if (!foundArticle) {
      return new Response(JSON.stringify({ error: 'Article not found in feed' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ article: foundArticle }), {
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  } catch (error) {
    console.error('Article fetch error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to fetch article' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export async function handleFeedDiscover(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const siteUrl = url.searchParams.get('url');

  if (!siteUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate URL
  try {
    new URL(siteUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const feeds = await discoverFeeds(siteUrl);
    return new Response(JSON.stringify({ feeds }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Feed discovery error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to discover feeds' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

interface FeedStatus {
  cached: boolean;
  lastFetchedAt?: number;
  error?: string;
  itemCount?: number;
}

// Batch check status of multiple feeds
export async function handleFeedStatusBatch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const feedUrls = url.searchParams.getAll('url');

  if (feedUrls.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing url parameter(s)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Limit to prevent abuse
  if (feedUrls.length > 100) {
    return new Response(JSON.stringify({ error: 'Too many URLs (max 100)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const statuses: Record<string, FeedStatus> = {};

  // Check each feed's status
  for (const feedUrl of feedUrls) {
    try {
      new URL(feedUrl);
    } catch {
      statuses[feedUrl] = { cached: false, error: 'Invalid URL' };
      continue;
    }

    const urlHash = hashUrl(feedUrl);

    // Check feed_cache for cached data
    const cached = await env.DB.prepare(
      'SELECT cached_at FROM feed_cache WHERE url_hash = ?'
    ).bind(urlHash).first<{ cached_at: number }>();

    // Check feed_metadata for error info and item count
    const metadata = await env.DB.prepare(
      'SELECT last_fetched_at, fetch_error, error_count FROM feed_metadata WHERE feed_url = ?'
    ).bind(feedUrl).first<{ last_fetched_at: number; fetch_error: string | null; error_count: number }>();

    // Count items
    const itemCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM feed_items WHERE feed_url = ?'
    ).bind(feedUrl).first<{ count: number }>();

    if (cached || (itemCount && itemCount.count > 0)) {
      statuses[feedUrl] = {
        cached: true,
        lastFetchedAt: (cached?.cached_at || metadata?.last_fetched_at || 0) * 1000,
        itemCount: itemCount?.count || 0,
      };
    } else if (metadata?.fetch_error) {
      statuses[feedUrl] = {
        cached: false,
        error: metadata.fetch_error,
        lastFetchedAt: metadata.last_fetched_at * 1000,
      };
    } else {
      statuses[feedUrl] = { cached: false };
    }
  }

  return new Response(JSON.stringify(statuses), {
    headers: { 'Content-Type': 'application/json' },
  });
}

interface BatchFeedResult {
  title: string;
  description?: string;
  siteUrl?: string;
  imageUrl?: string;
  items: FeedItem[];
  status: 'ready' | 'pending';
  lastFetchedAt?: number;
}

// Batch fetch cached content for multiple feeds in a single request
export async function handleBatchFeedFetch(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { urls?: string[]; since?: Record<string, number> };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const feedUrls = body.urls;
  const since = body.since || {}; // feedUrl -> timestamp of most recent known article
  if (!feedUrls || !Array.isArray(feedUrls) || feedUrls.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing urls array in request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Limit to prevent abuse
  if (feedUrls.length > 50) {
    return new Response(JSON.stringify({ error: 'Too many URLs (max 50)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate URLs
  const validUrls: string[] = [];
  const invalidUrls: string[] = [];
  for (const url of feedUrls) {
    try {
      new URL(url);
      validUrls.push(url);
    } catch {
      invalidUrls.push(url);
    }
  }

  const feeds: Record<string, BatchFeedResult> = {};

  // Initialize invalid URLs with error status
  for (const url of invalidUrls) {
    feeds[url] = {
      title: 'Invalid URL',
      items: [],
      status: 'pending',
    };
  }

  if (validUrls.length === 0) {
    return new Response(JSON.stringify({ feeds }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fetch all feed metadata in one query
  const metadataPlaceholders = validUrls.map(() => '?').join(',');
  const metadataResults = await env.DB.prepare(`
    SELECT feed_url, title, site_url, description, image_url
    FROM feed_metadata
    WHERE feed_url IN (${metadataPlaceholders})
  `).bind(...validUrls).all<{
    feed_url: string;
    title: string;
    site_url: string | null;
    description: string | null;
    image_url: string | null;
  }>();

  const metadataMap = new Map<string, typeof metadataResults.results[0]>();
  for (const row of metadataResults.results) {
    metadataMap.set(row.feed_url, row);
  }

  // Fetch cache timestamps in one query
  const urlHashes = validUrls.map(hashUrl);
  const cachePlaceholders = urlHashes.map(() => '?').join(',');
  const cacheResults = await env.DB.prepare(`
    SELECT url_hash, feed_url, cached_at
    FROM feed_cache
    WHERE url_hash IN (${cachePlaceholders})
  `).bind(...urlHashes).all<{
    url_hash: string;
    feed_url: string;
    cached_at: number;
  }>();

  const cacheMap = new Map<string, number>();
  for (const row of cacheResults.results) {
    cacheMap.set(row.feed_url, row.cached_at);
  }

  // Fetch all feed items for valid URLs in one query
  const itemsResults = await env.DB.prepare(`
    SELECT id, feed_url, guid, url, title, author, summary, content, image_url, published_at
    FROM feed_items
    WHERE feed_url IN (${metadataPlaceholders})
    ORDER BY feed_url, published_at DESC
  `).bind(...validUrls).all<FeedItemRow>();

  // Group items by feed URL, filtering by 'since' timestamp if provided
  const itemsByFeed = new Map<string, FeedItem[]>();
  for (const row of itemsResults.results) {
    // If client provided a 'since' timestamp for this feed, only include newer items
    const sinceTimestamp = since[row.feed_url];
    if (sinceTimestamp !== undefined) {
      // Convert milliseconds to seconds for comparison with DB timestamp
      const sinceSeconds = Math.floor(sinceTimestamp / 1000);
      if (row.published_at <= sinceSeconds) {
        continue; // Skip items older than or equal to the 'since' timestamp
      }
    }

    const items = itemsByFeed.get(row.feed_url) || [];
    // Limit to 100 items per feed
    if (items.length < 100) {
      items.push(mapRowToFeedItem(row));
    }
    itemsByFeed.set(row.feed_url, items);
  }

  // Build response for each URL
  for (const feedUrl of validUrls) {
    const metadata = metadataMap.get(feedUrl);
    const items = itemsByFeed.get(feedUrl) || [];
    const cachedAt = cacheMap.get(feedUrl);

    const hasContent = items.length > 0 || cachedAt !== undefined;

    feeds[feedUrl] = {
      title: metadata?.title || 'Unknown Feed',
      description: metadata?.description || undefined,
      siteUrl: metadata?.site_url || undefined,
      imageUrl: metadata?.image_url || undefined,
      items,
      status: hasContent ? 'ready' : 'pending',
      lastFetchedAt: cachedAt ? cachedAt * 1000 : undefined,
    };
  }

  return new Response(JSON.stringify({ feeds }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
