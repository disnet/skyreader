/**
 * URL canonicalization — the cross-app JOIN KEY for external-backed saves.
 *
 * This is a FAITHFUL PORT of `feed-proxy/src/url-normalize.ts`. The same article
 * saved natively, via a backing collection, or by two different Atmospheric apps
 * must collapse to one key, and the feed-proxy mention lanes already key on this
 * exact form — so backend dedup MUST produce byte-identical output. If you change
 * one copy, change both. (See docs/plans/EXTERNAL_BACKED_SAVES_PLAN.md — "the join
 * key is url_normalized".)
 *
 * Two deliberate non-normalizations (preserved from feed-proxy): scheme is kept
 * (http feeds stay http) and `www` is kept — both because downstream matching is
 * against the exact string people share, which is normally the site's own canonical.
 */

// Query params that are pure tracking / session noise — stripped before matching.
// Keep in sync with feed-proxy/src/url-normalize.ts.
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'ref',
  'ref_src',
  'ref_url',
  'source',
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'igsh',
  'si',
  'spm',
  'cmpid',
  '_hsenc',
  '_hsmi',
  'vero_id',
  'oly_anon_id',
  'oly_enc_id',
]);

/**
 * Canonicalize an article URL for cross-app dedup. Returns `null` for inputs that
 * aren't http(s) URLs (skip them — e.g. a Semble `type:NOTE` card has no URL).
 *
 * - lowercases host (but keeps `www`)
 * - removes the default port and the fragment
 * - strips tracking query params, sorts the rest for a stable key
 * - trims a trailing slash (except on the bare root)
 */
export function normalizeArticleUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  url.port = '';

  // Strip tracking params, keep + sort the rest so equivalent URLs key the same.
  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);

  // Trim a single trailing slash on a non-root path.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}
