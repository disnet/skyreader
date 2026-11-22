import type { Env } from '../types';
import { FeedProxyClient } from '../services/feed-proxy-client';
import { log } from '../utils/logger';

/** Pages asked about in one request; the proxy answers for no more. */
export const PAGE_TITLES_MAX_URLS = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// POST /api/page-titles — the real titles of the pages an article links to,
// for the reader's "Links in this article" list. Read by the feed proxy (one
// fetch per page, cached there), so nothing here touches D1. A proxy that
// can't answer is an empty answer: the list keeps the article's link text.
export async function handlePageTitles(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: { urls?: unknown };
  try {
    body = (await request.json()) as { urls?: unknown };
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!Array.isArray(body.urls)) return json({ error: 'Missing urls' }, 400);

  const urls = [
    ...new Set(
      body.urls.filter((u): u is string => {
        if (typeof u !== 'string' || u.length > 2048) return false;
        try {
          const { protocol } = new URL(u);
          return protocol === 'https:' || protocol === 'http:';
        } catch {
          return false;
        }
      })
    ),
  ].slice(0, PAGE_TITLES_MAX_URLS);
  if (urls.length === 0) return json({ titles: {}, pending: false });

  try {
    return json(await new FeedProxyClient(env).fetchPageTitles(urls));
  } catch (error) {
    // Titles are a nicety: a busy or unreachable proxy is a log line, not an alert.
    log.warn('page_titles_unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return json({ titles: {}, pending: false });
  }
}
