/**
 * Recommends — a one-tap, public "this is worth reading".
 *
 *   GET    /api/recommends                         → { recommends: [...] }
 *   POST   /api/recommends { url, title?, documentUri? } → { recommended: true, uri }
 *   DELETE /api/recommends { url }                 → { recommended: false }
 *
 * A recommend is an app.skyreader.social.recommend record in the reader's OWN
 * repo, keyed by the article's URL so it works for anything with a URL (RSS,
 * newsletters, web pages), not just atproto documents. When the article is a
 * standard.site document, a site.standard.graph.recommend pointing at it is
 * written beside ours, so the author and every standard.site app see it too.
 * That copy is best-effort: it needs a scope older sessions don't hold, and
 * the recommend stands without it.
 *
 * D1's `recommendations` row is the index ("have I recommended this?") and
 * holds the rkeys an un-recommend deletes. It is claimed BEFORE the PDS write,
 * so two taps racing each other mint one record, not two.
 */

import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { createPDSClient } from '../services/pds-client';
import { grantsScopes } from '../services/scope-check';
import { hasRequiredScopes, insufficientScopesResponse } from './auth';
import { RECOMMEND_SCOPES, STANDARD_RECOMMEND_SCOPES } from '../config/scopes';
import { parseAtUri } from '../utils/canonical-url';
import { normalizeArticleUrl } from '../utils/url-normalize';
import { generateTid } from '../utils/tid';
import { log } from '../utils/logger';

export const RECOMMEND_COLLECTION = 'app.skyreader.social.recommend';
export const STANDARD_RECOMMEND_COLLECTION = 'site.standard.graph.recommend';
const STANDARD_DOCUMENT_COLLECTION = 'site.standard.document';

/** The lexicon's cap on `subject`. */
const URL_MAX = 2048;
const TITLE_MAX = 300;
/** How many of the reader's recommends GET returns, newest first. */
const LIST_LIMIT = 2000;

interface RecommendRow {
  url: string;
  title: string | null;
  rkey: string;
  document_uri: string | null;
  standard_rkey: string | null;
  created_at: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** An http(s) URL and its normalized key, or null. */
function parseArticleUrl(raw: unknown): { url: string; normalized: string } | null {
  const url = str(raw);
  if (!url || url.length > URL_MAX) return null;
  const normalized = normalizeArticleUrl(url);
  return normalized ? { url, normalized } : null;
}

export async function handleRecommends(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT url, title, rkey, document_uri, standard_rkey, created_at
         FROM recommendations WHERE did = ? ORDER BY created_at DESC LIMIT ?`
    )
      .bind(session.did, LIST_LIMIT)
      .all<RecommendRow>();
    return json({
      recommends: rows.results.map((r) => ({
        url: r.url,
        title: r.title ?? undefined,
        documentUri: r.document_uri ?? undefined,
        createdAt: new Date(r.created_at * 1000).toISOString(),
      })),
    });
  }

  if (request.method !== 'POST' && request.method !== 'DELETE') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!hasRequiredScopes(session.grantedScopes, RECOMMEND_SCOPES)) {
    return insufficientScopesResponse();
  }

  let body: { url?: unknown; title?: unknown; documentUri?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const article = parseArticleUrl(body.url);
  if (!article) return json({ error: 'url must be an http(s) link' }, 400);

  const pds = createPDSClient(session);
  const canWriteStandard = grantsScopes(session.grantedScopes, STANDARD_RECOMMEND_SCOPES);

  if (request.method === 'POST') {
    let documentUri: string | undefined;
    if (body.documentUri !== undefined && body.documentUri !== null) {
      documentUri = str(body.documentUri);
      const ref = documentUri ? parseAtUri(documentUri) : null;
      if (!ref || ref.collection !== STANDARD_DOCUMENT_COLLECTION || !ref.rkey) {
        return json({ error: 'documentUri must be a site.standard.document at-uri' }, 400);
      }
    }
    const title = str(body.title)?.slice(0, TITLE_MAX);

    // Claim the row first: an existing recommend is the answer, not a second
    // record, and a concurrent tap loses the insert instead of writing its own.
    const rkey = generateTid();
    const claim = await env.DB.prepare(
      `INSERT OR IGNORE INTO recommendations (did, url_normalized, url, title, rkey, document_uri)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(session.did, article.normalized, article.url, title ?? null, rkey, documentUri ?? null)
      .run();
    if (!claim.meta.changes) {
      const existing = await env.DB.prepare(
        'SELECT rkey FROM recommendations WHERE did = ? AND url_normalized = ?'
      )
        .bind(session.did, article.normalized)
        .first<{ rkey: string }>();
      return json({
        recommended: true,
        uri: existing ? `at://${session.did}/${RECOMMEND_COLLECTION}/${existing.rkey}` : undefined,
      });
    }

    const createdAt = new Date().toISOString();
    const result = await pds.putRecord(RECOMMEND_COLLECTION, rkey, {
      $type: RECOMMEND_COLLECTION,
      subject: article.url,
      ...(documentUri ? { document: documentUri } : {}),
      createdAt,
    });
    if (!result.success) {
      // Release the claim so a retry can write; it never reached the repo.
      await env.DB.prepare('DELETE FROM recommendations WHERE did = ? AND rkey = ?')
        .bind(session.did, rkey)
        .run();
      if (/scope/i.test(result.error)) return insufficientScopesResponse();
      log.error('recommend_write_failed', { pdsUrl: session.pdsUrl, error: result.error });
      return json({ error: result.error }, result.retryable ? 503 : 502);
    }

    if (documentUri && canWriteStandard) {
      const standardRkey = generateTid();
      const standard = await pds.putRecord(STANDARD_RECOMMEND_COLLECTION, standardRkey, {
        $type: STANDARD_RECOMMEND_COLLECTION,
        document: documentUri,
        createdAt,
      });
      if (standard.success) {
        await env.DB.prepare(
          'UPDATE recommendations SET standard_rkey = ? WHERE did = ? AND rkey = ?'
        )
          .bind(standardRkey, session.did, rkey)
          .run();
      } else {
        log.warn('recommend_standard_copy_failed', {
          pdsUrl: session.pdsUrl,
          error: standard.error,
        });
      }
    }

    return json({ recommended: true, uri: result.data.uri }, 201);
  }

  // DELETE
  const row = await env.DB.prepare(
    'SELECT rkey, standard_rkey FROM recommendations WHERE did = ? AND url_normalized = ?'
  )
    .bind(session.did, article.normalized)
    .first<Pick<RecommendRow, 'rkey' | 'standard_rkey'>>();
  if (!row) return json({ recommended: false });

  // The standard.site copy goes first: once ours is gone the row is too, and a
  // copy left behind would have nothing pointing at it to clean it up later.
  if (row.standard_rkey && canWriteStandard) {
    const standard = await pds.deleteRecord(STANDARD_RECOMMEND_COLLECTION, row.standard_rkey);
    if (!standard.success) {
      log.error('recommend_standard_copy_delete_failed', {
        pdsUrl: session.pdsUrl,
        error: standard.error,
      });
      return json({ error: standard.error }, standard.retryable ? 503 : 502);
    }
  }
  const result = await pds.deleteRecord(RECOMMEND_COLLECTION, row.rkey);
  if (!result.success) {
    if (/scope/i.test(result.error)) return insufficientScopesResponse();
    log.error('recommend_delete_failed', { pdsUrl: session.pdsUrl, error: result.error });
    return json({ error: result.error }, result.retryable ? 503 : 502);
  }
  await env.DB.prepare('DELETE FROM recommendations WHERE did = ? AND url_normalized = ?')
    .bind(session.did, article.normalized)
    .run();
  return json({ recommended: false });
}
