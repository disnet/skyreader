/**
 * Per-scope document content digests, persisted in localStorage.
 *
 * The proxy hashes each publication scope's `(recordUri, recordCid)` set into an
 * opaque digest; the client echoes the last digest it saw as `since_digest`, and a
 * match returns a bodyless `unchanged` response (no re-download of the unchanged
 * ≤100-doc blob). We only ever store the opaque string — the cid stays
 * server-side.
 *
 * localStorage (not Dexie) because losing the map is self-healing: a missing
 * digest just causes one cold-start full fetch for that scope, so it never
 * warrants a schema migration.
 */

const STORAGE_KEY = 'skyreader-document-digests';

/** Stable key for one (author, publication) scope. `did|` for the all-pubs scope. */
export function scopeKey(did: string, siteUri?: string): string {
  return `${did}|${siteUri ?? ''}`;
}

/** Load the `{ scopeKey → digest }` map; returns `{}` on any miss/parse error. */
export function loadDigests(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Persist the `{ scopeKey → digest }` map; swallows quota/serialization errors. */
export function saveDigests(map: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Self-healing: a failed write just means a cold-start fetch next poll.
  }
}
