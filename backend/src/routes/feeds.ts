import type { Env } from '../types';
import { parseFeed, discoverFeeds } from '../services/feed-parser';

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

interface CachedFeed {
  url_hash: string;
  feed_url: string;
  content: string;
  etag: string | null;
  last_modified: string | null;
  cached_at: number;
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
      'SELECT * FROM feed_cache WHERE url_hash = ? AND cached_at > ?'
    ).bind(urlHash, now - CACHE_TTL_SECONDS).first<CachedFeed>();

    if (cached) {
      return new Response(cached.content, {
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }
  }

  try {
    const headers: HeadersInit = {
      'User-Agent': 'AT-RSS/1.0 (+https://at-rss.example.com)',
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

    // If not modified, update cache timestamp and return existing content
    if (response.status === 304) {
      const cached = await env.DB.prepare(
        'SELECT content FROM feed_cache WHERE url_hash = ?'
      ).bind(urlHash).first<{ content: string }>();

      if (cached) {
        // Update cached_at to extend the cache
        await env.DB.prepare(
          'UPDATE feed_cache SET cached_at = ? WHERE url_hash = ?'
        ).bind(now, urlHash).run();

        return new Response(cached.content, {
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        });
      }
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
    const parsedJson = JSON.stringify(parsed);

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
      parsedJson,
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
    // Check D1 cache first
    const cached = await env.DB.prepare(
      'SELECT content FROM feed_cache WHERE url_hash = ? AND cached_at > ?'
    ).bind(urlHash, now - CACHE_TTL_SECONDS).first<{ content: string }>();

    if (cached) {
      const parsed = JSON.parse(cached.content) as { items?: { guid: string; url?: string; content?: string; summary?: string }[] };
      if (parsed?.items) {
        // Try matching by GUID first, then by URL
        let article = parsed.items.find(item => item.guid === guid);
        if (!article && itemUrl) {
          article = parsed.items.find(item => item.url === itemUrl);
        }
        if (article) {
          return new Response(JSON.stringify({ article }), {
            headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
          });
        }
      }
    }

    // Fetch the feed
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'AT-RSS/1.0 (+https://at-rss.example.com)',
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

    // Find the article by guid first, then by URL (more stable across parses)
    let article = parsed.items.find(item => item.guid === guid);
    if (!article && itemUrl) {
      article = parsed.items.find(item => item.url === itemUrl);
    }
    if (!article) {
      return new Response(JSON.stringify({ error: 'Article not found in feed' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ article }), {
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
