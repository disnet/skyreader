// Linkblog routes (Phase 1) — sharing an article as a site.standard.document in
// the user's portable `skyreader-links` publication, plus publication settings.
//
// See LINKBLOG_PLAN.md and services/linkblog-sync.ts.

import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import { hasRequiredScopes, insufficientScopesResponse, LINKBLOG_SCOPES } from './auth';
import { isValidRkey, invalidRkeyResponse } from '../utils/validation';
import {
  deleteBoost,
  deleteLinkblogShare,
  getPublicationMeta,
  publicationUri,
  updateLinkblogShareNote,
  updatePublication,
  writeBoost,
  writeLinkblogShare,
  type LinkblogShareInput,
} from '../services/linkblog-sync';

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
    publication: publicationUri(session.did),
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

// POST /api/linkblog/boost
//
// A boost is a bare recommend of someone's link post (no commentary — that's a
// quote, which goes through /share). The rkey is client-generated for optimistic
// insertion; `document` is the AT URI of the link post being boosted.
export async function handleCreateBoost(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasRequiredScopes(session.grantedScopes, LINKBLOG_SCOPES)) {
    return insufficientScopesResponse();
  }

  let body: { rkey?: string; document?: string };
  try {
    body = (await request.json()) as { rkey?: string; document?: string };
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.rkey || !isValidRkey(body.rkey)) {
    return invalidRkeyResponse();
  }
  if (!body.document || !isAtUri(body.document)) {
    return json({ error: 'document must be an at:// URI' }, 400);
  }

  const result = await writeBoost(session, body.rkey, body.document);
  if (!result.success) {
    if (isScopeError(result.error)) return insufficientScopesResponse();
    return json({ error: result.error }, result.retryable ? 503 : 502);
  }

  return json({ uri: result.data.uri, cid: result.data.cid, rkey: body.rkey });
}

// DELETE /api/linkblog/boost/:rkey
export async function handleDeleteBoost(request: Request, env: Env): Promise<Response> {
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

  const result = await deleteBoost(session, rkey);
  if (!result.success) {
    if (isScopeError(result.error)) return insufficientScopesResponse();
    return json({ error: result.error }, result.retryable ? 503 : 502);
  }
  return json({ success: true });
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
