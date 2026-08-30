/**
 * standard.site record handling, ported from the feed proxy
 * (`feed-proxy/src/standard-site.ts`) so documents can live in D1 instead of the
 * proxy's SQLite blob cache.
 *
 * What changed in the port, and nothing else did:
 * - `bun:sqlite` → D1 (`publications_cache_v2` for publication metadata).
 * - Bun's `safeFetch` → plain `fetch`. The SSRF guard has no job in a Worker: it
 *   cannot reach private networks. The **DID validation does** — `isValidDid`
 *   guards the Jetstream `options_update` frame (see the poller), where one
 *   malformed entry closes the socket.
 * - `node:crypto` → `crypto.subtle`, which makes `digestScope` async. The bytes
 *   hashed are identical, so a scope's digest is the same string the proxy
 *   produced (test/standard-site.spec.ts pins it).
 */

import type { Env } from '../types';
import type {
  BasicTheme,
  ProxyDocument,
  ProxyReaderCollection,
  ProxyReaderCollectionItem,
  PublicationFonts,
} from './feed-proxy-client';
import { parseAtUri } from '../utils/canonical-url';
import { resolvePdsUrl } from '../utils/did-resolver';

// Publication records (base URL + icon) change rarely; cache for a day.
export const PUBLICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// A failed resolution (no base URL — transient PDS/getRecord blip, or a publication
// that doesn't exist yet) is only cached briefly. Without this a single blip would
// pin every document's canonicalUrl to a bare relative path for a full day.
export const PUBLICATION_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
// How many documents (most recent) to keep per author. Bounds payload, storage and
// work; matches what the proxy blob enforced, so it changes nothing observable.
export const MAX_DOCUMENTS_PER_AUTHOR = 100;
/**
 * listRecords pages of 100 → up to 500 scanned. Exported because a backfill's
 * subrequest budget counts these pages: they come out of the same per-invocation
 * ceiling as its D1 writes.
 */
export const MAX_LIST_PAGES = 5;
const FETCH_TIMEOUT_MS = 15 * 1000;
// A Standard Reader "Collection" curates other documents by at:// URI. Resolving
// each to a preview is a cross-PDS fetch, so bound the fan-out.
export const MAX_COLLECTION_ITEMS = 50;
const COLLECTION_RESOLVE_CONCURRENCY = 8;

export const DOCUMENT_COLLECTION = 'site.standard.document';
export const READER_COLLECTION = 'app.standard-reader.collection';

// AT Protocol DID syntax (https://atproto.com/specs/did). Deliberately the same
// shape the upstream Go implementation enforces, because a value that only looks
// like a DID ("did:" + anything) is accepted by our request path but *rejected* by
// Jetstream — and Jetstream rejects the whole `options_update`, closing the socket,
// so one bad row in D1 could take the document stream down entirely.
const DID_RE = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
const MAX_DID_LENGTH = 2048;

/** True if `did` is a syntactically valid AT Protocol DID. */
export function isValidDid(did: unknown): did is string {
  return typeof did === 'string' && did.length <= MAX_DID_LENGTH && DID_RE.test(did);
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
  // Skyreader's provenance marker on a link post it wrote.
  skyreaderLinkblog?: string;
}

/**
 * A Markpub markdown body as it lives on a record. The lexicons accept either a
 * structured `at.markpub.markdown` object or a legacy plain string, so we tolerate
 * both; `markpubToMarkdown` flattens it.
 */
export type MarkpubBody = string | { text?: { markdown?: string } } | undefined;

/** Raw `app.standard-reader.collection` record (the curated-edition sidecar). */
export interface CollectionRecord {
  document?: string;
  editorial?: { title?: string; body?: MarkpubBody };
  colophon?: { body?: MarkpubBody };
  items?: Array<{ document?: string; note?: MarkpubBody }>;
  createdAt?: string;
  updatedAt?: string;
}

interface PublicationRecord {
  $type?: string;
  url?: string;
  name?: string;
  description?: string;
  icon?: BlobRef;
  basicTheme?: BasicTheme;
}

/** A publication's typography record, paired to it by rkey. */
interface PublicationThemeRecord {
  $type?: string;
  publication?: string;
  fonts?: PublicationFonts;
}

/** Flatten a Markpub body (structured object or legacy string) to markdown text. */
export function markpubToMarkdown(body: MarkpubBody): string | undefined {
  if (!body) return undefined;
  if (typeof body === 'string') return body || undefined;
  return body.text?.markdown || undefined;
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

export interface SiteMeta {
  baseUrl: string | null;
  icon: string | null;
  name: string | null;
  theme: BasicTheme | null;
  fonts: PublicationFonts | null;
}

export const EMPTY_SITE_META: SiteMeta = {
  baseUrl: null,
  icon: null,
  name: null,
  theme: null,
  fonts: null,
};

interface PublicationCacheRow {
  publication_uri: string;
  base_url: string | null;
  icon: string | null;
  name: string | null;
  theme: string | null;
  fonts: string | null;
  cached_at: number;
}

/** Parse a cached JSON column, tolerating null / malformed rows. */
function parseJsonColumn<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rowToMeta(row: PublicationCacheRow): SiteMeta {
  return {
    baseUrl: row.base_url,
    icon: row.icon,
    name: row.name,
    theme: parseJsonColumn<BasicTheme>(row.theme),
    fonts: parseJsonColumn<PublicationFonts>(row.fonts),
  };
}

async function fetchRecord<T>(
  pdsUrl: string,
  did: string,
  collection: string,
  rkey: string
): Promise<T | null> {
  try {
    const params = new URLSearchParams({ repo: did, collection, rkey });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`, {
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
 * Read a publication's cached metadata, or null when there is no fresh row.
 * Separate from `resolveSiteMeta` because the serve path wants "what do we already
 * know?" without ever blocking on a PDS: a stale row still renders a document.
 */
export async function cachedSiteMeta(
  env: Env,
  siteUri: string,
  { allowStale = false }: { allowStale?: boolean } = {}
): Promise<SiteMeta | null> {
  if (!siteUri) return null;
  if (siteUri.startsWith('http://') || siteUri.startsWith('https://')) {
    return { ...EMPTY_SITE_META, baseUrl: siteUri };
  }
  const row = await env.DB.prepare(
    `SELECT publication_uri, base_url, icon, name, theme, fonts, cached_at
       FROM publications_cache_v2 WHERE publication_uri = ?`
  )
    .bind(siteUri)
    .first<PublicationCacheRow>();
  if (!row) return null;
  if (allowStale) return rowToMeta(row);
  const ttl = row.base_url ? PUBLICATION_CACHE_TTL_MS : PUBLICATION_NEGATIVE_CACHE_TTL_MS;
  return Date.now() - row.cached_at < ttl ? rowToMeta(row) : null;
}

/**
 * Resolve a publication's base URL / icon / name / theme / fonts from its
 * `at://…/site.standard.publication/rkey` URI, caching the result in D1. Loose
 * `https://` sites are their own base URL and have no record to fetch.
 */
export async function resolveSiteMeta(env: Env, siteUri: string): Promise<SiteMeta> {
  if (!siteUri) return EMPTY_SITE_META;

  const fresh = await cachedSiteMeta(env, siteUri);
  if (fresh) return fresh;

  const parsed = parseAtUri(siteUri);
  if (!parsed || parsed.collection !== 'site.standard.publication') return EMPTY_SITE_META;

  const pdsUrl = await resolvePdsUrl(parsed.did);
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

  try {
    await env.DB.prepare(
      `INSERT INTO publications_cache_v2 (publication_uri, base_url, icon, name, theme, fonts, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(publication_uri) DO UPDATE SET
         base_url = excluded.base_url, icon = excluded.icon, name = excluded.name,
         theme = excluded.theme, fonts = excluded.fonts, cached_at = excluded.cached_at`
    )
      .bind(
        siteUri,
        baseUrl,
        icon,
        name,
        theme ? JSON.stringify(theme) : null,
        fonts ? JSON.stringify(fonts) : null,
        Date.now()
      )
      .run();
  } catch (error) {
    // A cache write failure costs a re-resolve, never a document.
    console.error('[standard-site] publication cache write failed:', error);
  }

  return { baseUrl, icon, name, theme, fonts };
}

function toISO(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const ms = new Date(value).getTime();
  return isNaN(ms) ? fallback : new Date(ms).toISOString();
}

/** ms-epoch `publishedAt` for a record, falling back to `fallbackMs`. */
export function publishedAtMs(doc: DocumentRecord, fallbackMs: number): number {
  const ms = doc.publishedAt ? new Date(doc.publishedAt).getTime() : NaN;
  return Number.isFinite(ms) ? ms : fallbackMs;
}

/**
 * Map a raw `site.standard.document` record into the wire shape the frontend
 * consumes, given already-resolved publication metadata. Pure: every network- or
 * D1-touching part (`resolveSiteMeta`, collection previews) is resolved by the
 * caller, which is what lets the serve path map a whole author from one query.
 *
 * `indexedAt` is the row's ingest time rather than "now" (the proxy had no such
 * stamp and used fetch time); the frontend uses it only for display ordering
 * fallbacks.
 *
 * `canonicalUrl` is re-derived from `meta` whenever the publication resolves, so a
 * repaired publication cache fixes served links without rewriting rows. When it
 * does not resolve — a `getRecord` blip puts a negative entry in the cache for five
 * minutes — `canonicalUrlFallback` (the absolute URL stored on the row at write
 * time) is used instead of degrading the link to a bare relative path.
 */
export function recordToDocument(
  authorDid: string,
  recordUri: string,
  recordCid: string,
  doc: DocumentRecord,
  meta: SiteMeta,
  options: {
    indexedAt?: string;
    readerCollection?: ProxyReaderCollection | null;
    canonicalUrlFallback?: string | null;
  } = {}
): ProxyDocument {
  const nowISO = new Date().toISOString();
  const siteUri = doc.site || '';
  const canonicalUrl = meta.baseUrl
    ? buildCanonicalUrl(meta.baseUrl, doc.path || '')
    : options.canonicalUrlFallback || doc.path || '';

  // Surface external resource refs (the shared article URL for link posts),
  // keeping only entries with a real uri.
  const links = Array.isArray(doc.links)
    ? doc.links
        .filter((l): l is { uri: string; rel?: string } => typeof l?.uri === 'string' && !!l.uri)
        .map((l) => ({ uri: l.uri, ...(l.rel ? { rel: l.rel } : {}) }))
    : [];

  return {
    authorDid,
    recordUri,
    recordCid,
    siteUri,
    title: doc.title || '',
    publishedAt: toISO(doc.publishedAt, nowISO),
    path: doc.path || undefined,
    description: doc.description || undefined,
    coverImageCid: doc.coverImage?.ref?.$link || undefined,
    textContent: doc.textContent || undefined,
    bskyPostUri: doc.bskyPostRef?.uri || undefined,
    tags: doc.tags && doc.tags.length > 0 ? doc.tags : undefined,
    updatedAt: doc.updatedAt ? toISO(doc.updatedAt, nowISO) : undefined,
    canonicalUrl: canonicalUrl || undefined,
    content: doc.content ?? undefined,
    indexedAt: options.indexedAt ?? nowISO,
    createdAt: toISO(doc.createdAt, toISO(doc.publishedAt, nowISO)),
    siteIcon: meta.icon || undefined,
    links: links.length > 0 ? links : undefined,
    readerCollection: options.readerCollection || undefined,
    skyreaderLinkblog:
      typeof doc.skyreaderLinkblog === 'string' ? doc.skyreaderLinkblog : undefined,
  } as ProxyDocument;
}

/**
 * Apply a subscription's publication scope to a document list:
 * - empty/undefined → all documents
 * - `at://…` → only documents whose `site` matches that publication
 */
export function filterByPublication(documents: ProxyDocument[], siteUri?: string): ProxyDocument[] {
  if (!siteUri) return documents;
  return documents.filter((d) => d.siteUri === siteUri);
}

/**
 * Content digest for one publication scope: a stable hash over the scope's sorted
 * `(recordUri, recordCid)` pairs — new, edited, deleted and cap-evicted documents
 * all move it; an unchanged scope reproduces it exactly (CIDs are content-addressed
 * over deterministic DAG-CBOR, so a re-read of identical content re-hashes the same).
 *
 * Byte-for-byte the proxy's algorithm, so the digests a client already holds keep
 * matching across the cutover. The client treats it as opaque either way.
 */
export async function digestScope(documents: ProxyDocument[]): Promise<string> {
  const pairs = documents.map((d) => `${d.recordUri}\t${d.recordCid}`).sort();
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pairs.join('\n')));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Trim a (newest-first) document list to those newer than what the client already
 * has, mirroring the feed `since_guids` mechanism. The current frontend sends no
 * `since_uris`; retained for API completeness.
 */
export function filterSinceUris(
  documents: ProxyDocument[],
  sinceUris: Set<string>
): ProxyDocument[] {
  if (sinceUris.size === 0) return documents;
  for (let i = 0; i < documents.length; i++) {
    if (sinceUris.has(documents[i].recordUri)) return documents.slice(0, i);
  }
  return documents;
}

// --- PDS reads (backfill + on-demand) ---------------------------------------

export interface ListedRecord<T> {
  uri: string;
  cid: string;
  value: T;
}

/**
 * List an author's recent `site.standard.document` records, newest-repo-order,
 * capped at `MAX_DOCUMENTS_PER_AUTHOR`. Throws on PDS resolution / fetch failure so
 * the caller records the error + backoff.
 */
export async function listAuthorDocuments(
  authorDid: string
): Promise<Array<ListedRecord<DocumentRecord>>> {
  const pdsUrl = await resolvePdsUrl(authorDid);
  if (!pdsUrl) throw new Error(`Could not resolve PDS for ${authorDid}`);

  const raw: Array<ListedRecord<DocumentRecord>> = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES && raw.length < MAX_DOCUMENTS_PER_AUTHOR; page++) {
    const params = new URLSearchParams({
      repo: authorDid,
      collection: DOCUMENT_COLLECTION,
      limit: '100',
    });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`listRecords failed for ${authorDid}: HTTP ${res.status}`);
    const data = (await res.json()) as {
      records?: Array<ListedRecord<DocumentRecord>>;
      cursor?: string;
    };
    const records = data.records ?? [];
    raw.push(...records);
    if (!data.cursor || records.length === 0) break;
    cursor = data.cursor;
  }

  return raw;
}

/** One page of collection sidecars, plus whether absence from it proves deletion. */
export interface AuthorCollectionListing {
  /**
   * True only when the listing succeeded *and* covered the whole collection. A
   * failed fetch and an author with no editions both produce an empty map, so a
   * caller that prunes stored rows against this listing has to be able to tell
   * them apart — otherwise one blip deletes every curated edition we hold.
   */
  exhaustive: boolean;
  byRkey: Map<string, CollectionRecord>;
}

/** listRecords page size; a full page means there may be more behind a cursor. */
const COLLECTION_PAGE_SIZE = 100;

/**
 * List an author's `app.standard-reader.collection` sidecars, keyed by rkey (a
 * collection shares its rkey with the document it renders). Best-effort: a fetch
 * failure yields an empty, non-exhaustive listing — no magazine enrichment, not a
 * failed backfill. Collections are few, so one page suffices.
 */
export async function listAuthorCollections(authorDid: string): Promise<AuthorCollectionListing> {
  const byRkey = new Map<string, CollectionRecord>();
  try {
    const pdsUrl = await resolvePdsUrl(authorDid);
    if (!pdsUrl) return { exhaustive: false, byRkey };
    const params = new URLSearchParams({
      repo: authorDid,
      collection: READER_COLLECTION,
      limit: String(COLLECTION_PAGE_SIZE),
    });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { exhaustive: false, byRkey };
    const data = (await res.json()) as {
      records?: Array<{ uri: string; value: CollectionRecord }>;
    };
    const records = data.records ?? [];
    for (const record of records) {
      const parsed = parseAtUri(record.uri);
      if (parsed) byRkey.set(parsed.rkey, record.value);
    }
    return { exhaustive: records.length < COLLECTION_PAGE_SIZE, byRkey };
  } catch (error) {
    console.error('[standard-site] listCollections error:', error);
    return { exhaustive: false, byRkey };
  }
}

/** Fetch one `site.standard.document` record from its author's PDS. */
export async function getDocumentRecord(
  uri: string
): Promise<{ uri: string; cid: string; value: DocumentRecord } | null> {
  const parsed = parseAtUri(uri);
  if (!parsed || parsed.collection !== DOCUMENT_COLLECTION) return null;
  const pdsUrl = await resolvePdsUrl(parsed.did);
  if (!pdsUrl) return null;
  try {
    const params = new URLSearchParams({
      repo: parsed.did,
      collection: parsed.collection,
      rkey: parsed.rkey,
    });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { uri?: string; cid?: string; value?: DocumentRecord };
    if (!data.value) return null;
    return { uri: data.uri || uri, cid: data.cid || '', value: data.value };
  } catch (error) {
    console.error('[standard-site] getDocumentRecord error:', error);
    return null;
  }
}

// --- Curated collections -----------------------------------------------------

/**
 * Resolve one curated item (an at:// document URI + the curator's note) into a
 * preview. Best-effort: a malformed URI, unresolvable PDS or missing record
 * degrades to a note-only stub rather than failing the whole edition.
 */
async function resolveCollectionItem(
  env: Env,
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
    const record = await getDocumentRecord(uri);
    if (!record) return stub;
    const doc = record.value;
    const meta = await resolveSiteMeta(env, doc.site || '');
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
 * Items are capped at `MAX_COLLECTION_ITEMS` and resolved through a bounded worker
 * pool (curated order preserved); each resolution is independently fault-tolerant.
 * Returns null when nothing resolves, so the caller drops `readerCollection`
 * entirely and the frontend falls through to the ordinary document body.
 */
export async function resolveReaderCollection(
  env: Env,
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
      slots[i] = await resolveCollectionItem(env, rawItems[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(COLLECTION_RESOLVE_CONCURRENCY, rawItems.length) }, worker)
  );
  const resolved = slots.filter((i): i is ProxyReaderCollectionItem => i !== null);
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
