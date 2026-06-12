import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { createPDSClient } from '../services/pds-client';
import { isValidRkey, invalidRkeyResponse } from '../utils/validation';
import { getUserTierLimits } from '../services/user-tier';
import { getUserSettings } from './settings';

const COLLECTION = 'app.skyreader.feed.saved';

interface SavedRow {
  id: number;
  user_did: string;
  rkey: string;
  record_uri: string | null;
  url: string;
  title: string | null;
  author: string | null;
  description: string | null;
  content: string | null;
  content_type: string | null;
  domain: string | null;
  image: string | null;
  word_count: number | null;
  published_at: number | null;
  saved_at: number;
  created_at: number;
  source: string;
  item_guid: string | null;
}

interface CreateSavedBody {
  url: string;
  rkey: string;
  fromFeed?: boolean;
  source?: 'url' | 'feed' | 'share' | 'document';
  itemGuid?: string;
  title?: string;
  author?: string;
  description?: string;
  content?: string;
  image?: string;
  publishedAt?: string;
  domain?: string;
  wordCount?: number;
}

// POST /api/saved — save an item from a URL or feed article
export async function handleCreateSaved(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!hasRequiredScopes(session.grantedScopes)) {
    return insufficientScopesResponse();
  }

  let body: CreateSavedBody;
  try {
    body = (await request.json()) as CreateSavedBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Determine source
  const source: string = body.source || (body.fromFeed ? 'feed' : 'url');

  // For share/document sources, allow empty URL
  if (source === 'share' || source === 'document') {
    if (body.url === undefined || body.url === null) body.url = '';
  } else {
    if (!body.url || typeof body.url !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing url field' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (!body.rkey || !isValidRkey(body.rkey)) {
    return invalidRkeyResponse();
  }

  // Validate URL only for url/feed sources
  if (source !== 'share' && source !== 'document') {
    try {
      new URL(body.url);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid url' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Check for duplicate — by item_guid for feed/share/document saves, by URL otherwise
  if ((body.fromFeed || source === 'share' || source === 'document') && body.itemGuid) {
    const existing = await env.DB.prepare(
      'SELECT id FROM saved_articles WHERE user_did = ? AND item_guid = ?'
    )
      .bind(session.did, body.itemGuid)
      .first();

    if (existing) {
      return new Response(JSON.stringify({ error: 'Article already saved' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } else {
    const existing = await env.DB.prepare(
      'SELECT id FROM saved_articles WHERE user_did = ? AND url = ?'
    )
      .bind(session.did, body.url)
      .first();

    if (existing) {
      return new Response(JSON.stringify({ error: 'Article already saved' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Check monthly URL save limit for URL saves
  if (source === 'url') {
    const limits = await getUserTierLimits(env, session.did);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime();
    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM saved_articles
       WHERE user_did = ? AND source = 'url' AND saved_at >= ?`
    )
      .bind(session.did, monthStart)
      .first<{ count: number }>();

    const current = countResult?.count ?? 0;
    if (current >= limits.maxUrlSavesPerMonth) {
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return new Response(
        JSON.stringify({
          error: 'url_save_limit_reached',
          message: `You have reached your monthly URL save limit of ${limits.maxUrlSavesPerMonth}.`,
          limit: limits.maxUrlSavesPerMonth,
          current,
          resetsAt: nextMonth.toISOString(),
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }

  try {
    if (source === 'feed' || source === 'share' || source === 'document') {
      // Metadata save: use provided metadata, skip extraction
      return await handleMetadataSave(request, env, ctx, session, body, source);
    } else {
      // URL save: extract content via feed proxy
      return await handleUrlSave(request, env, ctx, session, body);
    }
  } catch (error) {
    console.error('Failed to save item:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to save item',
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

async function handleMetadataSave(
  _request: Request,
  env: Env,
  _ctx: ExecutionContext,
  session: Session,
  body: CreateSavedBody,
  source: string
): Promise<Response> {
  const now = Date.now();
  const savedAt = new Date().toISOString();
  const publishedAt = body.publishedAt || null;

  // Determine content type from source
  const contentType = source === 'feed' ? 'article' : source;

  // Build PDS record (only for feed saves with valid URLs)
  let recordUri = `at://${session.did}/${COLLECTION}/${body.rkey}`;
  const settings = await getUserSettings(env, session.did);
  if (settings.pdsSyncEnabled && source === 'feed' && body.url) {
    const record: Record<string, unknown> = {
      $type: COLLECTION,
      url: body.url,
      savedAt,
      contentType: 'article',
    };
    if (body.title) record.title = body.title;
    if (body.description) record.description = body.description;
    if (body.author) record.author = body.author;
    if (body.domain) record.domain = body.domain;
    if (body.image) record.image = body.image;
    if (publishedAt) record.publishedAt = publishedAt;
    if (body.itemGuid) record.itemGuid = body.itemGuid;

    const pdsClient = createPDSClient(session);
    const pdsResult = await pdsClient.putRecord(COLLECTION, body.rkey, record);

    if (pdsResult.success) {
      recordUri = pdsResult.data.uri;
    }
  }

  // Cache in D1. The full article body (when the client supplies it for a feed
  // save) is stored here, not in the PDS record — same split as URL saves — so
  // the saved item stays readable after the source article ages out of the feed.
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, title, author, description, content, content_type, domain, image, word_count, published_at, saved_at, created_at, source, item_guid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      session.did,
      body.rkey,
      recordUri,
      body.url,
      body.title || null,
      body.author || null,
      body.description || null,
      body.content || null,
      contentType,
      body.domain || null,
      body.image || null,
      body.wordCount || null,
      publishedAt ? new Date(publishedAt).getTime() : null,
      now,
      now,
      source,
      body.itemGuid || null
    )
    .run();

  return new Response(
    JSON.stringify({
      rkey: body.rkey,
      uri: recordUri,
      url: body.url,
      title: body.title || null,
      author: body.author || null,
      description: body.description || null,
      content: body.content || null,
      contentType,
      domain: body.domain || null,
      image: body.image || null,
      wordCount: body.wordCount || null,
      publishedAt,
      savedAt,
      source,
      itemGuid: body.itemGuid || null,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleUrlSave(
  _request: Request,
  env: Env,
  ctx: ExecutionContext,
  session: Session,
  body: CreateSavedBody
): Promise<Response> {
  const now = Date.now();
  const savedAt = new Date().toISOString();
  const publishedAt = body.publishedAt || null;

  // Build PDS record (no content written to PDS)
  const record: Record<string, unknown> = {
    $type: COLLECTION,
    url: body.url,
    savedAt,
    contentType: 'webpage',
  };
  if (body.title) record.title = body.title;
  if (body.description) record.description = body.description;
  if (body.author) record.author = body.author;
  if (body.domain) record.domain = body.domain;
  if (body.image) record.image = body.image;
  if (publishedAt) record.publishedAt = publishedAt;
  if (body.wordCount) record.wordCount = body.wordCount;

  // Write to PDS (if sync enabled)
  const settings = await getUserSettings(env, session.did);
  let recordUri = `at://${session.did}/${COLLECTION}/${body.rkey}`;
  if (settings.pdsSyncEnabled) {
    const pdsClient = createPDSClient(session);
    const pdsResult = await pdsClient.putRecord(COLLECTION, body.rkey, record);

    if (pdsResult.success) {
      recordUri = pdsResult.data.uri;
    }
  }

  // Cache in D1 (content is stored here, not in PDS)
  await env.DB.prepare(
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, title, author, description, content, content_type, domain, image, word_count, published_at, saved_at, created_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      session.did,
      body.rkey,
      recordUri,
      body.url,
      body.title || null,
      body.author || null,
      body.description || null,
      body.content || null,
      'webpage',
      body.domain || null,
      body.image || null,
      body.wordCount || null,
      publishedAt ? new Date(publishedAt).getTime() : null,
      now,
      now,
      'url'
    )
    .run();

  return new Response(
    JSON.stringify({
      uri: recordUri,
      savedAt,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

// GET /api/saved — list user's saved items
export async function handleGetSaved(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await env.DB.prepare(
      `SELECT rkey, record_uri, url, title, author, description, content, content_type, domain, image,
              word_count, published_at, saved_at, created_at, source, item_guid
       FROM saved_articles WHERE user_did = ? ORDER BY saved_at DESC`
    )
      .bind(session.did)
      .all<SavedRow>();

    const articles = result.results.map((row) => ({
      rkey: row.rkey,
      uri: row.record_uri,
      url: row.url,
      title: row.title,
      author: row.author,
      description: row.description,
      content: row.content,
      contentType: row.content_type || 'webpage',
      domain: row.domain,
      image: row.image,
      wordCount: row.word_count,
      publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      savedAt: new Date(row.saved_at).toISOString(),
      source: row.source || 'url',
      itemGuid: row.item_guid,
    }));

    return new Response(JSON.stringify({ articles }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get saved items:', error);
    return new Response(JSON.stringify({ error: 'Failed to get saved items' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// PATCH /api/saved/:rkey — update mutable fields on a saved item.
// Currently only the precomputed word count, used by the frontend to backfill
// old saves that were stored without one (so the read time stops falling back
// to the short description and showing a misleading "1 min"). D1-only: the
// word count is a derived display value and isn't part of the PDS record's
// canonical data, so there's no PDS write here.
export async function handleUpdateSaved(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'PATCH') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const rkey = url.pathname.split('/').pop();
  if (!rkey || !isValidRkey(rkey)) {
    return invalidRkeyResponse();
  }

  let body: { wordCount?: number };
  try {
    body = (await request.json()) as { wordCount?: number };
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (
    body.wordCount == null ||
    typeof body.wordCount !== 'number' ||
    !Number.isFinite(body.wordCount) ||
    body.wordCount < 0
  ) {
    return new Response(JSON.stringify({ error: 'Missing or invalid wordCount' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const result = await env.DB.prepare(
      'UPDATE saved_articles SET word_count = ? WHERE user_did = ? AND rkey = ?'
    )
      .bind(Math.round(body.wordCount), session.did, rkey)
      .run();

    if (!result.meta.changes) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to update saved item:', error);
    return new Response(JSON.stringify({ error: 'Failed to update saved item' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// DELETE /api/saved/:rkey — delete a saved item
export async function handleDeleteSaved(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'DELETE') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const rkey = url.pathname.split('/').pop();
  if (!rkey || !isValidRkey(rkey)) {
    return invalidRkeyResponse();
  }

  try {
    // Get the record info before deleting
    const row = await env.DB.prepare(
      'SELECT record_uri, item_guid FROM saved_articles WHERE user_did = ? AND rkey = ?'
    )
      .bind(session.did, rkey)
      .first<{ record_uri: string | null; item_guid: string | null }>();

    if (!row) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Delete from D1
    await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ? AND rkey = ?')
      .bind(session.did, rkey)
      .run();

    // Delete from PDS (fire and forget)
    const settings = await getUserSettings(env, session.did);
    if (settings.pdsSyncEnabled) {
      const pdsClient = createPDSClient(session);
      ctx.waitUntil(
        pdsClient.deleteRecord(COLLECTION, rkey).catch((err) => {
          console.error('Failed to delete from PDS:', err);
        })
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to delete saved item:', error);
    return new Response(JSON.stringify({ error: 'Failed to delete saved item' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// DELETE /api/saved/by-guid/:guid — delete a saved item by item_guid
export async function handleDeleteSavedByGuid(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  if (request.method !== 'DELETE') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const guid = decodeURIComponent(pathParts[pathParts.length - 1]);

  if (!guid) {
    return new Response(JSON.stringify({ error: 'Missing guid' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const row = await env.DB.prepare(
      'SELECT rkey, record_uri, item_guid FROM saved_articles WHERE user_did = ? AND item_guid = ?'
    )
      .bind(session.did, guid)
      .first<{
        rkey: string;
        record_uri: string | null;
        item_guid: string | null;
      }>();

    if (!row) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Delete from D1
    await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ? AND item_guid = ?')
      .bind(session.did, guid)
      .run();

    // Delete from PDS (fire and forget)
    const settings = await getUserSettings(env, session.did);
    if (settings.pdsSyncEnabled) {
      const pdsClient = createPDSClient(session);
      ctx.waitUntil(
        pdsClient.deleteRecord(COLLECTION, row.rkey).catch((err) => {
          console.error('Failed to delete from PDS:', err);
        })
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to delete saved item by guid:', error);
    return new Response(JSON.stringify({ error: 'Failed to delete saved item' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
