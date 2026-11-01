/**
 * What makes two feed addresses the same subscription. A feed reached over
 * http and over https is one feed, and a host is the same in any letter case:
 * an OPML from one reader often has `http://` where another app wrote
 * `https://`. Comparing the raw strings let the sync treat each pair as two
 * feeds, pulling one in and pushing the other out, so a reader ended up with
 * both everywhere.
 *
 * The path and query keep their case: `/Tech.xml` beside `/tech.xml`, or a
 * token in the query, can be another feed, and the sync deletes duplicates, so
 * it must never fold two real feeds together.
 */
export function feedUrlKey(url: string): string {
  const rest = url.trim().replace(/^https?:\/\//i, '');
  const slash = rest.indexOf('/');
  return slash < 0 ? rest.toLowerCase() : rest.slice(0, slash).toLowerCase() + rest.slice(slash);
}

/** True when two feed addresses name the same feed (see feedUrlKey). */
export function sameFeedUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return a === b;
  return feedUrlKey(a) === feedUrlKey(b);
}

/** feedUrlKey for a SQL column, for matching a row against `feedUrlKey(url)`. */
export function feedUrlKeySql(column: string): string {
  const rest = `(CASE
    WHEN lower(substr(trim(${column}), 1, 8)) = 'https://' THEN substr(trim(${column}), 9)
    WHEN lower(substr(trim(${column}), 1, 7)) = 'http://' THEN substr(trim(${column}), 8)
    ELSE trim(${column}) END)`;
  return `(CASE WHEN instr(${rest}, '/') = 0 THEN lower(${rest})
    ELSE lower(substr(${rest}, 1, instr(${rest}, '/') - 1)) || substr(${rest}, instr(${rest}, '/')) END)`;
}
