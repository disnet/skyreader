/**
 * Canonical form of a feed URL used as the dedup key.
 *
 * Rules:
 *   - Scheme + host are lowercased.
 *   - Default ports (`:80` on http, `:443` on https) are stripped.
 *   - The URL fragment is dropped.
 *   - A trailing slash on a non-root path is removed (`/feed/` → `/feed`).
 *     The root path `/` is left intact.
 *   - The query string is preserved verbatim (some feeds rely on query params).
 *   - The scheme is never rewritten (http→https). Some feeds are intentionally
 *     http-only and rewriting would silently break them.
 *
 * Throws if the input is not a valid absolute URL — callers should validate
 * with `isValidUrl()` first.
 */
export function normalizeFeedUrl(input: string): string {
  const url = new URL(input);

  url.hash = '';

  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  url.hostname = url.hostname.toLowerCase();

  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = pathname;

  return url.toString();
}
