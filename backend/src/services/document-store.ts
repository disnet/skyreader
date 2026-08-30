/**
 * The D1 store for standard.site documents.
 *
 * Documents used to live in the Fly proxy's SQLite as one JSON blob per author,
 * kept current by a persistent Bun WebSocket and served back through the Worker.
 * They now live here, one row per record: the JetstreamPoller DO writes
 * create/update/delete events straight in, `backfillAuthorDocuments` fills an
 * author's back catalogue over `listRecords` (the firehose never replays history),
 * and reads are plain D1 queries — no Fly on the read path.
 *
 * The wire shape the serve path produces is the proxy's, unchanged (see
 * `ProxyDocumentEntry`), so the frontend does not change across the cutover.
 */

import type { Env } from '../types';
import type { ProxyDocument, ProxyDocumentEntry, ProxyReaderCollection } from './feed-proxy-client';
import {
  DOCUMENT_COLLECTION,
  MAX_DOCUMENTS_PER_AUTHOR,
  READER_COLLECTION,
  type CollectionRecord,
  type DocumentRecord,
  type SiteMeta,
  EMPTY_SITE_META,
  buildCanonicalUrl,
  cachedSiteMeta,
  digestScope,
  getDocumentRecord,
  isValidDid,
  listAuthorCollections,
  listAuthorDocuments,
  publishedAtMs,
  recordToDocument,
  resolveReaderCollection,
  resolveSiteMeta,
} from './standard-site';
import { parseAtUri } from '../utils/canonical-url';
import { log } from '../utils/logger';

/** How long a resolved curated-edition preview is reused before re-resolving. */
const COLLECTION_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How many curated editions one request may resolve from scratch. Each edition
 * costs up to `MAX_COLLECTION_ITEMS` cross-PDS getRecords, so an unbounded fan-out
 * would let a batch of magazine subscriptions blow the subrequest budget. Editions
 * beyond the cap render without their item previews and resolve on a later read —
 * a cold edition costs one refresh to warm, not a failed batch.
 */
export const MAX_COLLECTION_RESOLVES_PER_REQUEST = 3;

/**
 * How long an author's stored set may go unverified before the reconcile loop
 * re-lists their repo. This is the self-heal the proxy got for free by
 * full-replacing its blob on every refresh: the firehose only carries writes made
 * while we were watching, so a gap (a reconnect, a cursor reset, an ingest pause)
 * leaves a hole nothing else fills.
 */
export const AUTHOR_RECONCILE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DocumentRow {
  record_uri: string;
  author_did: string;
  rkey: string;
  record_cid: string;
  site_uri: string;
  published_at: number;
  canonical_url: string | null;
  record_json: string;
  indexed_at: number;
}

interface CollectionRow {
  author_did: string;
  rkey: string;
  record_json: string;
  preview_json: string | null;
  preview_at: number | null;
}

interface AuthorRow {
  author_did: string;
  last_listed_at: number | null;
  complete: number;
  error_count: number;
  last_error: string | null;
}

function parseRecord<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// --- Write path --------------------------------------------------------------

/**
 * Upsert one `site.standard.document` record. Idempotent by `record_uri`, so a
 * replayed firehose event or a re-run backfill converges on the same row — which
 * is what makes Jetstream's at-least-once delivery safe here.
 *
 * Publication metadata is resolved (and D1-cached) at write time, so the serve
 * path never blocks on a PDS for a canonical URL.
 */
export async function upsertDocument(
  env: Env,
  authorDid: string,
  recordUri: string,
  recordCid: string,
  record: DocumentRecord,
  now = Date.now()
): Promise<void> {
  const parsed = parseAtUri(recordUri);
  if (!parsed) return;

  const siteUri = record.site || '';
  const meta = await resolveSiteMeta(env, siteUri);
  const canonicalUrl = meta.baseUrl
    ? buildCanonicalUrl(meta.baseUrl, record.path || '')
    : record.path || '';

  await env.DB.prepare(
    `INSERT INTO documents_v2
       (record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(record_uri) DO UPDATE SET
       record_cid = excluded.record_cid,
       site_uri = excluded.site_uri,
       published_at = excluded.published_at,
       canonical_url = excluded.canonical_url,
       record_json = excluded.record_json,
       updated_at = excluded.updated_at`
  )
    .bind(
      recordUri,
      authorDid,
      parsed.rkey,
      recordCid,
      siteUri,
      publishedAtMs(record, now),
      canonicalUrl || null,
      JSON.stringify(record),
      now,
      now
    )
    .run();
}

/**
 * Evict an author's oldest documents past the per-author cap. Ported from the
 * proxy's `MAX_DOCUMENTS_PER_AUTHOR` slice: storage and serve cost per author stay
 * bounded no matter how much that author publishes — which is the layer of spike
 * defence no DID filter can provide, because a *subscribed* author's flood passes
 * the filter by design.
 */
export async function trimAuthorDocuments(env: Env, authorDid: string): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM documents_v2
      WHERE record_uri IN (
        SELECT record_uri FROM documents_v2
         WHERE author_did = ?
         ORDER BY published_at DESC, record_uri DESC
         LIMIT -1 OFFSET ?
      )`
  )
    .bind(authorDid, MAX_DOCUMENTS_PER_AUTHOR)
    .run();
  return result.meta?.changes ?? 0;
}

export async function deleteDocument(env: Env, recordUri: string): Promise<void> {
  await env.DB.prepare('DELETE FROM documents_v2 WHERE record_uri = ?').bind(recordUri).run();
}

/**
 * Upsert a curated-edition sidecar. The stored preview is cleared on every write:
 * the item list may have changed, and a stale preview would render last week's
 * edition under this week's record.
 */
export async function upsertCollection(
  env: Env,
  authorDid: string,
  rkey: string,
  record: CollectionRecord,
  now = Date.now()
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO collections_v2 (author_did, rkey, record_json, preview_json, preview_at, indexed_at)
     VALUES (?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(author_did, rkey) DO UPDATE SET
       record_json = excluded.record_json,
       preview_json = NULL,
       preview_at = NULL,
       indexed_at = excluded.indexed_at`
  )
    .bind(authorDid, rkey, JSON.stringify(record), now)
    .run();
}

export async function deleteCollection(env: Env, authorDid: string, rkey: string): Promise<void> {
  await env.DB.prepare('DELETE FROM collections_v2 WHERE author_did = ? AND rkey = ?')
    .bind(authorDid, rkey)
    .run();
}

/** A Jetstream commit, narrowed to what the document streams care about. */
export interface DocumentCommitEvent {
  did: string;
  commit?: {
    operation: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    cid?: string;
    record?: unknown;
  };
}

/**
 * Apply one Jetstream commit to D1. Returns true when a write happened.
 *
 * `allowedDids` is the belt-and-braces re-check behind the server-side `wantedDids`
 * filter: the filter is applied by Jetstream at connect time, but there is a brief
 * unfiltered window when the DID set is large enough to be sent as an
 * `options_update` frame after `open` — and a server that ever changed the filter's
 * semantics (v2) would otherwise turn "more parse traffic" into "foreign rows".
 */
export async function applyDocumentEvent(
  env: Env,
  event: DocumentCommitEvent,
  allowedDids: Set<string>,
  now = Date.now()
): Promise<boolean> {
  const commit = event.commit;
  if (!commit) return false;
  if (!allowedDids.has(event.did)) return false;

  const { collection, operation, rkey } = commit;

  if (collection === READER_COLLECTION) {
    if (operation === 'delete') {
      await deleteCollection(env, event.did, rkey);
      return true;
    }
    if (!commit.record) return false;
    await upsertCollection(env, event.did, rkey, commit.record as CollectionRecord, now);
    return true;
  }

  if (collection !== DOCUMENT_COLLECTION) return false;

  const recordUri = `at://${event.did}/${DOCUMENT_COLLECTION}/${rkey}`;

  if (operation === 'delete') {
    await deleteDocument(env, recordUri);
    return true;
  }

  if (!commit.record) return false;
  await upsertDocument(
    env,
    event.did,
    recordUri,
    commit.cid || '',
    commit.record as DocumentRecord,
    now
  );
  await trimAuthorDocuments(env, event.did);
  await touchAuthor(env, { authorDid: event.did, lastEventAt: now });
  return true;
}

/** What one poll cycle did with an event. */
export type DrainOutcome = 'applied' | 'skipped' | 'error' | 'capped';

export interface DocumentDrain {
  handle(event: DocumentCommitEvent & { time_us?: number }): Promise<DrainOutcome>;
  /** Events actually written this cycle. */
  readonly applied: number;
  readonly errors: number;
  /** The cycle stopped on the apply cap. */
  readonly capped: boolean;
  /** Cursor to persist: the last event this cycle finished handling, never past it. */
  readonly cursor: string;
}

/**
 * One poll cycle's bounded, resumable drain.
 *
 * The cap is the spike guard that no DID filter can provide, because the dangerous
 * case is an author we *subscribe to* dumping thousands of documents — the filter
 * passes all of it by design. So a cycle applies at most `cap` events, then reports
 * `capped` and leaves its cursor at the last event it finished. The burst drains
 * over the following cycles instead of starving the subscriptions stream or
 * overrunning the alarm, and because the cursor never advances past unapplied work,
 * draining slowly costs latency rather than data.
 *
 * Kept out of the Durable Object so the spike behaviour can be driven directly with
 * M ≫ N events instead of through a WebSocket.
 */
export function createDocumentDrain(
  env: Env,
  options: { allowed: Set<string>; cap: number; cursor?: string; now?: () => number }
): DocumentDrain {
  let applied = 0;
  let errors = 0;
  let capped = false;
  let cursor = options.cursor ?? String((options.now?.() ?? Date.now()) * 1000);

  return {
    get applied() {
      return applied;
    },
    get errors() {
      return errors;
    },
    get capped() {
      return capped;
    },
    get cursor() {
      return cursor;
    },
    async handle(event) {
      const collection = event.commit?.collection;
      if (collection !== DOCUMENT_COLLECTION && collection !== READER_COLLECTION) return 'skipped';

      if (applied >= options.cap) {
        capped = true;
        return 'capped';
      }

      let outcome: DrainOutcome = 'skipped';
      try {
        const wrote = await applyDocumentEvent(env, event, options.allowed, options.now?.());
        if (wrote) {
          applied++;
          outcome = 'applied';
        }
      } catch (error) {
        errors++;
        outcome = 'error';
        console.error('[document-store] event apply failed:', error);
      }
      // Advance past anything we finished with, including a failure: a poison event
      // must not wedge the stream forever. The reconcile loop closes the hole a
      // dropped event leaves.
      if (event.time_us) cursor = String(event.time_us);
      return outcome;
    },
  };
}

/** Record ingest bookkeeping for an author (best effort — never fails a write). */
async function touchAuthor(
  env: Env,
  fields: {
    authorDid: string;
    lastEventAt?: number;
    lastListedAt?: number;
    complete?: boolean;
    error?: string | null;
  }
): Promise<void> {
  const now = Date.now();
  try {
    if (fields.error) {
      await env.DB.prepare(
        `INSERT INTO document_authors (author_did, error_count, last_error, last_error_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(author_did) DO UPDATE SET
           error_count = document_authors.error_count + 1,
           last_error = excluded.last_error,
           last_error_at = excluded.last_error_at`
      )
        .bind(fields.authorDid, fields.error.slice(0, 500), now)
        .run();
      return;
    }
    await env.DB.prepare(
      `INSERT INTO document_authors (author_did, last_listed_at, last_event_at, complete, error_count, last_error, last_error_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(author_did) DO UPDATE SET
         last_listed_at = COALESCE(excluded.last_listed_at, document_authors.last_listed_at),
         last_event_at = COALESCE(excluded.last_event_at, document_authors.last_event_at),
         complete = CASE WHEN excluded.last_listed_at IS NULL THEN document_authors.complete ELSE excluded.complete END,
         error_count = CASE WHEN excluded.last_listed_at IS NULL THEN document_authors.error_count ELSE 0 END,
         last_error = CASE WHEN excluded.last_listed_at IS NULL THEN document_authors.last_error ELSE NULL END`
    )
      .bind(
        fields.authorDid,
        fields.lastListedAt ?? null,
        fields.lastEventAt ?? null,
        fields.complete ? 1 : 0
      )
      .run();
  } catch (error) {
    console.error('[document-store] author bookkeeping failed:', error);
  }
}

// --- Backfill + reconcile ----------------------------------------------------

export interface BackfillResult {
  did: string;
  ok: boolean;
  documents: number;
  collections: number;
  complete: boolean;
  error?: string;
}

/**
 * Pull an author's back catalogue from their PDS into D1 and prune anything the
 * repo no longer has.
 *
 * Network replay (Jetstream v2) recovers *gaps*, not history, so this stays the
 * cold-start path: a brand-new `atproto.documents` subscription must see the
 * author's existing writing, and nothing in the firehose will ever carry it. Pruning
 * to the listed set reproduces what the proxy's full-blob replace did, which is also
 * how a delete missed during an ingest pause finally disappears.
 */
export async function backfillAuthorDocuments(
  env: Env,
  authorDid: string
): Promise<BackfillResult> {
  if (!isValidDid(authorDid)) {
    return {
      did: authorDid,
      ok: false,
      documents: 0,
      collections: 0,
      complete: false,
      error: 'Invalid DID',
    };
  }

  const now = Date.now();
  let listed: Awaited<ReturnType<typeof listAuthorDocuments>>;
  try {
    listed = await listAuthorDocuments(authorDid);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'listRecords failed';
    await touchAuthor(env, { authorDid, error: message });
    log.warn('documents_backfill_failed', { authorDid, error: message });
    return {
      did: authorDid,
      ok: false,
      documents: 0,
      collections: 0,
      complete: false,
      error: message,
    };
  }

  const complete = listed.length < MAX_DOCUMENTS_PER_AUTHOR;
  const kept = listed.slice(0, MAX_DOCUMENTS_PER_AUTHOR);

  for (const record of kept) {
    const parsed = parseAtUri(record.uri);
    if (!parsed || parsed.did !== authorDid) continue;
    await upsertDocument(env, authorDid, record.uri, record.cid, record.value, now);
  }

  // Anything not in the listed set is gone from the repo (or past the cap), which
  // is the drift the firehose alone can't correct.
  const keptUris = new Set(kept.map((r) => r.uri));
  const existing = await env.DB.prepare('SELECT record_uri FROM documents_v2 WHERE author_did = ?')
    .bind(authorDid)
    .all<{ record_uri: string }>();
  const stale = (existing.results ?? [])
    .map((r) => r.record_uri)
    .filter((uri) => !keptUris.has(uri));
  if (stale.length > 0) {
    await env.DB.batch(
      stale.map((uri) => env.DB.prepare('DELETE FROM documents_v2 WHERE record_uri = ?').bind(uri))
    );
  }

  const collections = await listAuthorCollections(authorDid);
  for (const [rkey, record] of collections) {
    await upsertCollectionIfChanged(env, authorDid, rkey, record, now);
  }

  await touchAuthor(env, { authorDid, lastListedAt: now, complete });
  log.info('documents_backfilled', {
    authorDid,
    documents: kept.length,
    collections: collections.size,
    removed: stale.length,
    complete,
  });

  return {
    did: authorDid,
    ok: true,
    documents: kept.length,
    collections: collections.size,
    complete,
  };
}

/**
 * Upsert a collection only when its record actually changed. A backfill re-runs
 * over unchanged editions; blindly upserting would drop every resolved preview and
 * make the next read pay the whole cross-PDS fan-out again.
 */
async function upsertCollectionIfChanged(
  env: Env,
  authorDid: string,
  rkey: string,
  record: CollectionRecord,
  now: number
): Promise<void> {
  const existing = await env.DB.prepare(
    'SELECT record_json FROM collections_v2 WHERE author_did = ? AND rkey = ?'
  )
    .bind(authorDid, rkey)
    .first<{ record_json: string }>();
  const next = JSON.stringify(record);
  if (existing?.record_json === next) return;
  await env.DB.prepare(
    `INSERT INTO collections_v2 (author_did, rkey, record_json, preview_json, preview_at, indexed_at)
     VALUES (?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(author_did, rkey) DO UPDATE SET
       record_json = excluded.record_json, preview_json = NULL, preview_at = NULL,
       indexed_at = excluded.indexed_at`
  )
    .bind(authorDid, rkey, next, now)
    .run();
}

/**
 * Every DID whose documents someone subscribes to. This is the true active-author
 * set — it comes from the subscription table rather than from read traffic, which
 * is the circularity the feed pipeline already fixed with the crawl-set pull.
 * Parked subscriptions count: parking pauses what a reader is shown, not whether we
 * hold the author's documents, and un-parking must not need a backfill.
 */
export async function subscribedDocumentAuthors(env: Env): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT DISTINCT subject_did AS did FROM subscriptions_cache
      WHERE source_type IN ('atproto.documents', 'atproto.collection') AND subject_did IS NOT NULL`
  ).all<{ did: string }>();
  // `isValidDid`, not just a `did:` prefix: this set becomes the Jetstream
  // `wantedDids` filter, and one malformed entry is rejected wholesale — closing
  // the socket and silently killing that cycle's drain.
  return (result.results ?? []).map((r) => r.did).filter((did): did is string => isValidDid(did));
}

/**
 * Authors whose stored set is stalest, for the reconcile loop. Never-listed authors
 * sort first (a subscription created before this shipped, or a failed backfill).
 */
export async function staleDocumentAuthors(
  env: Env,
  limit: number,
  now = Date.now()
): Promise<string[]> {
  const cutoff = now - AUTHOR_RECONCILE_INTERVAL_MS;
  const result = await env.DB.prepare(
    `SELECT DISTINCT s.subject_did AS did
       FROM subscriptions_cache s
       LEFT JOIN document_authors a ON a.author_did = s.subject_did
      WHERE s.source_type IN ('atproto.documents', 'atproto.collection')
        AND s.subject_did IS NOT NULL
        AND (a.last_listed_at IS NULL OR a.last_listed_at < ?)
      ORDER BY COALESCE(a.last_listed_at, 0) ASC
      LIMIT ?`
  )
    .bind(cutoff, limit)
    .all<{ did: string }>();
  return (result.results ?? []).map((r) => r.did).filter((did): did is string => isValidDid(did));
}

/** Re-list the stalest authors. Bounded per call — this rides the hourly cron. */
export async function reconcileStaleAuthors(env: Env, limit = 3): Promise<BackfillResult[]> {
  const dids = await staleDocumentAuthors(env, limit);
  const results: BackfillResult[] = [];
  for (const did of dids) {
    results.push(await backfillAuthorDocuments(env, did));
  }
  return results;
}

// --- Read path ---------------------------------------------------------------

/**
 * Resolve publication metadata for a set of site URIs, using the D1 cache and
 * resolving at most `maxResolves` misses inline. A stale row is preferred to a
 * blocking PDS fetch: it renders the document, and the write path refreshes it.
 */
async function metaForSites(
  env: Env,
  siteUris: string[],
  maxResolves = 5
): Promise<Map<string, SiteMeta>> {
  const out = new Map<string, SiteMeta>();
  let resolves = 0;
  for (const siteUri of new Set(siteUris)) {
    if (!siteUri) {
      out.set(siteUri, EMPTY_SITE_META);
      continue;
    }
    const fresh = await cachedSiteMeta(env, siteUri);
    if (fresh) {
      out.set(siteUri, fresh);
      continue;
    }
    if (resolves < maxResolves) {
      resolves++;
      out.set(siteUri, await resolveSiteMeta(env, siteUri));
      continue;
    }
    out.set(siteUri, (await cachedSiteMeta(env, siteUri, { allowStale: true })) ?? EMPTY_SITE_META);
  }
  return out;
}

/** The author's handle, when they're a Skyreader user. Masthead adornment only. */
async function localHandle(env: Env, did: string): Promise<string | undefined> {
  try {
    const row = await env.DB.prepare('SELECT handle FROM users WHERE did = ?')
      .bind(did)
      .first<{ handle: string }>();
    return row?.handle || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attach a curated edition to the document that renders it, resolving item previews
 * lazily and persisting them. The fan-out happens once per edition, in a request
 * context — never inside the poller's alarm, where it would compete with the drain.
 */
async function attachReaderCollection(
  env: Env,
  document: ProxyDocument,
  row: CollectionRow,
  meta: SiteMeta,
  budget: { remaining: number },
  now = Date.now()
): Promise<ProxyReaderCollection | null> {
  const edition = {
    publicationName: meta.name || undefined,
    theme: meta.theme || undefined,
    fonts: meta.fonts || undefined,
    authorHandle: await localHandle(env, document.authorDid),
  };

  const cached = row.preview_json ? parseRecord<ProxyReaderCollection>(row.preview_json) : null;
  const fresh = cached && row.preview_at && now - row.preview_at < COLLECTION_PREVIEW_TTL_MS;
  if (cached && fresh) return { ...cached, ...edition };

  if (budget.remaining <= 0) {
    // Out of resolve budget: serve the previous preview if we have one, else drop
    // the edition for this read. Either way the next read resolves it.
    return cached ? { ...cached, ...edition } : null;
  }
  budget.remaining--;

  const raw = parseRecord<CollectionRecord>(row.record_json);
  if (!raw) return null;
  const resolved = await resolveReaderCollection(env, raw, edition);
  if (!resolved) return null;

  try {
    await env.DB.prepare(
      'UPDATE collections_v2 SET preview_json = ?, preview_at = ? WHERE author_did = ? AND rkey = ?'
    )
      .bind(JSON.stringify(resolved), now, row.author_did, row.rkey)
      .run();
  } catch (error) {
    console.error('[document-store] preview persist failed:', error);
  }
  return resolved;
}

/**
 * Load one author's stored documents in the frontend's wire shape, newest first,
 * optionally scoped to a publication.
 */
export async function loadAuthorDocuments(
  env: Env,
  authorDid: string,
  options: { siteUri?: string; collectionBudget?: { remaining: number } } = {}
): Promise<ProxyDocument[]> {
  const scoped = options.siteUri
    ? await env.DB.prepare(
        `SELECT record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at
           FROM documents_v2 WHERE author_did = ? AND site_uri = ?
          ORDER BY published_at DESC LIMIT ?`
      )
        .bind(authorDid, options.siteUri, MAX_DOCUMENTS_PER_AUTHOR)
        .all<DocumentRow>()
    : await env.DB.prepare(
        `SELECT record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at
           FROM documents_v2 WHERE author_did = ?
          ORDER BY published_at DESC LIMIT ?`
      )
        .bind(authorDid, MAX_DOCUMENTS_PER_AUTHOR)
        .all<DocumentRow>();

  const rows = scoped.results ?? [];
  if (rows.length === 0) return [];

  const metas = await metaForSites(
    env,
    rows.map((r) => r.site_uri)
  );

  // Curated editions are rare; one query per author covers every document here.
  const collectionRows = await env.DB.prepare(
    'SELECT author_did, rkey, record_json, preview_json, preview_at FROM collections_v2 WHERE author_did = ?'
  )
    .bind(authorDid)
    .all<CollectionRow>();
  const byRkey = new Map((collectionRows.results ?? []).map((r) => [r.rkey, r]));
  const budget = options.collectionBudget ?? { remaining: MAX_COLLECTION_RESOLVES_PER_REQUEST };

  const documents: ProxyDocument[] = [];
  for (const row of rows) {
    const record = parseRecord<DocumentRecord>(row.record_json);
    if (!record) continue;
    const meta = metas.get(row.site_uri) ?? EMPTY_SITE_META;
    const document = recordToDocument(
      row.author_did,
      row.record_uri,
      row.record_cid,
      record,
      meta,
      {
        indexedAt: new Date(row.indexed_at).toISOString(),
      }
    );
    const collectionRow = byRkey.get(row.rkey);
    if (collectionRow) {
      const readerCollection = await attachReaderCollection(
        env,
        document,
        collectionRow,
        meta,
        budget
      );
      if (readerCollection) document.readerCollection = readerCollection;
    }
    documents.push(document);
  }

  return documents;
}

/**
 * Serve one requested `(did, siteUri)` scope in the proxy's response shape.
 *
 * `unchanged` / `ready` / `error` mean exactly what they meant on the proxy path,
 * and the digest is computed over the same `(recordUri, recordCid)` pairs, so a
 * client's stored digest keeps matching and the frontend's apply logic is untouched.
 * The one thing that cannot be reproduced is a per-author retry schedule
 * (`errorCount` / `nextRetryAt` were the proxy's cache-fetch backoff); an author we
 * have never successfully listed reports `error` without them.
 *
 * The proxy's other compensating case is gone rather than ported: an empty scope
 * over a non-empty author (subscribing to a publication whose back catalogue
 * predates the subscription) needed a forced re-list there, because its cache was
 * warmed by read traffic. Here, subscribing backfills the author's whole repo —
 * every publication of theirs at once — so the scope is populated before the first
 * read of it.
 */
export async function serveDocumentScope(
  env: Env,
  entry: { did: string; siteUri?: string; since_digest?: string },
  collectionBudget: { remaining: number }
): Promise<ProxyDocumentEntry> {
  const { did, siteUri } = entry;

  if (!isValidDid(did)) {
    return { did: String(did), siteUri, documents: [], status: 'error', error: 'Invalid DID' };
  }

  const author = await env.DB.prepare(
    'SELECT author_did, last_listed_at, complete, error_count, last_error FROM document_authors WHERE author_did = ?'
  )
    .bind(did)
    .first<AuthorRow>();

  const documents = await loadAuthorDocuments(env, did, { siteUri, collectionBudget });

  // Nothing stored and nothing ever listed: this author is not ingested yet (a
  // subscription created before the backfill ran, or a failed one). Report the
  // proxy's `error` so the client keeps what it holds and retries, rather than a
  // `ready` empty set, which would clear the scope.
  if (documents.length === 0 && !author?.last_listed_at) {
    return {
      did,
      siteUri,
      documents: [],
      status: 'error',
      error: author?.last_error || 'Documents not yet ingested for this author',
      errorCount: author?.error_count || 0,
    };
  }

  const digest = await digestScope(documents);
  if (entry.since_digest && entry.since_digest === digest) {
    return { did, siteUri, status: 'unchanged' };
  }

  return {
    did,
    siteUri,
    documents,
    status: 'ready',
    digest,
    // The author's whole repo fits under the cap, so an absent record means
    // deleted rather than merely beyond the cap.
    complete: author?.complete === 1,
  };
}

/**
 * Serve a single document by at:// URI, for a piece opened from a curated edition
 * whose author nobody subscribes to (so it is in no author's stored set). Falls
 * back to a live `getRecord` on a miss, exactly as the proxy's on-demand path did —
 * and doesn't store the result: an unsubscribed author's document is a one-shot
 * read, not an ingest.
 */
export async function serveSingleDocument(env: Env, uri: string): Promise<ProxyDocument | null> {
  const parsed = parseAtUri(uri);
  if (!parsed || parsed.collection !== DOCUMENT_COLLECTION) return null;

  const row = await env.DB.prepare(
    `SELECT record_uri, author_did, rkey, record_cid, site_uri, published_at, canonical_url, record_json, indexed_at
       FROM documents_v2 WHERE record_uri = ?`
  )
    .bind(uri)
    .first<DocumentRow>();

  if (row) {
    const record = parseRecord<DocumentRecord>(row.record_json);
    if (record) {
      const meta =
        (await cachedSiteMeta(env, row.site_uri, { allowStale: true })) ?? EMPTY_SITE_META;
      const document = recordToDocument(
        row.author_did,
        row.record_uri,
        row.record_cid,
        record,
        meta,
        { indexedAt: new Date(row.indexed_at).toISOString() }
      );
      const collectionRow = await env.DB.prepare(
        'SELECT author_did, rkey, record_json, preview_json, preview_at FROM collections_v2 WHERE author_did = ? AND rkey = ?'
      )
        .bind(row.author_did, row.rkey)
        .first<CollectionRow>();
      if (collectionRow) {
        const readerCollection = await attachReaderCollection(env, document, collectionRow, meta, {
          remaining: 1,
        });
        if (readerCollection) document.readerCollection = readerCollection;
      }
      return document;
    }
  }

  const fetched = await getDocumentRecord(uri);
  if (!fetched) return null;
  const meta = await resolveSiteMeta(env, fetched.value.site || '');
  return recordToDocument(parsed.did, fetched.uri, fetched.cid, fetched.value, meta);
}

/** Documents currently stored, for the admin ops panel. */
export async function documentStoreStats(
  env: Env
): Promise<{ documents: number; authors: number; collections: number }> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM documents_v2) AS documents,
       (SELECT COUNT(DISTINCT author_did) FROM documents_v2) AS authors,
       (SELECT COUNT(*) FROM collections_v2) AS collections`
  ).first<{ documents: number; authors: number; collections: number }>();
  return {
    documents: row?.documents ?? 0,
    authors: row?.authors ?? 0,
    collections: row?.collections ?? 0,
  };
}
