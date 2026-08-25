/**
 * The one engagement number the Atmosphere actually publishes: a Bluesky post's
 * like count, read from the public appview.
 *
 * The discussion stream ranks its entries by engagement, and only the Bluesky
 * lane has a per-entry metric to rank by — a linkblog note, a margin.at
 * annotation and a Semble card each *are* one save, with no second-order signal
 * attached. So this is deliberately small: one batched `app.bsky.feed.getPosts`
 * per lane expand, behind the lane's own cache. The same response carries each
 * post's own timestamp, which comes along free and gives the caller a recency
 * tiebreak over candidates it hasn't fetched from their PDS yet.
 *
 * Entirely best-effort. Every failure — a timeout, a 5xx, a post the appview no
 * longer serves — yields an absent entry in the map, and the caller falls back
 * to the recency order it used before. A missing adornment is not an error, so
 * nothing here throws and nothing routes through the Constellation breaker (a
 * different host, with its own health).
 */

const APPVIEW_BASE = 'https://public.api.bsky.app/xrpc';
/**
 * getPosts' own documented cap, and therefore the size of the candidate pool a
 * lane can rank in one call (see MAX_RANKED_CANDIDATES in mention-lane.ts). The
 * slice below is a guard, not a pager: a caller that hands over more URIs than
 * this loses the tail rather than paging for it.
 */
export const GET_POSTS_MAX_URIS = 25;
const FETCH_TIMEOUT_MS = 10 * 1000;
const HEADERS = {
  'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)',
  Accept: 'application/json',
};

interface GetPostsResponse {
  posts?: Array<{ uri?: unknown; likeCount?: unknown; record?: { createdAt?: unknown } }>;
}

/** What one batched call tells us about a post: how carried it is, and when. */
export interface PostEngagement {
  likeCount: number;
  // The post's own timestamp, so a caller ranking candidates can break ties on
  // recency without paying a PDS round trip per candidate to learn the date.
  // Null when the record carries none.
  createdAt: string | null;
}

/**
 * Engagement for a batch of `at://` post URIs, keyed by the URI the appview
 * echoes back. URIs the appview omits (deleted, blocked, never existed) are
 * simply absent — as is every URI when the call fails outright.
 */
export async function fetchPostEngagement(uris: string[]): Promise<Map<string, PostEngagement>> {
  const out = new Map<string, PostEngagement>();
  const wanted = [...new Set(uris.filter((uri) => uri.startsWith('at://')))].slice(
    0,
    GET_POSTS_MAX_URIS
  );
  if (wanted.length === 0) return out;

  try {
    const qs = new URLSearchParams();
    for (const uri of wanted) qs.append('uris', uri);
    // A fixed, trusted host: no SSRF surface, so this skips safeFetch's DNS pass.
    const res = await fetch(`${APPVIEW_BASE}/app.bsky.feed.getPosts?${qs}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as GetPostsResponse;
    for (const post of data.posts ?? []) {
      if (typeof post?.uri !== 'string') continue;
      const count = post.likeCount;
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) continue;
      const createdAt = post.record?.createdAt;
      out.set(post.uri, {
        likeCount: Math.floor(count),
        createdAt: typeof createdAt === 'string' ? createdAt : null,
      });
    }
  } catch (error) {
    console.error('[bsky-appview] getPosts error:', error);
  }
  return out;
}
