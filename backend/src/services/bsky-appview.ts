// Thin client for the public Bluesky AppView (read-only, no auth) — used by
// linkblog discovery (Phase 6) to fetch a user's follows and resolve profiles.
//
// The public AppView serves the social graph and profile views without auth, so
// these are plain GETs keyed by DID. Everything degrades gracefully: a failed
// page just ends pagination, a failed profile batch is skipped. Discovery is an
// adornment — never let it throw into a route.

const APPVIEW_BASE = 'https://public.api.bsky.app';

// The subset of an actor's profile we render: avatar + handle + display name.
export interface BskyProfileLite {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

interface GetFollowsResponse {
  follows?: BskyProfileLite[];
  cursor?: string;
}

interface GetProfilesResponse {
  profiles?: BskyProfileLite[];
}

function toLite(p: BskyProfileLite): BskyProfileLite {
  return { did: p.did, handle: p.handle, displayName: p.displayName, avatar: p.avatar };
}

/**
 * Every account `actor` follows on Bluesky, with their profile basics. Paginated
 * (100/page) up to `maxPages` (default 20 → 2000 follows) so a celebrity-sized
 * follow graph can't run unbounded; the cap is logged-silent (we just stop).
 */
export async function fetchFollows(actor: string, maxPages = 20): Promise<BskyProfileLite[]> {
  const out: BskyProfileLite[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ actor, limit: '100' });
    if (cursor) params.set('cursor', cursor);

    let data: GetFollowsResponse | null = null;
    try {
      const res = await fetch(`${APPVIEW_BASE}/xrpc/app.bsky.graph.getFollows?${params}`);
      if (res.ok) data = (await res.json()) as GetFollowsResponse;
    } catch (error) {
      console.error('[bsky-appview] getFollows error:', error);
    }
    if (!data) break;

    for (const f of data.follows ?? []) out.push(toLite(f));
    if (!data.cursor || (data.follows?.length ?? 0) === 0) break;
    cursor = data.cursor;
  }

  return out;
}

/**
 * Resolve a set of DIDs to profile basics, batched at the AppView's 25-actor
 * limit. Returns a DID→profile map; DIDs that fail to resolve are simply absent.
 */
export async function fetchProfiles(dids: string[]): Promise<Map<string, BskyProfileLite>> {
  const map = new Map<string, BskyProfileLite>();

  for (let i = 0; i < dids.length; i += 25) {
    const batch = dids.slice(i, i + 25);
    const params = new URLSearchParams();
    for (const did of batch) params.append('actors', did);

    try {
      const res = await fetch(`${APPVIEW_BASE}/xrpc/app.bsky.actor.getProfiles?${params}`);
      if (!res.ok) continue;
      const data = (await res.json()) as GetProfilesResponse;
      for (const p of data.profiles ?? []) map.set(p.did, toLite(p));
    } catch (error) {
      console.error('[bsky-appview] getProfiles error:', error);
    }
  }

  return map;
}
