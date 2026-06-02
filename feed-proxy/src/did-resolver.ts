/**
 * Resolve DIDs to their PDS URL (and handle).
 *
 * Ported from the backend (backend/src/utils/did-resolver.ts) so the proxy can
 * fetch AT Protocol records directly. Results are cached in SQLite — a DID's PDS
 * rarely changes, so this avoids hammering plc.directory on every document fetch.
 *
 * The same DID document also carries the handle (`alsoKnownAs`), so we resolve and
 * cache both in one fetch; `resolveHandle` reuses the cached row when present.
 */
import { Database } from 'bun:sqlite';

// PLC directory for did:plc resolution
const PLC_DIRECTORY = 'https://plc.directory';

// DID documents are effectively stable; re-resolve at most once a day.
const DID_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface DidDocument {
  id: string;
  alsoKnownAs?: string[];
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

interface DidCacheRow {
  did: string;
  pds_url: string | null;
  handle: string | null;
  cached_at: number;
}

interface ResolvedDid {
  pdsUrl: string | null;
  handle: string | null;
}

function pdsFromDoc(doc: DidDocument): string | null {
  const pdsService = doc.service?.find(
    (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer'
  );
  return pdsService?.serviceEndpoint || null;
}

// The handle is the first `at://`-prefixed entry in `alsoKnownAs`, sans scheme.
function handleFromDoc(doc: DidDocument): string | null {
  const aka = doc.alsoKnownAs?.find((a) => a.startsWith('at://'));
  return aka ? aka.slice('at://'.length) : null;
}

/**
 * Resolve a DID document to its PDS URL + handle, hitting plc.directory (did:plc)
 * or the domain's /.well-known/did.json (did:web). Returns nulls when
 * unresolvable.
 */
async function resolveDidUncached(did: string): Promise<ResolvedDid> {
  try {
    let doc: DidDocument | null = null;
    if (did.startsWith('did:plc:')) {
      const response = await fetch(`${PLC_DIRECTORY}/${did}`);
      if (response.ok) doc = (await response.json()) as DidDocument;
    } else if (did.startsWith('did:web:')) {
      const domain = did.replace('did:web:', '');
      const response = await fetch(`https://${domain}/.well-known/did.json`);
      if (response.ok) doc = (await response.json()) as DidDocument;
    }
    if (!doc) return { pdsUrl: null, handle: null };
    return { pdsUrl: pdsFromDoc(doc), handle: handleFromDoc(doc) };
  } catch (error) {
    console.error(`[did-resolver] Failed to resolve ${did}:`, error);
    return { pdsUrl: null, handle: null };
  }
}

// Read a still-fresh cache row, or null if missing/stale.
function readFreshCache(db: Database, did: string): DidCacheRow | null {
  const cached = db
    .query<
      DidCacheRow,
      [string]
    >('SELECT did, pds_url, handle, cached_at FROM did_cache WHERE did = ?')
    .get(did);
  if (cached && Date.now() - cached.cached_at < DID_CACHE_TTL_MS) return cached;
  return null;
}

// Resolve the DID document once and persist both pds_url + handle.
async function resolveAndCache(db: Database, did: string): Promise<ResolvedDid> {
  const resolved = await resolveDidUncached(did);
  db.run(
    `INSERT INTO did_cache (did, pds_url, handle, cached_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(did) DO UPDATE SET pds_url = excluded.pds_url, handle = excluded.handle, cached_at = excluded.cached_at`,
    [did, resolved.pdsUrl, resolved.handle, Date.now()]
  );
  return resolved;
}

/**
 * Resolve a DID to its PDS URL with a SQLite-backed cache. A null result (the DID
 * couldn't be resolved) is cached too, so a bad DID doesn't retry on every fetch
 * within the TTL.
 */
export async function resolvePdsUrl(db: Database, did: string): Promise<string | null> {
  const cached = readFreshCache(db, did);
  if (cached) return cached.pds_url;
  return (await resolveAndCache(db, did)).pdsUrl;
}

/**
 * Resolve a DID to its handle (e.g. `alice.bsky.social`), cached alongside the
 * PDS URL. Returns null when unresolvable.
 */
export async function resolveHandle(db: Database, did: string): Promise<string | null> {
  const cached = readFreshCache(db, did);
  if (cached) return cached.handle;
  return (await resolveAndCache(db, did)).handle;
}
