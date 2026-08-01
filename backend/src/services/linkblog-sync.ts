// Linkblog write path (Phase 1).
//
// Sharing an article creates a `site.standard.document` in the user's dedicated
// `skyreader-links` publication — a real, portable linkblog in their PDS,
// readable by any Atmospheric app and rendered publicly at
// <LINKBLOG_PUBLIC_URL>/<did>/. The publication is created lazily on first share.
//
// See LINKBLOG_PLAN.md. This replaces the old app.skyreader.social.share write.

import type { Env, Session } from '../types';
import { createPDSClient, type PDSResult, type PutRecordResponse } from './pds-client';
import { resolveHandle } from './oauth';
import { parseHandleTokens, buildMentionFacet, type MentionFacet } from '../utils/mention-facets';

// Cap on the number of distinct handles we resolve per note. Each unique handle
// costs up to a few sequential network round-trips (resolveHandle), all on the
// Worker write path, so an unbounded note could blow the per-request subrequest
// limit and stall the share write. Handles past the cap stay plain text.
const MAX_RESOLVED_HANDLES = 15;

// Upper bound on note length we scan for mentions. HANDLE_RE has nested
// quantifiers, so matching against an adversarially-large note is ~O(n²)
// backtracking on the Worker write path. Real notes are short; anything past
// this just won't have its tail scanned for @mentions (the note text itself is
// still stored verbatim by the caller). Comfortably above the excerpt cap.
const MAX_NOTE_SCAN_CHARS = 4000;

// Parse `@handle.tld` tokens in a note, resolve each unique handle to a DID, and
// return the didMention facets (byte-indexed into the trimmed note plaintext).
// Best-effort: an unresolvable handle just stays plain text. Resolving here (the
// async write path) keeps the content builders pure/sync. The mention is encoded
// for ANY resolvable handle — interop is universal. Surfacing it in-app is fully
// client-side: the recipient's browser discovers it via Constellation's backlink
// index (see frontend services/mentions.ts); there is no server-side notifier.
async function resolveNoteMentionHandles(note: string | undefined): Promise<Map<string, string>> {
  const text = note?.trim();
  if (!text) return new Map();
  // Bound the regex input (see MAX_NOTE_SCAN_CHARS). Byte offsets stay valid
  // because we only ever slice off the tail, never shift the prefix.
  const scanText = text.length > MAX_NOTE_SCAN_CHARS ? text.slice(0, MAX_NOTE_SCAN_CHARS) : text;
  const tokens = parseHandleTokens(scanText);
  if (tokens.length === 0) return new Map();

  const uniqueHandles = [...new Set(tokens.map((t) => t.handle))].slice(0, MAX_RESOLVED_HANDLES);
  const resolved = new Map<string, string>();
  await Promise.all(
    uniqueHandles.map(async (handle) => {
      try {
        const did = await resolveHandle(handle);
        if (did && did.startsWith('did:')) resolved.set(handle, did);
      } catch {
        /* unresolvable handle stays plain text */
      }
    })
  );

  return resolved;
}

export const PUBLICATION_COLLECTION = 'site.standard.publication';
export const DOCUMENT_COLLECTION = 'site.standard.document';

// One dedicated linkblog publication per user, at a fixed rkey.
export const LINKBLOG_RKEY = 'skyreader-links';

// Discovery marker. Every linkblog publication carries this single constant URL
// so Constellation indexes them all under one target — turning the backlink
// index into a zero-maintenance "who has a linkblog" registry:
//   GET /links/all?target=<LINKBLOG_MARKER_URL>
//     → links["site.standard.publication"][".skyreaderLinkblog"].distinct_dids
// returns every linkblog author's DID; intersect locally with a user's follows
// for onboarding, or list globally for /discover. (Publications are extendable
// per the standard.site lexicon, and Constellation indexes URI values at
// arbitrary custom paths — verified live against app.skyreader.feed.subscription.)
//
// MUST be a single global constant (NOT env-derived): the registry only works if
// every publication across dev/staging/prod writes the exact same target string.
// See LINKBLOG_PLAN.md Phase 6.
export const LINKBLOG_MARKER_URL = 'https://skyreader.app/linkblog';

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
  // Constant discovery marker (see LINKBLOG_MARKER_URL). Optional in the type
  // because pre-existing publications predate it and get backfilled lazily.
  skyreaderLinkblog?: string;
}

export function publicationUri(did: string): string {
  return `at://${did}/${PUBLICATION_COLLECTION}/${LINKBLOG_RKEY}`;
}

// The canonical public base for a user's linkblog. DID-based so it survives
// handle changes (see Phase 0). Trailing slash per the standard.site `url` field.
// Lives on the standalone linkblog site (linkblogs.skyreader.app), not the app
// origin — older records pointed at <FRONTEND_URL>/blogs/<did>/ and are redirected
// there (see frontend/static/_redirects) until backfilled.
export function linkblogBaseUrl(env: Env, did: string): string {
  const base = (env.LINKBLOG_PUBLIC_URL || 'https://linkblogs.skyreader.app').replace(/\/+$/, '');
  return `${base}/${did}/`;
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
    // Report the current canonical public URL, not the record's stored `value.url`
    // — older records still point at the previous origin (skyreader.app/blogs/…)
    // until lazy-backfilled, and the UI should always show where the linkblog
    // actually lives now (the stored field self-corrects on the user's next share).
    url,
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
    // Lazy backfill on each share — non-destructive (preserves user-customized
    // fields), at most one extra write per user since the next share finds nothing
    // to fix. Two things get healed here:
    //  1. The discovery marker, stamped onto publications created before it existed
    //     so they become discoverable via Constellation.
    //  2. The `url`, migrated to the current LINKBLOG_PUBLIC_URL when an older
    //     record still points at the previous origin (e.g. skyreader.app/blogs/…).
    //     We own the url field (not user-editable), so overwriting to canonical is
    //     safe. Stale records keep working via frontend/static/_redirects until a
    //     user's next share repoints them here.
    const value = existing.data.value;
    const expectedUrl = linkblogBaseUrl(env, session.did);
    const needsMarker = value.skyreaderLinkblog !== LINKBLOG_MARKER_URL;
    const needsUrl = value.url !== expectedUrl;
    if (needsMarker || needsUrl) {
      const updated: PublicationRecord = {
        ...value,
        $type: PUBLICATION_COLLECTION,
        url: expectedUrl,
        skyreaderLinkblog: LINKBLOG_MARKER_URL,
      };
      const put = await pdsClient.putRecord(PUBLICATION_COLLECTION, LINKBLOG_RKEY, updated);
      if (!put.success) return put;
    }
    return {
      success: true,
      data: { uri: publicationUri(session.did), created: false },
    };
  }

  const record: PublicationRecord = {
    $type: PUBLICATION_COLLECTION,
    url: linkblogBaseUrl(env, session.did),
    name: defaultPublicationName(session),
    skyreaderLinkblog: LINKBLOG_MARKER_URL,
  };

  const put = await pdsClient.putRecord(PUBLICATION_COLLECTION, LINKBLOG_RKEY, record);
  if (!put.success) return put;
  return {
    success: true,
    data: { uri: publicationUri(session.did), created: true },
  };
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
    : {
        url: linkblogBaseUrl(env, session.did),
        name: defaultPublicationName(session),
      };

  const record: PublicationRecord = {
    ...base,
    $type: PUBLICATION_COLLECTION,
    url: base.url || linkblogBaseUrl(env, session.did),
    skyreaderLinkblog: LINKBLOG_MARKER_URL,
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
  // Quote-reshare: the AT URI of the original link post being quoted. Added to
  // `links` as a `rel: "repost"` ref for provenance, alongside the article ref,
  // so the quote is its own linkblog entry that still credits the source.
  repostUri?: string;
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

// The article excerpt stored on a record's website link-card block. The card is
// the durable home of the excerpt now that the top-level `description` is reserved
// as the legacy-quote marker, so the note-update path reads it back from here to
// rebuild the card without dropping it.
function websiteCardExcerpt(content: unknown): string {
  const c = content as { pages?: Array<{ blocks?: Array<{ block?: Record<string, unknown> }> }> };
  for (const page of c?.pages ?? []) {
    for (const wrapper of page.blocks ?? []) {
      if (wrapper.block?.$type === 'pub.leaflet.blocks.website') {
        const desc = wrapper.block.description;
        if (typeof desc === 'string') return desc;
      }
    }
  }
  return '';
}

// Build the rich, interoperable body: the user's note as native text/blockquote
// blocks, then the shared article as a website link-card. The card carries the external URL so
// any pub.leaflet-aware reader (incl. Skyreader's own renderer in Phase 2) can
// render and open it; the top-level `links` field is the machine-readable ref.
type NoteBlock = { block: Record<string, unknown> };

// Parse the editor's deliberately small Markdown subset into native Leaflet
// blocks. Only a `>` at the beginning of a line is special; all other Markdown
// remains plaintext for Leaflet-aware clients to interpret as they choose.
export function noteToLeafletBlocks(
  note: string | undefined,
  resolvedHandles: Map<string, string> = new Map()
): NoteBlock[] {
  const text = note?.trim();
  if (!text) return [];

  const blocks: NoteBlock[] = [];
  let kind: 'text' | 'blockquote' | undefined;
  let lines: string[] = [];
  const flush = () => {
    if (!kind || lines.length === 0) return;
    const plaintext = lines.join('\n');
    const block: Record<string, unknown> = {
      $type: `pub.leaflet.blocks.${kind}`,
      plaintext,
    };
    const facets = parseHandleTokens(plaintext).flatMap((token) => {
      const did = resolvedHandles.get(token.handle);
      return did ? [buildMentionFacet(token.byteStart, token.byteEnd, did)] : [];
    });
    if (facets.length > 0) block.facets = facets;
    blocks.push({ block });
    kind = undefined;
    lines = [];
  };

  for (const line of text.split('\n')) {
    const quote = line.match(/^> ?(.*)$/);
    if (!quote && line.trim() === '') {
      flush();
      continue;
    }
    const nextKind = quote ? 'blockquote' : 'text';
    if (kind && kind !== nextKind) flush();
    kind = nextKind;
    lines.push(quote ? quote[1] : line);
  }
  flush();
  return blocks;
}

export function replaceLeafletNoteRegion(
  existing: unknown,
  note: string,
  resolvedHandles: Map<string, string> = new Map()
): unknown {
  const oldContent = existing as {
    $type?: string;
    pages?: Array<{ $type?: string; blocks?: Array<{ block?: Record<string, unknown> }> }>;
  };
  const oldBlocks = oldContent?.pages?.[0]?.blocks ?? [];
  const firstPreserved = oldBlocks.findIndex(
    (wrapper) =>
      wrapper.block?.$type !== 'pub.leaflet.blocks.text' &&
      wrapper.block?.$type !== 'pub.leaflet.blocks.blockquote'
  );
  const preserved = firstPreserved < 0 ? [] : oldBlocks.slice(firstPreserved);
  return {
    $type: oldContent?.$type || 'pub.leaflet.content',
    pages: [
      {
        $type: oldContent?.pages?.[0]?.$type || 'pub.leaflet.pages.linearDocument',
        blocks: [...noteToLeafletBlocks(note, resolvedHandles), ...preserved],
      },
      ...(oldContent?.pages?.slice(1) ?? []),
    ],
  };
}

function buildLeafletContent(
  input: LinkblogShareInput,
  excerpt: string,
  resolvedHandles?: Map<string, string>
): unknown {
  const blocks: Array<{ block: unknown }> = noteToLeafletBlocks(input.note, resolvedHandles);

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
  input: LinkblogShareInput,
  resolvedHandles?: Map<string, string>
): DocumentRecord {
  const now = new Date().toISOString();
  const excerpt = input.excerpt ? truncate(input.excerpt, MAX_EXCERPT_CHARS) : '';
  const note = input.note?.trim();
  const textContent = [note, excerpt].filter(Boolean).join('\n\n') || undefined;

  const links: Array<{ uri: string; rel: string }> = [{ uri: input.articleUrl, rel: 'related' }];
  if (input.repostUri) links.push({ uri: input.repostUri, rel: 'repost' });

  return {
    $type: DOCUMENT_COLLECTION,
    site: publicationUri(did),
    title: input.articleTitle?.trim() || input.articleUrl,
    path: `/${rkey}`,
    publishedAt: input.articlePublishedAt || now,
    createdAt: now,
    // The quote now lives inside the editable note (as a native blockquote), so
    // new shares no longer write a top-level `description`. Its presence is the
    // legacy marker the renderers use to keep showing the old standalone quote;
    // an absent description means "the note owns the body." The excerpt still
    // rides along in the website link-card block (buildLeafletContent) for
    // interop, and in `textContent` for search/durability.
    description: undefined,
    textContent,
    tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
    links,
    content: buildLeafletContent(input, excerpt, resolvedHandles),
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

  const resolvedHandles = await resolveNoteMentionHandles(input.note);
  const record = buildLinkblogDocument(session.did, rkey, input, resolvedHandles);
  return createPDSClient(session).putRecord(DOCUMENT_COLLECTION, rkey, record);
}

export async function deleteLinkblogShare(
  session: Session,
  rkey: string
): Promise<PDSResult<void>> {
  return createPDSClient(session).deleteRecord(DOCUMENT_COLLECTION, rkey);
}

// Update just the note on an existing share document, leaving everything else
// (createdAt, publishedAt, path, links/provenance, tags, the article link-card)
// intact. We read the record back, swap the note-derived parts — the leaflet
// note region and the flattened `textContent` — and putRecord under the same rkey.
export async function updateLinkblogShareNote(
  session: Session,
  rkey: string,
  note: string
): Promise<PDSResult<PutRecordResponse>> {
  const pdsClient = createPDSClient(session);
  const existing = await pdsClient.getRecord<DocumentRecord>(DOCUMENT_COLLECTION, rkey);
  if (!existing.success) return existing;

  const rec = existing.data.value;
  // Reconstruct the article link-card inputs from the stored record so the
  // rebuilt content keeps the same external link, title, and excerpt. The excerpt
  // comes from the website card (its durable home); `rec.description` is the
  // fallback for legacy records that still carry it at the top level. `...rec`
  // preserves that legacy `description` as-is — we never add one to a new record.
  const excerpt = websiteCardExcerpt(rec.content) || rec.description || '';
  const trimmedNote = note.trim();
  // Re-resolve mentions on edit so added/removed @handles re-encode; recipients
  // pick up the change on their next Constellation poll.
  const resolvedHandles = await resolveNoteMentionHandles(trimmedNote);

  const updated: DocumentRecord = {
    ...rec,
    $type: DOCUMENT_COLLECTION,
    textContent: [trimmedNote, excerpt].filter(Boolean).join('\n\n') || undefined,
    content: replaceLeafletNoteRegion(rec.content, trimmedNote, resolvedHandles),
  };

  return pdsClient.putRecord(DOCUMENT_COLLECTION, rkey, updated);
}
