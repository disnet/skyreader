/**
 * "See existing items" for one mention lane (Phase 5).
 *
 * The always-on counts (mentions.ts) tell a reader *how many* people referenced
 * an article in each lane. This resolves the *who*, for a single lane, only when
 * the reader expands it — the expensive path, since each entry costs a record
 * fetch from the linker's PDS. For the requested lane we:
 *
 *   1. discover the (collection, path) sources via `/links/all`, keep only those
 *      that bucket into this lane (path-precise, reusing the lane registry);
 *   2. fetch the linking records per source and dedup by author (one entry per
 *      DID, capped);
 *   3. resolve each author's handle, build a link out to the actual post / card
 *      / highlight, and pull a note/snippet from the record where we can.
 *
 * Link-outs and notes are best-effort and lane-specific: a Bluesky post and a
 * linkblog entry have stable permalinks we can build from did+rkey, while
 * margin.at / Semble degrade to handle-only when their shape isn't known. The
 * whole thing is adornment — any failure degrades to an empty list, and the
 * assembled result is cached briefly in `constellation_cache` (shared with the
 * Phase 3 context bundle; same short TTL since the index is firehose-fresh).
 */
import { Database } from 'bun:sqlite';
import { normalizeArticleUrl } from './url-normalize';
import { laneForSource, type LaneId } from './lanes';
import { resolveHandle, resolvePdsUrl } from './did-resolver';
import { resolveSiteMeta, buildCanonicalUrl } from './standard-site';

// The one-per-user Skyreader linkblog publication rkey (see backend
// linkblog-sync). Used only as a link-out fallback for our own docs.
const LINKBLOG_PUBLICATION_RKEY = 'skyreader-links';

const CONSTELLATION_BASE = 'https://constellation.microcosm.blue';
const HEADERS = { 'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)' };
const FETCH_TIMEOUT_MS = 10 * 1000;

// Firehose-fresh index → keep the assembled list only briefly.
const CACHE_TTL_MS = 5 * 60 * 1000;
// One entry per author; bound the per-record PDS fetches behind an expand.
const MAX_ENTRIES = 8;
// Over-fetch linking records before dedup-by-author so the cap is met after dups.
const LINKS_PAGE_LIMIT = 30;

export interface MentionLaneEntry {
  did: string;
  handle: string | null;
  note: string | null;
  url: string | null;
}

interface LinksAllResponse {
  links?: Record<string, Record<string, { records?: number; distinct_dids?: number }>>;
}

interface LinksResponse {
  linking_records?: Array<{ did: string; collection: string; rkey: string }>;
}

interface CacheRow {
  cache_key: string;
  context_json: string;
  cached_at: number;
}

async function constellationGet<T>(
  path: string,
  params: Record<string, string>
): Promise<T | null> {
  try {
    const qs = new URLSearchParams(params);
    const res = await fetch(`${CONSTELLATION_BASE}${path}?${qs}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (error) {
    console.error(`[mention-lane] ${path} error:`, error);
    return null;
  }
}

// Fetch a single record value from the author's PDS (for its note/snippet).
async function getRecordValue(
  db: Database,
  did: string,
  collection: string,
  rkey: string
): Promise<Record<string, unknown> | null> {
  const pdsUrl = await resolvePdsUrl(db, did);
  if (!pdsUrl) return null;
  try {
    const qs = new URLSearchParams({ repo: did, collection, rkey });
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${qs}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { value?: Record<string, unknown> };
    return data.value ?? null;
  } catch (error) {
    console.error(`[mention-lane] getRecord error for ${did}/${collection}/${rkey}:`, error);
    return null;
  }
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) return t;
    }
  }
  return null;
}

// A short snippet for a blogs entry. Prefer the document's own `description` —
// the canonical summary any standard.site post carries — then fall back to the
// leading pub.leaflet text block (a Skyreader note, when there's no description)
// and finally plain textContent.
function extractDocumentSnippet(value: Record<string, unknown>): string | null {
  const description = firstString(value.description);
  if (description) return description;
  const content = value.content as
    | { pages?: Array<{ blocks?: Array<{ block?: { $type?: string; plaintext?: string } }> }> }
    | undefined;
  for (const page of content?.pages ?? []) {
    for (const wrapper of page.blocks ?? []) {
      if (wrapper.block?.$type === 'pub.leaflet.blocks.text') {
        const text = wrapper.block.plaintext?.trim();
        if (text) return text;
      }
    }
  }
  return firstString(value.textContent);
}

// The document's own public URL — where the post actually lives — rather than a
// Skyreader permalink. Resolve the publication's base URL and join the document
// path, for any standard.site document. Skyreader's own linkblog docs resolve to
// their skyreader.app/blogs/<did>/<rkey> page (their publication's `url` is that
// base); a foreign document resolves to its own site. Falls back to the Skyreader
// permalink only for our own docs whose publication didn't resolve — a foreign
// doc with no resolvable site simply gets no link-out.
async function resolveDocumentUrl(
  db: Database,
  did: string,
  rkey: string,
  value: Record<string, unknown>
): Promise<string | null> {
  const siteUri = typeof value.site === 'string' ? value.site : '';
  const path = typeof value.path === 'string' ? value.path : '';
  if (siteUri) {
    const { baseUrl } = await resolveSiteMeta(db, siteUri);
    if (baseUrl) {
      const url = buildCanonicalUrl(baseUrl, path);
      if (url) return url;
    }
  }
  if (siteUri.endsWith(`/${LINKBLOG_PUBLICATION_RKEY}`)) {
    return `https://skyreader.app/blogs/${did}/${rkey}`;
  }
  return null;
}

// Build a lane entry from one linking record: a stable link-out where the lane
// has one, plus a note pulled from the record (best-effort, lane-specific).
async function resolveEntry(
  db: Database,
  laneId: LaneId,
  rec: { did: string; collection: string; rkey: string }
): Promise<MentionLaneEntry> {
  const { did, collection, rkey } = rec;
  const handle = await resolveHandle(db, did);
  let url: string | null = null;
  let note: string | null = null;

  switch (laneId) {
    case 'bluesky': {
      url = `https://bsky.app/profile/${did}/post/${rkey}`;
      const value = await getRecordValue(db, did, collection, rkey);
      if (value) note = firstString(value.text);
      break;
    }
    case 'linkblog': {
      const value = await getRecordValue(db, did, collection, rkey);
      if (value) {
        note = extractDocumentSnippet(value);
        url = await resolveDocumentUrl(db, did, rkey, value);
      }
      break;
    }
    case 'margin': {
      // No stable public permalink known; surface the annotation text if present.
      const value = await getRecordValue(db, did, collection, rkey);
      if (value) {
        const body = value.body as Record<string, unknown> | undefined;
        note = firstString(value.text, value.comment, body?.value, body?.text);
      }
      break;
    }
    case 'semble': {
      // Cosmik card — surface its title/note; no stable permalink known.
      const value = await getRecordValue(db, did, collection, rkey);
      if (value) {
        const content = value.content as Record<string, unknown> | undefined;
        note = firstString(content?.title, content?.note, value.title, value.note);
      }
      break;
    }
  }

  return { did, handle, note, url };
}

function cacheKey(laneId: LaneId, normUrl: string): string {
  return `lane-items:${laneId}|${normUrl}`;
}

/**
 * Resolve the people inside one lane for an article URL, served from
 * `constellation_cache` when fresh. Returns an empty list (never throws) on a
 * bad URL, an unknown lane, or any Constellation/PDS failure.
 */
export async function getMentionLaneItems(
  db: Database,
  rawUrl: string,
  laneId: LaneId
): Promise<MentionLaneEntry[]> {
  const normUrl = normalizeArticleUrl(rawUrl);
  if (!normUrl) return [];

  const key = cacheKey(laneId, normUrl);
  const now = Date.now();
  const cached = db
    .query<
      CacheRow,
      [string]
    >('SELECT cache_key, context_json, cached_at FROM constellation_cache WHERE cache_key = ?')
    .get(key);
  if (cached && now - cached.cached_at < CACHE_TTL_MS) {
    try {
      return JSON.parse(cached.context_json) as MentionLaneEntry[];
    } catch {
      // fall through and recompute
    }
  }

  // Discover which (collection, path) sources exist for this URL, keep only
  // those that bucket into the requested lane.
  const all = await constellationGet<LinksAllResponse>('/links/all', { target: normUrl });
  const sources: Array<{ collection: string; path: string }> = [];
  for (const [collection, paths] of Object.entries(all?.links ?? {})) {
    for (const [path, stats] of Object.entries(paths)) {
      if (!stats?.distinct_dids) continue;
      if (laneForSource(collection, path)?.id === laneId) sources.push({ collection, path });
    }
  }
  if (sources.length === 0) {
    // Cache the empty result too, so a lane with no people isn't re-queried on
    // every expand within the TTL.
    writeCache(db, key, [], now);
    return [];
  }

  // Gather linking records across this lane's sources, dedup by author (a person
  // may link via several paths), capped.
  const seen = new Set<string>();
  const picked: Array<{ did: string; collection: string; rkey: string }> = [];
  for (const src of sources) {
    if (picked.length >= MAX_ENTRIES) break;
    const data = await constellationGet<LinksResponse>('/links', {
      target: normUrl,
      collection: src.collection,
      path: src.path,
      limit: String(LINKS_PAGE_LIMIT),
    });
    for (const rec of data?.linking_records ?? []) {
      if (seen.has(rec.did)) continue;
      seen.add(rec.did);
      picked.push({ did: rec.did, collection: rec.collection, rkey: rec.rkey });
      if (picked.length >= MAX_ENTRIES) break;
    }
  }

  const entries = await Promise.all(picked.map((rec) => resolveEntry(db, laneId, rec)));
  writeCache(db, key, entries, now);
  return entries;
}

function writeCache(db: Database, key: string, entries: MentionLaneEntry[], now: number): void {
  db.run(
    `INSERT INTO constellation_cache (cache_key, context_json, cached_at) VALUES (?, ?, ?)
		ON CONFLICT(cache_key) DO UPDATE SET context_json = excluded.context_json, cached_at = excluded.cached_at`,
    [key, JSON.stringify(entries), now]
  );
}
