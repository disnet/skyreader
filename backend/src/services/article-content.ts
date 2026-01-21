import type { Env } from '../types';
import { parseFeed } from './feed-parser';
import { storeItems } from '../routes/feeds';

function hashUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

export async function fetchArticleContent(
  env: Env,
  feedUrl: string,
  itemGuid: string,
  itemUrl?: string
): Promise<string | null> {
  try {
    // Query feed_items directly instead of parsing feed_cache JSON
    let article = await env.DB.prepare(`
      SELECT content, summary FROM feed_items
      WHERE feed_url = ? AND guid = ?
    `).bind(feedUrl, itemGuid).first<{ content: string | null; summary: string | null }>();

    if (!article && itemUrl) {
      article = await env.DB.prepare(`
        SELECT content, summary FROM feed_items
        WHERE feed_url = ? AND url = ?
      `).bind(feedUrl, itemUrl).first<{ content: string | null; summary: string | null }>();
    }

    if (article) {
      return article.content || article.summary || null;
    }

    // Not in feed_items, fetch from source
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch feed ${feedUrl}: ${response.status}`);
      return null;
    }

    const xml = await response.text();
    const parsed = parseFeed(xml, feedUrl);

    // Store items in feed_items table
    await storeItems(env, feedUrl, parsed.items);

    // Update feed_cache for TTL tracking (content no longer needed)
    const urlHash = hashUrl(feedUrl);
    const now = Math.floor(Date.now() / 1000);
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

    // Try matching by GUID first, then by URL
    let foundArticle = parsed.items.find(item => item.guid === itemGuid);
    if (!foundArticle && itemUrl) {
      foundArticle = parsed.items.find(item => item.url === itemUrl);
    }
    return foundArticle?.content || foundArticle?.summary || null;
  } catch (error) {
    console.error(`Error fetching article content from ${feedUrl}:`, error);
    return null;
  }
}
