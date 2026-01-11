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

  // Check cache unless force refresh
  if (!force) {
    const cached = await env.FEED_CACHE.get(`feed:${urlHash}`, 'json');
    if (cached) {
      return new Response(JSON.stringify(cached), {
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }
  }

  try {
    const headers: HeadersInit = {
      'User-Agent': 'AT-RSS/1.0 (+https://at-rss.example.com)',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    };

    // Only use conditional headers if not forcing refresh
    if (!force) {
      const metaStr = await env.FEED_CACHE.get(`feed:${urlHash}:meta`);
      const meta = metaStr ? JSON.parse(metaStr) as { etag?: string; lastModified?: string } : null;

      if (meta?.etag) {
        headers['If-None-Match'] = meta.etag;
      }
      if (meta?.lastModified) {
        headers['If-Modified-Since'] = meta.lastModified;
      }
    }

    const response = await fetch(feedUrl, { headers });

    // If not modified and we have cached data, return cached
    if (response.status === 304) {
      const cached = await env.FEED_CACHE.get(`feed:${urlHash}`, 'json');
      if (cached) {
        return new Response(JSON.stringify(cached), {
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

    // Cache the parsed feed (best effort - don't fail if KV limit reached)
    try {
      await Promise.all([
        env.FEED_CACHE.put(`feed:${urlHash}`, JSON.stringify(parsed), { expirationTtl: 900 }), // 15 min
        env.FEED_CACHE.put(
          `feed:${urlHash}:meta`,
          JSON.stringify({
            etag: response.headers.get('ETag'),
            lastModified: response.headers.get('Last-Modified'),
            fetchedAt: Date.now(),
          }),
          { expirationTtl: 3600 }
        ), // 1 hour
      ]);
    } catch (cacheError) {
      // KV limit likely reached - continue without caching
      console.warn('Failed to cache feed (KV limit?):', cacheError);
    }

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

    return new Response(JSON.stringify(parsed), {
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

  try {
    // Check cache first
    const cached = await env.FEED_CACHE.get(`feed:${urlHash}`, 'json') as { items?: { guid: string; content?: string; summary?: string }[] } | null;
    if (cached?.items) {
      const article = cached.items.find(item => item.guid === guid);
      if (article) {
        return new Response(JSON.stringify({ article }), {
          headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
        });
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

    // Cache the parsed feed (best effort)
    try {
      await env.FEED_CACHE.put(`feed:${urlHash}`, JSON.stringify(parsed), { expirationTtl: 900 });
    } catch (cacheError) {
      console.warn('Failed to cache feed (KV limit?):', cacheError);
    }

    // Find the article by guid
    const article = parsed.items.find(item => item.guid === guid);
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
