/**
 * The Skyreader linkblog registry (Phase 6).
 *
 * Every `site.standard.publication` we write carries one constant marker field
 * (`skyreaderLinkblog: "https://skyreader.app/linkblog"`), so Constellation —
 * which indexes URI values at arbitrary record paths — turns that single target
 * into a network-wide registry of *everyone with a Skyreader linkblog*. One
 * backlink query enumerates them all; no maintained indexer of our own.
 *
 *   GET /links?target=https://skyreader.app/linkblog
 *       &collection=site.standard.publication&path=.skyreaderLinkblog
 *
 * The result is a slowly-changing global list, identical for every user, so we
 * cache it once here (longer TTL than the per-post social context — the set of
 * people who *have* a linkblog churns far slower than recommend counts). The
 * backend intersects it with a user's Bluesky follows for onboarding, or lists it
 * whole for /discover.
 */
import { Database } from 'bun:sqlite';

const CONSTELLATION_BASE = 'https://constellation.microcosm.blue';

// The constant marker — MUST match backend LINKBLOG_MARKER_URL exactly, or the
// registry won't find the publications it stamps.
const MARKER_URL = 'https://skyreader.app/linkblog';
const PUBLICATION_COLLECTION = 'site.standard.publication';
const MARKER_PATH = '.skyreaderLinkblog';

// Who-has-a-linkblog changes slowly; refresh a populated registry every 15 min.
const REGISTRY_TTL_MS = 15 * 60 * 1000;
// An *empty* result is treated as provisional, not settled — a transient
// Constellation hiccup (or querying before the firehose has indexed the first
// stamped publication) returns zero, and we must not freeze that for 15 min.
// Re-check empties aggressively so the registry converges as soon as data exists.
const EMPTY_TTL_MS = 60 * 1000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 25; // hard cap (~5k authors) so a runaway cursor can't loop.
const FETCH_TIMEOUT_MS = 10 * 1000;

const CONSTELLATION_HEADERS = {
	'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)',
};

interface ConstellationLinksResponse {
	linking_records?: Array<{ did: string; collection: string; rkey: string }>;
	cursor?: string;
}

interface RegistryCacheRow {
	dids_json: string;
	cached_at: number;
}

// Page through Constellation's backlinks for the marker, collecting distinct
// author DIDs. Returns null on a *total* failure (first page errored) so the
// caller can fall back to a stale cache; a mid-pagination failure returns
// whatever resolved so far (better a partial registry than none).
async function fetchRegistryFromConstellation(): Promise<string[] | null> {
	const seen = new Set<string>();
	let cursor: string | undefined;

	for (let page = 0; page < MAX_PAGES; page++) {
		const params = new URLSearchParams({
			target: MARKER_URL,
			collection: PUBLICATION_COLLECTION,
			path: MARKER_PATH,
			limit: String(PAGE_LIMIT),
		});
		if (cursor) params.set('cursor', cursor);

		let data: ConstellationLinksResponse | null = null;
		try {
			const res = await fetch(`${CONSTELLATION_BASE}/links?${params}`, {
				headers: CONSTELLATION_HEADERS,
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (res.ok) data = (await res.json()) as ConstellationLinksResponse;
			else console.error(`[linkblog-registry] Constellation returned HTTP ${res.status}`);
		} catch (error) {
			console.error('[linkblog-registry] fetch error:', error);
		}
		if (!data) return seen.size > 0 ? [...seen] : null;

		for (const rec of data.linking_records ?? []) {
			if (rec.did) seen.add(rec.did);
		}
		if (!data.cursor || (data.linking_records?.length ?? 0) === 0) break;
		cursor = data.cursor;
	}

	return [...seen];
}

/**
 * The set of DIDs that have a Skyreader linkblog, served from
 * `linkblog_registry_cache` when fresh. On a Constellation outage it degrades to
 * the last cached value (or an empty list), never throwing — discovery is an
 * adornment, like the rest of the Constellation layer.
 */
export async function getLinkblogRegistry(db: Database): Promise<string[]> {
	const now = Date.now();
	const cached = db
		.query<RegistryCacheRow, [string]>(
			'SELECT dids_json, cached_at FROM linkblog_registry_cache WHERE marker = ?'
		)
		.get(MARKER_URL);
	if (cached) {
		const parsed = JSON.parse(cached.dids_json) as string[];
		// Populated registries are trusted for the full TTL; empty ones only briefly.
		const ttl = parsed.length > 0 ? REGISTRY_TTL_MS : EMPTY_TTL_MS;
		if (now - cached.cached_at < ttl) return parsed;
	}

	const dids = await fetchRegistryFromConstellation();
	if (dids === null) {
		// Constellation unreachable — serve stale if we have it, else empty.
		return cached ? (JSON.parse(cached.dids_json) as string[]) : [];
	}

	db.run(
		`INSERT INTO linkblog_registry_cache (marker, dids_json, cached_at) VALUES (?, ?, ?)
		ON CONFLICT(marker) DO UPDATE SET dids_json = excluded.dids_json, cached_at = excluded.cached_at`,
		[MARKER_URL, JSON.stringify(dids), now]
	);
	return dids;
}
