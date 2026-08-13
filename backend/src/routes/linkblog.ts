// Linkblog routes (Phase 1) — sharing an article as a site.standard.document in
// the user's portable `skyreader-links` publication, plus publication settings.
//
// See LINKBLOG_PLAN.md and services/linkblog-sync.ts.

import type { Env } from '../types';
import { getSessionFromRequest } from '../services/oauth';
import {
  hasRequiredScopes,
  insufficientScopesResponse,
  LINKBLOG_SCOPES,
  PCKT_SCOPES,
  OFFPRINT_SCOPES,
} from './auth';
import { isValidRkey, invalidRkeyResponse } from '../utils/validation';
import {
  deleteLinkblogShare,
  deleteLinkblog,
  DOCUMENT_COLLECTION,
  FOREIGN_RECORD_ERROR,
  getPublicationMeta,
  getLinkblogTarget,
  isLinkblogDisabled,
  httpUrlOrUndefined,
  linkblogBaseUrl,
  PUBLICATION_COLLECTION,
  publicationUri,
  restoreLinkblog,
  updateLinkblogShareNote,
  updatePublication,
  writeLinkblogShare,
  type LinkblogShareInput,
  type ContentFormat,
} from '../services/linkblog-sync';
import { appForContentType, appForUrl, type PublicationApp } from '../services/publication-app';
import { createPDSClient } from '../services/pds-client';
import { getLinkblogDiscover, getLinkblogFriends } from '../services/linkblog-discovery';

// The Skyreader linkblog isn't a third-party app's publication; label it as ours
// so the picker can say plainly which side of the choice each row is on.
const SKYREADER_APP: PublicationApp = {
  id: 'skyreader',
  label: 'Skyreader',
  format: 'leaflet',
  formatLocked: true,
  supported: true,
};

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

// A pckt or Offprint linkblog needs one scope beyond the standard.site pair,
// because the post only surfaces on those hosts once its companion record is
// written (see COMPANION_COLLECTIONS). Checked here rather than left to fail
// inside the write so the user gets the "log in again" banner instead of a share
// that publishes to their PDS and then quietly never appears on their blog.
const COMPANION_SCOPES: Partial<Record<ContentFormat, string[]>> = {
  pckt: PCKT_SCOPES,
  offprint: OFFPRINT_SCOPES,
};

function missingCompanionScopes(
  session: { grantedScopes?: string },
  format: ContentFormat
): boolean {
  const required = COMPANION_SCOPES[format];
  return !!required && !hasRequiredScopes(session.grantedScopes, required);
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
  if (await isLinkblogDisabled(env, session.did)) {
    return json({ error: 'linkblog_deleted' }, 409);
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

  const target = await getLinkblogTarget(env, session.did);
  if (missingCompanionScopes(session, target.format)) return insufficientScopesResponse();

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
    publication: target.siteUri,
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

  // An edit changes the document's cid, which strands the companion's strongRef
  // on the old revision unless it's rewritten too — so the scope matters here as
  // much as on the create. Checked against the current target rather than the
  // stored record, which we haven't read yet.
  const target = await getLinkblogTarget(env, session.did);
  if (missingCompanionScopes(session, target.format)) return insufficientScopesResponse();

  const result = await updateLinkblogShareNote(session, rkey, body.note);
  if (!result.success) {
    if (isScopeError(result.error)) return insufficientScopesResponse();
    // Not a PDS failure: the record isn't ours to rewrite.
    if (result.error === FOREIGN_RECORD_ERROR) return json({ error: result.error }, 409);
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
    // Not a PDS failure: the record isn't ours to delete.
    if (result.error === FOREIGN_RECORD_ERROR) return json({ error: result.error }, 409);
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
  if (await isLinkblogDisabled(env, session.did)) {
    return json({ error: 'linkblog_deleted' }, 409);
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

// Formats a connect request may ask for. `pckt` is deliberately absent: pckt
// won't render a post it didn't write (see publication-app.ts), so writing pckt
// blocks anywhere produces a document nothing shows. Reading pckt content is
// unaffected — only choosing it as an output format is gone.
const FORMATS = new Set<ContentFormat>(['leaflet', 'offprint', 'markpub']);

export async function migrateLinkblogFollowers(
  env: Env,
  subjectDid: string,
  previousSiteUri: string,
  nextSiteUri: string
): Promise<void> {
  if (previousSiteUri === nextSiteUri) return;

  // Heal the follower's siteUrl while we're here. The author's public linkblog
  // page is what tells the reader this publication is a linkblog once its rkey is
  // no longer `skyreader-links` (see sourceDisplay); rows created before we
  // persisted it have none. COALESCE so a user-set value is never overwritten.
  const linkblogPage = linkblogBaseUrl(env, subjectDid);

  // A follower may already subscribe to the destination publication. Keep that
  // row and use it to reconcile the old graph edge, then remove the redundant
  // source row. Otherwise move the source row in place.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE subscriptions_cache AS destination
       SET atmosphere_previous_feed_url = COALESCE(
             (SELECT source.atmosphere_previous_feed_url
              FROM subscriptions_cache AS source
              WHERE source.user_did = destination.user_did
                AND source.source_type = 'atproto.documents'
                AND source.subject_did = ? AND source.feed_url = ?),
             destination.atmosphere_previous_feed_url,
             ?
           ),
           site_url = COALESCE(site_url, ?),
           atmosphere_synced = NULL
       WHERE source_type = 'atproto.documents' AND subject_did = ? AND feed_url = ?
         AND EXISTS (
           SELECT 1 FROM subscriptions_cache AS source
           WHERE source.user_did = destination.user_did
             AND source.source_type = 'atproto.documents'
             AND source.subject_did = ? AND source.feed_url = ?
         )`
    ).bind(
      subjectDid,
      previousSiteUri,
      previousSiteUri,
      linkblogPage,
      subjectDid,
      nextSiteUri,
      subjectDid,
      previousSiteUri
    ),
    env.DB.prepare(
      `DELETE FROM subscriptions_cache AS source
       WHERE source_type = 'atproto.documents' AND subject_did = ? AND feed_url = ?
         AND EXISTS (
           SELECT 1 FROM subscriptions_cache AS destination
           WHERE destination.user_did = source.user_did
             AND destination.source_type = 'atproto.documents'
             AND destination.subject_did = ? AND destination.feed_url = ?
         )`
    ).bind(subjectDid, previousSiteUri, subjectDid, nextSiteUri),
    env.DB.prepare(
      `UPDATE subscriptions_cache
       SET feed_url = ?,
           atmosphere_previous_feed_url = COALESCE(atmosphere_previous_feed_url, ?),
           site_url = COALESCE(site_url, ?),
           atmosphere_synced = NULL
       WHERE source_type = 'atproto.documents' AND subject_did = ? AND feed_url = ?`
    ).bind(nextSiteUri, previousSiteUri, linkblogPage, subjectDid, previousSiteUri),
  ]);
}

/** What a publication's existing documents say about it: how many, and which
 *  app's content lexicon they use (the most common one wins — a publication that
 *  gained a few Skyreader leaflet posts is still a pckt publication). */
interface PublicationEvidence {
  posts: number;
  contentTypes: Map<string, number>;
}

export function summarizeDocuments(
  documents: Array<{ site?: string; content?: unknown }>
): Map<string, PublicationEvidence> {
  const bySite = new Map<string, PublicationEvidence>();
  for (const doc of documents) {
    if (!doc.site) continue;
    let evidence = bySite.get(doc.site);
    if (!evidence) {
      evidence = { posts: 0, contentTypes: new Map() };
      bySite.set(doc.site, evidence);
    }
    evidence.posts++;
    const contentType = (doc.content as { $type?: string } | undefined)?.$type;
    if (contentType) {
      evidence.contentTypes.set(contentType, (evidence.contentTypes.get(contentType) ?? 0) + 1);
    }
  }
  return bySite;
}

function dominantContentType(evidence: PublicationEvidence | undefined): string | undefined {
  if (!evidence) return undefined;
  let winner: string | undefined;
  let best = 0;
  for (const [contentType, count] of evidence.contentTypes) {
    if (count > best) {
      winner = contentType;
      best = count;
    }
  }
  return winner;
}

/** Which app a publication belongs to: its own posts name it, its host is the
 *  fallback for one that's still empty. */
export function appForPublication(
  evidence: PublicationEvidence | undefined,
  url: string | undefined
): PublicationApp | null {
  return appForContentType(dominantContentType(evidence)) ?? appForUrl(url);
}

/** The format an app leaves no choice about, if it is one — see `formatLocked`. */
function lockedFormat(app: PublicationApp | null): ContentFormat | null {
  return app?.formatLocked ? app.format : null;
}

/**
 * Can a linkblog publish here at all? An app we can't place is assumed to render
 * standard.site documents (that's what the collection is for); only an app we
 * know ignores foreign records is refused — see `PublicationApp.supported`.
 */
export function publicationSupported(app: PublicationApp | null): boolean {
  return app?.supported !== false;
}

/**
 * The format links get written in when connecting to a publication. A Leaflet,
 * pckt or Offprint publication renders only its own blocks, so the app decides
 * and the request doesn't get a say; anything else takes the requested format,
 * falling back to leaflet, which every standard.site reader in Skyreader shows.
 */
export function connectContentFormat(
  app: PublicationApp | null,
  requested: ContentFormat | undefined
): ContentFormat {
  return lockedFormat(app) ?? requested ?? 'leaflet';
}

export async function handleListPublications(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const pdsClient = createPDSClient(session);
  // Documents are read only to describe each publication (which app, how many
  // posts), so a failure there degrades the list rather than failing it.
  const [result, documents] = await Promise.all([
    pdsClient.listAllRecords<{ name?: string; description?: string; url?: string }>(
      PUBLICATION_COLLECTION,
      { maxPages: 5, maxRecords: 200 }
    ),
    pdsClient.listAllRecords<{ site?: string; content?: unknown }>(DOCUMENT_COLLECTION, {
      maxPages: 3,
      maxRecords: 300,
    }),
  ]);
  if (!result.success) return json({ error: result.error }, 502);
  const evidenceBySite = summarizeDocuments(
    documents.success ? documents.data.map((record) => record.value) : []
  );

  const defaultUri = publicationUri(session.did);
  const publications = result.data.map((record) => {
    const evidence = evidenceBySite.get(record.uri);
    const url = httpUrlOrUndefined(record.value.url);
    const isDefault = record.uri === defaultUri;
    // Skyreader's own linkblog is named for the app the user is standing in, not
    // for the content lexicon it happens to write.
    const app = isDefault ? SKYREADER_APP : appForPublication(evidence, url);
    return {
      uri: record.uri,
      rkey: record.uri.split('/').pop(),
      name: record.value.name || 'Untitled publication',
      description: record.value.description,
      url,
      isDefault,
      appId: app?.id,
      appLabel: app?.label,
      // Only offered when we can write it — Greengale resolves to an app with no
      // format, and the picker leaves that choice to the user.
      detectedFormat: app?.format ?? undefined,
      // Leaflet, pckt and Offprint read only their own blocks, so the picker
      // states the format instead of offering it. The connect route enforces the
      // same thing, whatever the client sends.
      formatLocked: lockedFormat(app) !== null,
      // Listed but not connectable — the picker shows the row disabled with the
      // reason, which beats leaving a publication the user owns unexplained.
      supported: publicationSupported(app),
      unsupportedReason: app?.unsupportedReason,
      posts: evidence?.posts ?? 0,
    };
  });
  // The Skyreader linkblog is always offered, even before its record exists — it's
  // created lazily on first share, and a user who connected an external
  // publication without ever sharing would otherwise have no way back. Choosing it
  // hits the disconnect path, which works whether or not the record is there.
  if (!publications.some((p) => p.isDefault)) {
    publications.unshift({
      uri: defaultUri,
      rkey: defaultUri.split('/').pop(),
      name: 'Skyreader linkblog',
      description: undefined,
      url: undefined,
      isDefault: true,
      appId: SKYREADER_APP.id,
      appLabel: SKYREADER_APP.label,
      detectedFormat: SKYREADER_APP.format ?? undefined,
      formatLocked: true,
      supported: true,
      unsupportedReason: undefined,
      posts: evidenceBySite.get(defaultUri)?.posts ?? 0,
    });
  }
  return json({ publications });
}

export async function handleConnectPublication(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  const now = Math.floor(Date.now() / 1000);
  if (request.method === 'DELETE') {
    const previousTarget = await getLinkblogTarget(env, session.did);
    const nextSiteUri = publicationUri(session.did);
    await env.DB.prepare(
      'UPDATE user_settings SET linkblog_publication = NULL, linkblog_content_format = NULL, updated_at = ? WHERE user_did = ?'
    )
      .bind(now, session.did)
      .run();
    await migrateLinkblogFollowers(env, session.did, previousTarget.siteUri, nextSiteUri);
    return json(await getPublicationMeta(session, env));
  }
  if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
  if (await isLinkblogDisabled(env, session.did)) {
    return json({ error: 'linkblog_deleted' }, 409);
  }
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
  const selectedPublicationUri = body.publicationUri!;
  if (body.format && !FORMATS.has(body.format))
    return json({ error: 'Unsupported content format' }, 400);
  const pdsClient = createPDSClient(session);
  const exists = await pdsClient.getRecord<{ url?: string }>('site.standard.publication', match[2]);
  if (!exists.success) return json({ error: 'Publication not found' }, 404);
  // A Leaflet, pckt or Offprint publication renders only its own blocks, so the
  // format isn't the client's to pick: detect the app the same way the picker
  // describes it, and write what that app reads. Detection failing is not a
  // reason to refuse the connect — it just leaves the choice where it was.
  const documents = await pdsClient.listAllRecords<{ site?: string; content?: unknown }>(
    DOCUMENT_COLLECTION,
    { maxPages: 3, maxRecords: 300 }
  );
  const evidence = documents.success
    ? summarizeDocuments(documents.data.map((record) => record.value)).get(selectedPublicationUri)
    : undefined;
  const app = appForPublication(evidence, httpUrlOrUndefined(exists.data.value?.url));
  // Some apps ignore records they didn't write themselves, so connecting would
  // quietly publish into a site that never shows the result. Refuse rather than
  // accept a setting that can't work.
  if (!publicationSupported(app)) {
    return json(
      {
        error:
          app?.unsupportedReason ??
          "This publication's app doesn't show posts written by other apps.",
      },
      400
    );
  }
  const format = connectContentFormat(app, body.format);
  const previousTarget = await getLinkblogTarget(env, session.did);
  await env.DB.prepare(
    `INSERT INTO user_settings (user_did, linkblog_publication, linkblog_content_format, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_did) DO UPDATE SET linkblog_publication=excluded.linkblog_publication,
    linkblog_content_format=excluded.linkblog_content_format, updated_at=excluded.updated_at`
  )
    .bind(session.did, selectedPublicationUri, format, now, now)
    .run();
  await migrateLinkblogFollowers(env, session.did, previousTarget.siteUri, selectedPublicationUri);
  return json(await getPublicationMeta(session, env));
}

export async function handleDeletePublication(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  if (!hasRequiredScopes(session.grantedScopes, LINKBLOG_SCOPES)) {
    return insufficientScopesResponse();
  }
  const result = await deleteLinkblog(session, env);
  if (!result.success) return json({ error: result.error }, result.retryable ? 503 : 502);
  // Delete moves the target back to the default publication the same way
  // disconnecting does, so followers of a connected publication have to come
  // with it — otherwise a restore publishes to `skyreader-links` while every
  // existing subscriber still points at a feed that will never update again.
  await migrateLinkblogFollowers(
    env,
    session.did,
    result.data.previousSiteUri,
    publicationUri(session.did)
  );
  return json({ success: true, deletedPosts: result.data.deletedPosts });
}

export async function handleRestorePublication(request: Request, env: Env): Promise<Response> {
  const session = await getSessionFromRequest(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  // Gated like every other linkblog mutation. Restoring only flips a D1 flag, but
  // a session that can't write is one whose next share fails — better to send it
  // into the re-auth flow here than to hand back a linkblog it can't publish to.
  if (!hasRequiredScopes(session.grantedScopes, LINKBLOG_SCOPES)) {
    return insufficientScopesResponse();
  }
  await restoreLinkblog(session, env);
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
