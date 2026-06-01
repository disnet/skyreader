// Linkblog write path (Phase 1).
//
// Sharing an article creates a `site.standard.document` in the user's dedicated
// `skyreader-links` publication — a real, portable linkblog in their PDS,
// readable by any Atmospheric app and rendered publicly at
// <FRONTEND_URL>/blogs/<did>/. The publication is created lazily on first share.
//
// See LINKBLOG_PLAN.md. This replaces the old app.skyreader.social.share write.

import type { Env, Session } from '../types';
import { createPDSClient, type PDSResult, type PutRecordResponse } from './pds-client';

export const PUBLICATION_COLLECTION = 'site.standard.publication';
export const DOCUMENT_COLLECTION = 'site.standard.document';

// One dedicated linkblog publication per user, at a fixed rkey.
export const LINKBLOG_RKEY = 'skyreader-links';

// Generous excerpt cap — the excerpt is the only durable copy if the source
// link-rots or paywalls, so keep it roomy, but bound it so a record can't bloat.
const MAX_EXCERPT_CHARS = 1500;

interface BlobRef {
  $type?: 'blob';
  ref: { $link: string };
  mimeType: string;
  size?: number;
}

interface PublicationRecord {
  $type?: string;
  url: string;
  name?: string;
  description?: string;
  icon?: BlobRef;
}

export function publicationUri(did: string): string {
  return `at://${did}/${PUBLICATION_COLLECTION}/${LINKBLOG_RKEY}`;
}

// The canonical public base for a user's linkblog. DID-based so it survives
// handle changes (see Phase 0). Trailing slash per the standard.site `url` field.
export function linkblogBaseUrl(env: Env, did: string): string {
  const base = (env.FRONTEND_URL || 'https://skyreader.app').replace(/\/+$/, '');
  return `${base}/blogs/${did}/`;
}

function defaultPublicationName(session: Session): string {
  const who = session.displayName?.trim() || (session.handle ? `@${session.handle}` : 'My');
  return `${who}'s links`;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + '…';
}

// ── Publication ──────────────────────────────────────────────────────────────

export interface PublicationMeta {
  uri: string;
  url: string;
  name: string;
  description?: string;
  iconUrl?: string;
  exists: boolean;
}

function iconUrlFromBlob(did: string, icon: BlobRef | undefined): string | undefined {
  const cid = icon?.ref?.$link;
  return cid ? `https://cdn.bsky.app/img/avatar/plain/${did}/${cid}@jpeg` : undefined;
}

// Read the current linkblog publication, or synthesize sensible defaults when it
// doesn't exist yet (so the settings UI can render before the first share).
export async function getPublicationMeta(session: Session, env: Env): Promise<PublicationMeta> {
  const pdsClient = createPDSClient(session);
  const result = await pdsClient.getRecord<PublicationRecord>(
    PUBLICATION_COLLECTION,
    LINKBLOG_RKEY
  );

  const url = linkblogBaseUrl(env, session.did);
  if (!result.success) {
    return {
      uri: publicationUri(session.did),
      url,
      name: defaultPublicationName(session),
      exists: false,
    };
  }

  const value = result.data.value;
  return {
    uri: publicationUri(session.did),
    url: value.url || url,
    name: value.name || defaultPublicationName(session),
    description: value.description,
    iconUrl: iconUrlFromBlob(session.did, value.icon),
    exists: true,
  };
}

// Create the linkblog publication if it doesn't already exist. Idempotent and
// non-destructive: if a record is already there (possibly user-customized), it's
// left untouched. Returns the publication AT URI.
export async function ensureLinkblogPublication(
  session: Session,
  env: Env
): Promise<PDSResult<{ uri: string; created: boolean }>> {
  const pdsClient = createPDSClient(session);
  const existing = await pdsClient.getRecord<PublicationRecord>(
    PUBLICATION_COLLECTION,
    LINKBLOG_RKEY
  );

  if (existing.success) {
    return { success: true, data: { uri: publicationUri(session.did), created: false } };
  }

  const record: PublicationRecord = {
    $type: PUBLICATION_COLLECTION,
    url: linkblogBaseUrl(env, session.did),
    name: defaultPublicationName(session),
  };

  const put = await pdsClient.putRecord(PUBLICATION_COLLECTION, LINKBLOG_RKEY, record);
  if (!put.success) return put;
  return { success: true, data: { uri: publicationUri(session.did), created: true } };
}

// Update the publication's name/description, preserving url + icon. Creates the
// record (with defaults) if it doesn't exist yet so settings work pre-first-share.
export async function updatePublication(
  session: Session,
  env: Env,
  updates: { name?: string; description?: string }
): Promise<PDSResult<PutRecordResponse>> {
  const pdsClient = createPDSClient(session);
  const existing = await pdsClient.getRecord<PublicationRecord>(
    PUBLICATION_COLLECTION,
    LINKBLOG_RKEY
  );

  const base: PublicationRecord = existing.success
    ? existing.data.value
    : { url: linkblogBaseUrl(env, session.did), name: defaultPublicationName(session) };

  const record: PublicationRecord = {
    ...base,
    $type: PUBLICATION_COLLECTION,
    url: base.url || linkblogBaseUrl(env, session.did),
  };
  if (updates.name !== undefined)
    record.name = updates.name.trim() || defaultPublicationName(session);
  if (updates.description !== undefined) {
    const desc = updates.description.trim();
    if (desc) record.description = desc;
    else delete record.description;
  }

  return pdsClient.putRecord(PUBLICATION_COLLECTION, LINKBLOG_RKEY, record);
}

// ── Document (a share) ───────────────────────────────────────────────────────

export interface LinkblogShareInput {
  articleUrl: string;
  articleTitle?: string;
  articleAuthor?: string;
  excerpt?: string; // generous first-paragraph excerpt (durable fallback copy)
  articleImage?: string;
  articlePublishedAt?: string;
  note?: string; // the user's commentary
  tags?: string[];
}

interface DocumentRecord {
  $type: string;
  site: string;
  title: string;
  path: string;
  publishedAt: string;
  createdAt: string;
  description?: string;
  textContent?: string;
  tags?: string[];
  links?: Array<{ uri: string; rel: string }>;
  content?: unknown;
}

// Build the rich, interoperable body: the user's note as a text block, then the
// shared article as a website link-card. The card carries the external URL so
// any pub.leaflet-aware reader (incl. Skyreader's own renderer in Phase 2) can
// render and open it; the top-level `links` field is the machine-readable ref.
function buildLeafletContent(input: LinkblogShareInput, excerpt: string): unknown {
  const blocks: Array<{ block: unknown }> = [];

  const note = input.note?.trim();
  if (note) {
    blocks.push({ block: { $type: 'pub.leaflet.blocks.text', plaintext: note } });
  }

  const website: Record<string, unknown> = {
    $type: 'pub.leaflet.blocks.website',
    url: input.articleUrl,
  };
  if (input.articleTitle) website.title = input.articleTitle;
  if (excerpt) website.description = excerpt;
  blocks.push({ block: website });

  return {
    $type: 'pub.leaflet.content',
    pages: [{ $type: 'pub.leaflet.pages.linearDocument', blocks }],
  };
}

export function buildLinkblogDocument(
  did: string,
  rkey: string,
  input: LinkblogShareInput
): DocumentRecord {
  const now = new Date().toISOString();
  const excerpt = input.excerpt ? truncate(input.excerpt, MAX_EXCERPT_CHARS) : '';
  const note = input.note?.trim();
  const textContent = [note, excerpt].filter(Boolean).join('\n\n') || undefined;

  return {
    $type: DOCUMENT_COLLECTION,
    site: publicationUri(did),
    title: input.articleTitle?.trim() || input.articleUrl,
    path: `/${rkey}`,
    publishedAt: input.articlePublishedAt || now,
    createdAt: now,
    description: excerpt || undefined,
    textContent,
    tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
    links: [{ uri: input.articleUrl, rel: 'related' }],
    content: buildLeafletContent(input, excerpt),
  };
}

// Ensure the publication exists, then write the share document. The rkey is
// supplied by the caller (client-generated TID) for optimistic insertion.
export async function writeLinkblogShare(
  session: Session,
  env: Env,
  rkey: string,
  input: LinkblogShareInput
): Promise<PDSResult<PutRecordResponse>> {
  const ensured = await ensureLinkblogPublication(session, env);
  if (!ensured.success) return ensured;

  const record = buildLinkblogDocument(session.did, rkey, input);
  return createPDSClient(session).putRecord(DOCUMENT_COLLECTION, rkey, record);
}

export async function deleteLinkblogShare(
  session: Session,
  rkey: string
): Promise<PDSResult<void>> {
  return createPDSClient(session).deleteRecord(DOCUMENT_COLLECTION, rkey);
}
