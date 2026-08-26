/**
 * Standard.site (AT Protocol) document fetching + resolution.
 *
 * Ported from the backend's canonical-url.ts so the proxy can fetch
 * `site.standard.document` records directly from a publisher's PDS, resolve their
 * canonical URLs / publication metadata, and return them in the frontend's
 * `SocialDocument` shape. Publication base-URL/name/icon are cached in SQLite
 * (mirroring the old D1 `publications_cache`).
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { resolvePdsUrl, resolveHandle } from './did-resolver';
import { safeFetch } from './ssrf-guard';

// Publication records (base URL + icon) change rarely; cache for a day.
const PUBLICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// A failed resolution (no base URL — transient PDS/getRecord blip, or a publication
// that doesn't exist yet) is only cached briefly. Without this a single blip would
// pin every document's canonicalUrl to a bare relative path for a full day.
const PUBLICATION_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
// How many documents (most recent) to keep per author. Bounds payload + work; a
// reader rarely scrolls deeper than this, and older docs are still reachable by
// raising this cap later.
export const MAX_DOCUMENTS_PER_AUTHOR = 100;
const MAX_LIST_PAGES = 5; // listRecords pages of 100 → up to 500 scanned
const FETCH_TIMEOUT_MS = 30 * 1000;
const DOCUMENT_ADVERTISEMENT_TIMEOUT_MS = 10 * 1000;
const DOCUMENT_ADVERTISEMENT_MAX_BYTES = 1024 * 1024;
// A Standard Reader "Collection" (a site.standard.document carrying a
// `readerCollection`) curates other documents by at:// URI. We resolve each to a
// title/canonical-URL preview, bounded so a hostile or runaway edition can't fan
// out into unbounded cross-PDS fetches.
const MAX_COLLECTION_ITEMS = 50;
// Curated items can each live on a different PDS, and several editions may resolve
// in one batch fetch — so resolve through a small worker pool rather than firing
// all MAX_COLLECTION_ITEMS at once.
const COLLECTION_RESOLVE_CONCURRENCY = 8;

/**
 * A resolved document in the exact shape the frontend's `SocialDocument`
 * consumes (minus the client-only `id`). Dates are ISO strings, `coverImageCid`
 * is the raw blob CID (the client builds the CDN URL with the authorDid), and
 * `content` is the structured record object passed through untouched.
 */
export interface ProxyDocument {
  authorDid: string;
  recordUri: string;
  recordCid: string;
  siteUri: string;
  title: string;
  publishedAt: string;
  path?: string;
  description?: string;
  coverImageCid?: string;
  textContent?: string;
  bskyPostUri?: string;
  tags?: string[];
  updatedAt?: string;
  canonicalUrl?: string;
  content?: unknown;
  indexedAt?: string;
  createdAt: string;
  siteIcon?: string;
  // External resource refs (RFC-8288-style). A linkblog "link post" carries the
  // shared article's https URL here; the frontend renders it as a link post.
  links?: Array<{ uri: string; rel?: string }>;
  // Standard Reader "Collection": a curated magazine edition. Each item points to
  // another document; we resolve them to previews (see `ProxyReaderCollection`).
  readerCollection?: ProxyReaderCollection;
  // Passed through verbatim from the record (see DocumentRecord). Clients use it
  // to decide whether a document is theirs to edit or delete.
  skyreaderLinkblog?: string;
}

/**
 * A Markpub markdown body as it lives on a record. The lexicons accept either a
 * structured `at.markpub.markdown` object or a legacy plain string "on read
 * during migration", so we tolerate both. `markpubToMarkdown` flattens it.
 */
export type MarkpubBody = string | { text?: { markdown?: string } } | undefined;

/**
 * Raw `app.standard-reader.collection` record (the curated-edition sidecar). It
 * shares its rkey with the `site.standard.document` named by `document`, and the
 * edition title comes from that document (the collection itself carries none).
 */
export interface CollectionRecord {
  document?: string;
  editorial?: { title?: string; body?: MarkpubBody };
  colophon?: { body?: MarkpubBody };
  items?: Array<{ document?: string; note?: MarkpubBody }>;
  createdAt?: string;
  updatedAt?: string;
}

/** Flatten a Markpub body (structured object or legacy string) to markdown text. */
export function markpubToMarkdown(body: MarkpubBody): string | undefined {
  if (!body) return undefined;
  if (typeof body === 'string') return body || undefined;
  return body.text?.markdown || undefined;
}

/** Google Font family names for a collections publication's typography. */
export interface PublicationFonts {
  title?: string;
  body?: string;
}

/** A publication's `basicTheme` palette — accent/background/foreground colors as
 *  raw RGB triples, used to paint the magazine view of a curated Collection. */
export interface BasicTheme {
  accent?: { r: number; g: number; b: number };
  background?: { r: number; g: number; b: number };
  foreground?: { r: number; g: number; b: number };
  accentForeground?: { r: number; g: number; b: number };
}

/** A curated item resolved to a preview the frontend can render without a second
 *  round-trip: the curator's `note` plus the referenced document's metadata. */
export interface ProxyReaderCollectionItem {
  /** The referenced document's at:// URI (or raw https URL for loose links). */
  document: string;
  /** The curator's blurb for this piece (markdown). */
  note?: string;
  /** Author DID of the referenced document, when it's an at:// URI. */
  authorDid?: string;
  title?: string;
  description?: string;
  canonicalUrl?: string;
  siteIcon?: string;
  /** The referenced document's publication name (e.g. "Alex's Blog"), shown as
   *  the source label in the magazine TOC. Falls back to hostname in the UI. */
  sourceName?: string;
  publishedAt?: string;
}

/** Resolved curated edition: editorial/colophon markdown + resolved items.
 *  `publicationName`/`theme`/`fonts`/`authorHandle` describe the edition's own
 *  publication, used to render the optional themed magazine masthead. */
export interface ProxyReaderCollection {
  editorial?: { title?: string; body?: string };
  colophon?: { body?: string };
  items: ProxyReaderCollectionItem[];
  publicationName?: string;
  theme?: BasicTheme;
  fonts?: PublicationFonts;
  authorHandle?: string;
}

interface BlobRef {
  ref?: { $link?: string };
  mimeType?: string;
}

export interface DocumentRecord {
  $type?: string;
  site?: string;
  title?: string;
  publishedAt?: string;
  path?: string;
  description?: string;
  coverImage?: BlobRef;
  textContent?: string;
  bskyPostRef?: { uri?: string; cid?: string };
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  content?: unknown;
  links?: Array<{ uri?: string; rel?: string }>;
  // Skyreader's provenance marker on a link post it wrote (a constant URL, the
  // same one its publications carry). A linkblog connected to an existing
  // publication shares that publication with the posts its home app writes, so
  // this is the only thing separating "a share" from "an essay that links out".
  skyreaderLinkblog?: string;
}

interface PublicationRecord {
  $type?: string;
  url?: string;
  name?: string;
  description?: string;
  icon?: BlobRef;
  basicTheme?: BasicTheme;
}

interface ListRecordsResponse {
  records?: Array<{ uri: string; cid: string; value: DocumentRecord }>;
  cursor?: string;
}

interface ParsedAtUri {
  did: string;
  collection: string;
  rkey: string;
}

interface PublicationCacheRow {
  publication_uri: string;
  base_url: string | null;
  icon: string | null;
  name: string | null;
  theme: string | null;
  fonts: string | null;
  cached_at: number;
}

/** A publication's typography record, paired to it by rkey. */
interface PublicationThemeRecord {
  $type?: string;
  publication?: string;
  fonts?: PublicationFonts;
}

// AT Protocol DID syntax (https://atproto.com/specs/did). Deliberately the same
// shape the upstream Go implementation enforces, because a value that only looks
// like a DID ("did:" + anything) is accepted by our request path but *rejected*
// by Jetstream — and Jetstream rejects the whole `options_update`, closing the
// socket, so one bad row in the cache can take the firehose down entirely.
const DID_RE = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
const MAX_DID_LENGTH = 2048;

/** True if `did` is a syntactically valid AT Protocol DID. */
export function isValidDid(did: unknown): did is string {
  return typeof did === 'string' && did.length <= MAX_DID_LENGTH && DID_RE.test(did);
}

/** Parse `at://did/collection/rkey` into its components, or null if malformed. */
export function parseAtUri(uri: string): ParsedAtUri | null {
  if (!uri.startsWith('at://')) return null;
  const parts = uri.slice(5).split('/');
  if (parts.length < 3) return null;
  const did = parts[0];
  if (!did.startsWith('did:')) return null;
  return { did, collection: parts[1], rkey: parts.slice(2).join('/') };
}

/** Bluesky CDN URL for a publication icon / image blob. */
function resolveBlobUrl(did: string, blob: BlobRef | undefined): string | null {
  if (!blob?.ref?.$link) return null;
  return `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${blob.ref.$link}@jpeg`;
}

/** Combine a publication base URL with a document path, normalizing slashes. */
export function buildCanonicalUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path || '';
  if (!path) return baseUrl;
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Verify that an article origin advertises a caller-supplied standard.site
 * document URI. The document record's site/path fields are author-controlled,
 * so they cannot establish this binding: the public article itself must name
 * the exact record in a <link> tag, matching standard.site discovery.
 */
export async function articleAdvertisesDocument(
  articleUrl: string,
  documentUri: string
): Promise<boolean> {
  const parsed = parseAtUri(documentUri);
  if (!parsed || parsed.collection !== 'site.standard.document') return false;

  try {
    const response = await safeFetch(articleUrl, {
      headers: {
        'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(DOCUMENT_ADVERTISEMENT_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return false;
    }

    const contentLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength > DOCUMENT_ADVERTISEMENT_MAX_BYTES) {
      await response.body?.cancel().catch(() => {});
      return false;
    }

    const reader = response.body?.getReader();
    if (!reader) return false;
    const decoder = new TextDecoder();
    let total = 0;
    let html = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DOCUMENT_ADVERTISEMENT_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return false;
      }
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();

    for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
      const href = match[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      if (href === documentUri) return true;
    }
  } catch (error) {
    console.error('[standard-site] document advertisement verification error:', error);
  }
  return false;
}

async function fetchRecord<T>(
  pdsUrl: string,
  did: string,
  collection: string,
  rkey: string
): Promise<T | null> {
  try {
    const params = new URLSearchParams({ repo: did, collection, rkey });
    const res = await safeFetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { value?: T };
    return data.value ?? null;
  } catch (error) {
    console.error('[standard-site] getRecord error:', error);
    return null;
  }
}

/**
 * Resolve a publication's base URL + icon from its `at://...publication/rkey`
 * URI, caching the result in SQLite. Returns nulls for non-`at://` sites (loose
 * https:// documents) — those have no publication record to resolve.
 */
export interface SiteMeta {
  baseUrl: string | null;
  icon: string | null;
  name: string | null;
  theme: BasicTheme | null;
  fonts: PublicationFonts | null;
}

export async function resolveSiteMeta(db: Database, siteUri: string): Promise<SiteMeta> {
  const empty: SiteMeta = { baseUrl: null, icon: null, name: null, theme: null, fonts: null };
  if (!siteUri) return empty;

  // Loose https:// sites are already their own base URL, no record to fetch.
  if (siteUri.startsWith('http://') || siteUri.startsWith('https://')) {
    return { ...empty, baseUrl: siteUri };
  }

  const parsed = parseAtUri(siteUri);
  if (!parsed || parsed.collection !== 'site.standard.publication') {
    return empty;
  }

  const now = Date.now();
  const cached = db
    .query<PublicationCacheRow, [string]>(
      'SELECT publication_uri, base_url, icon, name, theme, fonts, cached_at FROM publication_cache WHERE publication_uri = ?'
    )
    .get(siteUri);
  if (cached) {
    const ttl = cached.base_url ? PUBLICATION_CACHE_TTL_MS : PUBLICATION_NEGATIVE_CACHE_TTL_MS;
    if (now - cached.cached_at < ttl) {
      return {
        baseUrl: cached.base_url,
        icon: cached.icon,
        name: cached.name,
        theme: parseJsonColumn<BasicTheme>(cached.theme),
        fonts: parseJsonColumn<PublicationFonts>(cached.fonts),
      };
    }
  }

  const pdsUrl = await resolvePdsUrl(db, parsed.did);
  let baseUrl: string | null = null;
  let icon: string | null = null;
  let name: string | null = null;
  let theme: BasicTheme | null = null;
  let fonts: PublicationFonts | null = null;
  if (pdsUrl) {
    const record = await fetchRecord<PublicationRecord>(
      pdsUrl,
      parsed.did,
      parsed.collection,
      parsed.rkey
    );
    baseUrl = record?.url || null;
    icon = resolveBlobUrl(parsed.did, record?.icon);
    name = record?.name || null;
    theme = record?.basicTheme ?? null;
    // Typography lives on a sidecar `publicationTheme` record paired by rkey.
    // Best-effort: a missing record just means the magazine uses default fonts.
    const themeRecord = await fetchRecord<PublicationThemeRecord>(
      pdsUrl,
      parsed.did,
      'app.standard-reader.publicationTheme',
      parsed.rkey
    );
    const f = themeRecord?.fonts;
    if (f && (f.title || f.body))
      fonts = { title: f.title || undefined, body: f.body || undefined };
  }

  db.run(
    `INSERT INTO publication_cache (publication_uri, base_url, icon, name, theme, fonts, cached_at) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(publication_uri) DO UPDATE SET base_url = excluded.base_url, icon = excluded.icon, name = excluded.name, theme = excluded.theme, fonts = excluded.fonts, cached_at = excluded.cached_at`,
    [
      siteUri,
      baseUrl,
      icon,
      name,
      theme ? JSON.stringify(theme) : null,
      fonts ? JSON.stringify(fonts) : null,
      now,
    ]
  );

  return { baseUrl, icon, name, theme, fonts };
}

/** Parse a cached JSON column, tolerating null / malformed rows (a bad row
 *  degrades to null rather than throwing). */
function parseJsonColumn<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toISO(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const ms = new Date(value).getTime();
  return isNaN(ms) ? fallback : new Date(ms).toISOString();
}

/**
 * Resolve one curated collection item (an at:// document URI + the curator's
 * note) into a preview. Best-effort: a malformed URI, unresolvable PDS, or
 * missing record degrades to a note-only stub (the frontend still shows the note
 * and the raw link) rather than failing the whole collection.
 */
async function resolveCollectionItem(
  db: Database,
  item: { document?: string; note?: MarkpubBody }
): Promise<ProxyReaderCollectionItem | null> {
  const uri = item.document;
  if (!uri) return null;

  const note = markpubToMarkdown(item.note);

  // Loose https:// references (rare): keep as a bare link, nothing to resolve.
  if (uri.startsWith('http://') || uri.startsWith('https://')) {
    return { document: uri, note, canonicalUrl: uri };
  }

  const parsed = parseAtUri(uri);
  if (!parsed) return { document: uri, note };

  const stub: ProxyReaderCollectionItem = { document: uri, note, authorDid: parsed.did };

  try {
    const pdsUrl = await resolvePdsUrl(db, parsed.did);
    if (!pdsUrl) return stub;
    const doc = await fetchRecord<DocumentRecord>(
      pdsUrl,
      parsed.did,
      parsed.collection,
      parsed.rkey
    );
    if (!doc) return stub;

    const meta = await resolveSiteMeta(db, doc.site || '');
    const canonicalUrl = meta.baseUrl ? buildCanonicalUrl(meta.baseUrl, doc.path || '') : undefined;

    return {
      ...stub,
      title: doc.title || undefined,
      description: doc.description || undefined,
      canonicalUrl: canonicalUrl || undefined,
      siteIcon: meta.icon || undefined,
      sourceName: meta.name || undefined,
      publishedAt: doc.publishedAt || undefined,
    };
  } catch (error) {
    console.error('[standard-site] collection item resolve error:', error);
    return stub;
  }
}

/**
 * Resolve an `app.standard-reader.collection` record into renderable previews.
 * Items are capped at `MAX_COLLECTION_ITEMS` and resolved through a
 * `COLLECTION_RESOLVE_CONCURRENCY` worker pool (curated order preserved); each
 * resolution is independently fault-tolerant. Returns null when there are no
 * resolvable items. `editorial`/`colophon`/`note` bodies are Markpub (structured
 * object or legacy string) and are flattened to markdown here.
 */
async function resolveReaderCollection(
  db: Database,
  raw: CollectionRecord,
  edition: {
    publicationName?: string;
    theme?: BasicTheme;
    fonts?: PublicationFonts;
    authorHandle?: string;
  } = {}
): Promise<ProxyReaderCollection | null> {
  const rawItems = Array.isArray(raw.items) ? raw.items.slice(0, MAX_COLLECTION_ITEMS) : [];

  // Drain a shared cursor through a bounded pool, writing each result back by
  // index so the curated order survives out-of-order completion.
  const slots: Array<ProxyReaderCollectionItem | null> = new Array(rawItems.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < rawItems.length; i = next++) {
      slots[i] = await resolveCollectionItem(db, rawItems[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(COLLECTION_RESOLVE_CONCURRENCY, rawItems.length) }, worker)
  );
  const resolved = slots.filter((i): i is ProxyReaderCollectionItem => i !== null);

  // No resolvable items → not a renderable edition. Returning null lets the
  // caller drop `readerCollection` entirely, so the frontend falls through to the
  // ordinary document body instead of rendering an empty edition.
  if (resolved.length === 0) return null;

  const editorialBody = markpubToMarkdown(raw.editorial?.body);
  const editorialTitle = raw.editorial?.title || undefined;
  const colophonBody = markpubToMarkdown(raw.colophon?.body);

  return {
    editorial:
      editorialBody || editorialTitle ? { title: editorialTitle, body: editorialBody } : undefined,
    colophon: colophonBody ? { body: colophonBody } : undefined,
    items: resolved,
    publicationName: edition.publicationName || undefined,
    theme: edition.theme || undefined,
    fonts: edition.fonts || undefined,
    authorHandle: edition.authorHandle || undefined,
  };
}

/**
 * Map a single raw `site.standard.document` record into a `ProxyDocument`,
 * resolving its publication's base URL + icon (SQLite-cached via
 * `resolveSiteMeta`). Shared by the backfill list path
 * (`fetchDocumentsForAuthor`) and the Jetstream firehose splice path so both
 * produce byte-identical document shapes.
 */
export async function recordToProxyDocument(
  db: Database,
  authorDid: string,
  recordUri: string,
  recordCid: string,
  doc: DocumentRecord,
  // The paired `app.standard-reader.collection` sidecar (same rkey), when this
  // document is a curated magazine edition. Supplied by the list/backfill path;
  // the Jetstream splice path omits it (firehose collection enrichment is a
  // follow-up), so a spliced edition simply renders without the magazine toggle
  // until the next full refresh.
  collection?: CollectionRecord | null
): Promise<ProxyDocument> {
  const fetchedAtISO = new Date().toISOString();
  const siteUri = doc.site || '';
  const meta = await resolveSiteMeta(db, siteUri);

  const canonicalUrl = meta.baseUrl
    ? buildCanonicalUrl(meta.baseUrl, doc.path || '')
    : doc.path || '';

  // Surface external resource refs (the shared article URL for link posts),
  // keeping only entries with a real uri.
  const links = Array.isArray(doc.links)
    ? doc.links
        .filter((l): l is { uri: string; rel?: string } => typeof l?.uri === 'string' && !!l.uri)
        .map((l) => ({ uri: l.uri, ...(l.rel ? { rel: l.rel } : {}) }))
    : [];

  // Resolve the paired curated edition (if any) to renderable item previews. The
  // edition's own publication name + theme (colors) + fonts + author handle drive
  // the optional magazine view; the handle is best-effort (cached DID resolution)
  // and degrades to absent.
  const readerCollection = collection
    ? await resolveReaderCollection(db, collection, {
        publicationName: meta.name || undefined,
        theme: meta.theme || undefined,
        fonts: meta.fonts || undefined,
        authorHandle: (await resolveHandle(db, authorDid)) || undefined,
      })
    : null;

  return {
    authorDid,
    recordUri,
    recordCid,
    siteUri,
    title: doc.title || '',
    publishedAt: toISO(doc.publishedAt, fetchedAtISO),
    path: doc.path || undefined,
    description: doc.description || undefined,
    coverImageCid: doc.coverImage?.ref?.$link || undefined,
    textContent: doc.textContent || undefined,
    bskyPostUri: doc.bskyPostRef?.uri || undefined,
    tags: doc.tags && doc.tags.length > 0 ? doc.tags : undefined,
    updatedAt: doc.updatedAt ? toISO(doc.updatedAt, fetchedAtISO) : undefined,
    canonicalUrl: canonicalUrl || undefined,
    content: doc.content ?? undefined,
    indexedAt: fetchedAtISO,
    createdAt: toISO(doc.createdAt, toISO(doc.publishedAt, fetchedAtISO)),
    siteIcon: meta.icon || undefined,
    links: links.length > 0 ? links : undefined,
    readerCollection: readerCollection || undefined,
    skyreaderLinkblog:
      typeof doc.skyreaderLinkblog === 'string' ? doc.skyreaderLinkblog : undefined,
  };
}

/**
 * Fetch and resolve a single `site.standard.document` by its at:// URI. Used for
 * on-demand reads — e.g. opening a curated piece from a Collection that the user
 * doesn't subscribe to, so it never appears in any author's cached list. Returns
 * null for a malformed URI, unresolvable PDS, or missing record. Not cached: a
 * click is a one-shot read, and `recordToProxyDocument` still reuses the
 * SQLite-cached publication meta.
 */
export async function fetchSingleDocument(
  db: Database,
  uri: string
): Promise<ProxyDocument | null> {
  const parsed = parseAtUri(uri);
  if (!parsed || parsed.collection !== 'site.standard.document') return null;

  const pdsUrl = await resolvePdsUrl(db, parsed.did);
  if (!pdsUrl) return null;

  try {
    const params = new URLSearchParams({
      repo: parsed.did,
      collection: parsed.collection,
      rkey: parsed.rkey,
    });
    const res = await safeFetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { uri?: string; cid?: string; value?: DocumentRecord };
    if (!data.value) return null;
    return recordToProxyDocument(db, parsed.did, data.uri || uri, data.cid || '', data.value);
  } catch (error) {
    console.error('[standard-site] fetchSingleDocument error:', error);
    return null;
  }
}

/**
 * List an author's `app.standard-reader.collection` sidecars, keyed by rkey. A
 * collection shares its rkey with the `site.standard.document` it renders, so the
 * map lets the document loop pair each doc with its edition in O(1) without a
 * getRecord per document. Best-effort: a fetch failure yields an empty map (no
 * magazine enrichment) rather than failing the whole document refresh. Collections
 * are few, so a single listRecords page suffices.
 */
async function fetchCollectionsForAuthor(
  pdsUrl: string,
  authorDid: string
): Promise<Map<string, CollectionRecord>> {
  const byRkey = new Map<string, CollectionRecord>();
  try {
    const params = new URLSearchParams({
      repo: authorDid,
      collection: 'app.standard-reader.collection',
      limit: '100',
    });
    const res = await safeFetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return byRkey;
    const data = (await res.json()) as {
      records?: Array<{ uri: string; value: CollectionRecord }>;
    };
    for (const record of data.records ?? []) {
      const parsed = parseAtUri(record.uri);
      if (parsed) byRkey.set(parsed.rkey, record.value);
    }
  } catch (error) {
    console.error('[standard-site] listCollections error:', error);
  }
  return byRkey;
}

/**
 * Fetch a publisher's recent `site.standard.document` records and map them to
 * `ProxyDocument`s (canonical URL + icon resolved). Returns the full unfiltered
 * list (newest first) so a single cached entry per author serves subscribers of
 * any of that author's publications; the publication filter is applied at
 * response time. Throws on PDS resolution / fetch failure so the caller records
 * an error + backoff.
 */
export async function fetchDocumentsForAuthor(
  db: Database,
  authorDid: string
): Promise<ProxyDocument[]> {
  const pdsUrl = await resolvePdsUrl(db, authorDid);
  if (!pdsUrl) {
    throw new Error(`Could not resolve PDS for ${authorDid}`);
  }

  const raw: Array<{ uri: string; cid: string; value: DocumentRecord }> = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES && raw.length < MAX_DOCUMENTS_PER_AUTHOR; page++) {
    const params = new URLSearchParams({
      repo: authorDid,
      collection: 'site.standard.document',
      limit: '100',
    });
    if (cursor) params.set('cursor', cursor);

    const res = await safeFetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`listRecords failed for ${authorDid}: HTTP ${res.status}`);
    }
    const data = (await res.json()) as ListRecordsResponse;
    const records = data.records ?? [];
    raw.push(...records);
    if (!data.cursor || records.length === 0) break;
    cursor = data.cursor;
  }

  // Pair each document with its curated edition (if any), matched by shared rkey.
  // One listRecords for the whole author, vs a getRecord per document.
  const collectionsByRkey = await fetchCollectionsForAuthor(pdsUrl, authorDid);

  // Map each record to a resolved ProxyDocument. resolveSiteMeta (inside
  // recordToProxyDocument) is SQLite-cached, so repeated publications in the
  // batch are cheap point-reads after the first.
  const documents: ProxyDocument[] = [];
  for (const record of raw.slice(0, MAX_DOCUMENTS_PER_AUTHOR)) {
    const rkey = parseAtUri(record.uri)?.rkey;
    const collection = rkey ? collectionsByRkey.get(rkey) : undefined;
    documents.push(
      await recordToProxyDocument(db, authorDid, record.uri, record.cid, record.value, collection)
    );
  }

  // Newest first, matching the feed/timeline ordering.
  documents.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return documents;
}

/**
 * Apply a subscription's publication scope to an author's document list:
 * - empty/undefined → all documents
 * - `at://...` → only documents whose `site` matches that publication
 */
export function filterByPublication(documents: ProxyDocument[], siteUri?: string): ProxyDocument[] {
  if (!siteUri) return documents;
  return documents.filter((d) => d.siteUri === siteUri);
}

/**
 * Content digest for one publication scope: a cheap stable hash over the scoped
 * blob's sorted `(recordUri, recordCid)` pairs. `recordCid` changes on every edit
 * and `recordUri` identifies the doc, so this single value captures every new,
 * edited, and deleted document in the scope:
 *
 * - a NEW doc adds a pair → digest changes;
 * - an EDITED doc changes a recordCid → digest changes;
 * - a DELETED / cap-evicted doc removes a pair → digest changes;
 * - an UNCHANGED scope → identical sorted pairs → identical digest.
 *
 * The cid lives entirely server-side here; the client only ever stores the opaque
 * digest string. The load-bearing property is that the cid is *identical for
 * byte-identical content across a refetch* (CIDs are content-addressed over
 * deterministic DAG-CBOR), so a no-op refresh yields the same digest — otherwise
 * every poll would be a miss and the payload win would silently evaporate.
 */
export function digestScope(documents: ProxyDocument[]): string {
  const pairs = documents.map((d) => `${d.recordUri}\t${d.recordCid}`).sort();
  return createHash('sha256').update(pairs.join('\n')).digest('hex');
}

/**
 * Trim a (newest-first) document list to those newer than what the client
 * already has, mirroring the feed `since_guids` mechanism: stop at the first
 * document whose recordUri the client reports as already seen.
 *
 * Note: the current frontend deliberately sends no `since_uris` (it fetches the
 * full list each cycle so upstream edits/deletes self-heal), so this is a no-op
 * in practice today. Retained for API completeness / future incremental clients.
 */
export function filterSinceUris(
  documents: ProxyDocument[],
  sinceUris: Set<string>
): ProxyDocument[] {
  if (sinceUris.size === 0) return documents;
  for (let i = 0; i < documents.length; i++) {
    if (sinceUris.has(documents[i].recordUri)) {
      return documents.slice(0, i);
    }
  }
  return documents;
}
