/**
 * Network-wide article mentions, sliced by source lane (Phase 5).
 *
 * For any article URL, ask Constellation 'who across the Atmosphere referenced
 * this, and how?' — bucketed into lanes (linkblog notes / Bluesky posts /
 * margin.at highlights / Semble saves) with an honest per-lane distinct-DID
 * count and a deduped total. Computed once per *normalized* URL and cached in
 * `mention_cache`, shared by every reader and every feed the URL appears in.
 *
 * Two things make this tractable and honest:
 *
 *  - **Decay-gated re-polling.** A freshly published article has ~0 mentions the
 *    moment it enters a feed; discussion accumulates over hours/days. So a row
 *    has its own freshness curve (hot for ~48h, cooling to ~7d, then frozen),
 *    decoupled from the feed TTL — we never re-query every URL on every tick.
 *  - **Distinct-DID union, never a sum.** One Bluesky post links a URL via
 *    several paths; summing the per-path `distinct_dids` double-counts. We fetch
 *    the actual DID sets for the laned paths and union them per lane and overall.
 *
 * Adornment only: every lookup degrades silently to empty so a slow/down
 * Constellation never blocks the read.
 */
import { Database } from 'bun:sqlite';
import { normalizeArticleUrl, constellationTargets } from './url-normalize';
import { LANES, laneForSource, type LaneId } from './lanes';
import { constellationGet } from './constellation-client';
import { advertisedDocuments } from './standard-site';

// DIDs paged per (collection, path). One page is exact for the common small
// count; very popular URLs cap here and render as '<n>+'.
const LINKS_PAGE_LIMIT = 200;
// Bound total Constellation requests per enrichment (pathological URLs).
const MAX_SOURCE_QUERIES = 12;

// Decay curve — when a cached row is due for a re-poll, by URL age since first
// sighting. Discussion accumulates fast then trickles: a fresh article is hot,
// cools over a week, then settles. But the tail is never truly zero — people
// still occasionally post an old article to Bluesky or save it to Semble — so a
// settled row keeps a slow re-check rather than freezing forever. That stays
// cheap because re-checks are *demand-gated*: a settled row is only re-polled
// when someone actually opens the article (the read path), at most once per
// SETTLED_RECHECK_MS, deduped — not a sweep of every old URL.
const HOT_AGE_MS = 48 * 60 * 60 * 1000;
const HOT_RECHECK_MS = 60 * 60 * 1000;
const COOL_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COOL_RECHECK_MS = 12 * 60 * 60 * 1000;
const SETTLED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

// A backstop on how long a resolved document target is trusted. Revalidation
// normally rides the mention decay gate (a due row re-asks the origin), but the
// warm loop resets `checked_at` without ever looking at an origin — so a feed
// item could stay perpetually not-due and keep a removed advertisement alive.
// This bounds that: the read path re-asks at least this often either way.
const DOC_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export interface MentionLane {
  lane: LaneId;
  label: string;
  verb: string;
  noun: string;
  icon: string;
  count: number;
  // True when the lane's count hit the page cap and is a lower bound.
  capped: boolean;
}

export interface ArticleMentions {
  total: number;
  lanes: MentionLane[];
}

const EMPTY: ArticleMentions = { total: 0, lanes: [] };

interface MentionCacheRow {
  url_hash: string;
  url: string;
  total_dids: number;
  lanes_json: string;
  first_seen_at: number;
  checked_at: number;
  doc_uri: string | null;
  // When we last asked the article origin which document it advertises. Distinct
  // from `doc_uri`: NULL means "never looked", while a stamp with a NULL doc_uri
  // means "looked, this URL is not a document" — so a plain article doesn't pay
  // for an origin fetch on every read.
  doc_checked_at: number | null;
}

export function hashUrl(url: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(url);
  return hasher.digest('hex').slice(0, 16);
}

interface LinksAllResponse {
  links?: Record<string, Record<string, { records?: number; distinct_dids?: number }>>;
}

interface DistinctDidsResponse {
  // The exact distinct-DID count for this (collection, path), independent of how
  // many identities a single page returns.
  total?: number;
  linking_dids?: string[];
  cursor?: string;
}

// Distinct DIDs that linked `target` via one (collection, path). Asks Constellation
// for the *deduped* DID list directly (`/links/distinct-dids`) rather than raw
// linking records: one account posting a URL 200 times is one DID, not a full
// page. Returns the DID set plus whether the true count outruns the page we hold
// (so the lane count is an honest lower bound — never a "200+" inflated by a
// single chatty account, which the raw-record count would have produced).
async function fetchSourceDids(
  target: string,
  collection: string,
  path: string
): Promise<{ dids: Set<string>; capped: boolean }> {
  const data = await constellationGet<DistinctDidsResponse>('/links/distinct-dids', {
    target,
    collection,
    path,
    limit: String(LINKS_PAGE_LIMIT),
  });
  const dids = new Set(data?.linking_dids ?? []);
  // `total` is the full distinct-DID count; we only carry one page of identities
  // for the union, so we've capped when the true total exceeds what we fetched.
  const total = data?.total ?? dids.size;
  return { dids, capped: total > dids.size };
}

/**
 * Run the full Constellation lookup for a normalized URL: discover sources via
 * `/links/all`, bucket them into lanes, union distinct DIDs per lane and across
 * all lanes. Returns lanes in registry (priority) order, non-empty only.
 */
export async function computeMentions(normUrl: string, docUri?: string): Promise<ArticleMentions> {
  // Probe both trailing-slash forms (Constellation matches the target string
  // exactly) and carry the matching target with each source so we fetch its DIDs
  // against the form that actually has links. See constellationTargets.
  const sources: Array<{ target: string; laneId: LaneId; collection: string; path: string }> = [];
  let queryCount = 0;
  const targets = [...constellationTargets(normUrl), ...(docUri ? [docUri] : [])];
  for (const target of targets) {
    const isDocumentTarget = target === docUri;
    const all = await constellationGet<LinksAllResponse>('/links/all', { target });
    if (!all?.links) continue;
    // Collect the laned (collection, path) sources Constellation actually reports,
    // bounded so a pathological URL can't fan out unboundedly.
    for (const [collection, paths] of Object.entries(all.links)) {
      for (const [path, stats] of Object.entries(paths)) {
        if (!stats?.distinct_dids) continue;
        const lane = laneForSource(collection, path);
        if (!lane || (isDocumentTarget && lane.id !== 'leaflet')) continue;
        if (queryCount >= MAX_SOURCE_QUERIES) break;
        queryCount++;
        sources.push({ target, laneId: lane.id, collection, path });
      }
    }
  }

  if (sources.length === 0) return EMPTY;

  // Fetch every source's DID set in parallel, then union within and across lanes
  // (and across both target forms — one person who linked both is still one DID).
  const resolved = await Promise.all(
    sources.map((s) =>
      fetchSourceDids(s.target, s.collection, s.path).then((r) => ({
        laneId: s.laneId,
        ...r,
      }))
    )
  );

  const laneDids = new Map<LaneId, Set<string>>();
  const laneCapped = new Map<LaneId, boolean>();
  const totalDids = new Set<string>();
  for (const r of resolved) {
    const set = laneDids.get(r.laneId) ?? new Set<string>();
    for (const did of r.dids) {
      set.add(did);
      totalDids.add(did);
    }
    laneDids.set(r.laneId, set);
    if (r.capped) laneCapped.set(r.laneId, true);
  }

  // Emit in registry priority order so the lead lane is lanes[0].
  const lanes: MentionLane[] = [];
  for (const lane of LANES) {
    const count = laneDids.get(lane.id)?.size ?? 0;
    if (count === 0) continue;
    lanes.push({
      lane: lane.id,
      label: lane.label,
      verb: lane.verb,
      noun: lane.noun,
      icon: lane.icon,
      count,
      capped: laneCapped.get(lane.id) ?? false,
    });
  }

  return { total: totalDids.size, lanes };
}

// Whether a cached row is due for a re-poll given its age and last check.
function isDue(row: MentionCacheRow, now: number): boolean {
  const age = now - row.first_seen_at;
  const sinceCheck = now - row.checked_at;
  if (age < HOT_AGE_MS) return sinceCheck > HOT_RECHECK_MS;
  if (age < COOL_AGE_MS) return sinceCheck > COOL_RECHECK_MS;
  return sinceCheck > SETTLED_RECHECK_MS; // settled: slow, read-gated re-poll
}

function rowToMentions(row: MentionCacheRow): ArticleMentions {
  try {
    const lanes = JSON.parse(row.lanes_json) as MentionLane[];
    return { total: row.total_dids, lanes };
  } catch {
    return EMPTY;
  }
}

/**
 * Read the cached mention breakdown for a raw article URL, with no network call.
 * Returns the breakdown (empty when below threshold or absent), plus whether a
 * background enrichment is warranted (missing row, due per the decay gate, or
 * carrying a document target we haven't resolved yet).
 * `normUrl` is null when the URL isn't a usable http(s) target.
 *
 * `resolveDocument` is the caller saying it will let the enrichment fetch the
 * article origin (the demand-gated read path does; the warm loop doesn't), so a
 * row that has never had its document target looked up counts as enrichable
 * only for callers that can actually resolve it.
 */
export function readCachedMentions(
  db: Database,
  rawUrl: string,
  now: number,
  options: { docUri?: string; resolveDocument?: boolean } = {}
): {
  normUrl: string | null;
  mentions: ArticleMentions;
  shouldEnrich: boolean;
} {
  const normUrl = normalizeArticleUrl(rawUrl);
  if (!normUrl) return { normUrl: null, mentions: EMPTY, shouldEnrich: false };

  const row = db
    .query<MentionCacheRow, [string]>('SELECT * FROM mention_cache WHERE url_hash = ?')
    .get(hashUrl(normUrl));

  if (!row) return { normUrl, mentions: EMPTY, shouldEnrich: true };

  // Surface every real reference, down to a single linker — a row with zero DIDs
  // naturally renders empty (no lanes), so no threshold is needed to suppress it.
  const mentions = rowToMentions(row);
  const needsDocLookup = Boolean(options.resolveDocument) && !row.doc_checked_at;
  return { normUrl, mentions, shouldEnrich: needsDocLookup || isDue(row, now) };
}

/**
 * Compute and persist the mention breakdown for a normalized URL. Re-checks the
 * decay gate first (so concurrent triggers and warm-loop overlap don't re-query
 * a settled/fresh row). Preserves `first_seen_at` across updates so the decay
 * curve is anchored to first sighting, not last check. Best-effort — never throws.
 *
 * `resolveDocument` allows one bounded fetch of the article origin to learn which
 * standard.site document (if any) this URL *is* — the only way a Leaflet comment
 * is reachable, since `pub.leaflet.comment` targets the document's at:// URI and
 * never the https URL. It is demand-gated (the read path passes it, the feed warm
 * loop does not) and the answer is persisted either way, so a URL costs at most
 * one origin fetch per decay window rather than one per read.
 */
export async function enrichMentions(
  db: Database,
  normUrl: string,
  options: { docUri?: string; resolveDocument?: boolean } = {}
): Promise<void> {
  const { docUri, resolveDocument = false } = options;
  const now = Date.now();
  const existing = db
    .query<MentionCacheRow, [string]>('SELECT * FROM mention_cache WHERE url_hash = ?')
    .get(hashUrl(normUrl));
  const due = !existing || isDue(existing, now);

  // Ask the origin which document it advertises when we're recomputing anyway,
  // when we've never asked, or when the last answer has aged out. A
  // recently-resolved target is otherwise left alone — that stamp is what keeps a
  // plain article from re-fetching its own HTML on every reader who opens it.
  const docCheckedAt = existing?.doc_checked_at ?? null;
  const wantDocLookup =
    resolveDocument && (due || !docCheckedAt || now - docCheckedAt > DOC_RECHECK_MS);
  if (existing && !due && !wantDocLookup) return;

  // The document target is shared by every reader of this URL, and the origin is
  // the only authority on it: a client-supplied candidate counts only if the page
  // actually advertises it, and a URL-keyed item (a saved article, an RSS item)
  // gets the page's own target with no client involvement at all. Revalidating on
  // every due re-poll means a removed advertisement stops contributing comments.
  let docUriChanged = false;
  let effectiveDocUri = existing?.doc_uri ?? undefined;
  if (wantDocLookup) {
    const advertised = await advertisedDocuments(normUrl);
    const resolved =
      (docUri && advertised.includes(docUri) ? docUri : undefined) ?? advertised[0] ?? undefined;
    docUriChanged = (resolved ?? null) !== (existing?.doc_uri ?? null);
    effectiveDocUri = resolved;
  }

  // Nothing new to compute: a fresh row that looked for a target and found the
  // one it already had. Still record that we looked, so the next read is free.
  if (existing && !due && !docUriChanged) {
    db.run('UPDATE mention_cache SET doc_checked_at = ? WHERE url_hash = ?', [
      now,
      hashUrl(normUrl),
    ]);
    return;
  }

  let mentions: ArticleMentions;
  try {
    mentions = await computeMentions(normUrl, effectiveDocUri);
  } catch (error) {
    console.error(`[mentions] enrich error for ${normUrl}:`, error);
    return;
  }

  const firstSeen = existing?.first_seen_at ?? now;
  // A warm-loop enrich never looked for a target, so it must not stamp
  // `doc_checked_at` — that would tell the read path the lookup was already done.
  const nextDocCheckedAt = wantDocLookup ? now : docCheckedAt;
  db.run(
    `INSERT INTO mention_cache (url_hash, url, total_dids, lanes_json, first_seen_at, checked_at, doc_uri, doc_checked_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(url_hash) DO UPDATE SET
			total_dids = excluded.total_dids,
			lanes_json = excluded.lanes_json,
			checked_at = excluded.checked_at,
			doc_uri = excluded.doc_uri,
			doc_checked_at = excluded.doc_checked_at`,
    [
      hashUrl(normUrl),
      normUrl,
      mentions.total,
      JSON.stringify(mentions.lanes),
      firstSeen,
      now,
      effectiveDocUri ?? null,
      nextDocCheckedAt,
    ]
  );
}
