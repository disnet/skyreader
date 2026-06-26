import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { createPDSClient } from '../services/pds-client';
import { isValidRkey, invalidRkeyResponse } from '../utils/validation';
import { getUserTierLimits } from '../services/user-tier';
import { getUserSettings, type SaveBacking } from './settings';
import {
  pollBackedMembership,
  listBackedSaved,
  backedUnsave,
  extractMissingBackedContent,
} from '../services/backing/sync';
import { createMember } from '../services/backing/write';
import {
  enableBacking,
  disableBacking,
  exportNativeSaves,
  countExportableSaves,
} from '../services/backing/enable';
import { hasIntegrationScopes } from './integrations';
import { normalizeArticleUrl } from '../utils/url-normalize';

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
    // When backing is on, EVERY save becomes a membership in the foreign
    // (Semble/Margin) collection. A URL that won't normalize (no web URL to key
    // on) falls through to the native, D1-only path below.
    const settings = await getUserSettings(env, session.did);
    if (settings.backing.provider !== 'skyreader' && normalizeArticleUrl(body.url)) {
      return await handleBackedSave(env, session, body, source, settings.backing);
    }

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

  // Saves live only in D1 (canonical) and, when backing is on, in the user's
  // Semble/Margin collection (the backed path handles that earlier). We do not
  // publish an app.skyreader.feed.saved record to the PDS; record_uri is a stable
  // local identifier for this save.
  const recordUri = `at://${session.did}/${COLLECTION}/${body.rkey}`;

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

  // Saves are stored in D1 only (and in the user's Semble/Margin collection when
  // backing is on, handled earlier). No app.skyreader.feed.saved record is written
  // to the PDS; record_uri is a stable local identifier for this save.
  const recordUri = `at://${session.did}/${COLLECTION}/${body.rkey}`;

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

/**
 * Backed save (Phase 3, "adopt"): project the save into the user's foreign
 * collection and record it in the two stores. No app.skyreader.feed.saved export —
 * membership in the collection IS the save. The enrichment row stays canonical for
 * reading work (content, word count); the membership row holds the foreign handles.
 */
async function handleBackedSave(
  env: Env,
  session: Session,
  body: CreateSavedBody,
  source: string,
  backing: Extract<SaveBacking, { provider: 'semble' | 'margin' }>
): Promise<Response> {
  const now = Date.now();
  const savedAt = new Date().toISOString();
  const url = body.url;
  const urlNormalized = normalizeArticleUrl(url)!; // guaranteed by the caller's guard
  const publishedAt = body.publishedAt || null;
  const contentType = source === 'feed' ? 'article' : source === 'url' ? 'webpage' : source;
  // For a document save the member URL is the resolved blogs URL (already in body.url)
  // and the doc's recordUri (itemGuid) is the canonical atproto peer reference.
  const canonicalAtUri = source === 'document' ? body.itemGuid || undefined : undefined;

  // Idempotency: if this URL is already a member of the backing collection, the save
  // is a no-op on the foreign side. Reuse the existing handles instead of writing a
  // SECOND card/link — otherwise the conflict-update below would overwrite the row's
  // handles and orphan the first foreign record (untracked, undeletable on unsave).
  // The pre-save gate only catches a raw-url duplicate; a URL that differs raw but
  // normalizes the same reaches here, which is exactly the case this guards.
  const existingMember = await env.DB.prepare(
    `SELECT external_item_uri, external_link_uri FROM backed_collection_members
     WHERE user_did = ? AND external_collection = ? AND url_normalized = ?`
  )
    .bind(session.did, backing.collectionUri, urlNormalized)
    .first<{ external_item_uri: string; external_link_uri: string }>();

  // Create the foreign item + membership records (errors bubble to the 502 handler).
  const pds = createPDSClient(session);
  const handles = existingMember
    ? { itemUri: existingMember.external_item_uri, linkUri: existingMember.external_link_uri }
    : await createMember(pds, session.did, backing.provider, backing.collectionUri, {
        url,
        title: body.title,
        description: body.description,
        author: body.author,
        publishedAt: publishedAt || undefined,
        canonicalAtUri,
      });

  const metadata = JSON.stringify({
    title: body.title,
    author: body.author,
    description: body.description,
    image: body.image,
    domain: body.domain,
    canonicalAtUri,
  });

  // Upsert enrichment (merge onto any stub a poll left) + membership, and clear any
  // tombstone for this URL (a re-save of something just unsaved). record_uri is NULL:
  // a backed save has no app.skyreader.feed.saved export.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO saved_articles
         (user_did, rkey, record_uri, url, url_normalized, title, author, description, content,
          content_type, domain, image, word_count, published_at, saved_at, created_at, source, item_guid)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_did, url_normalized) DO UPDATE SET
         rkey = excluded.rkey,
         title = COALESCE(excluded.title, title),
         author = COALESCE(excluded.author, author),
         description = COALESCE(excluded.description, description),
         content = COALESCE(excluded.content, content),
         content_type = excluded.content_type,
         domain = COALESCE(excluded.domain, domain),
         image = COALESCE(excluded.image, image),
         word_count = COALESCE(excluded.word_count, word_count),
         published_at = COALESCE(excluded.published_at, published_at),
         source = excluded.source,
         item_guid = COALESCE(excluded.item_guid, item_guid),
         saved_at = excluded.saved_at`
    ).bind(
      session.did,
      body.rkey,
      url,
      urlNormalized,
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
      body.itemGuid || canonicalAtUri || null
    ),
    env.DB.prepare(
      `INSERT INTO backed_collection_members
         (user_did, external_collection, url_normalized, url, external_provider, external_item_uri, external_link_uri, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_did, external_collection, url_normalized) DO UPDATE SET
         url = excluded.url,
         external_item_uri = excluded.external_item_uri,
         external_link_uri = excluded.external_link_uri,
         metadata = excluded.metadata`
    ).bind(
      session.did,
      backing.collectionUri,
      urlNormalized,
      url,
      backing.provider,
      handles.itemUri,
      handles.linkUri,
      metadata
    ),
    env.DB.prepare(
      `DELETE FROM backed_unsave_tombstones
       WHERE user_did = ? AND external_collection = ? AND url_normalized = ?`
    ).bind(session.did, backing.collectionUri, urlNormalized),
  ]);

  return new Response(
    JSON.stringify({
      rkey: body.rkey,
      uri: handles.itemUri,
      url,
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

/**
 * POST /api/saved/backing — turn external-backed saves on or off (Phase 5).
 *
 * Body: { action: 'enable', provider: 'semble'|'margin', collectionUri?, exportExisting? }
 *     | { action: 'exportBatch', offset?, limit? }
 *     | { action: 'disable' }
 *
 * Enable requires the provider's repo scopes (returns scope_upgrade_required so the
 * frontend can re-auth). Without `collectionUri` a default "Skyreader Saves"
 * collection is created. `exportExisting` projects the user's current native saves
 * into the collection (idempotent, all in one request).
 *
 * `exportBatch` exports one slice of the existing saves and reports `{ exported,
 * scanned, total }` — the frontend loops it (advancing `offset` by `scanned`) so a
 * large library uploads with a live progress bar instead of one silent blocking call.
 */
export async function handleSetBacking(request: Request, env: Env): Promise<Response> {
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

  let body: {
    action?: 'enable' | 'disable' | 'exportBatch';
    provider?: 'semble' | 'margin';
    collectionUri?: string;
    exportExisting?: boolean;
    offset?: number;
    limit?: number;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    if (body.action === 'disable') {
      await disableBacking(env, session);
      return new Response(JSON.stringify({ backing: { provider: 'skyreader' } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (body.action === 'exportBatch') {
      // Export one slice of the user's existing saves into their already-on backing
      // collection. The frontend drives this in a loop to render a progress bar.
      const settings = await getUserSettings(env, session.did);
      if (settings.backing.provider === 'skyreader') {
        return new Response(JSON.stringify({ error: 'Backing is not enabled' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const DEFAULT_LIMIT = 25;
      const MAX_LIMIT = 50;
      const limit = Math.min(Math.max(1, Math.floor(body.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
      const offset = Math.max(0, Math.floor(body.offset ?? 0));
      const total = await countExportableSaves(env, session.did);
      const { exported, scanned } = await exportNativeSaves(env, session, settings.backing, {
        offset,
        limit,
      });
      return new Response(JSON.stringify({ exported, scanned, total }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (body.action === 'enable') {
      if (body.provider !== 'semble' && body.provider !== 'margin') {
        return new Response(JSON.stringify({ error: "provider must be 'semble' or 'margin'" }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Backing writes records to the provider's collections — require those scopes.
      if (!hasIntegrationScopes(session, body.provider)) {
        return new Response(
          JSON.stringify({
            error: 'scope_upgrade_required',
            message: `Additional permissions are needed for ${body.provider}. Please log in again.`,
            integration: body.provider,
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (body.collectionUri && !body.collectionUri.startsWith('at://')) {
        return new Response(JSON.stringify({ error: 'collectionUri must be an at:// uri' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const result = await enableBacking(env, session, {
        provider: body.provider,
        collectionUri: body.collectionUri,
        exportExisting: body.exportExisting,
      });
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({ error: "action must be 'enable', 'disable', or 'exportBatch'" }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Failed to set backing:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to set backing' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// GET /api/saved — list user's saved items
export async function handleGetSaved(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
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
    // When backing is on, the Saved list IS the foreign collection: refresh the
    // membership snapshot (open-driven, gated) then read membership ⋈ enrichment.
    // A failed/incomplete poll is non-fatal — we still read the last good membership.
    const settings = await getUserSettings(env, session.did);
    if (settings.backing.provider !== 'skyreader') {
      try {
        await pollBackedMembership(env, session.did, settings.backing);
      } catch (pollErr) {
        console.error('Backed membership poll failed (serving last good snapshot):', pollErr);
      }
      // Metadata only — the body is the bulk of a saved item and the client
      // already caches it; it hydrates bodies for unseen rkeys via /api/saved/bodies.
      const articles = (await listBackedSaved(env, session.did, settings.backing)).map(
        ({ content: _content, ...rest }) => rest
      );
      // Fill in bodies for imported stubs after responding (bounded, self-healing
      // across opens). Titles are already seeded from the foreign record metadata.
      ctx.waitUntil(
        extractMissingBackedContent(env, session.did).catch((err) => {
          console.error('Backed content extraction failed:', err);
        })
      );
      // Backing is a snapshot of foreign membership (items can be *removed*
      // elsewhere), so it can't be merged incrementally — `full: true` tells the
      // client to replace its cache wholesale. `cursor: null` → single page.
      return new Response(JSON.stringify({ articles, cursor: null, full: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Keyset pagination over (saved_at DESC, id DESC). The client refreshes
    // incrementally — it pages newest-first and stops once it reaches items it
    // already has — so a typical refresh pulls one small page instead of the
    // whole history (bodies included). New saves always sort ahead of cached
    // ones (saved_at is set at save time), making "stop at first cached rkey" safe.
    const DEFAULT_LIMIT = 50;
    const MAX_LIMIT = 200;
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT)),
      MAX_LIMIT
    );

    // Cursor is "<saved_at>.<id>" of the last row of the previous page.
    let cursorSavedAt: number | null = null;
    let cursorId: number | null = null;
    const rawCursor = url.searchParams.get('cursor');
    if (rawCursor) {
      const [s, i] = rawCursor.split('.');
      const sv = Number(s);
      const iv = Number(i);
      if (Number.isFinite(sv) && Number.isFinite(iv)) {
        cursorSavedAt = sv;
        cursorId = iv;
      } else {
        return new Response(JSON.stringify({ error: 'Invalid cursor' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const where =
      cursorSavedAt !== null
        ? `user_did = ? AND (saved_at < ? OR (saved_at = ? AND id < ?))`
        : `user_did = ?`;
    const bindings =
      cursorSavedAt !== null
        ? [session.did, cursorSavedAt, cursorSavedAt, cursorId, limit]
        : [session.did, limit];

    // `content` is deliberately excluded — it's the bulk of a row and the client
    // already has bodies cached. Fresh rkeys are hydrated via /api/saved/bodies.
    const result = await env.DB.prepare(
      `SELECT id, rkey, record_uri, url, title, author, description, content_type, domain, image,
              word_count, published_at, saved_at, created_at, source, item_guid
       FROM saved_articles WHERE ${where} ORDER BY saved_at DESC, id DESC LIMIT ?`
    )
      .bind(...bindings)
      .all<SavedRow>();

    const articles = result.results.map((row) => ({
      rkey: row.rkey,
      uri: row.record_uri,
      url: row.url,
      title: row.title,
      author: row.author,
      description: row.description,
      contentType: row.content_type || 'webpage',
      domain: row.domain,
      image: row.image,
      wordCount: row.word_count,
      publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      savedAt: new Date(row.saved_at).toISOString(),
      source: row.source || 'url',
      itemGuid: row.item_guid,
    }));

    // A full page means there may be more — hand back a cursor pointing past the
    // last row. A short page is the end of the list (cursor null).
    const last = result.results[result.results.length - 1];
    const cursor = result.results.length === limit && last ? `${last.saved_at}.${last.id}` : null;

    return new Response(JSON.stringify({ articles, cursor, full: false }), {
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

// POST /api/saved/bodies — hydrate article bodies for a set of rkeys.
// GET /api/saved returns metadata only (the body is ~20-50× the rest of a row);
// the client asks for bodies only for items it hasn't cached yet, so a no-op
// refresh transfers almost nothing. Bodies come straight from saved_articles,
// which is where both native and external-backed content lives.
export async function handleGetSavedBodies(request: Request, env: Env): Promise<Response> {
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

  let body: { rkeys?: unknown };
  try {
    body = (await request.json()) as { rkeys?: unknown };
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const MAX_RKEYS = 200;
  const rkeys = Array.isArray(body.rkeys)
    ? body.rkeys
        .filter((r): r is string => typeof r === 'string' && isValidRkey(r))
        .slice(0, MAX_RKEYS)
    : null;
  if (!rkeys) {
    return new Response(JSON.stringify({ error: 'Missing rkeys array' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const bodies: Record<string, string | null> = {};
  if (rkeys.length > 0) {
    const placeholders = rkeys.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `SELECT rkey, content FROM saved_articles WHERE user_did = ? AND rkey IN (${placeholders})`
    )
      .bind(session.did, ...rkeys)
      .all<{ rkey: string; content: string | null }>();
    for (const row of result.results) {
      bodies[row.rkey] = row.content;
    }
  }

  return new Response(JSON.stringify({ bodies }), {
    headers: { 'Content-Type': 'application/json' },
  });
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
      'SELECT record_uri, item_guid, url_normalized FROM saved_articles WHERE user_did = ? AND rkey = ?'
    )
      .bind(session.did, rkey)
      .first<{
        record_uri: string | null;
        item_guid: string | null;
        url_normalized: string | null;
      }>();

    if (!row) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Delete the enrichment row from D1
    await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ? AND rkey = ?')
      .bind(session.did, rkey)
      .run();

    const settings = await getUserSettings(env, session.did);
    if (settings.backing.provider !== 'skyreader' && row.url_normalized) {
      // Backed: remove the membership from the foreign collection (+ tombstone).
      // Native saves live only in D1, so deleting the row above is the whole job.
      await backedUnsave(env, session, settings.backing, row.url_normalized, ctx);
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
      'SELECT rkey, record_uri, item_guid, url_normalized FROM saved_articles WHERE user_did = ? AND item_guid = ?'
    )
      .bind(session.did, guid)
      .first<{
        rkey: string;
        record_uri: string | null;
        item_guid: string | null;
        url_normalized: string | null;
      }>();

    if (!row) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Delete the enrichment row from D1
    await env.DB.prepare('DELETE FROM saved_articles WHERE user_did = ? AND item_guid = ?')
      .bind(session.did, guid)
      .run();

    const settings = await getUserSettings(env, session.did);
    if (settings.backing.provider !== 'skyreader' && row.url_normalized) {
      // Backed: remove the membership from the foreign collection (+ tombstone).
      // Native saves live only in D1, so deleting the row above is the whole job.
      await backedUnsave(env, session, settings.backing, row.url_normalized, ctx);
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
