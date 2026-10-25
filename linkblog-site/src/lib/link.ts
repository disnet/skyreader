// Pure helpers for the public link page ("Discussion across the Atmosphere") at
// read.skyreader.app/<article URL>. No network or framework deps, shared by the
// reroute hook, the load function and the page.

// The hosts that serve link pages at the root. Everywhere else (the linkblog
// hosts, local dev) the same page lives under /link/<article URL>.
const READ_HOSTS = new Set(['read.skyreader.app', 'staging-read.skyreader.app']);

export const LINK_PREFIX = '/link';

// Our own query parameter: how many times a still-looking page has refreshed
// itself. Stripped before the rest of the query is handed back to the article.
export const REFRESH_PARAM = 'skyreader_refresh';
export const MAX_REFRESHES = 6;

const MAX_ARTICLE_URL_LENGTH = 2048;

// Paths a browser or crawler asks any host for. On a read host they'd otherwise
// be taken for a bare domain (`favicon.ico`) and looked up as an article.
const NOT_ARTICLES =
  /^\/(?:favicon\.ico|robots\.txt|sitemap\.xml|apple-touch-icon[^/]*\.png|\.well-known\/.*)$/i;

export function isArticlePath(pathname: string): boolean {
  return !NOT_ARTICLES.test(pathname);
}

export function isReadHost(hostname: string): boolean {
  return READ_HOSTS.has(hostname);
}

// The link page's path prefix on a given host: none on a read host, /link elsewhere.
export function linkPrefixFor(hostname: string): string {
  return isReadHost(hostname) ? '' : LINK_PREFIX;
}

/**
 * The article a link page is about, from the page's own URL:
 * `/https://example.com/post?id=7` (or `/link/https://…` off a read host), or a
 * bare `/example.com/post`. Proxies and browsers can merge the `//` after the
 * scheme, so `https:/example.com` is repaired. The page URL's query belongs to
 * the article, minus our refresh counter. Null when there's no article to name
 * (the landing page) or it isn't an http(s) URL.
 */
export function articleUrlFromPage(pageUrl: URL): string | null {
  let rest = pageUrl.pathname;
  if (!isReadHost(pageUrl.hostname) && rest.startsWith(`${LINK_PREFIX}/`)) {
    rest = rest.slice(LINK_PREFIX.length);
  }
  rest = rest.replace(/^\/+/, '');
  if (!rest) return null;

  const scheme = /^(https?):\/*/i.exec(rest);
  let candidate = scheme
    ? `${scheme[1].toLowerCase()}://${rest.slice(scheme[0].length)}`
    : /^[^/]+\.[^/]+/.test(rest)
      ? `https://${rest}`
      : null;
  if (!candidate) return null;

  const query = new URLSearchParams(pageUrl.search);
  query.delete(REFRESH_PARAM);
  const search = query.toString();
  if (search) candidate += `?${search}`;
  return safeArticleUrl(candidate);
}

// An http(s) URL with a real host, within the length the API accepts.
export function safeArticleUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_ARTICLE_URL_LENGTH) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.href;
  } catch {
    return null;
  }
}

// The link page for an article on this origin: the article URL appended as-is,
// which keeps it readable and is what people type.
export function linkPageUrl(origin: string, hostname: string, articleUrl: string): string {
  return `${origin}${linkPrefixFor(hostname)}/${articleUrl}`;
}

// Where a still-looking page refreshes to. Built from the parsed article, never
// from the visitor's own path: `//evil.example/x` names the article
// https://evil.example/x, but as a refresh target it's another site.
export function refreshPath(hostname: string, articleUrl: string, refreshes: number): string {
  const separator = articleUrl.includes('?') ? '&' : '?';
  return `${linkPrefixFor(hostname)}/${articleUrl}${separator}${REFRESH_PARAM}=${refreshes}`;
}

export interface LinkLane {
  lane: string;
  label: string;
  verb: string;
  noun: string;
  count: number;
  capped: boolean;
}

export interface LinkEntry {
  did: string;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
  createdAt: string | null;
  note: string | null;
  url: string | null;
  verb: string | null;
  quote: string | null;
  collections: { name: string; url: string | null }[];
}

export interface LinkPageData {
  url: string;
  meta: { title?: string; siteName?: string; description?: string } | null;
  total: number;
  lanes: LinkLane[];
  entries: Record<string, LinkEntry[]>;
  pending: boolean;
  unavailable: boolean;
}

// "4 Bluesky posts", "2 linkblog notes": one phrase per lane, from the lanes' own
// honest nouns.
export function countPhrases(lanes: LinkLane[]): string[] {
  return lanes
    .filter((lane) => lane.count > 0)
    .map((lane) => {
      const n = `${lane.count}${lane.capped ? '+' : ''}`;
      return `${n} ${lane.noun}${lane.count === 1 && !lane.capped ? '' : 's'}`;
    });
}

// Who someone is, for a line of text: their name, else their handle, else a
// shortened DID (never blank).
export function personName(entry: LinkEntry): string {
  return entry.displayName?.trim() || entry.handle || `${entry.did.slice(0, 18)}…`;
}

export function profileUrl(entry: LinkEntry): string | null {
  return entry.handle ? `https://bsky.app/profile/${entry.handle}` : null;
}

// Commentary first (linkblog notes, Leaflet comments), then Bluesky posts and
// Margin notes that carry words but no highlighted passage. Newest first within
// the merged list would bury the considered notes under quick posts, so lane
// order wins and each lane keeps the proxy's own ranking.
const DISCUSSION_LANES = ['linkblog', 'leaflet', 'bluesky'];

export interface PageSections {
  highlights: LinkEntry[];
  discussion: Array<LinkEntry & { lane: string }>;
  saves: LinkEntry[];
}

export function pageSections(data: Pick<LinkPageData, 'entries'>): PageSections {
  const margin = data.entries.margin ?? [];
  const discussion: Array<LinkEntry & { lane: string }> = [];
  for (const lane of DISCUSSION_LANES) {
    for (const entry of data.entries[lane] ?? []) discussion.push({ ...entry, lane });
  }
  for (const entry of margin) {
    if (!entry.quote && entry.note) discussion.push({ ...entry, lane: 'margin' });
  }
  return {
    highlights: margin.filter((entry) => Boolean(entry.quote)),
    discussion,
    saves: data.entries.semble ?? [],
  };
}

// Distinct people the page shows by name. Pages with fewer than this stay out of
// search engines, so a link page can't be minted for any junk URL and indexed
// under our name.
export const INDEX_MIN_PEOPLE = 3;
