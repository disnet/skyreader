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
const REFRESH_SUFFIX = new RegExp(`(?:^\\?|&)${REFRESH_PARAM}=\\d*$`);

const MAX_ARTICLE_URL_LENGTH = 2048;

// Paths a browser or crawler asks any host for. On a read host they'd otherwise
// be taken for a bare domain (`favicon.ico`) and looked up as an article. Our
// own unfurl card (static/og-link.png) is listed for the same reason.
const NOT_ARTICLES =
  /^\/(?:favicon\.ico|robots\.txt|sitemap\.xml|og-link\.png|apple-touch-icon[^/]*\.png|\.well-known\/.*)$/i;

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

  // The query is handed back byte for byte (re-serializing it would turn `%20`
  // into `+` and `?flag` into `?flag=`, naming a different URL). Only the
  // counter refreshPath appends, always last, is taken off.
  const search = pageUrl.search.replace(REFRESH_SUFFIX, '');
  if (search.length > 1) candidate += search;
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

// The link page for an article as reached from any of this site's hosts: the
// linkblog hosts hand off to their sibling read host, so the address a reader
// copies is the short one; local dev keeps it on this origin under /link.
export function readPageUrlFor(origin: string, rawArticleUrl: string): string | null {
  // The same article the read host will parse back: no fragment, within length.
  const articleUrl = safeArticleUrl(rawArticleUrl.split('#')[0]);
  if (!articleUrl) return null;
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch {
    // fall through to production
  }
  if (isReadHost(host)) return linkPageUrl(origin, host, articleUrl);
  if (host === '127.0.0.1' || host === 'localhost') return linkPageUrl(origin, host, articleUrl);
  const readOrigin = host.includes('staging')
    ? 'https://staging-read.skyreader.app'
    : 'https://read.skyreader.app';
  return `${readOrigin}/${articleUrl}`;
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

// A typed edge someone drew on Semble between this article and another one
// ("this supports that"). `direction` is which way it points: out from this
// article, or in to it.
export interface LinkConnection {
  id: string;
  direction: 'out' | 'in';
  type: string | null;
  note: string | null;
  createdAt: string | null;
  curator: { did: string; handle: string; name: string | null; avatarUrl: string | null };
  other: { url: string; title: string | null; siteName: string | null };
}

export interface LinkPageData {
  url: string;
  meta: { title?: string; siteName?: string; description?: string } | null;
  total: number;
  lanes: LinkLane[];
  entries: Record<string, LinkEntry[]>;
  semble?: { connections: LinkConnection[]; cardUrl: string | null };
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
  connections: LinkConnection[];
}

export function pageSections(data: Pick<LinkPageData, 'entries' | 'semble'>): PageSections {
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
    connections: data.semble?.connections ?? [],
  };
}

// A connection's curator as a row's person, so a connection lays out like every
// other row: who first, then the edge they drew.
export function curatorEntry(connection: LinkConnection): LinkEntry {
  return {
    did: connection.curator.did,
    handle: connection.curator.handle || null,
    displayName: connection.curator.name,
    avatar: connection.curator.avatarUrl,
    createdAt: connection.createdAt,
    note: connection.note,
    url: null,
    verb: null,
    quote: null,
    collections: [],
  };
}

// Distinct people the page shows by name. Pages with fewer than this stay out of
// search engines, so a link page can't be minted for any junk URL and indexed
// under our name.
export const INDEX_MIN_PEOPLE = 3;

// ── Entry rows, styled after the reader's Discussion panel ──────────────────

// "3w ago", like the panel. The page is rendered per request (HTML isn't
// cached), so the phrase is fresh; the exact date rides along as a tooltip.
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// The letter shown when someone has no avatar (or it fails to load: the photo
// sits over the monogram, and a broken image with empty alt draws nothing).
export function monogramFor(entry: Pick<LinkEntry, 'did' | 'handle' | 'displayName'>): string {
  const source = entry.displayName?.trim() || entry.handle || entry.did.replace(/^did:[a-z]+:/, '');
  return (Array.from(source)[0] ?? '?').toUpperCase();
}

// A stable tint per person, as one of HUE_BUCKETS classes: the strict CSP
// allows no inline style attribute, so the panel's per-person hue becomes a
// handful of fixed hues in app.css.
export const HUE_BUCKETS = 8;
export function hueClassFor(did: string): string {
  let h = 0;
  for (let i = 0; i < did.length; i++) h = (h * 31 + did.charCodeAt(i)) % 360;
  return `hue-${Math.floor(h / (360 / HUE_BUCKETS))}`;
}

// ── Note text ───────────────────────────────────────────────────────────────

// Long notes are clipped on the page, with a control to read the rest. Cut at a
// word boundary near `max` characters.
export const NOTE_CLIP = 280;
export function clipText(text: string, max = NOTE_CLIP): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return { text: `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`, clipped: true };
}
