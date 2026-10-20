import type { Env } from '../types';
import { DEV_LOG_AUTHOR_DID, DEV_LOG_PUBLICATION_URI } from '../config/dev-log';
import { loadAuthorDocuments, scheduleAuthorDocuments } from '../services/document-store';

/**
 * "New in Skyreader": the newest Dev Log posts, for the notification bell.
 *
 *   GET /api/updates → { updates: [{ uri, title, description, url, publishedAt }] }
 *
 * Served from D1. The poller watches the Dev Log's author (config/dev-log.ts), so
 * a new post lands within a cycle of being published; the scheduled walk covers a
 * fresh database or a stream that missed it, and costs one indexed read when the
 * author was listed within the hour.
 */

/** Older posts are history, not news: a reader who joins later isn't shown them. */
export const UPDATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_UPDATES = 3;

export interface DevLogUpdate {
  uri: string;
  title: string;
  description: string | null;
  url: string;
  publishedAt: string;
}

export async function handleUpdates(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  scheduleAuthorDocuments(env, (p) => ctx.waitUntil(p), DEV_LOG_AUTHOR_DID);

  const documents = await loadAuthorDocuments(env, DEV_LOG_AUTHOR_DID, {
    siteUri: DEV_LOG_PUBLICATION_URI,
    readerCollections: false,
  });
  const cutoff = Date.now() - UPDATE_WINDOW_MS;
  const updates: DevLogUpdate[] = [];
  for (const doc of documents) {
    if (updates.length >= MAX_UPDATES) break;
    const published = Date.parse(doc.publishedAt);
    // Only a post with an absolute https URL: the bell links straight to it.
    if (!(published >= cutoff) || !doc.canonicalUrl?.startsWith('https://')) continue;
    updates.push({
      uri: doc.recordUri,
      title: doc.title,
      description: doc.description ?? null,
      url: doc.canonicalUrl,
      publishedAt: doc.publishedAt,
    });
  }
  return Response.json({ updates });
}
