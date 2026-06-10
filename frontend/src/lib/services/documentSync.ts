import type { SocialDocument, Subscription } from '$lib/types';
import { scopeKey } from './documentDigests';

/**
 * Pure helpers for syncing standard.site documents from the proxy batch endpoint
 * into the social timeline. Extracted from the social store / feedFetcher (which
 * are Svelte rune modules, untestable in plain vitest) so the reconciliation and
 * batching logic can be unit-tested directly. See documentSync.test.ts.
 */

/** A request for one author, optionally scoped to a publication. */
export interface DocumentRequest {
  did: string;
  siteUri?: string;
  // The per-scope digest the client last stored; absent on first-ever sync (cold
  // start). A server-side match returns a bodyless `unchanged` result.
  since_digest?: string;
}

/** A proxy result for one (author, publication scope). */
export interface DocumentScopeResult {
  did: string;
  siteUri?: string;
  // Present only on `ready` (a digest miss / cold start). Absent on `unchanged`.
  documents?: SocialDocument[];
  status: 'ready' | 'unchanged' | 'error';
  // Per-scope content hash to store and echo as `since_digest` next poll.
  digest?: string;
}

/**
 * Whether a document falls within a subscription's publication scope, mirroring
 * the proxy's filterByPublication:
 * - undefined → all of the author's documents
 * - an at://...publication URI → only that publication
 */
export function docInScope(d: SocialDocument, siteUri?: string): boolean {
  if (!siteUri) return true;
  return d.siteUri === siteUri;
}

export function sortByPublishedDesc(docs: SocialDocument[]): SocialDocument[] {
  return [...docs].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
}

/**
 * Reconcile the current documents with freshly-fetched per-scope results. Each
 * result is authoritative for its (author, publication scope), so reconciling per
 * scope makes upstream edits and deletes self-heal: in-scope documents the proxy
 * no longer returns are dropped, the rest upserted. Deduped by recordUri (a doc
 * can fall in two overlapping subscription scopes; the most recently applied
 * wins) and returned newest-first.
 *
 * Only `ready` results mutate state — `error` results are ignored so a transient
 * fetch failure never drops cached documents.
 */
export function reconcileDocuments(
  current: SocialDocument[],
  results: DocumentScopeResult[]
): SocialDocument[] {
  const ready = results.filter((r) => r.status === 'ready');

  let next = current;
  for (const r of ready) {
    // Drop everything currently in this scope, then add the fresh set. (A `ready`
    // result always carries `documents`; `?? []` only satisfies the optional type
    // — an `unchanged` result, which has no documents, never reaches here because
    // it is filtered out by status above.)
    next = [
      ...next.filter((d) => !(d.authorDid === r.did && docInScope(d, r.siteUri))),
      ...(r.documents ?? []),
    ];
  }

  const byUri = new Map<string, SocialDocument>();
  for (const d of next) byUri.set(d.recordUri, d);
  return sortByPublishedDesc([...byUri.values()]);
}

/**
 * Map subscriptions to per-author document requests. Only `atproto.documents`
 * subscriptions with a `subjectDid` produce a request; the publication scope comes
 * from `feedUrl` (an at://...publication URI, or empty for all of the author's
 * documents).
 */
export function buildDocumentRequests(
  subscriptions: Subscription[],
  digests: Record<string, string> = {}
): DocumentRequest[] {
  return subscriptions
    .filter((sub) => sub.sourceType === 'atproto.documents' && sub.subjectDid)
    .map((sub) => {
      const did = sub.subjectDid as string;
      const siteUri = sub.feedUrl || undefined;
      const since_digest = digests[scopeKey(did, siteUri)];
      return { did, siteUri, ...(since_digest ? { since_digest } : {}) };
    });
}

/**
 * Run `requests` through `fetchBatch` in chunks of `batchSize`, accumulating every
 * batch's author entries. A failing batch is logged via `onError` and skipped —
 * it must not abort the others or the overall refresh.
 */
export async function collectDocumentBatches<A>(
  requests: DocumentRequest[],
  batchSize: number,
  fetchBatch: (batch: DocumentRequest[]) => Promise<{ authors: A[] }>,
  onError: (e: unknown) => void = (e) => console.error('Document batch fetch failed:', e)
): Promise<A[]> {
  const all: A[] = [];
  for (let offset = 0; offset < requests.length; offset += batchSize) {
    const batch = requests.slice(offset, offset + batchSize);
    try {
      const { authors } = await fetchBatch(batch);
      all.push(...authors);
    } catch (e) {
      onError(e);
    }
  }
  return all;
}
