import type { Env, FeedItem } from '../types';
import { getSessionFromRequest } from '../services/oauth';

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
  fetched_at: number;
  content_hash: string | null;
}

interface FeedItemRowWithFeedTitle extends FeedItemRow {
  feed_title: string | null;
}

function mapItemRow(row: FeedItemRow | FeedItemRowWithFeedTitle, includeContent = false): FeedItem & { feedUrl: string; feedTitle?: string } {
  const item: FeedItem & { feedUrl: string; feedTitle?: string } = {
    guid: row.guid,
    url: row.url,
    title: row.title,
    author: row.author || undefined,
    summary: row.summary || undefined,
    imageUrl: row.image_url || undefined,
    publishedAt: new Date(row.published_at * 1000).toISOString(),
    feedUrl: row.feed_url,
  };

  if (includeContent && row.content) {
    item.content = row.content;
  }

  if ('feed_title' in row && row.feed_title) {
    item.feedTitle = row.feed_title;
  }

  return item;
}

// GET /api/items - Paginated items with filters
export async function handleItemsList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const feedUrls = url.searchParams.getAll('feedUrl');
  const since = url.searchParams.get('since');
  const before = url.searchParams.get('before');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const search = url.searchParams.get('search');

  // Limit feedUrls to avoid exceeding SQL variable limit
  if (feedUrls.length > 100) {
    return new Response(JSON.stringify({ error: 'Too many feedUrls (max 100)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const bindings: unknown[] = [];
  let query: string;

  if (feedUrls.length > 0) {
    // Items from specific feeds (no auth required for public feeds)
    const placeholders = feedUrls.map(() => '?').join(', ');
    query = `
      SELECT fi.id, fi.feed_url, fi.guid, fi.url, fi.title, fi.author, fi.summary, fi.image_url, fi.published_at,
             fm.title as feed_title
      FROM feed_items fi
      LEFT JOIN feed_metadata fm ON fm.feed_url = fi.feed_url
      WHERE fi.feed_url IN (${placeholders})
    `;
    bindings.push(...feedUrls);
  } else {
    // All items - requires auth to get user's subscribed feeds
    const session = await getSessionFromRequest(request, env);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Authentication required when no feedUrl specified' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    query = `
      SELECT fi.id, fi.feed_url, fi.guid, fi.url, fi.title, fi.author, fi.summary, fi.image_url, fi.published_at,
             fm.title as feed_title
      FROM feed_items fi
      INNER JOIN subscriptions_cache sc ON sc.feed_url = fi.feed_url
      LEFT JOIN feed_metadata fm ON fm.feed_url = fi.feed_url
      WHERE sc.user_did = ?
    `;
    bindings.push(session.did);
  }

  if (since) {
    query += ` AND fi.published_at >= ?`;
    bindings.push(parseInt(since));
  }
  if (before) {
    query += ` AND fi.published_at < ?`;
    bindings.push(parseInt(before));
  }
  if (search) {
    query += ` AND (fi.title LIKE ? OR fi.summary LIKE ?)`;
    const searchPattern = `%${search}%`;
    bindings.push(searchPattern, searchPattern);
  }

  query += ` ORDER BY fi.published_at DESC LIMIT ?`;
  bindings.push(limit + 1);

  const results = await env.DB.prepare(query).bind(...bindings).all<FeedItemRowWithFeedTitle>();

  const hasMore = results.results.length > limit;
  const items = results.results.slice(0, limit).map(row => mapItemRow(row, false));
  const nextCursor = hasMore && items.length > 0
    ? new Date(items[items.length - 1].publishedAt).getTime() / 1000
    : null;

  return new Response(JSON.stringify({ items, cursor: nextCursor }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET /api/items/recent - Recent items across all subscribed feeds
export async function handleItemsRecent(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const hours = parseInt(url.searchParams.get('hours') || '24');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);

  const since = Math.floor(Date.now() / 1000) - (hours * 60 * 60);

  const results = await env.DB.prepare(`
    SELECT fi.id, fi.feed_url, fi.guid, fi.url, fi.title, fi.author, fi.summary, fi.image_url, fi.published_at,
           fm.title as feed_title
    FROM feed_items fi
    INNER JOIN subscriptions_cache sc ON sc.feed_url = fi.feed_url
    LEFT JOIN feed_metadata fm ON fm.feed_url = fi.feed_url
    WHERE sc.user_did = ?
      AND fi.published_at >= ?
    ORDER BY fi.published_at DESC
    LIMIT ?
  `).bind(session.did, since, limit).all<FeedItemRowWithFeedTitle>();

  return new Response(JSON.stringify({ items: results.results.map(row => mapItemRow(row, false)) }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET /api/items/get - Single item with full content
export async function handleItemGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const feedUrl = url.searchParams.get('feedUrl');
  const guid = url.searchParams.get('guid');

  if (!feedUrl || !guid) {
    return new Response(JSON.stringify({ error: 'Missing feedUrl or guid parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const item = await env.DB.prepare(`
    SELECT fi.*, fm.title as feed_title
    FROM feed_items fi
    LEFT JOIN feed_metadata fm ON fm.feed_url = fi.feed_url
    WHERE fi.feed_url = ? AND fi.guid = ?
  `).bind(feedUrl, guid).first<FeedItemRowWithFeedTitle>();

  if (!item) {
    return new Response(JSON.stringify({ error: 'Item not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ item: mapItemRow(item, true) }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET /api/items/by-feed - Items for a specific feed (for frontend feed display)
export async function handleItemsByFeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const feedUrl = url.searchParams.get('feedUrl');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
  const before = url.searchParams.get('before');

  if (!feedUrl) {
    return new Response(JSON.stringify({ error: 'Missing feedUrl parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const bindings: unknown[] = [feedUrl];
  let query = `
    SELECT fi.id, fi.feed_url, fi.guid, fi.url, fi.title, fi.author, fi.summary, fi.content, fi.image_url, fi.published_at,
           fm.title as feed_title
    FROM feed_items fi
    LEFT JOIN feed_metadata fm ON fm.feed_url = fi.feed_url
    WHERE fi.feed_url = ?
  `;

  if (before) {
    query += ` AND fi.published_at < ?`;
    bindings.push(parseInt(before));
  }

  query += ` ORDER BY fi.published_at DESC LIMIT ?`;
  bindings.push(limit + 1);

  const results = await env.DB.prepare(query).bind(...bindings).all<FeedItemRowWithFeedTitle>();

  const hasMore = results.results.length > limit;
  const items = results.results.slice(0, limit).map(row => mapItemRow(row, true));
  const nextCursor = hasMore && items.length > 0
    ? new Date(items[items.length - 1].publishedAt).getTime() / 1000
    : null;

  // Also get feed metadata
  const feedMeta = await env.DB.prepare(`
    SELECT title, site_url, description, image_url FROM feed_metadata WHERE feed_url = ?
  `).bind(feedUrl).first<{ title: string; site_url: string | null; description: string | null; image_url: string | null }>();

  return new Response(JSON.stringify({
    feed: feedMeta ? {
      title: feedMeta.title,
      siteUrl: feedMeta.site_url,
      description: feedMeta.description,
      imageUrl: feedMeta.image_url,
    } : null,
    items,
    cursor: nextCursor,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
