/**
 * What makes two feed addresses the same subscription. A feed reached over
 * http and over https is one feed, and so is one address written in different
 * letter case: an OPML from one reader often has `http://` where another app
 * wrote `https://`. Comparing the raw strings let the sync treat each pair as
 * two feeds, pulling one in and pushing the other out, so a reader ended up
 * with both everywhere.
 */
export function feedUrlKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '');
}

/** True when two feed addresses name the same feed (see feedUrlKey). */
export function sameFeedUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return a === b;
  return feedUrlKey(a) === feedUrlKey(b);
}

/** feedUrlKey for a SQL column, for matching a row against `feedUrlKey(url)`. */
export function feedUrlKeySql(column: string): string {
  return `(CASE
    WHEN lower(trim(${column})) LIKE 'https://%' THEN substr(lower(trim(${column})), 9)
    WHEN lower(trim(${column})) LIKE 'http://%' THEN substr(lower(trim(${column})), 8)
    ELSE lower(trim(${column})) END)`;
}
