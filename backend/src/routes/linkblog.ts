// Linkblog routes (Phase 1) — sharing an article as a site.standard.document in
// the user's portable `skyreader-links` publication, plus publication settings.
//
// See LINKBLOG_PLAN.md and services/linkblog-sync.ts.

import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { hasRequiredScopes, insufficientScopesResponse, LINKBLOG_SCOPES } from './auth';
import { isValidRkey, invalidRkeyResponse } from '../utils/validation';
import {
  deleteLinkblogShare,
  getPublicationMeta,
  getLinkblogTarget,
  publicationUri,
  updateLinkblogShareNote,
  updatePublication,
  writeLinkblogShare,
  type LinkblogShareInput,
  type ContentFormat,
} from '../services/linkblog-sync';
import { createPDSClient } from '../services/pds-client';
import { getLinkblogDiscover, getLinkblogFriends } from '../services/linkblog-discovery';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Sessions predating the linkblog scopes can't write standard.site records.
// Detect that and ask the client to re-auth (the frontend already renders a
// "log in again" banner for `scope_upgrade_required`). We check proactively
// from the granted-scopes string, and also translate the PDS's own scope
// rejection as an authoritative fallback when our stored scopes are stale.
function isScopeError(error: string): boolean {
  return /scope/i.test(error);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAtUri(value: string): boolean {
  return typeof value === 'string' && value.startsWith('at://');
}

interface CreateLinkblogShareRequest extends LinkblogShareInput {
  rkey?: string;
}

// POST /api/linkblog/share
//
// Awaits the PDS write (unlike the old fire-and-forget share) so the client gets
// the real uri/cid back and can roll back its optimistic insert on failure.
export async function handleCreateLinkblogShare(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasRequiredScopes(session.grantedScopes, LINKBLOG_SCOPES)) {
    return insufficientScopesResponse();
  }

  let body: CreateLinkblogShareRequest;
  try {
    body = (await request.json()) as CreateLinkblogShareRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { rkey } = body;
  if (!rkey || !isValidRkey(rkey)) {
    return invalidRkeyResponse();
  }
  if (!body.articleUrl || !isHttpUrl(body.articleUrl)) {
    return json({ error: 'articleUrl must be a valid http(s) URL' }, 400);
  }
  if (body.repostUri !== undefined && !isAtUri(body.repostUri)) {
    return json({ error: 'repostUri must be an at:// URI' }, 400);
  }

  const input: LinkblogShareInput = {
    articleUrl: body.articleUrl,
    articleTitle: body.articleTitle,
    articleAuthor: body.articleAuthor,
    excerpt: body.excerpt,
    articleImage: body.articleImage,
    articlePublishedAt: body.articlePublishedAt,
    note: body.note,
    tags: body.tags,
    repostUri: body.repostUri,
  };

  const result = await writeLinkblogShare(session, env, rkey, input);
  if (!result.success) {
    if (isScopeError(result.error)) return insufficientScopesResponse();
    return json({ error: result.error }, result.retryable ? 503 : 502);
  }

  return json({
    uri: result.data.uri,
    cid: result.data.cid,
    rkey,
    publication: (await getLinkblogTarget(env, session.did)).siteUri,
  });
}

// PATCH /api/linkblog/share/:rkey — update the note on an existing share.
// Body: { note: string } (empty string clears the commentary).
export async function handleUpdateLinkblogShare(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'PATCH') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasRequiredScopes(session.grantedScopes, LINKBLOG_SCOPES)) {
    return insufficientScopesResponse();
  }

  const pathParts = new URL(request.url).pathname.split('/');
  const rkey = pathParts[pathParts.length - 1];
  if (!rkey || !isValidRkey(rkey)) {
    return invalidRkeyResponse();
  }

  let body: { note?: string };
  try {
    body = (await request.json()) as { note?: string };
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof body.note !== 'string') {
    return json({ error: 'note must be a string' }, 400);
  }

  const result = await updateLinkblogShareNote(session, rkey, body.note);
  if (!result.success) {
    if (isScopeError(result.error)) return insufficientScopesResponse();
    return json({ error: result.error }, result.retryable ? 503 : 502);
  }
  return json({ uri: result.data.uri, cid: result.data.cid, rkey });
}

// DELETE /api/linkblog/share/:rkey
export async function handleDeleteLinkblogShare(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'DELETE') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasRequiredScopes(session.grantedScopes, LINKBLOG_SCOPES)) {
    return insufficientScopesResponse();
  }

  const pathParts = new URL(request.url).pathname.split('/');
  const rkey = pathParts[pathParts.length - 1];
  if (!rkey || !isValidRkey(rkey)) {
    return invalidRkeyResponse();
  }

  const result = await deleteLinkblogShare(session, rkey);
  if (!result.success) {
    if (isScopeError(result.error)) return insufficientScopesResponse();
    return json({ error: result.error }, result.retryable ? 503 : 502);
  }
  return json({ success: true });
}

// GET /api/linkblog/discover/friends — people the user follows on Bluesky who
// have a linkblog (Phase 6 onboarding). Read-only; no linkblog scopes needed.
export async function handleDiscoverFriends(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const people = await getLinkblogFriends(session, env);
  return json({ people });
}

// GET /api/linkblog/discover — the whole linkblog registry, friends first
// (flagged isFollow), for the /discover page. Read-only.
export async function handleDiscover(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const people = await getLinkblogDiscover(session, env);
  return json({ people });
}

// GET /api/linkblog/publication — current (or default) publication metadata.
export async function handleGetPublication(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  const meta = await getPublicationMeta(session, env);
  return json(meta);
}

// PATCH /api/linkblog/publication — customize name/description.
export async function handleUpdatePublication(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasRequiredScopes(session.grantedScopes, LINKBLOG_SCOPES)) {
    return insufficientScopesResponse();
  }
  if ((await getLinkblogTarget(env, session.did)).external) {
    return json({ error: 'This publication is managed by its home app' }, 409);
  }

  let body: { name?: string; description?: string };
  try {
    body = (await request.json()) as { name?: string; description?: string };
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.name !== undefined && typeof body.name !== 'string') {
    return json({ error: 'name must be a string' }, 400);
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return json({ error: 'description must be a string' }, 400);
  }

  const result = await updatePublication(session, env, {
    name: body.name,
    description: body.description,
  });
  if (!result.success) {
    if (isScopeError(result.error)) return insufficientScopesResponse();
    return json({ error: result.error }, result.retryable ? 503 : 502);
  }

  const meta = await getPublicationMeta(session, env);
  return json(meta);
}

const FORMATS = new Set<ContentFormat>(['leaflet', 'pckt', 'offprint', 'markpub']);

export async function handleListPublications(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const result = await createPDSClient(session).listAllRecords<{ name?: string; url?: string }>(
    'site.standard.publication',
    { maxPages: 5, maxRecords: 200 }
  );
  if (!result.success) return json({ error: result.error }, 502);
  return json({
    publications: result.data.map((record) => ({
      uri: record.uri,
      rkey: record.uri.split('/').pop(),
      name: record.value.name || 'Untitled publication',
      url: record.value.url,
      isDefault: record.uri === publicationUri(session.did),
    })),
  });
}

export async function handleConnectPublication(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const now = Math.floor(Date.now() / 1000);
  if (request.method === 'DELETE') {
    await env.DB.prepare(
      'UPDATE user_settings SET linkblog_publication = NULL, linkblog_content_format = NULL, updated_at = ? WHERE user_did = ?'
    )
      .bind(now, session.did)
      .run();
    return json(await getPublicationMeta(session, env));
  }
  if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
  let body: { publicationUri?: string; format?: ContentFormat };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const match = body.publicationUri?.match(
    /^at:\/\/([^/]+)\/site\.standard\.publication\/([^/]+)$/
  );
  if (!match || match[1] !== session.did)
    return json({ error: 'Choose a publication from your own Atmosphere account' }, 400);
  if (body.format && !FORMATS.has(body.format))
    return json({ error: 'Unsupported content format' }, 400);
  const exists = await createPDSClient(session).getRecord('site.standard.publication', match[2]);
  if (!exists.success) return json({ error: 'Publication not found' }, 404);
  const format = body.format || 'leaflet';
  await env.DB.prepare(
    `INSERT INTO user_settings (user_did, linkblog_publication, linkblog_content_format, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_did) DO UPDATE SET linkblog_publication=excluded.linkblog_publication,
    linkblog_content_format=excluded.linkblog_content_format, updated_at=excluded.updated_at`
  )
    .bind(session.did, body.publicationUri, format, now, now)
    .run();
  await env.DB.prepare(
    `UPDATE subscriptions_cache SET feed_url = ?, atmosphere_synced = NULL, updated_at = ?
    WHERE source_type = 'atproto.documents' AND subject_did = ? AND feed_url = ?`
  )
    .bind(body.publicationUri, now * 1000, session.did, publicationUri(session.did))
    .run();
  return json(await getPublicationMeta(session, env));
}

export async function handleResolvePublication(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const did = decodeURIComponent(new URL(request.url).pathname.split('/').pop() || '');
  if (!did.startsWith('did:')) return json({ error: 'Invalid DID' }, 400);
  const target = await getLinkblogTarget(env, did);
  return new Response(
    JSON.stringify({ siteUri: target.siteUri, defaultSiteUri: publicationUri(did) }),
    {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
    }
  );
}
