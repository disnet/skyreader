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

export type ContentFormat = 'leaflet' | 'pckt' | 'offprint' | 'markpub';
export interface LinkblogTarget {
  siteUri: string;
  format: ContentFormat;
  external: boolean;
}

const CONTENT_FORMATS = new Set<ContentFormat>(['leaflet', 'pckt', 'offprint', 'markpub']);

export function defaultLinkblogTarget(did: string): LinkblogTarget {
  return { siteUri: publicationUri(did), format: 'leaflet', external: false };
}

// Turn a stored `linkblog_publication` setting into a target, ignoring anything
// that isn't a publication in this user's own repo.
function targetFromRow(
  did: string,
  publication: string | null | undefined,
  contentFormat: string | null | undefined
): LinkblogTarget {
  const fallback = defaultLinkblogTarget(did);
  if (!publication) return fallback;
  const match = publication.match(/^at:\/\/([^/]+)\/site\.standard\.publication\/([^/]+)$/);
  if (!match || match[1] !== did) return fallback;
  const format = CONTENT_FORMATS.has(contentFormat as ContentFormat)
    ? (contentFormat as ContentFormat)
    : 'leaflet';
  return {
    siteUri: publication,
    format,
    external: publication !== fallback.siteUri,
  };
}

export async function getLinkblogTarget(env: Env, did: string): Promise<LinkblogTarget> {
  try {
    const row = await env.DB.prepare(
      'SELECT linkblog_publication, linkblog_content_format FROM user_settings WHERE user_did = ?'
    )
      .bind(did)
      .first<{ linkblog_publication: string | null; linkblog_content_format: string | null }>();
    return targetFromRow(did, row?.linkblog_publication, row?.linkblog_content_format);
  } catch {
    // Deploys remain usable while a migration is rolling out.
    return defaultLinkblogTarget(did);
  }
}

// D1 caps bound parameters per statement; chunk the IN (...) list well under it.
const TARGET_LOOKUP_CHUNK = 80;

// Batch form of getLinkblogTarget for list endpoints (discovery). Every requested
// DID is present in the result — DIDs with no (or an unusable) setting map to the
// default Skyreader publication, same as the single-DID resolver.
export async function getLinkblogTargets(
  env: Env,
  dids: string[]
): Promise<Map<string, LinkblogTarget>> {
  const out = new Map<string, LinkblogTarget>();
  const unique = [...new Set(dids)];
  for (const did of unique) out.set(did, defaultLinkblogTarget(did));
  if (unique.length === 0) return out;

  try {
    for (let i = 0; i < unique.length; i += TARGET_LOOKUP_CHUNK) {
      const chunk = unique.slice(i, i + TARGET_LOOKUP_CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT user_did, linkblog_publication, linkblog_content_format
         FROM user_settings WHERE user_did IN (${placeholders})`
      )
        .bind(...chunk)
        .all<{
          user_did: string;
          linkblog_publication: string | null;
          linkblog_content_format: string | null;
        }>();
      for (const row of rows.results ?? []) {
        out.set(
          row.user_did,
          targetFromRow(row.user_did, row.linkblog_publication, row.linkblog_content_format)
        );
      }
    }
  } catch {
    // Best-effort: discovery falls back to the default publication for everyone.
  }
  return out;
}

// Bound on the connected-linkblog list below. Far above any plausible count of
// users who've connected an existing publication; a cap only so a runaway table
// can't be loaded whole into a discovery request.
const MAX_CONNECTED_AUTHORS = 2000;

// The DIDs whose linkblog is an EXISTING publication they connected.
//
// These users are invisible to the Constellation marker registry: the marker is
// stamped on the `skyreader-links` publication we create, and connecting is
// deliberately non-mutating — we never touch a publication the home app owns. A
// user who connects before their first share therefore never creates a marked
// record at all. Discovery unions this local list over the registry so they're
// still findable (see linkblog-discovery.ts). Best-effort, like everything in
// discovery: a failure yields a shorter list, not an error.
export async function getConnectedLinkblogAuthors(env: Env): Promise<string[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT user_did, linkblog_publication FROM user_settings
       WHERE linkblog_publication IS NOT NULL LIMIT ?`
    )
      .bind(MAX_CONNECTED_AUTHORS)
      .all<{ user_did: string; linkblog_publication: string }>();
    // Only rows that actually resolve to a target (a publication in that user's
    // own repo) count — targetFromRow rejects anything else.
    return (rows.results ?? [])
      .filter((row) => targetFromRow(row.user_did, row.linkblog_publication, null).external)
      .map((row) => row.user_did);
  } catch {
    return [];
  }
}

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
  // Optional: a foreign publication (Leaflet, pckt, …) isn't guaranteed to carry
  // one, and we never depend on it for our own records.
  url?: string;
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
  // ALWAYS the Skyreader linkblog page for this user (<linkblogs origin>/<did>/).
  // Clients build the handle alias off its origin and present it as "your public
  // page", so it must stay on the linkblog site even when the documents live in a
  // connected publication — that page renders them too.
  url: string;
  // For a connected publication only: its own site, as stored on the record
  // (e.g. https://leaflet.pub/lish/…). Absent when there is none, or when it
  // isn't an http(s) URL. Purely informational — never the "your linkblog" link.
  externalUrl?: string;
  name: string;
  description?: string;
  iconUrl?: string;
  exists: boolean;
  external: boolean;
  format: ContentFormat;
}

// PDS records are user-controlled, so a `url` can be any string. Only surface it
// when it's a real http(s) URL (it ends up in an href).
export function httpUrlOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function iconUrlFromBlob(did: string, icon: BlobRef | undefined): string | undefined {
  const cid = icon?.ref?.$link;
  return cid ? `https://cdn.bsky.app/img/avatar/plain/${did}/${cid}@jpeg` : undefined;
}

// Read the current linkblog publication, or synthesize sensible defaults when it
// doesn't exist yet (so the settings UI can render before the first share).
export async function getPublicationMeta(session: Session, env: Env): Promise<PublicationMeta> {
  const target = await getLinkblogTarget(env, session.did);
  const pdsClient = createPDSClient(session);
  const rkey = target.siteUri.split('/').pop() || LINKBLOG_RKEY;
  const result = await pdsClient.getRecord<PublicationRecord>(PUBLICATION_COLLECTION, rkey);

  const url = linkblogBaseUrl(env, session.did);
  if (!result.success) {
    return {
      uri: target.siteUri,
      url,
      name: defaultPublicationName(session),
      exists: false,
      external: target.external,
      format: target.format,
    };
  }

  const value = result.data.value;
  return {
    uri: target.siteUri,
    // Report the current canonical public URL, not the record's stored `value.url`
    // — older records still point at the previous origin (skyreader.app/blogs/…)
    // until lazy-backfilled, and the UI should always show where the linkblog
    // actually lives now (the stored field self-corrects on the user's next share).
    // A connected publication's own site rides along separately as `externalUrl`.
    url,
    externalUrl: target.external ? httpUrlOrUndefined(value.url) : undefined,
    name: value.name || defaultPublicationName(session),
    description: value.description,
    iconUrl: iconUrlFromBlob(session.did, value.icon),
    exists: true,
    external: target.external,
    format: target.format,
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
  // Provenance marker: "Skyreader wrote this link post" (same constant the
  // publication carries — see LINKBLOG_MARKER_URL). Load-bearing once a linkblog
  // is connected to an existing publication: that publication also holds posts
  // its HOME app wrote, and a home-app post that happens to link out is otherwise
  // indistinguishable from a share. Everything Skyreader offers to *mutate* — the
  // un-share/delete, the in-place note edit, the "already shared" overlay — keys
  // off this, so we never rewrite or destroy someone's Leaflet/pckt essay.
  // Absent on documents in the default publication written before the marker
  // existed; those are covered by the publication check instead.
  skyreaderLinkblog?: string;
}

// Whether a `site.standard.document` is one of OUR link posts: it carries the
// marker, or it lives in the user's own Skyreader publication (where everything
// is ours, marker or not — pre-marker records still count).
function isSkyreaderShareRecord(
  did: string,
  rec: Pick<DocumentRecord, 'site' | 'skyreaderLinkblog'>
): boolean {
  return rec.skyreaderLinkblog === LINKBLOG_MARKER_URL || rec.site === publicationUri(did);
}

// The article excerpt stored on a record's website link-card block. The card is
// the durable home of the excerpt now that the top-level `description` is reserved
// as the legacy-quote marker, so the note-update path reads it back from here to
// rebuild the card without dropping it.
function websiteCardExcerpt(content: unknown): string {
  const c = content as {
    pages?: Array<{ blocks?: Array<{ block?: Record<string, unknown> }> }>;
    items?: Array<{ $type?: string; attrs?: Record<string, unknown> }>;
  };
  for (const page of c?.pages ?? []) {
    for (const wrapper of page.blocks ?? []) {
      if (wrapper.block?.$type === 'pub.leaflet.blocks.website') {
        const desc = wrapper.block.description;
        if (typeof desc === 'string') return desc;
      }
    }
  }
  // pckt's link card keeps the same excerpt under `attrs.description`.
  for (const item of c?.items ?? []) {
    if (item?.$type === 'blog.pckt.block.website' && typeof item.attrs?.description === 'string') {
      return item.attrs.description;
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
  resolvedHandles?: Map<string, string>,
  siteUri = publicationUri(did),
  format: ContentFormat = 'leaflet'
): DocumentRecord {
  const now = new Date().toISOString();
  const excerpt = input.excerpt ? truncate(input.excerpt, MAX_EXCERPT_CHARS) : '';
  const note = input.note?.trim();
  const textContent = [note, excerpt].filter(Boolean).join('\n\n') || undefined;

  const links: Array<{ uri: string; rel: string }> = [{ uri: input.articleUrl, rel: 'related' }];
  if (input.repostUri) links.push({ uri: input.repostUri, rel: 'repost' });

  return {
    $type: DOCUMENT_COLLECTION,
    site: siteUri,
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
    content: buildContent(format, input, excerpt, resolvedHandles),
    // See DocumentRecord.skyreaderLinkblog — the tell that separates a Skyreader
    // share from a post the connected publication's home app wrote.
    skyreaderLinkblog: LINKBLOG_MARKER_URL,
  };
}

// The block-item formats (pckt, Offprint) share a shape — an ordered `items`
// array of `<prefix>text` / `<prefix>blockquote` blocks — and differ only in the
// NSID prefix and in how they carry the shared article.
const ITEM_PREFIX: Record<'pckt' | 'offprint', string> = {
  pckt: 'blog.pckt.block.',
  offprint: 'app.offprint.block.',
};

const ITEM_CONTENT_TYPE: Record<'pckt' | 'offprint', string> = {
  pckt: 'blog.pckt.content',
  offprint: 'app.offprint.content',
};

// The note as native blocks: one item per paragraph, a leading `>` making it a
// blockquote (the same deliberately small Markdown subset the editor speaks).
function noteToBlockItems(
  prefix: string,
  note: string | undefined
): Array<Record<string, unknown>> {
  const text = note?.trim();
  if (!text) return [];
  return text.split(/\n\s*\n/).map((paragraph) => {
    const quoted = paragraph.startsWith('>');
    const plaintext = paragraph.replace(/^> ?/gm, '');
    const textBlock = { $type: `${prefix}text`, plaintext };
    return quoted ? { $type: `${prefix}blockquote`, content: [textBlock] } : textBlock;
  });
}

// The shared article itself, trailing the note. pckt has a native link card;
// Offprint has no equivalent block, so the article rides as a final text line.
function articleItem(
  format: 'pckt' | 'offprint',
  article: { url: string; title?: string; excerpt?: string }
): Record<string, unknown> {
  if (format === 'pckt') {
    return {
      $type: 'blog.pckt.block.website',
      attrs: {
        src: article.url,
        title: article.title,
        description: article.excerpt || undefined,
      },
    };
  }
  return {
    $type: 'app.offprint.block.text',
    plaintext: `${article.title || article.url} — ${article.url}`,
  };
}

function markpubLinkLine(url: string, title?: string): string {
  return `[${(title || url).replace(/([\\[\]()])/g, '\\$1')}](${url})`;
}

function buildContent(
  format: ContentFormat,
  input: LinkblogShareInput,
  excerpt: string,
  handles?: Map<string, string>
): unknown {
  if (format === 'leaflet') return buildLeafletContent(input, excerpt, handles);
  if (format === 'markpub') {
    return {
      $type: 'at.markpub.markdown',
      text: {
        markdown: [input.note?.trim(), markpubLinkLine(input.articleUrl, input.articleTitle)]
          .filter(Boolean)
          .join('\n\n'),
      },
    };
  }
  const items = [
    ...noteToBlockItems(ITEM_PREFIX[format], input.note),
    articleItem(format, { url: input.articleUrl, title: input.articleTitle, excerpt }),
  ];
  return { $type: ITEM_CONTENT_TYPE[format], items };
}

// Which content shape a stored record uses, or null for anything we can't edit.
export function contentFormatOf(content: unknown): ContentFormat | null {
  switch ((content as { $type?: string } | undefined)?.$type) {
    case 'pub.leaflet.content':
      return 'leaflet';
    case 'blog.pckt.content':
      return 'pckt';
    case 'app.offprint.content':
      return 'offprint';
    case 'at.markpub.markdown':
      return 'markpub';
    default:
      return null;
  }
}

// Is this item part of the leading note region (as opposed to the article that
// closes the post)? Offprint's article line is an ordinary text block, so it's
// identified by the article URL it carries.
function isNoteItem(item: unknown, prefix: string, articleUrl: string | undefined): boolean {
  const block = item as { $type?: string; plaintext?: unknown } | undefined;
  if (block?.$type === `${prefix}blockquote`) return true;
  if (block?.$type !== `${prefix}text`) return false;
  const plaintext = typeof block.plaintext === 'string' ? block.plaintext : '';
  return !(articleUrl && plaintext.includes(articleUrl));
}

// Swap the note region of a pckt/Offprint body, preserving the article block and
// anything the home app appended after it.
export function replaceItemsNoteRegion(
  existing: unknown,
  format: 'pckt' | 'offprint',
  note: string,
  article: { url?: string; title?: string }
): unknown {
  const content = existing as { $type?: string; items?: unknown[] } | undefined;
  const prefix = ITEM_PREFIX[format];
  const items = Array.isArray(content?.items) ? content.items : [];
  const firstPreserved = items.findIndex((item) => !isNoteItem(item, prefix, article.url));
  const preserved = firstPreserved < 0 ? [] : items.slice(firstPreserved);
  return {
    ...content,
    $type: content?.$type || ITEM_CONTENT_TYPE[format],
    items: [
      ...noteToBlockItems(prefix, note),
      // The article block should always be there; rebuild it if the record somehow
      // arrived without one, so an edit can't drop the link itself.
      ...(preserved.length > 0
        ? preserved
        : article.url
          ? [articleItem(format, { url: article.url, title: article.title })]
          : []),
    ],
  };
}

// Swap the note in a Markdown body: everything before the trailing article link,
// which is kept verbatim when present.
export function replaceMarkpubNote(
  existing: unknown,
  note: string,
  article: { url?: string; title?: string }
): unknown {
  const content = existing as { text?: { markdown?: string } } | undefined;
  const markdown = content?.text?.markdown ?? '';
  let tail = article.url ? markpubLinkLine(article.url, article.title) : '';
  if (article.url) {
    const lines = markdown.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(`](${article.url})`)) {
        tail = lines[i].trim();
        break;
      }
    }
  }
  return {
    ...content,
    $type: 'at.markpub.markdown',
    text: {
      ...(content?.text ?? {}),
      markdown: [note.trim(), tail].filter(Boolean).join('\n\n'),
    },
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
  const target = await getLinkblogTarget(env, session.did);
  if (!target.external) {
    const ensured = await ensureLinkblogPublication(session, env);
    if (!ensured.success) return ensured;
  }

  const resolvedHandles = await resolveNoteMentionHandles(input.note);
  const record = buildLinkblogDocument(
    session.did,
    rkey,
    input,
    resolvedHandles,
    target.siteUri,
    target.format
  );
  return createPDSClient(session).putRecord(DOCUMENT_COLLECTION, rkey, record);
}

// A read that came back "no such record" — a normal outcome, not a failure.
function isNotFoundError(error: string): boolean {
  return /RecordNotFound|could not locate record/i.test(error);
}

// Returned when a mutation targets a record Skyreader didn't write. The routes
// map it to 409 (a policy answer, not a PDS failure).
export const FOREIGN_RECORD_ERROR =
  'That post was written by this publication’s own app, so Skyreader won’t change it';

// Delete one of the user's own link posts. A connected publication also holds
// posts its HOME app wrote, so the record is read back first and only deleted
// when it's actually a Skyreader share — deleting a user's Leaflet/pckt essay
// because it happened to carry an outbound link is unrecoverable.
export async function deleteLinkblogShare(
  session: Session,
  rkey: string
): Promise<PDSResult<void>> {
  const pdsClient = createPDSClient(session);
  const existing = await pdsClient.getRecord<DocumentRecord>(DOCUMENT_COLLECTION, rkey);
  if (!existing.success) {
    // Already gone — un-sharing is idempotent (deleteRecord is too).
    if (isNotFoundError(existing.error)) return { success: true, data: undefined };
    return existing;
  }
  if (!isSkyreaderShareRecord(session.did, existing.data.value)) {
    return { success: false, error: FOREIGN_RECORD_ERROR, retryable: false };
  }
  return pdsClient.deleteRecord(DOCUMENT_COLLECTION, rkey);
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
  // Same guard as the delete path: rewriting the note region of a post the home
  // app wrote would replace its leading blocks with our commentary.
  if (!isSkyreaderShareRecord(session.did, rec)) {
    return { success: false, error: FOREIGN_RECORD_ERROR, retryable: false };
  }
  const format = contentFormatOf(rec.content);
  if (!format) {
    const contentType = (rec.content as { $type?: string } | undefined)?.$type;
    return {
      success: false,
      error: `Editing ${contentType || 'unknown'} linkblog content is not supported yet`,
      retryable: false,
    };
  }
  // Reconstruct the article link-card inputs from the stored record so the
  // rebuilt content keeps the same external link, title, and excerpt. The excerpt
  // comes from the website card (its durable home); `rec.description` is the
  // fallback for legacy records that still carry it at the top level. `...rec`
  // preserves that legacy `description` as-is — we never add one to a new record.
  const excerpt = websiteCardExcerpt(rec.content) || rec.description || '';
  const trimmedNote = note.trim();
  const article = {
    url: rec.links?.find((l) => /^https?:\/\//i.test(l.uri))?.uri,
    title: rec.title,
  };
  // Re-resolve mentions on edit so added/removed @handles re-encode; recipients
  // pick up the change on their next Constellation poll. (Facets are a Leaflet
  // richtext feature; the other formats store the note as plain text.)
  const resolvedHandles =
    format === 'leaflet' ? await resolveNoteMentionHandles(trimmedNote) : new Map<string, string>();

  const updated: DocumentRecord = {
    ...rec,
    $type: DOCUMENT_COLLECTION,
    // Backfill the marker onto pre-marker shares while we're rewriting anyway.
    skyreaderLinkblog: LINKBLOG_MARKER_URL,
    textContent: [trimmedNote, excerpt].filter(Boolean).join('\n\n') || undefined,
    content:
      format === 'leaflet'
        ? replaceLeafletNoteRegion(rec.content, trimmedNote, resolvedHandles)
        : format === 'markpub'
          ? replaceMarkpubNote(rec.content, trimmedNote, article)
          : replaceItemsNoteRegion(rec.content, format, trimmedNote, article),
  };

  return pdsClient.putRecord(DOCUMENT_COLLECTION, rkey, updated);
}
