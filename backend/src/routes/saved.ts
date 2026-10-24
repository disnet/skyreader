import type { Env, Session } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { createPDSClient } from '../services/pds-client';
import { savedUrlKey } from '../services/semble-connections';
import { isValidRkey, invalidRkeyResponse } from '../utils/validation';
import { removeSavedFromCollections } from './shelf';
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
import { chunkArray } from './reading';
import { deleteSavedFile, storeLinkedOriginalForUrl } from './saved-pdf';
import {
  captureSnapshot,
  deleteSnapshots,
  listSnapshots,
  type SnapshotMethod,
} from '../services/archive/snapshots';
import { exactDoi } from '../services/export/identifiers';
import { findSnapshotImage, snapshotImageUrl } from '../services/archive/snapshot-images';
import { storeFor } from '../services/saved-file-store';
import {
  parseMetadataEdit,
  unlessEdited,
  addEditedFields,
  type EditableColumn,
} from '../services/saved-metadata';
import { extractImportedSaves, OPEN_EXTRACT_RATE_KEY } from './saved-import';
import { checkRateLimit } from '../services/rate-limit';

const COLLECTION = 'app.skyreader.feed.saved';

// How far GET /api/saved/updates' returned mark trails the clock (see there).
const UPDATES_SAFETY_MARGIN_MS = 60_000;

// Conservative cap on bound parameters per D1 statement (see reading.ts).
const BODIES_SQL_PARAMS = 90;

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
  updated_at: number | null;
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
  // 'pdf' or 'epub' when the extraction came from one (the ExtractedArticle says
  // so). Any other value is ignored: a URL save is otherwise a 'webpage'.
  contentType?: 'pdf' | 'epub';
  // The DOI the page named in its <head> (ExtractedArticle.doi). Stored only
  // when it reads as one (savedDoi).
  doi?: string;
  // When the URL is already saved, upgrade the existing item's content/metadata
  // with this request's fields instead of returning 409. Used by the browser
  // extension, whose live-DOM extraction can see paywalled/JS-rendered content
  // the server-side extractor can't.
  updateContent?: boolean;
  // How the client captured `content`: 'live-dom' (the extension, from the open
  // tab) or 'server' (via /api/extract). Recorded on the save's snapshot; any
  // other value is ignored.
  captureMethod?: 'live-dom' | 'server';
}

// How a save's body was captured, for its snapshot: the client's word for a URL
// save, else what the source implies. Unknown is null, never a guess.
function snapshotMethod(body: CreateSavedBody, source: string): SnapshotMethod | null {
  if (body.captureMethod === 'live-dom' || body.captureMethod === 'server') {
    return body.captureMethod;
  }
  if (source === 'feed') return 'feed';
  if (source === 'document') return 'record';
  return null;
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

  // A PDF or EPUB saved by link keeps its original, as an upload does, fetched
  // after the response so the save itself waits on nothing (routes/saved-pdf.ts).
  const keepPdfOriginal = (response: Response): Response => {
    if (response.ok && fileContentType(body) && body.url) {
      ctx.waitUntil(storeLinkedOriginalForUrl(env, session.did, body.url));
    }
    return response;
  };

  // Feed/share/document saves are deduped by item guid, not URL (below).
  const keyedByGuid =
    (body.fromFeed || source === 'feed' || source === 'share' || source === 'document') &&
    !!body.itemGuid;
  // Share/document saves may have no URL, and so may a feed save keyed by its
  // item guid: an emailed newsletter is its own article, with no web copy. A
  // URL save always needs its URL, whatever else rides along.
  const urlOptional =
    source === 'share' || source === 'document' || (source === 'feed' && keyedByGuid);
  if (urlOptional) {
    if (typeof body.url !== 'string') body.url = '';
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

  // Validate URL only for url/feed sources that carry one
  if (source !== 'share' && source !== 'document' && body.url) {
    try {
      new URL(body.url);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid url' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Check for duplicate — by item_guid for feed/share/document saves, by URL
  // otherwise. A save with no URL has nothing to match on: '' would collide with
  // every other URL-less save (newsletters, link-less shares).
  if (keyedByGuid) {
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
  } else if (body.url) {
    const existing = await env.DB.prepare(
      'SELECT id, rkey, record_uri FROM saved_articles WHERE user_did = ? AND url = ?'
    )
      .bind(session.did, body.url)
      .first<Pick<SavedRow, 'id' | 'rkey' | 'record_uri'>>();

    if (existing) {
      // Content upgrade: a re-save carrying fresh content replaces what we have
      // (live-DOM extraction beats a paywall stub or truncated feed body).
      // This is an update of an existing save, so it deliberately runs before —
      // and doesn't count against — the monthly URL-save limit.
      if (body.updateContent && body.content) {
        return keepPdfOriginal(await handleContentUpdate(env, ctx, session, body, existing));
      }
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
       WHERE user_did = ? AND source = 'url' AND imported_from IS NULL AND saved_at >= ?`
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
      return keepPdfOriginal(
        await handleBackedSave(env, ctx, session, body, source, settings.backing)
      );
    }

    if (source === 'feed' || source === 'share' || source === 'document') {
      // Metadata save: use provided metadata, skip extraction
      return await handleMetadataSave(request, env, ctx, session, body, source);
    } else {
      // URL save: the client has already extracted the article (via /api/extract)
      // and posts the content, so nothing here fetches the page.
      return keepPdfOriginal(await handleUrlSave(request, env, ctx, session, body));
    }
  } catch (error) {
    console.error('Failed to save item:', error);
    // No `blocked` flag here: this route never fetches the target site, so a
    // refusal by the site surfaces on /api/extract, before the save is attempted.
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
  ctx: ExecutionContext,
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
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_key, title, author, description, content, content_type, domain, image, word_count, published_at, saved_at, created_at, source, item_guid, doi)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      session.did,
      body.rkey,
      recordUri,
      body.url,
      savedUrlKey(body.url),
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
      body.itemGuid || null,
      savedDoi(body)
    )
    .run();
  ctx.waitUntil(
    captureSnapshot(env, {
      did: session.did,
      saveRkey: body.rkey,
      url: body.url,
      body: body.content,
      method: snapshotMethod(body, source),
    })
  );

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

// Upgrade an already-saved item's content in place (updateContent flag). Each
// field only overwrites when the request provides a value — same new-wins
// COALESCE shape as the backed-save upsert — so a sparse extraction never
// blanks existing metadata, and a field the reader edited by hand keeps their
// value (services/saved-metadata.ts). The rkey and record_uri are unchanged:
// this is the same save, with better content.
async function handleContentUpdate(
  env: Env,
  ctx: ExecutionContext,
  session: Session,
  body: CreateSavedBody,
  existing: Pick<SavedRow, 'id' | 'rkey' | 'record_uri'>
): Promise<Response> {
  const publishedAt = body.publishedAt ? new Date(body.publishedAt).getTime() : null;

  const kept = await env.DB.prepare(
    `UPDATE saved_articles SET
       title = ${unlessEdited('title', 'COALESCE(?, title)')},
       author = ${unlessEdited('author', 'COALESCE(?, author)')},
       description = ${unlessEdited('description', 'COALESCE(?, description)')},
       content = COALESCE(?, content),
       domain = COALESCE(?, domain),
       image = COALESCE(?, image),
       word_count = COALESCE(?, word_count),
       published_at = ${unlessEdited('published_at', 'COALESCE(?, published_at)')},
       doi = COALESCE(?, doi),
       content_type = CASE
         WHEN ? IS NOT NULL THEN ?
         WHEN ? IS NOT NULL AND content_type IN ('pdf', 'epub') THEN 'webpage'
         ELSE content_type
       END,
       updated_at = ?
     WHERE id = ? AND user_did = ?
     RETURNING title, author, description, published_at`
  )
    .bind(
      body.title || null,
      body.author || null,
      body.description || null,
      body.content || null,
      body.domain || null,
      body.image || null,
      body.wordCount || null,
      publishedAt,
      savedDoi(body),
      // A PDF or EPUB body re-types the save as one. A web page's body replacing
      // a file's is a web page again; any other upgrade keeps the type it had.
      fileContentType(body),
      fileContentType(body),
      body.content || null,
      Date.now(),
      existing.id,
      session.did
    )
    .first<KeptMetadata>();
  // A new capture of the same save: kept beside the earlier one, not over it.
  ctx.waitUntil(
    captureSnapshot(env, {
      did: session.did,
      saveRkey: existing.rkey,
      url: body.url,
      body: body.content,
      method: snapshotMethod(body, 'url'),
    })
  );

  return new Response(
    JSON.stringify({
      rkey: existing.rkey,
      uri: existing.record_uri,
      updated: true,
      // What the save now carries: a field the reader edited kept theirs.
      ...keptMetadata(kept),
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

type KeptMetadata = Pick<SavedRow, 'title' | 'author' | 'description' | 'published_at'>;

// A save's stored metadata in response shape, after a write that may have kept
// the reader's own edits over the request's values. Nothing when no row came back.
function keptMetadata(row: KeptMetadata | null) {
  if (!row) return {};
  return {
    title: row.title,
    author: row.author,
    description: row.description,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
  };
}

// The file type a save's body came from, when it came from one. Only 'pdf' and
// 'epub' are accepted from the client; the field is otherwise untrusted input.
function fileContentType(body: CreateSavedBody): 'pdf' | 'epub' | null {
  return body.contentType === 'pdf' || body.contentType === 'epub' ? body.contentType : null;
}

// The DOI a save stores, from the page's own <head> (read by the extractor).
// The field is untrusted input like every other, so it's kept only when it's
// a DOI and nothing more.
function savedDoi(body: CreateSavedBody): string | null {
  return exactDoi(body.doi) ?? null;
}

// The stored type of a URL save: a file's type, else a web page.
function urlSaveContentType(body: CreateSavedBody): 'pdf' | 'epub' | 'webpage' {
  return fileContentType(body) ?? 'webpage';
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
    `INSERT INTO saved_articles (user_did, rkey, record_uri, url, url_key, title, author, description, content, content_type, domain, image, word_count, published_at, saved_at, created_at, source, doi)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      session.did,
      body.rkey,
      recordUri,
      body.url,
      savedUrlKey(body.url),
      body.title || null,
      body.author || null,
      body.description || null,
      body.content || null,
      urlSaveContentType(body),
      body.domain || null,
      body.image || null,
      body.wordCount || null,
      publishedAt ? new Date(publishedAt).getTime() : null,
      now,
      now,
      'url',
      savedDoi(body)
    )
    .run();
  ctx.waitUntil(
    captureSnapshot(env, {
      did: session.did,
      saveRkey: body.rkey,
      url: body.url,
      body: body.content,
      method: snapshotMethod(body, 'url'),
    })
  );

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
  ctx: ExecutionContext,
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
  const contentType =
    source === 'feed' ? 'article' : source === 'url' ? urlSaveContentType(body) : source;
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
  const batchResults = await env.DB.batch([
    // The upsert moves an existing row to this save's rkey; its snapshots (and
    // their pictures) move with it.
    env.DB.prepare(
      `UPDATE saved_snapshots SET save_rkey = ?
       WHERE user_did = ? AND save_rkey IN (
         SELECT rkey FROM saved_articles WHERE user_did = ? AND url_normalized = ?)`
    ).bind(body.rkey, session.did, session.did, urlNormalized),
    env.DB.prepare(
      `UPDATE saved_snapshot_images SET save_rkey = ?
       WHERE user_did = ? AND save_rkey IN (
         SELECT rkey FROM saved_articles WHERE user_did = ? AND url_normalized = ?)`
    ).bind(body.rkey, session.did, session.did, urlNormalized),
    env.DB.prepare(
      `INSERT INTO saved_articles
         (user_did, rkey, record_uri, url, url_normalized, url_key, title, author, description, content,
          content_type, domain, image, word_count, published_at, saved_at, created_at, source, item_guid, doi)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_did, url_normalized) DO UPDATE SET
         rkey = excluded.rkey,
         title = ${unlessEdited('title', 'COALESCE(excluded.title, title)')},
         author = ${unlessEdited('author', 'COALESCE(excluded.author, author)')},
         description = ${unlessEdited('description', 'COALESCE(excluded.description, description)')},
         content = COALESCE(excluded.content, content),
         -- The type describes the body: when the body above is the one already
         -- stored (this save brought no text, e.g. a failed PDF extraction), so
         -- is the type. A stub with no body yet takes this save's type.
         content_type = CASE WHEN excluded.content IS NULL AND content IS NOT NULL
           THEN content_type ELSE excluded.content_type END,
         domain = COALESCE(excluded.domain, domain),
         image = COALESCE(excluded.image, image),
         word_count = COALESCE(excluded.word_count, word_count),
         published_at = ${unlessEdited('published_at', 'COALESCE(excluded.published_at, published_at)')},
         source = excluded.source,
         item_guid = COALESCE(excluded.item_guid, item_guid),
         doi = COALESCE(excluded.doi, doi),
         -- A body landing on an existing row is an in-place edit the client's
         -- cached copy doesn't have (excluded.saved_at is this request's now).
         updated_at = CASE WHEN excluded.content IS NOT NULL THEN excluded.saved_at ELSE updated_at END,
         saved_at = excluded.saved_at
       RETURNING title, author, description, published_at`
    ).bind(
      session.did,
      body.rkey,
      url,
      urlNormalized,
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
      body.itemGuid || canonicalAtUri || null,
      savedDoi(body)
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
  // A re-save onto a row the reader edited keeps their fields; answer with those.
  const kept = (batchResults[2]?.results?.[0] as KeptMetadata | undefined) ?? null;
  // The upsert above sets the row's rkey to this save's, so the snapshot keys on it.
  ctx.waitUntil(
    captureSnapshot(env, {
      did: session.did,
      saveRkey: body.rkey,
      url,
      body: body.content,
      method: snapshotMethod(body, source),
    })
  );

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
      ...keptMetadata(kept),
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
    /** exportBatch: just these saves (the ones an import added) instead of an offset slice. */
    rkeys?: unknown;
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
      if (body.rkeys !== undefined) {
        const rkeys = body.rkeys;
        if (
          !Array.isArray(rkeys) ||
          rkeys.length > MAX_LIMIT ||
          !rkeys.every((r) => typeof r === 'string' && isValidRkey(r))
        ) {
          return new Response(JSON.stringify({ error: `rkeys: at most ${MAX_LIMIT} rkeys` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const { exported, scanned } = await exportNativeSaves(env, session, settings.backing, {
          rkeys: rkeys as string[],
        });
        return new Response(JSON.stringify({ exported, scanned, total: rkeys.length }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
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
            message: `Additional permissions are needed for ${body.provider}.`,
            integration: body.provider,
            feature: body.provider,
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
    // When backing is on, the Saved list IS the foreign collection: serve the
    // last good membership ⋈ enrichment immediately and refresh the membership
    // snapshot in the background (the poll is auth-free and session-less, so it
    // is waitUntil-safe — the next open reads what it wrote). The poll used to
    // run inline and a large collection held the response for many seconds,
    // which also serialized the client's whole refresh behind it. Only an
    // account with no successful snapshot yet (enable-time poll failed or
    // hasn't landed) still pays for an inline poll — otherwise the list would
    // render an unverified empty snapshot.
    const settings = await getUserSettings(env, session.did);
    if (settings.backing.provider !== 'skyreader') {
      let verified = settings.lastSuccessfulBackingPoll != null;
      if (verified) {
        ctx.waitUntil(
          pollBackedMembership(env, session.did, settings.backing).catch((pollErr) => {
            console.error('Backed membership poll failed (serving last good snapshot):', pollErr);
          })
        );
      } else {
        try {
          // Forced past POLL_GATE_MS on purpose: the gate keys off
          // `last_backing_poll`, which a *failed* poll stamps too, so an ordinary
          // poll here would no-op for a minute after enable-time failed — and we'd
          // answer `full: true` with a snapshot that was never verified.
          const poll = await pollBackedMembership(env, session.did, settings.backing, {
            force: true,
          });
          verified = poll.complete;
        } catch (pollErr) {
          console.error('Backed membership poll failed (serving last good snapshot):', pollErr);
        }
      }
      // Metadata only — the body is the bulk of a saved item and the client
      // already caches it; it hydrates bodies for unseen rkeys via /api/saved/bodies.
      const articles = (await listBackedSaved(env, session.did, settings.backing)).map(
        ({ content: _content, ...rest }) => rest
      );

      // The snapshot is served whole on every refresh (membership can shrink, so
      // it can't page), which for a large collection is >1MB per poll — almost
      // always byte-identical to what the client already holds. The digest is
      // over the serialized articles themselves (not membership keys), so an
      // enrichment update (a title or description landing after extraction)
      // moves it too; the client echoes the digest of the last snapshot it kept
      // and an unchanged one costs a couple hundred bytes. Only a verified
      // snapshot may short-circuit: `unchanged` tells the client to keep its
      // cache, which is exactly the wholesale trust an unverified one hasn't earned.
      const serialized = JSON.stringify(articles);
      const digestBytes = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(serialized)
      );
      const digest = [...new Uint8Array(digestBytes)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      // Keep enrichment self-healing even when the metadata snapshot is
      // unchanged. In particular, a failed extraction leaves `content` NULL
      // without changing this digest; scheduling the retry after the early
      // return would strand that stub forever.
      ctx.waitUntil(
        extractMissingBackedContent(env, session.did).catch((err) => {
          console.error('Backed content extraction failed:', err);
        })
      );

      const sinceDigest = new URL(request.url).searchParams.get('since_digest');
      if (verified && sinceDigest && sinceDigest === digest) {
        return new Response(
          JSON.stringify({ articles: [], cursor: null, full: true, unchanged: true, digest }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Backing is a snapshot of foreign membership (items can be *removed*
      // elsewhere), so it can't be merged incrementally — `full: true` tells the
      // client to replace its cache wholesale. `cursor: null` → single page.
      // Only claim `full` once a snapshot has actually landed: a wholesale
      // replace from an unverified (possibly empty) membership table wipes the
      // user's Saved list. Unverified degrades to the merge path, which keeps
      // the client's cache and is a no-op when we have no rows to offer.
      return new Response(JSON.stringify({ articles, cursor: null, full: verified, digest }), {
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
              word_count, published_at, saved_at, created_at, source, item_guid, updated_at
       FROM saved_articles WHERE ${where} ORDER BY saved_at DESC, id DESC LIMIT ?`
    )
      .bind(...bindings)
      .all<SavedRow>();

    const articles = result.results.map(rowToListItem);

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

// Metadata-only list shape shared by GET /api/saved and GET /api/saved/updates.
// `updatedAt` lets the client tell a changed body from the one it cached.
function rowToListItem(row: Omit<SavedRow, 'content' | 'user_did'>) {
  return {
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
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

// GET /api/saved/updates?since=<ms> — saved items edited in place after `since`.
// The list refresh is incremental over saved_at and stops at the first cached
// rkey, so an older save whose content changed (an extension re-save upgrading
// a paywall stub, a background extraction filling an empty body) would never be
// re-sent. This returns just those rows (metadata only; the client re-hydrates
// their bodies via /api/saved/bodies), oldest change first, paged by `next`.
export async function handleGetSavedUpdates(request: Request, env: Env): Promise<Response> {
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

  const LIMIT = 200;
  const rawSince = Number(new URL(request.url).searchParams.get('since') ?? 0);
  const since = Number.isFinite(rawSince) && rawSince > 0 ? Math.floor(rawSince) : 0;

  try {
    // Writers stamp updated_at from their own clock before their UPDATE commits,
    // so an edit stamped just before this read can still be invisible to the
    // query below. Hand back a mark that trails the clock by a margin: the
    // client re-sees recent rows (harmless — it applies by updatedAt) instead of
    // skipping one forever.
    const asOf = Date.now() - UPDATES_SAFETY_MARGIN_MS;
    const result = await env.DB.prepare(
      `SELECT id, rkey, record_uri, url, title, author, description, content_type, domain, image,
              word_count, published_at, saved_at, created_at, source, item_guid, updated_at
       FROM saved_articles
       WHERE user_did = ? AND updated_at IS NOT NULL AND updated_at > ?
       ORDER BY updated_at ASC, id ASC LIMIT ?`
    )
      .bind(session.did, since, LIMIT)
      .all<SavedRow>();

    const rows = result.results;
    const more = rows.length === LIMIT;
    // A full page resumes from its last row's stamp (rows sharing that exact
    // millisecond get re-sent, which is idempotent); otherwise we're caught up.
    const next = more ? rows[rows.length - 1].updated_at! - 1 : Math.max(since, asOf);

    return new Response(JSON.stringify({ articles: rows.map(rowToListItem), next, more }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to get saved updates:', error);
    return new Response(JSON.stringify({ error: 'Failed to get saved updates' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// GET /api/saved/status?url=<url> — is this exact URL already in the user's Saved
// list? A lightweight existence check for clients (the browser extension) that
// have no local cache to consult. Matches the pre-save dedup gate in
// handleCreateSaved (exact-URL match on saved_articles.url).
export async function handleSavedStatus(request: Request, env: Env): Promise<Response> {
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

  const url = new URL(request.url).searchParams.get('url');
  if (!url) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const existing = await env.DB.prepare(
      'SELECT 1 FROM saved_articles WHERE user_did = ? AND url = ? LIMIT 1'
    )
      .bind(session.did, url)
      .first();
    return new Response(JSON.stringify({ saved: !!existing }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to check saved status:', error);
    return new Response(JSON.stringify({ error: 'Failed to check saved status' }), {
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

  let body: { rkeys?: unknown; extract?: unknown };
  try {
    body = (await request.json()) as { rkeys?: unknown; extract?: unknown };
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

  // The reader opening one save asks for its text to be fetched if it was
  // imported without it (routes/saved-import.ts). Bulk hydration never does.
  if (body.extract === true && rkeys.length === 1) {
    const waiting = await env.DB.prepare(
      `SELECT 1 FROM saved_articles WHERE user_did = ? AND rkey = ?
          AND imported_from IS NOT NULL AND content IS NULL AND url != ''`
    )
      .bind(session.did, rkeys[0])
      .first();
    if (waiting && (await checkRateLimit(env, session.did, OPEN_EXTRACT_RATE_KEY)).allowed) {
      await extractImportedSaves(env, session.did, rkeys);
    }
  }

  const bodies: Record<string, string | null> = {};
  // D1 caps bound parameters per statement well below SQLite's 999, so a full
  // MAX_RKEYS request has to go out as several IN (...) queries.
  for (const chunk of chunkArray(rkeys, BODIES_SQL_PARAMS - 1)) {
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `SELECT rkey, content FROM saved_articles WHERE user_did = ? AND rkey IN (${placeholders})`
    )
      .bind(session.did, ...chunk)
      .all<{ rkey: string; content: string | null }>();
    for (const row of result.results) {
      bodies[row.rkey] = row.content;
    }
  }

  return new Response(JSON.stringify({ bodies }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// PATCH /api/saved/:rkey — update mutable fields on a saved item:
//  - wordCount: the precomputed word count, used by the frontend to backfill old
//    saves stored without one (so the read time stops falling back to the short
//    description and showing a misleading "1 min").
//  - title / author / description / publishedAt: the reader's own edit of the
//    save's metadata (services/saved-metadata.ts), kept over later extractions.
// D1-only, like saves themselves. A save backed by Semble or Margin keeps the
// foreign card's metadata as it was: the edit is the reader's, in Skyreader.
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

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sets: string[] = [];
  const binds: unknown[] = [];

  if ('wordCount' in body) {
    const wordCount = body.wordCount;
    if (typeof wordCount !== 'number' || !Number.isFinite(wordCount) || wordCount < 0) {
      return new Response(JSON.stringify({ error: 'Missing or invalid wordCount' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    sets.push('word_count = ?');
    binds.push(Math.round(wordCount));
  }

  const parsedEdit = parseMetadataEdit(body);
  if ('error' in parsedEdit) {
    return new Response(JSON.stringify({ error: parsedEdit.error }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const edited = Object.keys(parsedEdit.edit) as EditableColumn[];

  if (sets.length === 0 && edited.length === 0) {
    return new Response(JSON.stringify({ error: 'Nothing to update' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // A reader's edit is a change other devices (and the search index) have to
    // pick up, so it stamps updated_at; the word-count backfill alone doesn't.
    let updatedAt: number | null = null;
    if (edited.length > 0) {
      for (const column of edited) {
        sets.push(`${column} = ?`);
        binds.push(parsedEdit.edit[column]);
      }
      updatedAt = Date.now();
      sets.push(`edited_fields = ${addEditedFields(edited)}`, 'updated_at = ?');
      binds.push(updatedAt);
    }

    const result = await env.DB.prepare(
      `UPDATE saved_articles SET ${sets.join(', ')} WHERE user_did = ? AND rkey = ?`
    )
      .bind(...binds, session.did, rkey)
      .run();
    if (!result.meta.changes) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        ...(updatedAt ? { updatedAt: new Date(updatedAt).toISOString() } : {}),
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
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
    // An uploaded PDF's original goes with it, and so do its snapshots.
    await deleteSavedFile(env, session.did, rkey);
    await deleteSnapshots(env, session.did, [rkey]);
    // …and so do its places in Shelf collections.
    await removeSavedFromCollections(env, session.did, [rkey]);

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
    // Every save under this guid goes (normally one), and each one's snapshots with it.
    const guidRkeys = await env.DB.prepare(
      'SELECT rkey FROM saved_articles WHERE user_did = ? AND item_guid = ?'
    )
      .bind(session.did, guid)
      .all<{ rkey: string }>();
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
    await deleteSnapshots(
      env,
      session.did,
      guidRkeys.results.map((r) => r.rkey)
    );
    await removeSavedFromCollections(env, session.did, [row.rkey]);

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

// GET /api/saved/:rkey/snapshots — the captures of a save's body, oldest first:
// when, from where, how, and the body's hash. The bodies themselves stay in R2.
export async function handleGetSavedSnapshots(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const rkey = new URL(request.url).pathname.split('/')[3];
  if (!rkey || !isValidRkey(rkey)) return invalidRkeyResponse();
  const save = await env.DB.prepare(
    'SELECT 1 AS x FROM saved_articles WHERE user_did = ? AND rkey = ?'
  )
    .bind(session.did, rkey)
    .first();
  if (!save) return json({ error: 'Not found' }, 404);

  const rows = await listSnapshots(env, session.did, rkey);
  return json({
    snapshots: rows.map((row) => ({
      rkey: row.rkey,
      capturedAt: new Date(row.captured_at).toISOString(),
      url: row.url,
      contentType: row.content_type,
      sha256: row.sha256,
      size: row.size,
      method: row.method,
    })),
  });
}

// GET /api/saved/:rkey/snapshot-image?url=… — the copy of a picture a save's
// snapshot kept, by the address its body gives (services/archive/snapshot-images.ts).
// The reader asks when the site's own picture fails to load. Owner-only, and
// sandboxed like a book's pictures.
export async function handleGetSnapshotImage(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  const notFound = () =>
    new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const url = new URL(request.url);
  const rkey = url.pathname.split('/')[3];
  if (!rkey || !isValidRkey(rkey)) return invalidRkeyResponse();
  const imageUrl = snapshotImageUrl(url.searchParams.get('url') ?? '', '');
  if (!imageUrl) return notFound();

  const image = await findSnapshotImage(env, session.did, rkey, imageUrl);
  const object = image ? await storeFor(env, image.ref)?.get(image.ref) : null;
  if (!image || !object) return notFound();
  return new Response(object.body, {
    headers: {
      'Content-Type': image.contentType,
      'Content-Length': String(object.size),
      // A kept picture never changes; a later capture with other bytes is a new row.
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
