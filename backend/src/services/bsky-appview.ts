// Thin client for the public Bluesky AppView (read-only, no auth) — used by
// linkblog discovery (Phase 6) to fetch a user's follows and resolve profiles.
//
// The public AppView serves the social graph and profile views without auth, so
// these are plain GETs keyed by DID. Everything degrades gracefully: a failed
// page just ends pagination, a failed profile batch is skipped. Discovery is an
// adornment — never let it throw into a route.

import { log, serializeError } from '../utils/logger';

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
  return {
    did: p.did,
    handle: p.handle,
    displayName: p.displayName,
    avatar: p.avatar,
  };
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
 * Like counts for a set of post at-uris. A post that's gone (deleted, or taken
 * down) is simply absent, as is every post in a batch that failed.
 */
export async function fetchPostLikeCounts(uris: string[]): Promise<Map<string, number>> {
  const { posts } = await fetchPosts<{ uri?: string; likeCount?: number }>(uris);
  const counts = new Map<string, number>();
  for (const [uri, p] of posts) {
    if (typeof p.likeCount === 'number') counts.set(uri, p.likeCount);
  }
  return counts;
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

const GET_POSTS_MAX = 25;

type GetPostsBatch<T> = { ok: true; posts: T[] } | { ok: false; rejected: boolean };

async function getPostsBatch<T>(uris: string[]): Promise<GetPostsBatch<T>> {
  const params = new URLSearchParams();
  for (const uri of uris) params.append('uris', uri);
  try {
    const res = await fetch(`${APPVIEW_BASE}/xrpc/app.bsky.feed.getPosts?${params}`);
    if (!res.ok) {
      log.warn('bsky_appview_get_posts_failed', { status: res.status, uris: uris.length });
      // A 4xx is the request (a uri the appview won't take), not the appview.
      return { ok: false, rejected: res.status >= 400 && res.status < 500 && res.status !== 429 };
    }
    const data = (await res.json()) as { posts?: T[] };
    return { ok: true, posts: data.posts ?? [] };
  } catch (error) {
    log.warn('bsky_appview_get_posts_failed', { uris: uris.length, ...serializeError(error) });
    return { ok: false, rejected: false };
  }
}

/**
 * Full post views for a set of post at-uris, batched at getPosts' 25-uri limit
 * and fetched in parallel, as uri → view. Posts that are gone or withheld from
 * logged-out viewers are simply absent. A batch the appview rejects is retried
 * one uri at a time, so one uri it won't take costs only itself. `complete` is
 * false when a batch failed for any other reason (5xx, rate limit, network), so
 * a caller walking a high-water mark can hold it rather than skip what the
 * failed batch held.
 */
export async function fetchPosts<T extends { uri?: string }>(
  uris: string[]
): Promise<{ posts: Map<string, T>; complete: boolean }> {
  const batches: string[][] = [];
  for (let i = 0; i < uris.length; i += GET_POSTS_MAX) {
    batches.push(uris.slice(i, i + GET_POSTS_MAX));
  }
  const fetchBatch = async (batch: string[]): Promise<{ posts: T[]; complete: boolean }> => {
    const res = await getPostsBatch<T>(batch);
    if (res.ok) return { posts: res.posts, complete: true };
    if (!res.rejected) return { posts: [], complete: false };
    if (batch.length === 1) return { posts: [], complete: true };
    const singles = await Promise.all(batch.map((uri) => fetchBatch([uri])));
    return {
      posts: singles.flatMap((r) => r.posts),
      complete: singles.every((r) => r.complete),
    };
  };
  const results = await Promise.all(batches.map(fetchBatch));
  const posts = new Map<string, T>();
  for (const r of results) {
    for (const p of r.posts) if (p.uri) posts.set(p.uri, p);
  }
  return { posts, complete: results.every((r) => r.complete) };
}
