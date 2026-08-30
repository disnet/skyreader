/**
 * Operator endpoints for the standard.site document store: the one-time backfill of
 * everyone's already-subscribed authors, and the shadow-compare that has to come
 * back clean before `documents_v2_enabled` is flipped in production.
 *
 * Both authenticate with `FEED_PROXY_SECRET` — the same shared secret the crawler
 * endpoints use, so no new secret exists to manage — and are fail-closed when it is
 * unset.
 */

import type { Env } from '../types';
import { isAuthorizedProxyRequest } from './ingest';
import {
  FeedProxyClient,
  type ProxyDocument,
  type ProxyDocumentEntry,
} from '../services/feed-proxy-client';
import {
  backfillAuthorDocuments,
  loadAuthorDocuments,
  staleDocumentAuthors,
  subscribedDocumentAuthorPage,
  type BackfillResult,
} from '../services/document-store';
import { digestScope } from '../services/standard-site';
import { log } from '../utils/logger';

/**
 * Authors backfilled per call. A backfill is a `listRecords` walk plus a write per
 * document — up to `BACKFILL_QUERY_COST` D1 queries — so the operator drives the
 * migration as a loop of bounded calls rather than one request that would outlive
 * its CPU budget or run into `D1_QUERIES_PER_INVOCATION` partway through and lose
 * the walks it hadn't reached. Five authors is ~560 queries, well under.
 */
const MAX_BACKFILL_BATCH = 5;

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * POST /api/internal/documents/backfill
 *
 * Body: `{ dids?: string[], limit?: number }`. With `dids`, backfills exactly those
 * authors. Without, takes the stalest subscribed authors that need one — which is
 * both the one-time migration (nobody has been listed yet, so every author is
 * stale) and the ongoing self-heal, run one bounded chunk at a time.
 */
export async function handleDocumentBackfill(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!isAuthorizedProxyRequest(request, env)) return unauthorized();

  let body: { dids?: string[]; limit?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body is the common case (backfill the next chunk).
  }

  const limit = Math.min(
    Math.max(1, Math.floor(body.limit ?? MAX_BACKFILL_BATCH)),
    MAX_BACKFILL_BATCH
  );
  const dids = Array.isArray(body.dids)
    ? body.dids.slice(0, limit)
    : await staleDocumentAuthors(env, limit);

  const results: BackfillResult[] = [];
  for (const did of dids) {
    results.push(await backfillAuthorDocuments(env, did));
  }

  // Authors still queued after this chunk. An author whose PDS can't be listed at
  // all drops out for a backoff window rather than pinning this above 0 forever,
  // so the driving loop terminates on a repo we will never be able to read.
  const remaining = Array.isArray(body.dids)
    ? null
    : (await staleDocumentAuthors(env, limit)).length;
  log.info('documents_backfill_batch', {
    requested: dids.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });

  return json({
    backfilled: results.length,
    results,
    // Non-null only for the "next chunk" form: how many of this chunk's size still
    // need work, so a driving loop knows when to stop. 0 means the migration is done.
    remaining,
  });
}

interface ScopeDrift {
  did: string;
  siteUri?: string;
  proxyCount: number;
  d1Count: number;
  /** In the proxy's set, missing from D1 — the drift that loses a reader content. */
  missingInD1: string[];
  /** In D1, absent upstream — a delete we never applied. */
  extraInD1: string[];
  /** Same record, different cid: an edit one side didn't see. */
  cidMismatches: string[];
  /** Same record, different canonical URL: a publication-cache divergence. */
  canonicalMismatches: string[];
  proxyDigest: string | null;
  d1Digest: string;
  /** True when nothing above differs — the bar for flipping the read gate. */
  clean: boolean;
  error?: string;
}

function byUri(documents: ProxyDocument[]): Map<string, ProxyDocument> {
  return new Map(documents.map((d) => [d.recordUri, d]));
}

/**
 * POST /api/internal/documents/shadow-compare
 *
 * Body: `{ dids?: string[], limit?: number, cursor?: string }`. Serves each author
 * both ways — proxy blob and D1 rows — and reports the difference. This is Phase 3's
 * gate: the flip to `documents_v2_enabled` waits on a clean report, because a silent
 * hole in the store looks exactly like an author who stopped publishing.
 *
 * Without `dids` the endpoint walks the whole subscribed-author set one page at a
 * time: pass the returned `cursor` back to get the next page, and keep going until
 * it comes back null. Only "every page clean" is the gate — a single call compares
 * the page it was given and says nothing about the authors behind it.
 */
export async function handleDocumentShadowCompare(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!isAuthorizedProxyRequest(request, env)) return unauthorized();

  let body: { dids?: string[]; limit?: number; cursor?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* empty body → compare the first page of subscribed authors */
  }

  const limit = Math.min(Math.max(1, Math.floor(body.limit ?? 10)), 50);
  const explicit = Array.isArray(body.dids);
  const page = explicit
    ? { dids: body.dids!.slice(0, limit), cursor: null, remaining: 0 }
    : await subscribedDocumentAuthorPage(env, {
        limit,
        after: typeof body.cursor === 'string' ? body.cursor : undefined,
      });
  const dids = page.dids;

  if (dids.length === 0) {
    return json({
      compared: 0,
      clean: true,
      cursor: page.cursor,
      remaining: page.remaining,
      scopes: [],
    });
  }

  const client = new FeedProxyClient(env);
  let proxyEntries;
  try {
    proxyEntries = await client.fetchDocumentsBatch(dids.map((did) => ({ did })));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Proxy fetch failed' }, 502);
  }

  const byDid = new Map(proxyEntries.map((entry) => [entry.did, entry]));
  const scopes: ScopeDrift[] = [];
  for (const did of dids) {
    // An author the proxy answered nothing for is drift too: the compare has to
    // account for every author it was asked about, or the walk's coverage is a
    // claim rather than a fact.
    const entry: ProxyDocumentEntry = byDid.get(did) ?? {
      did,
      status: 'error',
      error: 'No proxy entry returned',
      documents: [],
    };
    const proxyDocs = entry.documents ?? [];
    const d1Docs = await loadAuthorDocuments(env, entry.did, {
      // Comparison is about which records exist, not about warming magazine
      // previews; resolving them here would fan out across foreign PDSes.
      collectionBudget: { remaining: 0 },
    });
    const proxyByUri = byUri(proxyDocs);
    const d1ByUri = byUri(d1Docs);

    const cidMismatches: string[] = [];
    const canonicalMismatches: string[] = [];
    for (const [uri, proxyDoc] of proxyByUri) {
      const d1Doc = d1ByUri.get(uri);
      if (!d1Doc) continue;
      if (proxyDoc.recordCid !== d1Doc.recordCid) cidMismatches.push(uri);
      if ((proxyDoc.canonicalUrl || '') !== (d1Doc.canonicalUrl || ''))
        canonicalMismatches.push(uri);
    }

    const missingInD1 = [...proxyByUri.keys()].filter((uri) => !d1ByUri.has(uri));
    const extraInD1 = [...d1ByUri.keys()].filter((uri) => !proxyByUri.has(uri));
    const d1Digest = await digestScope(d1Docs);

    scopes.push({
      did: entry.did,
      siteUri: entry.siteUri,
      proxyCount: proxyDocs.length,
      d1Count: d1Docs.length,
      missingInD1,
      extraInD1,
      cidMismatches,
      canonicalMismatches,
      proxyDigest: entry.digest ?? null,
      d1Digest,
      clean:
        entry.status !== 'error' &&
        missingInD1.length === 0 &&
        extraInD1.length === 0 &&
        cidMismatches.length === 0 &&
        canonicalMismatches.length === 0,
      error: entry.status === 'error' ? entry.error : undefined,
    });
  }

  const clean = scopes.every((s) => s.clean);
  log.info('documents_shadow_compare', {
    compared: scopes.length,
    clean,
    drifted: scopes.filter((s) => !s.clean).length,
    remaining: page.remaining,
  });

  return json({
    compared: scopes.length,
    // This page only. The cutover gate is every page of the walk clean, which the
    // caller establishes by following `cursor` to the end.
    clean,
    cursor: page.cursor,
    remaining: page.remaining,
    scopes,
  });
}
