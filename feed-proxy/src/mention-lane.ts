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
import { normalizeArticleUrl, constellationTargets } from './url-normalize';
import { laneForSource, type LaneId } from './lanes';
import { resolveHandle, resolvePdsUrl } from './did-resolver';
import { resolveSiteMeta, buildCanonicalUrl, parseAtUri } from './standard-site';
import { constellationGet } from './constellation-client';

// The one-per-user Skyreader linkblog publication rkey (see backend
// linkblog-sync). Used only as a link-out fallback for our own docs.
const LINKBLOG_PUBLICATION_RKEY = 'skyreader-links';

const FETCH_TIMEOUT_MS = 10 * 1000;

// Firehose-fresh index → keep the assembled list only briefly.
const CACHE_TTL_MS = 5 * 60 * 1000;
// One entry per author; bound the per-record PDS fetches behind an expand.
const MAX_ENTRIES = 8;
// Over-fetch linking records before dedup-by-author so the cap is met after dups.
const LINKS_PAGE_LIMIT = 30;

// Semble's public web app. A card's saver links to their profile; a collection
// resolves to /profile/<handle>/collections/<rkey> (the live collection view —
// the per-card page is not built yet, so we never link a bare card).
const SEMBLE_WEB_BASE = 'https://semble.so';
// Most cards sit in 0-2 collections; cap the per-card fan-out either way.
const MAX_SEMBLE_COLLECTIONS = 3;

// A named Semble collection a card was filed into, with a link to its public
// page where resolvable. Semble-only; empty for every other lane.
export interface SembleCollection {
  name: string;
  url: string | null;
}

export interface MentionLaneEntry {
  did: string;
  handle: string | null;
  note: string | null;
  url: string | null;
  // Which Semble collection(s) the saver filed this card into (Semble lane only).
  collections: SembleCollection[];
  // The per-entry action verb (margin.at lane only) — the note's W3C motivation
  // as past tense ('highlighted' / 'commented' / …). Null for other lanes.
  verb: string | null;
  // The highlighted passage a margin.at note targets (its TextQuoteSelector),
  // distinct from the user's own comment in `note`. Null elsewhere.
  quote: string | null;
}

// margin.at note motivations (W3C Web Annotation) → an honest past-tense verb.
// Unknown / missing motivation degrades to a neutral 'annotated'.
const MARGIN_MOTIVATION_VERBS: Record<string, string> = {
  highlighting: 'highlighted',
  commenting: 'commented',
  bookmarking: 'bookmarked',
  tagging: 'tagged',
  describing: 'described',
  linking: 'linked',
  replying: 'replied',
  editing: 'edited',
  questioning: 'questioned',
  assessing: 'assessed',
};

function marginVerb(motivation: unknown): string {
  const m = typeof motivation === 'string' ? motivation : '';
  return MARGIN_MOTIVATION_VERBS[m] ?? 'annotated';
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

// The named collection(s) a Semble card was filed into. Constellation backlinks
// the card's AT-URI through `network.cosmik.collectionLink.card.uri`; each link
// points at a `network.cosmik.collection` we resolve to a name + public URL.
// Collaborative collections can live in another repo, so the owner DID comes
// from the collection AT-URI, not the saver. Best-effort and bounded — any
// failure just yields fewer chips.
async function resolveSembleCollections(
  db: Database,
  cardUri: string
): Promise<SembleCollection[]> {
  const data = await constellationGet<LinksResponse>('/links', {
    target: cardUri,
    collection: 'network.cosmik.collectionLink',
    path: '.card.uri',
    limit: '20',
  });
  const out: SembleCollection[] = [];
  const seen = new Set<string>();
  for (const rec of data?.linking_records ?? []) {
    if (out.length >= MAX_SEMBLE_COLLECTIONS) break;
    const link = await getRecordValue(db, rec.did, rec.collection, rec.rkey);
    const collectionUri = firstString((link?.collection as { uri?: unknown })?.uri);
    if (!collectionUri || seen.has(collectionUri)) continue;
    seen.add(collectionUri);
    const parsed = parseAtUri(collectionUri);
    if (!parsed) continue;
    const value = await getRecordValue(db, parsed.did, parsed.collection, parsed.rkey);
    const name = firstString(value?.name);
    if (!name) continue;
    const ownerHandle = await resolveHandle(db, parsed.did);
    const url = ownerHandle
      ? `${SEMBLE_WEB_BASE}/profile/${ownerHandle}/collections/${parsed.rkey}`
      : null;
    out.push({ name, url });
  }
  return out;
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
  let collections: SembleCollection[] = [];
  let verb: string | null = null;
  let quote: string | null = null;

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
      // at.margin.note — a W3C-style web annotation. Surface its motivation as
      // the honest per-note verb, the highlighted passage (TextQuoteSelector
      // `.target.selector.exact`) as the quote, and the user's own words
      // (`.body.value`) as the comment. No stable public permalink, so no
      // link-out.
      const value = await getRecordValue(db, did, collection, rkey);
      if (value) {
        verb = marginVerb(value.motivation);
        const body = value.body as Record<string, unknown> | undefined;
        note = firstString(body?.value, value.text, value.comment, body?.text);
        const target = value.target as Record<string, unknown> | undefined;
        const selector = target?.selector as Record<string, unknown> | undefined;
        quote = firstString(selector?.exact);
      }
      break;
    }
    case 'semble': {
      // Cosmik card — surface its title/note, link the saver to their Semble
      // profile (the per-card page isn't built), and resolve which named
      // collection(s) they filed it into.
      if (handle) url = `${SEMBLE_WEB_BASE}/profile/${handle}`;
      const value = await getRecordValue(db, did, collection, rkey);
      if (value) {
        const content = value.content as Record<string, unknown> | undefined;
        note = firstString(content?.title, content?.note, value.title, value.note);
      }
      collections = await resolveSembleCollections(db, `at://${did}/${collection}/${rkey}`);
      break;
    }
  }

  return { did, handle, note, url, collections, verb, quote };
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

  // Discover which (collection, path) sources exist for this URL — across both
  // trailing-slash forms, since Constellation matches the target string exactly
  // (see constellationTargets) — keeping only those that bucket into the
  // requested lane, with the target form that actually carries the links.
  const sources: Array<{ target: string; collection: string; path: string }> = [];
  for (const target of constellationTargets(normUrl)) {
    const all = await constellationGet<LinksAllResponse>('/links/all', { target });
    for (const [collection, paths] of Object.entries(all?.links ?? {})) {
      for (const [path, stats] of Object.entries(paths)) {
        if (!stats?.distinct_dids) continue;
        if (laneForSource(collection, path)?.id === laneId)
          sources.push({ target, collection, path });
      }
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
      target: src.target,
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
