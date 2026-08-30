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

/** First wait after a failed list; doubles per consecutive failure. */
export const AUTHOR_RETRY_BASE_MS = 60 * 60 * 1000;

/** Ceiling on that wait — a dead author is still retried once a reconcile interval. */
export const AUTHOR_RETRY_MAX_MS = AUTHOR_RECONCILE_INTERVAL_MS;

/** How long after a failure an author is held out of the reconcile queue. */
export function authorRetryBackoffMs(errorCount: number): number {
  const exponent = Math.min(Math.max(Math.floor(errorCount), 1) - 1, 12);
  return Math.min(AUTHOR_RETRY_BASE_MS * 2 ** exponent, AUTHOR_RETRY_MAX_MS);
}

/**
 * D1's ceiling on queries per Worker invocation (paid plan), and the number every
 * bounded loop in this file is really sized against.
 *
 * The unit is the *statement*, not the call: each statement inside a `DB.batch`
 * counts on its own, so "one batch per event" is not one query per event. Hitting
 * the ceiling is quiet in exactly the case the bounds exist for — the drain catches
 * each throw per event, counts it as an error and advances its cursor past it — so
 * the cost of every write here is counted rather than assumed.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
export const D1_QUERIES_PER_INVOCATION = 1000;

/**
 * What the drain leaves for the rest of a poll cycle: the subscriptions stream's
 * writes, the flag and author-set reads, and the back-catalogue walks the alarm runs
 * once both sockets are closed (`MAX_CYCLE_BACKFILLS` × `BACKFILL_QUERY_COST`).
 */
export const DOCUMENT_CYCLE_QUERY_RESERVE = 300;

/** Queries one poll cycle's document drain may spend. */
export const DOCUMENT_DRAIN_QUERY_BUDGET = D1_QUERIES_PER_INVOCATION - DOCUMENT_CYCLE_QUERY_RESERVE;

/**
 * Worst-case queries one applied event costs: the record write, plus a first-seen
 * publication's cache read and its refresh. Every later event for that publication
 * costs the write alone, because the resolved metadata is memoised on the context.
 *
 * Charging every event the cold-publication price is also what keeps the *fetch*
 * subrequest budget in range: a resolve is three cross-PDS fetches, and a cycle of
 * nothing but cold publications stops at a quarter of the query budget.
 */
const QUERIES_PER_APPLIED_EVENT = 4;

/** Queries the end-of-run flush spends per author written during the run. */
const QUERIES_PER_FLUSHED_AUTHOR = 2;

/**
 * Worst-case queries one author's backfill spends: a write per document up to the
 * per-author cap, plus the prune, the sidecar reads and the bookkeeping. Callers
 * that fan backfills out inside one invocation size their fan-out against this.
 */
export const BACKFILL_QUERY_COST = MAX_DOCUMENTS_PER_AUTHOR + 12;

/**
 * `authorRetryBackoffMs` as SQL, so the queue query can apply it per row. Binds, in
 * order: the ceiling, the base. `1 << n` is SQLite's shift; the exponent is clamped
 * before shifting so a long-broken author can't overflow it.
 */
const RETRY_BACKOFF_SQL = 'MIN(?, ? * (1 << MIN(MAX(COALESCE(a.error_count, 1), 1) - 1, 12)))';

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
 * State shared by a run of writes — one poll cycle's drain, or one author's
 * backfill. Both of its jobs are about the query budget above.
 *
 * Publication metadata resolved once is reused by every later write in the run. A
 * flood is one author and usually one publication, so this is the difference
 * between one cache read for the burst and one per event.
 *
 * The per-author cap eviction and the ingest bookkeeping are settled once, in
 * {@link flushDocumentApplyContext}, rather than riding every write: trimming after
 * each of 500 events deletes nothing 499 times and spends 500 queries doing it. The
 * trade is that the eviction is no longer atomic with the write that made it
 * necessary — an author sits over the cap between the two, and a run that dies in
 * between leaves them there until the next drain, backfill or reconcile trims,
 * all of which do.
 */
export interface DocumentApplyContext {
  /** Publication metadata already resolved during this run. */
  siteMeta: Map<string, SiteMeta>;
  /** Authors written during this run, trimmed and stamped at the flush. */
  touched: Set<string>;
  /** D1 queries spent so far — what the drain stops on. */
  queries: number;
  /** Timestamp of the most recent applied event, for the flush's bookkeeping. */
  lastEventAt: number;
}

export function createDocumentApplyContext(): DocumentApplyContext {
  return { siteMeta: new Map(), touched: new Set(), queries: 0, lastEventAt: 0 };
}

/**
 * Settle the deferred per-author work: cap eviction and ingest bookkeeping, one
 * pair of statements per author written during the run. Best effort — losing it
 * costs a delayed eviction, never a document.
 */
export async function flushDocumentApplyContext(
  env: Env,
  ctx: DocumentApplyContext
): Promise<void> {
  if (ctx.touched.size === 0) return;
  const authors = [...ctx.touched];
  ctx.touched.clear();
  const lastEventAt = ctx.lastEventAt || Date.now();
  const statements = authors.flatMap((authorDid) => [
    trimAuthorDocumentsStatement(env, authorDid),
    authorBookkeepingStatement(env, { authorDid, lastEventAt }),
  ]);
  ctx.queries += statements.length;
  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error('[document-store] apply flush failed:', error);
  }
}

/**
 * Publication metadata for a write, resolved at most once per run. Cheap enough to
 * do at write time — and doing it here is what keeps the serve path from ever
 * blocking on a PDS for a canonical URL.
 */
async function siteMetaForWrite(
  env: Env,
  siteUri: string,
  ctx: DocumentApplyContext
): Promise<SiteMeta> {
  const memoised = ctx.siteMeta.get(siteUri);
  if (memoised) return memoised;
  // A cold publication is a cache read plus a refresh write; a warm one is the
  // read alone. Charged at the worst case, which is what the drain budgets for.
  ctx.queries += 2;
  const meta = await resolveSiteMeta(env, siteUri);
  ctx.siteMeta.set(siteUri, meta);
  return meta;
}

/**
 * The statement that upserts one `site.standard.document` record. Idempotent by
 * `record_uri`, so a replayed firehose event or a re-run backfill converges on the
 * same row — which is what makes Jetstream's at-least-once delivery safe here.
 *
 * Publication metadata is resolved (and D1-cached) here, at write time, so the
 * serve path never blocks on a PDS for a canonical URL. Returns null for a URI we
 * can't parse an rkey out of, which is not a row we could ever address again.
 */
async function documentUpsertStatement(
  env: Env,
  authorDid: string,
  recordUri: string,
  recordCid: string,
  record: DocumentRecord,
  now: number,
  ctx: DocumentApplyContext
): Promise<D1PreparedStatement | null> {
  const parsed = parseAtUri(recordUri);
  if (!parsed) return null;

  const siteUri = record.site || '';
  const meta = await siteMetaForWrite(env, siteUri, ctx);
  const canonicalUrl = meta.baseUrl
    ? buildCanonicalUrl(meta.baseUrl, record.path || '')
    : record.path || '';

  return env.DB.prepare(
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
  ).bind(
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
  );
}

/** Upsert one record on its own (the backfill's per-record write). */
export async function upsertDocument(
  env: Env,
  authorDid: string,
  recordUri: string,
  recordCid: string,
  record: DocumentRecord,
  now = Date.now(),
  context?: DocumentApplyContext
): Promise<void> {
  const ctx = context ?? createDocumentApplyContext();
  const statement = await documentUpsertStatement(
    env,
    authorDid,
    recordUri,
    recordCid,
    record,
    now,
    ctx
  );
  if (!statement) return;
  ctx.queries++;
  await statement.run();
}

/**
 * Evict an author's oldest documents past the per-author cap. Ported from the
 * proxy's `MAX_DOCUMENTS_PER_AUTHOR` slice: storage and serve cost per author stay
 * bounded no matter how much that author publishes — which is the layer of spike
 * defence no DID filter can provide, because a *subscribed* author's flood passes
 * the filter by design.
 */
function trimAuthorDocumentsStatement(env: Env, authorDid: string): D1PreparedStatement {
  return env.DB.prepare(
    `DELETE FROM documents_v2
      WHERE record_uri IN (
        SELECT record_uri FROM documents_v2
         WHERE author_did = ?
         ORDER BY published_at DESC, record_uri DESC
         LIMIT -1 OFFSET ?
      )`
  ).bind(authorDid, MAX_DOCUMENTS_PER_AUTHOR);
}

export async function trimAuthorDocuments(env: Env, authorDid: string): Promise<number> {
  const result = await trimAuthorDocumentsStatement(env, authorDid).run();
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
  now = Date.now(),
  context?: DocumentApplyContext
): Promise<boolean> {
  const commit = event.commit;
  if (!commit) return false;
  if (!allowedDids.has(event.did)) return false;

  // Without a caller-owned context this is a one-off write, so it flushes its own
  // deferred work before returning and stays self-contained.
  const ctx = context ?? createDocumentApplyContext();
  const wrote = await applyToContext(env, event, now, ctx);
  if (!context) await flushDocumentApplyContext(env, ctx);
  return wrote;
}

async function applyToContext(
  env: Env,
  event: DocumentCommitEvent,
  now: number,
  ctx: DocumentApplyContext
): Promise<boolean> {
  const commit = event.commit!;
  const { collection, operation, rkey } = commit;

  if (collection === READER_COLLECTION) {
    if (operation === 'delete') {
      ctx.queries++;
      await deleteCollection(env, event.did, rkey);
      return true;
    }
    if (!commit.record) return false;
    ctx.queries++;
    await upsertCollection(env, event.did, rkey, commit.record as CollectionRecord, now);
    return true;
  }

  if (collection !== DOCUMENT_COLLECTION) return false;

  const recordUri = `at://${event.did}/${DOCUMENT_COLLECTION}/${rkey}`;

  if (operation === 'delete') {
    ctx.queries++;
    await deleteDocument(env, recordUri);
    return true;
  }

  if (!commit.record) return false;
  const upsert = await documentUpsertStatement(
    env,
    event.did,
    recordUri,
    commit.cid || '',
    commit.record as DocumentRecord,
    now,
    ctx
  );
  if (!upsert) return false;

  // One statement per applied event. The cap eviction and the bookkeeping this
  // write implies are recorded on the context and settled once at the flush — see
  // `DocumentApplyContext` for why, and `D1_QUERIES_PER_INVOCATION` for the ceiling
  // that makes per-event statement count the thing to economise on.
  ctx.queries++;
  await upsert.run();
  ctx.touched.add(event.did);
  ctx.lastEventAt = Math.max(ctx.lastEventAt, now);
  return true;
}

/** What one poll cycle did with an event. */
export type DrainOutcome = 'applied' | 'skipped' | 'error' | 'capped';

export interface DocumentDrain {
  handle(event: DocumentCommitEvent & { time_us?: number }): Promise<DrainOutcome>;
  /** Settle the cycle's deferred per-author work. Call once, after the socket closes. */
  flush(): Promise<void>;
  /** Events actually written this cycle. */
  readonly applied: number;
  readonly errors: number;
  /** The cycle stopped early — on the apply cap or on the query budget. */
  readonly capped: boolean;
  /** Which of the two stopped it, for the log line. */
  readonly cappedBy: 'apply-cap' | 'query-budget' | null;
  /** D1 queries this cycle's drain has spent, flush included. */
  readonly queries: number;
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
 * `queryBudget` is the harder of the two bounds and the one that has to hold: D1
 * refuses everything past `D1_QUERIES_PER_INVOCATION` in an invocation, and the
 * drain would meet that ceiling by catching a throw per event and walking its cursor
 * over the burst it was meant to protect. So the cycle stops while it can still
 * afford another event *and* the flush its writes have already earned, whatever the
 * configured cap says.
 *
 * Kept out of the Durable Object so the spike behaviour can be driven directly with
 * M ≫ N events instead of through a WebSocket.
 */
export function createDocumentDrain(
  env: Env,
  options: {
    allowed: Set<string>;
    cap: number;
    cursor?: string;
    now?: () => number;
    queryBudget?: number;
  }
): DocumentDrain {
  let applied = 0;
  let errors = 0;
  let cappedBy: 'apply-cap' | 'query-budget' | null = null;
  let cursor = options.cursor ?? String((options.now?.() ?? Date.now()) * 1000);
  const ctx = createDocumentApplyContext();
  const queryBudget = options.queryBudget ?? DOCUMENT_DRAIN_QUERY_BUDGET;

  /** Room for one more event and for flushing the author it would touch. */
  const affordable = () =>
    ctx.queries + QUERIES_PER_APPLIED_EVENT + QUERIES_PER_FLUSHED_AUTHOR * (ctx.touched.size + 1) <=
    queryBudget;

  return {
    get applied() {
      return applied;
    },
    get errors() {
      return errors;
    },
    get capped() {
      return cappedBy !== null;
    },
    get cappedBy() {
      return cappedBy;
    },
    get queries() {
      return ctx.queries;
    },
    get cursor() {
      return cursor;
    },
    async flush() {
      await flushDocumentApplyContext(env, ctx);
    },
    async handle(event) {
      const collection = event.commit?.collection;
      if (collection !== DOCUMENT_COLLECTION && collection !== READER_COLLECTION) return 'skipped';

      if (applied >= options.cap) {
        cappedBy = 'apply-cap';
        return 'capped';
      }

      if (!affordable()) {
        cappedBy = 'query-budget';
        return 'capped';
      }

      let outcome: DrainOutcome = 'skipped';
      try {
        const wrote = await applyDocumentEvent(env, event, options.allowed, options.now?.(), ctx);
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

interface AuthorBookkeeping {
  authorDid: string;
  lastEventAt?: number;
  lastListedAt?: number;
  complete?: boolean;
  error?: string | null;
}

/** The statement that records one author's ingest bookkeeping. */
function authorBookkeepingStatement(
  env: Env,
  fields: AuthorBookkeeping,
  now = Date.now()
): D1PreparedStatement {
  if (fields.error) {
    // A failed list stamps `last_error_at`, which is what the reconcile queue's
    // backoff reads: an author who can never be listed has to give its slot back.
    return env.DB.prepare(
      `INSERT INTO document_authors (author_did, error_count, last_error, last_error_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(author_did) DO UPDATE SET
         error_count = document_authors.error_count + 1,
         last_error = excluded.last_error,
         last_error_at = excluded.last_error_at`
    ).bind(fields.authorDid, fields.error.slice(0, 500), now);
  }
  return env.DB.prepare(
    `INSERT INTO document_authors (author_did, last_listed_at, last_event_at, complete, error_count, last_error, last_error_at)
     VALUES (?, ?, ?, ?, 0, NULL, NULL)
     ON CONFLICT(author_did) DO UPDATE SET
       last_listed_at = COALESCE(excluded.last_listed_at, document_authors.last_listed_at),
       last_event_at = COALESCE(excluded.last_event_at, document_authors.last_event_at),
       complete = CASE WHEN excluded.last_listed_at IS NULL THEN document_authors.complete ELSE excluded.complete END,
       error_count = CASE WHEN excluded.last_listed_at IS NULL THEN document_authors.error_count ELSE 0 END,
       last_error = CASE WHEN excluded.last_listed_at IS NULL THEN document_authors.last_error ELSE NULL END,
       last_error_at = CASE WHEN excluded.last_listed_at IS NULL THEN document_authors.last_error_at ELSE NULL END`
  ).bind(
    fields.authorDid,
    fields.lastListedAt ?? null,
    fields.lastEventAt ?? null,
    fields.complete ? 1 : 0
  );
}

/** Record ingest bookkeeping for an author (best effort — never fails a write). */
async function touchAuthor(env: Env, fields: AuthorBookkeeping): Promise<void> {
  try {
    await authorBookkeepingStatement(env, fields).run();
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
  authorDid: string,
  // One context per author: their documents nearly all share one publication, so
  // the metadata behind every canonical URL is resolved once instead of per record.
  ctx: DocumentApplyContext = createDocumentApplyContext()
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
    await upsertDocument(env, authorDid, record.uri, record.cid, record.value, now, ctx);
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
  for (const [rkey, record] of collections.byRkey) {
    await upsertCollectionIfChanged(env, authorDid, rkey, record, now);
  }

  // Sidecars drift the same way documents do — a delete missed during a pause
  // leaves a curated edition attached to a document the author has since changed.
  // Only a listing that both succeeded and covered the whole collection can prove
  // absence, hence `exhaustive`: an empty map from a failed fetch would otherwise
  // delete every edition we hold.
  let removedCollections = 0;
  if (collections.exhaustive) {
    const storedRkeys = await env.DB.prepare('SELECT rkey FROM collections_v2 WHERE author_did = ?')
      .bind(authorDid)
      .all<{ rkey: string }>();
    const goneRkeys = (storedRkeys.results ?? [])
      .map((r) => r.rkey)
      .filter((rkey) => !collections.byRkey.has(rkey));
    if (goneRkeys.length > 0) {
      await env.DB.batch(
        goneRkeys.map((rkey) =>
          env.DB.prepare('DELETE FROM collections_v2 WHERE author_did = ? AND rkey = ?').bind(
            authorDid,
            rkey
          )
        )
      );
      removedCollections = goneRkeys.length;
    }
  }

  await touchAuthor(env, { authorDid, lastListedAt: now, complete });
  log.info('documents_backfilled', {
    authorDid,
    documents: kept.length,
    collections: collections.byRkey.size,
    removed: stale.length,
    removedCollections,
    complete,
  });

  return {
    did: authorDid,
    ok: true,
    documents: kept.length,
    collections: collections.byRkey.size,
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

/** One page of the subscribed-author set, in a stable order. */
export interface AuthorPage {
  dids: string[];
  /** Resume token for the next page; null when this page reached the end. */
  cursor: string | null;
  /** Authors still after this page — 0 only when the whole set has been walked. */
  remaining: number;
}

/**
 * A page of {@link subscribedDocumentAuthors}, ordered by DID and resumable.
 *
 * The shadow-compare is a gate on the read cutover, so it has to be able to cover
 * *every* subscribed author: comparing the same first N of them repeatedly says
 * nothing about author N+1, and a clean verdict from a partial walk would admit a
 * lossy cutover. Ordering by `subject_did` gives a total order that a concurrent
 * subscribe can't shuffle a page out of.
 */
export async function subscribedDocumentAuthorPage(
  env: Env,
  options: { limit: number; after?: string }
): Promise<AuthorPage> {
  const after = options.after ?? '';
  const result = await env.DB.prepare(
    `SELECT DISTINCT subject_did AS did FROM subscriptions_cache
      WHERE source_type IN ('atproto.documents', 'atproto.collection')
        AND subject_did IS NOT NULL AND subject_did > ?
      ORDER BY subject_did ASC LIMIT ?`
  )
    .bind(after, options.limit)
    .all<{ did: string }>();

  const page = (result.results ?? []).map((r) => r.did);
  // The cursor is the last DID *examined*, valid or not, so a malformed row can
  // never stall the walk — it is simply skipped and left behind.
  const cursor = page.length === options.limit ? page[page.length - 1] : null;
  const tail = cursor
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT DISTINCT subject_did FROM subscriptions_cache
            WHERE source_type IN ('atproto.documents', 'atproto.collection')
              AND subject_did IS NOT NULL AND subject_did > ?)`
      )
        .bind(cursor)
        .first<{ n: number }>()
    : null;

  return {
    dids: page.filter((did): did is string => isValidDid(did)),
    cursor,
    remaining: tail?.n ?? 0,
  };
}

/**
 * Authors whose stored set is stalest, for the reconcile loop. Never-listed authors
 * sort first (a subscription created before this shipped, or a failed backfill).
 *
 * An author whose last attempt *failed* is held off for a backoff window derived
 * from their error count, and sorts by that failure rather than by their (still
 * NULL) `last_listed_at`. Without both halves, an author who can never be listed —
 * deleted account, unresolvable DID, dead PDS — is re-selected at the front of the
 * queue on every run, forever: the reconcile is the only self-heal in this design,
 * and three such authors would starve it silently. It also lets the migration's
 * `remaining` counter reach 0, which it otherwise never could.
 */
export async function staleDocumentAuthors(
  env: Env,
  limit: number,
  now = Date.now()
): Promise<string[]> {
  const cutoff = now - AUTHOR_RECONCILE_INTERVAL_MS;
  const result = await env.DB.prepare(
    `SELECT DISTINCT s.subject_did AS did,
            COALESCE(a.last_listed_at, a.last_error_at, 0) AS staleness
       FROM subscriptions_cache s
       LEFT JOIN document_authors a ON a.author_did = s.subject_did
      WHERE s.source_type IN ('atproto.documents', 'atproto.collection')
        AND s.subject_did IS NOT NULL
        AND (a.last_listed_at IS NULL OR a.last_listed_at < ?)
        AND (a.last_error_at IS NULL OR a.last_error_at + ${RETRY_BACKOFF_SQL} <= ?)
      ORDER BY staleness ASC
      LIMIT ?`
  )
    .bind(cutoff, AUTHOR_RETRY_MAX_MS, AUTHOR_RETRY_BASE_MS, now, limit)
    .all<{ did: string }>();
  return (result.results ?? []).map((r) => r.did).filter((did): did is string => isValidDid(did));
}

/**
 * Re-list the stalest authors. Bounded per call — this rides the cron, one author a
 * minute plus three on the hour, and never more than `BACKFILL_QUERY_COST` queries
 * an author of that run's budget.
 */
export async function reconcileStaleAuthors(env: Env, limit = 3): Promise<BackfillResult[]> {
  const dids = await staleDocumentAuthors(env, limit);
  const results: BackfillResult[] = [];
  for (const did of dids) {
    results.push(await backfillAuthorDocuments(env, did));
  }
  return results;
}

/**
 * How recently an author must have been listed for a new subscription to skip its
 * backfill. Ten readers subscribing to the same linkblog in an hour should cost one
 * `listRecords` walk, not ten.
 */
export const BACKFILL_FRESHNESS_MS = 60 * 60 * 1000;

/**
 * Backfill an author unless we already hold a fresh listing or are inside the retry
 * backoff for a failing one.
 *
 * Every path that creates an `atproto.documents` subscription calls this, because a
 * subscription whose author was never listed serves `status:'error'` on every poll
 * until the hourly reconcile happens to reach it — the reader sees an error and an
 * empty linkblog in the meantime. The proxy had no such window: it listed the author
 * inline on the first read.
 */
export async function ensureAuthorDocuments(
  env: Env,
  authorDid: string,
  now = Date.now()
): Promise<BackfillResult | null> {
  if (!isValidDid(authorDid)) return null;

  const author = await env.DB.prepare(
    'SELECT last_listed_at, last_error_at, error_count FROM document_authors WHERE author_did = ?'
  )
    .bind(authorDid)
    .first<{ last_listed_at: number | null; last_error_at: number | null; error_count: number }>();

  if (author?.last_listed_at && now - author.last_listed_at < BACKFILL_FRESHNESS_MS) return null;
  if (
    author?.last_error_at &&
    now - author.last_error_at < authorRetryBackoffMs(author.error_count)
  ) {
    return null;
  }

  return backfillAuthorDocuments(env, authorDid);
}

/**
 * Fire {@link ensureAuthorDocuments} in the background of a request. A `listRecords`
 * walk is several PDS round-trips and no subscribe response should wait on them; a
 * failure is recorded on the author row and retried by the reconcile.
 */
export function scheduleAuthorDocuments(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  authorDid: string
): void {
  waitUntil(
    ensureAuthorDocuments(env, authorDid).catch((error) => {
      log.warn('documents_backfill_schedule_failed', {
        authorDid,
        error: error instanceof Error ? error.message : String(error),
      });
    })
  );
}

/**
 * Back catalogues one sync request may pull.
 *
 * A single subscribe schedules one walk and is done. The sync paths are different:
 * they can import or mirror dozens of `atproto.documents` rows in one pass, and
 * every scheduled walk runs in that same invocation via `waitUntil` — up to
 * `BACKFILL_QUERY_COST` D1 queries each, against the same
 * `D1_QUERIES_PER_INVOCATION` ceiling the drain budgets for. Fifteen of them would
 * take the whole request past it, failing the surviving walks *and* whatever else
 * the sync had scheduled there.
 *
 * Two per path, then — `/api/sync` runs both — with the rest left to the reconcile,
 * where a never-listed author already sorts to the front of the queue.
 */
export const MAX_SYNC_BACKFILLS = 2;

/**
 * A bounded, de-duplicating scheduler for the sync paths. Returns a function that
 * schedules a walk and reports whether it did, so a caller can say how many authors
 * it left to the reconcile.
 */
export function createBackfillScheduler(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  limit = MAX_SYNC_BACKFILLS
): (authorDid: string) => boolean {
  const scheduled = new Set<string>();
  return (authorDid: string) => {
    if (!isValidDid(authorDid)) return false;
    // Two publications by the same author are one walk, and the second caller is
    // told it is covered rather than deferred.
    if (scheduled.has(authorDid)) return true;
    if (scheduled.size >= limit) return false;
    scheduled.add(authorDid);
    scheduleAuthorDocuments(env, waitUntil, authorDid);
    return true;
  };
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
        // The URL resolved when the row was written, used only while the
        // publication itself won't resolve — otherwise a five-minute negative
        // cache entry would serve a relative path next to a row holding the
        // absolute one.
        canonicalUrlFallback: row.canonical_url,
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
    // deleted rather than merely beyond the cap. The stored flag alone can't say
    // that: it was set at the last successful *list*, and the poller keeps writing
    // afterwards, so an author listed at 40 documents who has since published past
    // the cap would still claim completeness while cap eviction drops their oldest.
    // The proxy recomputed this per serve from the set it was about to return; the
    // row count reproduces that, and the flag keeps "never listed ⇒ not
    // authoritative".
    complete:
      author?.complete === 1 && (await storedDocumentCount(env, did)) < MAX_DOCUMENTS_PER_AUTHOR,
  };
}

/** How many documents we hold for an author, across every publication of theirs. */
async function storedDocumentCount(env: Env, authorDid: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM documents_v2 WHERE author_did = ?')
    .bind(authorDid)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
        {
          indexedAt: new Date(row.indexed_at).toISOString(),
          canonicalUrlFallback: row.canonical_url,
        }
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
