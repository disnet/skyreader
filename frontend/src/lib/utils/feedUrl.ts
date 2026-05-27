/**
 * Canonical form of a feed URL used as the dedup key.
 *
 * Must stay in sync with `backend/src/lib/feed-url.ts`.
 *
 * Rules:
 *   - Scheme + host are lowercased.
 *   - Default ports (`:80` on http, `:443` on https) are stripped.
 *   - The URL fragment is dropped.
 *   - A trailing slash on a non-root path is removed (`/feed/` → `/feed`).
 *     The root path `/` is left intact.
 *   - The query string is preserved verbatim.
 *   - The scheme is never rewritten.
 *
 * Throws if the input is not a valid absolute URL.
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

/**
 * Safe variant — returns the original string if normalization fails.
 * Use this for code paths that need to handle legacy/malformed URLs
 * gracefully (e.g., comparing existing cached subscriptions).
 */
export function normalizeFeedUrlSafe(input: string): string {
  try {
    return normalizeFeedUrl(input);
  } catch {
    return input;
  }
}
