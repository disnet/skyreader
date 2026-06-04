/**
 * Constellation backlink lookups for linkblog social context (Phase 3).
 *
 * Constellation (constellation.microcosm.blue) indexes the whole AT Protocol
 * firehose into a backlink graph, so we can ask network-wide questions about a
 * link post without running our own indexer:
 *
 *  - who quoted it                                          (a `repost` count)
 *  - who else across the Atmosphere linked the same article (with their notes)
 *
 * These are *adornments*: every lookup degrades silently (returns 0 / empty) so a
 * slow or down Constellation never blocks the read. Assembled results are cached
 * in SQLite (`constellation_cache`) with a short TTL since the index is firehose-
 * fresh. Notes/handles for "also linked by" are fetched from each linker's PDS.
 */
import { Database } from 'bun:sqlite';
import { resolveHandle, resolvePdsUrl } from './did-resolver';
import { constellationGet } from './constellation-client';

const DOCUMENT_COLLECTION = 'site.standard.document';
// JSON path of the external/at-uri ref in a link-post document's `links` array.
const LINKS_PATH = '.links[].uri';

// Firehose-fresh index → keep the assembled bundle only briefly.
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
// Cap "also linked by" — we fetch each linker's record for its note, so bound the
// work. A handful is plenty for the context line.
const MAX_ALSO_LINKED = 6;
const FETCH_TIMEOUT_MS = 10 * 1000;

export interface AlsoLinkedEntry {
  did: string;
  handle: string | null;
  note: string | null;
  recordUri: string;
}

export interface SocialContext {
  quoteCount: number;
  alsoLinkedBy: AlsoLinkedEntry[];
}

export interface SocialContextQuery {
  // The link post's own record AT URI — for recommend + quote counts.
  docUri?: string;
  // The external article URL the link post points at — for "also linked by".
  articleUrl?: string;
  // Omit this DID from "also linked by" (typically the link post's own author).
  excludeDid?: string;
}

interface ConstellationCountResponse {
  total?: number;
}

interface ConstellationLinksResponse {
  total?: number;
  linking_records?: Array<{ did: string; collection: string; rkey: string }>;
  cursor?: string;
}

interface CacheRow {
  cache_key: string;
  context_json: string;
  cached_at: number;
}

const EMPTY: SocialContext = {
  quoteCount: 0,
  alsoLinkedBy: [],
};

// Count of documents whose `links` ref points at this doc (quote-reshares of it).
async function fetchQuoteCount(docUri: string): Promise<number> {
  const data = await constellationGet<ConstellationCountResponse>('/links/count', {
    target: docUri,
    collection: DOCUMENT_COLLECTION,
    path: LINKS_PATH,
  });
  return data?.total ?? 0;
}

interface RawDocValue {
  description?: string;
  textContent?: string;
  content?: unknown;
}

// Extract the note (commentary) from a link-post document record: the leading
// pub.leaflet text block, falling back to description/textContent. Mirrors the
// frontend's getLinkPostNote so "also linked by" notes read the same.
function extractNote(value: RawDocValue): string | null {
  const content = value.content as
    | {
        pages?: Array<{
          blocks?: Array<{ block?: { $type?: string; plaintext?: string } }>;
        }>;
      }
    | undefined;
  for (const page of content?.pages ?? []) {
    for (const wrapper of page.blocks ?? []) {
      if (wrapper.block?.$type === 'pub.leaflet.blocks.text') {
        const text = wrapper.block.plaintext?.trim();
        if (text) return text;
      }
    }
  }
  const fallback = (value.description || value.textContent || '').trim();
  return fallback || null;
}

// Fetch a single linker's document record to pull its note, and resolve a handle.
async function resolveAlsoLinked(
  db: Database,
  rec: { did: string; rkey: string }
): Promise<AlsoLinkedEntry | null> {
  const recordUri = `at://${rec.did}/${DOCUMENT_COLLECTION}/${rec.rkey}`;
  const [pdsUrl, handle] = await Promise.all([
    resolvePdsUrl(db, rec.did),
    resolveHandle(db, rec.did),
  ]);
  let note: string | null = null;
  if (pdsUrl) {
    try {
      const qs = new URLSearchParams({
        repo: rec.did,
        collection: DOCUMENT_COLLECTION,
        rkey: rec.rkey,
      });
      const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${qs}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as { value?: RawDocValue };
        if (data.value) note = extractNote(data.value);
      }
    } catch (error) {
      console.error(`[constellation] getRecord error for ${recordUri}:`, error);
    }
  }
  return { did: rec.did, handle, note, recordUri };
}

// Other link posts across the Atmosphere pointing at the same external article.
async function fetchAlsoLinkedBy(
  db: Database,
  articleUrl: string,
  excludeDid?: string
): Promise<AlsoLinkedEntry[]> {
  const data = await constellationGet<ConstellationLinksResponse>('/links', {
    target: articleUrl,
    collection: DOCUMENT_COLLECTION,
    path: LINKS_PATH,
    limit: String(MAX_ALSO_LINKED * 2), // over-fetch; we filter + dedup below
  });
  const records = data?.linking_records ?? [];

  // One entry per distinct author (a user may have linked the article more than
  // once), excluding the link post's own author, capped.
  const seen = new Set<string>();
  const picked: Array<{ did: string; rkey: string }> = [];
  for (const rec of records) {
    if (rec.did === excludeDid || seen.has(rec.did)) continue;
    seen.add(rec.did);
    picked.push({ did: rec.did, rkey: rec.rkey });
    if (picked.length >= MAX_ALSO_LINKED) break;
  }

  const resolved = await Promise.all(picked.map((rec) => resolveAlsoLinked(db, rec)));
  return resolved.filter((e): e is AlsoLinkedEntry => e !== null);
}

function cacheKey(query: SocialContextQuery): string {
  return `${query.docUri || ''}|${query.articleUrl || ''}|${query.excludeDid || ''}`;
}

/**
 * Assemble the social context for one link post, served from `constellation_cache`
 * when fresh. Each sub-lookup degrades to its empty value independently, so a
 * partial Constellation/PDS outage still returns whatever resolved.
 */
export async function getSocialContext(
  db: Database,
  query: SocialContextQuery
): Promise<SocialContext> {
  if (!query.docUri && !query.articleUrl) return EMPTY;

  const key = cacheKey(query);
  const now = Date.now();
  const cached = db
    .query<
      CacheRow,
      [string]
    >('SELECT cache_key, context_json, cached_at FROM constellation_cache WHERE cache_key = ?')
    .get(key);
  if (cached && now - cached.cached_at < CONTEXT_CACHE_TTL_MS) {
    return JSON.parse(cached.context_json) as SocialContext;
  }

  const [quoteCount, alsoLinkedBy] = await Promise.all([
    query.docUri ? fetchQuoteCount(query.docUri) : Promise.resolve(0),
    query.articleUrl
      ? fetchAlsoLinkedBy(db, query.articleUrl, query.excludeDid)
      : Promise.resolve([] as AlsoLinkedEntry[]),
  ]);

  const context: SocialContext = { quoteCount, alsoLinkedBy };
  db.run(
    `INSERT INTO constellation_cache (cache_key, context_json, cached_at) VALUES (?, ?, ?)
		ON CONFLICT(cache_key) DO UPDATE SET context_json = excluded.context_json, cached_at = excluded.cached_at`,
    [key, JSON.stringify(context), now]
  );
  return context;
}
