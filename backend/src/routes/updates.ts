import type { Env } from '../types';
import { devLogPublication } from '../config/dev-log';

/**
 * "New in Skyreader": the newest Dev Log posts, for the notification bell.
 *
 *   GET /api/updates → { updates: [{ uri, title, description, url, publishedAt }] }
 *
 * One small indexed read of D1. The poller watches the Dev Log's author and the
 * reconcile re-lists them (config/dev-log.ts), so a new post lands within a cycle
 * of being published; nothing here touches a PDS.
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

export async function handleUpdates(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const devLog = devLogPublication(env);
  if (!devLog) return Response.json({ updates: [] });

  const rows = await env.DB.prepare(
    `SELECT record_uri, published_at, canonical_url, record_json FROM documents_v2
      WHERE author_did = ? AND site_uri = ? AND published_at >= ?
      ORDER BY published_at DESC LIMIT ?`
  )
    .bind(devLog.authorDid, devLog.uri, Date.now() - UPDATE_WINDOW_MS, MAX_UPDATES)
    .all<{
      record_uri: string;
      published_at: number;
      canonical_url: string | null;
      record_json: string;
    }>();

  const updates: DevLogUpdate[] = [];
  for (const row of rows.results ?? []) {
    // Only a post with an absolute https URL: the bell links straight to it.
    if (!row.canonical_url?.startsWith('https://')) continue;
    let record: { title?: unknown; description?: unknown };
    try {
      record = JSON.parse(row.record_json);
    } catch {
      continue;
    }
    if (typeof record.title !== 'string' || !record.title.trim()) continue;
    updates.push({
      uri: row.record_uri,
      title: record.title,
      description: typeof record.description === 'string' ? record.description : null,
      url: row.canonical_url,
      publishedAt: new Date(row.published_at).toISOString(),
    });
  }
  return Response.json({ updates });
}
