// A stable key for "is this the same page?" comparisons between a URL the app
// stored and a URL some other network handed us.
//
// Saved items are keyed by the exact URL string they were saved with, which is
// fine while both sides came from the same place. It stops being fine the moment
// a link arrives from elsewhere — a Semble connection, a share, the extension —
// because the same article routinely travels as `…/post`, `…/post/`, and
// `…/post?utm_source=…`. Compared literally, an article the reader already keeps
// reads as unsaved.
//
// Deliberately mirrors `feed-proxy/src/url-normalize.ts` (the canonical form used
// for Constellation lookups), including its two non-normalizations: the scheme
// and `www` are preserved, because they distinguish real hosts more often than
// they mask duplicates. Keep the two in step.

// Pure tracking / session noise. Anything unlisted is preserved — some sites key
// real content off `?p=` or `?id=`.
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
 * Canonicalize a URL for same-page matching. Returns `null` for anything that
 * isn't an http(s) URL — a guid, an at:// uri, a bare id — so callers that
 * accept either can tell the two apart and fall back to an exact match.
 *
 * - lowercases the host (keeps `www`)
 * - drops the fragment and the default port
 * - strips tracking params, sorts the rest
 * - trims one trailing slash on a non-root path
 */
export function urlKey(input: string): string | null {
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

  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams) {
    const lowerKey = key.toLowerCase();
    if (TRACKING_PARAMS.has(lowerKey) || isHostTrackingParam(url.hostname, lowerKey)) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}
