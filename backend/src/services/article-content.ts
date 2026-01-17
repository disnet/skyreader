import type { Env } from '../types';
import { parseFeed } from './feed-parser';

const CACHE_TTL_SECONDS = 900; // 15 minutes

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
    const urlHash = hashUrl(feedUrl);
    const now = Math.floor(Date.now() / 1000);

    // Check D1 cache first
    const cached = await env.DB.prepare(
      'SELECT content, cached_at FROM feed_cache WHERE url_hash = ?'
    ).bind(urlHash).first<{ content: string; cached_at: number }>();

    const isCacheValid = cached && (now - cached.cached_at) <= CACHE_TTL_SECONDS;

    if (isCacheValid && cached) {
      const parsed = JSON.parse(cached.content) as { items?: { guid: string; url?: string; content?: string; summary?: string }[] };
      if (parsed?.items) {
        // Try matching by GUID first, then by URL
        let article = parsed.items.find(item => item.guid === itemGuid);
        if (!article && itemUrl) {
          article = parsed.items.find(item => item.url === itemUrl);
        }
        if (article) {
          return article.content || article.summary || null;
        }
      }
    }

    // Not in cache or cache stale, fetch from source
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

    // Try matching by GUID first, then by URL
    let article = parsed.items.find(item => item.guid === itemGuid);
    if (!article && itemUrl) {
      article = parsed.items.find(item => item.url === itemUrl);
    }
    return article?.content || article?.summary || null;
  } catch (error) {
    console.error(`Error fetching article content from ${feedUrl}:`, error);
    return null;
  }
}
