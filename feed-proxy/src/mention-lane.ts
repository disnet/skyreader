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
 * whole thing is adornment — a per-record failure degrades to an emptier entry,
 * and the assembled result is cached briefly in `constellation_cache` (shared
 * with the Phase 3 context bundle; same short TTL since the index is
 * firehose-fresh).
 *
 * The one failure that does NOT degrade silently is the index itself being
 * unreachable: an empty list is a claim ("nobody wrote about this") the reader
 * acts on, so we raise MentionLaneUnavailableError instead and let the surface
 * offer a retry.
 */
import { Database } from 'bun:sqlite';
import { normalizeArticleUrl, constellationTargets } from './url-normalize';
import { laneForSource, type LaneId } from './lanes';
import { resolveHandle, resolvePdsUrl } from './did-resolver';
import { safeFetch } from './ssrf-guard';
import { resolveSiteMeta, buildCanonicalUrl, parseAtUri } from './standard-site';
import { constellationGet, constellationGetResult } from './constellation-client';
import { extractContentText } from './document-content';
import { fetchSembleContext, type SembleContext } from './semble-client';

// The one-per-user Skyreader linkblog publication rkey (see backend
// linkblog-sync). Used only as a link-out fallback for our own docs.
const LINKBLOG_PUBLICATION_RKEY = 'skyreader-links';

const FETCH_TIMEOUT_MS = 10 * 1000;

// Firehose-fresh index → keep the assembled list only briefly.
const CACHE_TTL_MS = 5 * 60 * 1000;
// A person's name and avatar change far more slowly than the link index, and the
// lookup costs a PDS round trip per author, so it gets its own long TTL. Held
// well inside the table's 24h sweep (see app.ts).
const PROFILE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
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
  // The author's own name + avatar from their app.bsky.actor.profile record, so
  // a lane reads as people rather than as a list of DIDs. Both null when they
  // have no profile record (or it can't be resolved) — the UI falls back to a
  // monogram and the handle.
  displayName: string | null;
  avatar: string | null;
  // When the reference itself was written (the record's own timestamp, ISO), so
  // the surface can sort one merged discussion chronologically across lanes.
  // Null when the record carries no usable date.
  createdAt: string | null;
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

export interface MentionLaneItemsResult {
  entries: MentionLaneEntry[];
  sembleContext?: SembleContext;
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
    const res = await safeFetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?${qs}`, {
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
// leading body text block (a Skyreader/leaflet/pckt/offprint note, when there's
// no description) and finally plain textContent. The body walk is format-aware
// (extractContentText) so a pckt or offprint post yields its note too, not just
// leaflet ones.
function extractDocumentSnippet(value: Record<string, unknown>): string | null {
  const description = firstString(value.description);
  if (description) return description;
  return firstString(extractContentText(value.content), value.textContent);
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

// The author's public profile, as the reader would recognize them: the display
// name and avatar from their app.bsky.actor.profile record. Read straight from
// their PDS (the same path every other record here takes) rather than through an
// appview, so a person with no Bluesky presence still resolves. Cached on its own
// long TTL because a name and face outlive the link index by a wide margin.
async function resolveProfile(db: Database, did: string): Promise<AuthorProfile> {
  const key = `profile:${did}`;
  const now = Date.now();
  const cached = db
    .query<
      CacheRow,
      [string]
    >('SELECT cache_key, context_json, cached_at FROM constellation_cache WHERE cache_key = ?')
    .get(key);
  if (cached && now - cached.cached_at < PROFILE_CACHE_TTL_MS) {
    try {
      return JSON.parse(cached.context_json) as AuthorProfile;
    } catch {
      // fall through and re-resolve
    }
  }

  const value = await getRecordValue(db, did, 'app.bsky.actor.profile', 'self');
  const displayName = firstString(value?.displayName);
  const cid = firstString((value?.avatar as { ref?: { $link?: unknown } })?.ref?.$link);
  const profile: AuthorProfile = {
    displayName,
    // The Bluesky CDN serves any repo's avatar blob by DID + CID (same shape the
    // backend uses for publication icons), which keeps us off the PDS for images.
    avatar: cid ? `https://cdn.bsky.app/img/avatar/plain/${did}/${cid}@jpeg` : null,
  };
  // Cache the miss too — a DID with no profile record shouldn't re-fetch on
  // every expand.
  writeCacheJson(db, key, profile, now);
  return profile;
}

interface AuthorProfile {
  displayName: string | null;
  avatar: string | null;
}

// The record's own timestamp, normalized to ISO. Each lexicon spells it
// differently (a post has `createdAt`, a standard.site document `publishedAt`, a
// margin.at note `created`), so the caller passes the keys in priority order.
// Anything unparseable degrades to null and simply sorts last.
function recordDate(value: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!value) return null;
  for (const key of keys) {
    const raw = firstString(value[key]);
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
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
  // Identity and the record itself are independent lookups — run them together
  // so adding the profile doesn't add a round trip to the entry's latency.
  const [handle, profile, value] = await Promise.all([
    resolveHandle(db, did),
    resolveProfile(db, did),
    getRecordValue(db, did, collection, rkey),
  ]);
  let url: string | null = null;
  let note: string | null = null;
  let collections: SembleCollection[] = [];
  let verb: string | null = null;
  let quote: string | null = null;
  let createdAt: string | null = null;

  switch (laneId) {
    case 'bluesky': {
      url = `https://bsky.app/profile/${did}/post/${rkey}`;
      if (value) note = firstString(value.text);
      createdAt = recordDate(value, 'createdAt');
      break;
    }
    case 'linkblog': {
      if (value) {
        note = extractDocumentSnippet(value);
        url = await resolveDocumentUrl(db, did, rkey, value);
      }
      createdAt = recordDate(value, 'publishedAt', 'createdAt');
      break;
    }
    case 'margin': {
      // at.margin.note — a W3C-style web annotation. Surface its motivation as
      // the honest per-note verb, the highlighted passage (TextQuoteSelector
      // `.target.selector.exact`) as the quote, and the user's own words
      // (`.body.value`) as the comment. No stable public permalink, so no
      // link-out.
      if (value) {
        verb = marginVerb(value.motivation);
        const body = value.body as Record<string, unknown> | undefined;
        note = firstString(body?.value, value.text, value.comment, body?.text);
        const target = value.target as Record<string, unknown> | undefined;
        const selector = target?.selector as Record<string, unknown> | undefined;
        quote = firstString(selector?.exact);
      }
      createdAt = recordDate(value, 'created', 'createdAt');
      break;
    }
    case 'semble': {
      // Cosmik card — surface its title/note, link the saver to their Semble
      // profile (the per-card page isn't built), and resolve which named
      // collection(s) they filed it into.
      if (handle) url = `${SEMBLE_WEB_BASE}/profile/${handle}`;
      if (value) {
        const content = value.content as Record<string, unknown> | undefined;
        note = firstString(content?.title, content?.note, value.title, value.note);
      }
      createdAt = recordDate(value, 'createdAt', 'created');
      collections = await resolveSembleCollections(db, `at://${did}/${collection}/${rkey}`);
      break;
    }
  }

  return {
    did,
    handle,
    displayName: profile.displayName,
    avatar: profile.avatar,
    createdAt,
    note,
    url,
    collections,
    verb,
    quote,
  };
}

function cacheKey(laneId: LaneId, normUrl: string): string {
  return `lane-items2:${laneId}|${normUrl}`;
}

/**
 * Constellation never answered, so we don't know whether anyone wrote about this
 * article. Thrown rather than returned as `[]` because the two are different
 * things to a reader: an empty list says "nobody", and the surface is entitled
 * to say that plainly. Only raised when we came back with nothing at all — a
 * partial outage that still yielded people resolves normally.
 */
export class MentionLaneUnavailableError extends Error {
  constructor() {
    super('Constellation unavailable');
    this.name = 'MentionLaneUnavailableError';
  }
}

/**
 * Resolve the people inside one lane for an article URL, served from
 * `constellation_cache` when fresh. Returns an empty list for a bad URL, an
 * unknown lane, or a PDS failure on an individual record. Throws
 * `MentionLaneUnavailableError` when Constellation itself couldn't be reached
 * and nothing resolved — nothing is cached in that case, so the reader's retry
 * hits the network rather than a cached "nobody".
 */
export async function getMentionLaneItems(
  db: Database,
  rawUrl: string,
  laneId: LaneId
): Promise<MentionLaneItemsResult> {
  const normUrl = normalizeArticleUrl(rawUrl);
  if (!normUrl) return { entries: [] };

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
      const parsed = JSON.parse(cached.context_json) as MentionLaneItemsResult;
      if (parsed && Array.isArray(parsed.entries)) return parsed;
    } catch {
      // fall through and recompute
    }
  }

  // Semble's URL API already hydrates all public categories. Keep the legacy
  // entries alongside the richer context so the merged human stream remains
  // backward compatible. If every API category fails we continue into the
  // existing Constellation/PDS saver resolver below.
  if (laneId === 'semble') {
    const sembleContext = await fetchSembleContext(normUrl);
    if (sembleContext) {
      const entries: MentionLaneEntry[] = sembleContext.savers.map((saver) => ({
        did: saver.author.did,
        handle: saver.author.handle || null,
        displayName: saver.author.name,
        avatar: saver.author.avatarUrl,
        createdAt: saver.savedAt,
        note: saver.note,
        url: saver.author.handle ? `${SEMBLE_WEB_BASE}/profile/${saver.author.handle}` : null,
        collections: saver.collections.map((c) => ({ name: c.name, url: c.url })),
        verb: null,
        quote: null,
      }));
      const result = { entries, sembleContext };
      writeCacheJson(db, key, result, now);
      return result;
    }
  }

  // Discover which (collection, path) sources exist for this URL — across both
  // trailing-slash forms, since Constellation matches the target string exactly
  // (see constellationTargets) — keeping only those that bucket into the
  // requested lane, with the target form that actually carries the links.
  const sources: Array<{ target: string; collection: string; path: string }> = [];
  // Set by any call the host didn't answer. An empty result that carries this is
  // "we don't know", not "nobody" — see MentionLaneUnavailableError.
  let unreachable = false;
  for (const target of constellationTargets(normUrl)) {
    const all = await constellationGetResult<LinksAllResponse>('/links/all', { target });
    if (!all.reachable) unreachable = true;
    for (const [collection, paths] of Object.entries(all.data?.links ?? {})) {
      for (const [path, stats] of Object.entries(paths)) {
        if (!stats?.distinct_dids) continue;
        if (laneForSource(collection, path)?.id === laneId)
          sources.push({ target, collection, path });
      }
    }
  }
  if (sources.length === 0) {
    if (unreachable) throw new MentionLaneUnavailableError();
    // Cache the empty result too, so a lane with no people isn't re-queried on
    // every expand within the TTL.
    const result: MentionLaneItemsResult = { entries: [] };
    writeCacheJson(db, key, result, now);
    return result;
  }

  // Gather linking records across this lane's sources, dedup by author (a person
  // may link via several paths), capped.
  const seen = new Set<string>();
  const picked: Array<{ did: string; collection: string; rkey: string }> = [];
  for (const src of sources) {
    if (picked.length >= MAX_ENTRIES) break;
    const links = await constellationGetResult<LinksResponse>('/links', {
      target: src.target,
      collection: src.collection,
      path: src.path,
      limit: String(LINKS_PAGE_LIMIT),
    });
    if (!links.reachable) unreachable = true;
    for (const rec of links.data?.linking_records ?? []) {
      if (seen.has(rec.did)) continue;
      seen.add(rec.did);
      picked.push({ did: rec.did, collection: rec.collection, rkey: rec.rkey });
      if (picked.length >= MAX_ENTRIES) break;
    }
  }
  // The index said this lane has people; if we then couldn't reach it to ask who,
  // an empty list would read as "nobody" — which is the one thing we know is
  // false here.
  if (picked.length === 0 && unreachable) throw new MentionLaneUnavailableError();

  const entries = await Promise.all(picked.map((rec) => resolveEntry(db, laneId, rec)));
  const result: MentionLaneItemsResult =
    laneId === 'semble'
      ? {
          entries,
          sembleContext: {
            stats: null,
            savers: [],
            notes: [],
            collections: [],
            connections: [],
            truncated: { savers: false, notes: false, collections: false, connections: false },
            incomplete: true,
            source: 'constellation-fallback',
          },
        }
      : { entries };
  writeCacheJson(db, key, result, now);
  return result;
}

// Shared upsert for anything this module parks in `constellation_cache` (the
// assembled lane list, a resolved author profile). Each key carries its own TTL
// on read.
function writeCacheJson(db: Database, key: string, value: unknown, now: number): void {
  db.run(
    `INSERT INTO constellation_cache (cache_key, context_json, cached_at) VALUES (?, ?, ?)
		ON CONFLICT(cache_key) DO UPDATE SET context_json = excluded.context_json, cached_at = excluded.cached_at`,
    [key, JSON.stringify(value), now]
  );
}
