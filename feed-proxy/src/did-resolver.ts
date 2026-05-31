/**
 * Resolve DIDs to their PDS URL.
 *
 * Ported from the backend (backend/src/utils/did-resolver.ts) so the proxy can
 * fetch AT Protocol records directly. Results are cached in SQLite — a DID's PDS
 * rarely changes, so this avoids hammering plc.directory on every document fetch.
 */
import { Database } from 'bun:sqlite';

// PLC directory for did:plc resolution
const PLC_DIRECTORY = 'https://plc.directory';

// DID documents are effectively stable; re-resolve at most once a day.
const DID_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface DidDocument {
	id: string;
	service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

interface DidCacheRow {
	did: string;
	pds_url: string | null;
	cached_at: number;
}

function pdsFromDoc(doc: DidDocument): string | null {
	const pdsService = doc.service?.find(
		(s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
	);
	return pdsService?.serviceEndpoint || null;
}

/**
 * Resolve a DID to its PDS URL, hitting plc.directory (did:plc) or the domain's
 * /.well-known/did.json (did:web). Returns null when unresolvable.
 */
async function resolvePdsUrlUncached(did: string): Promise<string | null> {
	try {
		if (did.startsWith('did:plc:')) {
			const response = await fetch(`${PLC_DIRECTORY}/${did}`);
			if (!response.ok) return null;
			return pdsFromDoc((await response.json()) as DidDocument);
		} else if (did.startsWith('did:web:')) {
			const domain = did.replace('did:web:', '');
			const response = await fetch(`https://${domain}/.well-known/did.json`);
			if (!response.ok) return null;
			return pdsFromDoc((await response.json()) as DidDocument);
		}
		return null;
	} catch (error) {
		console.error(`[did-resolver] Failed to resolve PDS URL for ${did}:`, error);
		return null;
	}
}

/**
 * Resolve a DID to its PDS URL with a SQLite-backed cache. A null result (the DID
 * couldn't be resolved) is cached too, so a bad DID doesn't retry on every fetch
 * within the TTL.
 */
export async function resolvePdsUrl(db: Database, did: string): Promise<string | null> {
	const now = Date.now();
	const cached = db
		.query<DidCacheRow, [string]>('SELECT did, pds_url, cached_at FROM did_cache WHERE did = ?')
		.get(did);

	if (cached && now - cached.cached_at < DID_CACHE_TTL_MS) {
		return cached.pds_url;
	}

	const pdsUrl = await resolvePdsUrlUncached(did);

	db.run(
		`INSERT INTO did_cache (did, pds_url, cached_at) VALUES (?, ?, ?)
		ON CONFLICT(did) DO UPDATE SET pds_url = excluded.pds_url, cached_at = excluded.cached_at`,
		[did, pdsUrl, now]
	);

	return pdsUrl;
}
