/**
 * URL canonicalization for Constellation mention lookups (Phase 5).
 *
 * Constellation matches the target **string exactly**, but a feed's article URL
 * almost never equals the URL someone pasted into Bluesky: tracking params,
 * trailing slash, `www`, fragments. Without normalization the mention lookup
 * returns false zeros for articles that have real discussion and feels broken.
 *
 * This is deliberately a *single* canonical form (not a multi-variant probe) —
 * good enough for v1, and the one place to tune if matching proves lossy. Two
 * deliberate non-normalizations, both because Constellation matches the exact
 * string people shared and a feed's article URL is normally the site's own
 * canonical (which is also what gets pasted):
 *
 *  - **Scheme is preserved** (http feeds stay http) — upgrading would mismatch
 *    linkers who pasted the http form; almost everything is https anyway.
 *  - **`www` is preserved** — verified live: stripping it turned
 *    `https://www.theverge.com/` (30+ real linkers) into a false zero, because
 *    the shared URL keeps the `www`.
 */

// Query params that are pure tracking / session noise — stripped before matching.
// Anything not listed is preserved (some sites key real content off `?p=`, `?id=`).
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

// Short parameter names are too ambiguous to strip everywhere. Substack uses
// `r` exclusively as a reader/referral token on post URLs, while another site
// may use the same name to select real content.
function isHostTrackingParam(hostname: string, key: string): boolean {
  return key === 'r' && (hostname === 'substack.com' || hostname.endsWith('.substack.com'));
}

/**
 * Canonicalize an article URL for mention matching. Returns `null` for inputs
 * that aren't http(s) URLs (skip them — no mentions to look up).
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
    const lowerKey = key.toLowerCase();
    if (TRACKING_PARAMS.has(lowerKey) || isHostTrackingParam(url.hostname, lowerKey)) continue;
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

/**
 * The trailing-slash variants of a normalized URL to probe in Constellation.
 *
 * Constellation matches the target **string exactly**, but `/foo` and `/foo/`
 * are the same page on essentially every server and people share both forms —
 * the site's own canonical varies (inkandswitch and many doc sites canonicalize
 * *with* a slash; lots of blogs without). `normalizeArticleUrl` collapses to the
 * no-slash key for a stable cache id, so a slash-canonical article would read as
 * a false zero if we only queried that one form. Probe both and union the DIDs
 * (a person who linked both forms is still one person), keeping the no-slash form
 * as the canonical cache key.
 *
 * Returns the normalized slash variants plus, when supplied, the exact raw
 * spelling and its slash variant for legacy records written before callers
 * canonicalized their targets.
 */
export function constellationTargets(normUrl: string, rawUrl?: string): string[] {
  const targets = new Set<string>();

  const addSlashVariants = (input: string) => {
    targets.add(input);
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return;
    }
    if (url.pathname === '/') return;
    url.pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : `${url.pathname}/`;
    targets.add(url.toString());
  };

  addSlashVariants(normUrl);

  // Records written before callers canonicalized their target may still carry
  // the exact tracked URL. Probe that spelling too when the request has it; the
  // normalized forms remain first so current records take the cheap path.
  const raw = rawUrl?.trim();
  if (raw && raw !== normUrl && normalizeArticleUrl(raw) === normUrl) {
    addSlashVariants(raw);
  }

  return [...targets];
}
