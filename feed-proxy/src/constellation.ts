/**
 * Constellation backlink lookups for linkblog social context (Phase 3).
 *
 * Constellation (constellation.microcosm.blue) indexes the whole AT Protocol
 * firehose into a backlink graph, so we can ask a network-wide question about a
 * link post without running our own indexer: how many other posts quote it.
 *
 * This once also answered "who else across the Atmosphere linked the same
 * article", with each linker's note pulled from their PDS. The discussion surface
 * asks that question properly now — across all four lanes rather than just
 * standard.site, in mention-lane.ts — so the card stopped rendering this copy of
 * it and the lookup was removed rather than left to cost a Constellation query
 * plus a PDS fetch per linker on every link post nobody reads it from.
 *
 * This is an *adornment*: the lookup degrades silently (returns 0) so a slow or
 * down Constellation never blocks the read. Assembled results are cached in
 * SQLite (`constellation_cache`) with a short TTL since the index is
 * firehose-fresh.
 */
import { Database } from 'bun:sqlite';
import { constellationGet } from './constellation-client';

const DOCUMENT_COLLECTION = 'site.standard.document';
// JSON path of the external/at-uri ref in a link-post document's `links` array.
const LINKS_PATH = '.links[].uri';

// Firehose-fresh index → keep the assembled bundle only briefly.
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;

export interface SocialContext {
  quoteCount: number;
}

export interface SocialContextQuery {
  // The link post's own record AT URI — the only thing the context keys off.
  docUri?: string;
}

interface ConstellationCountResponse {
  total?: number;
}

interface CacheRow {
  cache_key: string;
  context_json: string;
  cached_at: number;
}

const EMPTY: SocialContext = { quoteCount: 0 };

// Count of documents whose `links` ref points at this doc (quote-reshares of it).
async function fetchQuoteCount(docUri: string): Promise<number> {
  const data = await constellationGet<ConstellationCountResponse>('/links/count', {
    target: docUri,
    collection: DOCUMENT_COLLECTION,
    path: LINKS_PATH,
  });
  return data?.total ?? 0;
}

// Namespaced like the table's other tenants (`lane-items:`, `profile:`), which
// also retires the old `docUri|articleUrl|excludeDid` keys: nothing reads them,
// so the rows written before this simply age out on the sweep.
function cacheKey(query: SocialContextQuery): string {
  return `social:${query.docUri}`;
}

/**
 * Assemble the social context for one link post, served from `constellation_cache`
 * when fresh. The lookup degrades to its empty value, so a Constellation outage
 * still returns a well-formed bundle.
 */
export async function getSocialContext(
  db: Database,
  query: SocialContextQuery
): Promise<SocialContext> {
  if (!query.docUri) return EMPTY;

  const key = cacheKey(query);
  const now = Date.now();
  const cached = db
    .query<CacheRow, [string]>(
      'SELECT cache_key, context_json, cached_at FROM constellation_cache WHERE cache_key = ?'
    )
    .get(key);
  if (cached && now - cached.cached_at < CONTEXT_CACHE_TTL_MS) {
    return JSON.parse(cached.context_json) as SocialContext;
  }

  const context: SocialContext = { quoteCount: await fetchQuoteCount(query.docUri) };
  db.run(
    `INSERT INTO constellation_cache (cache_key, context_json, cached_at) VALUES (?, ?, ?)
		ON CONFLICT(cache_key) DO UPDATE SET context_json = excluded.context_json, cached_at = excluded.cached_at`,
    [key, JSON.stringify(context), now]
  );
  return context;
}
