// Where the people you follow might write, beyond the standard.site
// publications on their PDS: the websites they list on a Sifa profile (sifa.id,
// records on their own PDS, sometimes with the feed URL itself), the site at a
// domain handle (@someone.com usually serves a blog), and the links in their
// Bluesky bio (a Substack, a Ghost site, "read my essays at …"). Discover asks the backend to find feeds at these
// sites (routes/site-feeds.ts, cached per site for everyone) and offers what it
// finds as "the writing of people you follow".
//
// Everything here is a pure guess at where a feed might be. A wrong guess costs
// one cached miss on the backend, so the filters only drop the guesses that are
// common and certainly useless: hosting-provider handles and social profiles.

import type { FollowingPublication } from '$lib/types';
import { getFaviconUrl } from '$lib/utils/favicon';
import type { FollowLite, SifaLink } from './socialGraph';

export interface SiteCandidate {
  /** What the backend is asked about: a host, or a host and path. */
  site: string;
  /** Where the guess came from, for the row's subtitle. */
  source: 'handle' | 'profile' | 'sifa';
  /** A feed the person named themselves (on Sifa): no lookup needed. */
  feedUrl?: string;
  /** Their own name for the site (on Sifa), for the row's title. */
  label?: string;
}

/** A follow as discovery sees it: the cached row plus what their PDS lists. */
export type FollowForSites = Pick<FollowLite, 'handle' | 'description'> & {
  sifaLinks?: SifaLink[];
};

// Handles under these are accounts on a hosting provider, not someone's own
// domain. Anything else shared by several follows is caught by
// `sharedHandleParents` below.
const PROVIDER_SUFFIXES = [
  'bsky.social',
  'bsky.team',
  'bsky.app',
  'brid.gy',
  'eurosky.social',
  'blacksky.app',
  'northsky.social',
  'gndr.social',
  'xmirror.bot',
  'bsky.network',
];

// Links in a bio to these go to a profile or a storefront, not to writing with a
// feed worth offering. Subdomains count (m.youtube.com, open.spotify.com).
const NON_BLOG_HOSTS = [
  'bsky.app',
  'bsky.social',
  'twitter.com',
  'x.com',
  'instagram.com',
  'facebook.com',
  'threads.net',
  'threads.com',
  'tiktok.com',
  'linkedin.com',
  'github.com',
  'gitlab.com',
  'codeberg.org',
  'youtube.com',
  'youtu.be',
  'twitch.tv',
  'patreon.com',
  'ko-fi.com',
  'buymeacoffee.com',
  'paypal.me',
  'paypal.com',
  'venmo.com',
  'cash.app',
  'linktr.ee',
  'bio.link',
  'beacons.ai',
  'carrd.co',
  'bit.ly',
  'discord.gg',
  'discord.com',
  't.me',
  'telegram.me',
  'mastodon.social',
  'spotify.com',
  'apple.com',
  'soundcloud.com',
  'bandcamp.com',
  'amazon.com',
  'goodreads.com',
  'keybase.io',
  'pronouns.page',
  'orcid.org',
  'scholar.google.com',
  'google.com',
  'etsy.com',
  'gofundme.com',
  'cara.app',
  'artstation.com',
  'deviantart.com',
  'pixiv.net',
];

// Bio text that looks like a domain but is a file name or a version.
const NOT_A_TLD = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'rs',
  'json',
  'txt',
  'md',
  'png',
  'jpg',
]);

const COUNTRY_SECOND_LEVEL =
  /^(?:co|com|org|net|ac|gov|edu|ltd|plc|me|ne|or|go|id|nom|gen|biz|info)\.[a-z]{2}$/;

// Hosts where a blog lives at a path rather than a subdomain.
const PATH_PLATFORMS = ['medium.com', 'write.as'];

const MAX_PROFILE_LINKS = 2;
const MAX_SIFA_LINKS = 3;

// A URL in plain bio text, with or without its scheme. Bluesky bios are plain
// text (links are only faceted in posts), so this is a scan, not a parse. The
// lookbehind skips @handles and email addresses.
const BIO_URL = /(?<![@\w.-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s|)\]>,"'“”]*)?/gi;

function hostMatches(host: string, suffixes: string[]): boolean {
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
}

function parentOf(handle: string): string | null {
  const dot = handle.indexOf('.');
  const parent = dot >= 0 ? handle.slice(dot + 1) : '';
  return parent.includes('.') ? parent : null;
}

/**
 * Handle parents shared by `min` or more of the given follows: the hosting
 * providers we don't know by name (a community PDS hands out `name.it.social`
 * to everyone on it). A personal subdomain (`blog.someone.com`) is one account,
 * so it stays a candidate.
 */
export function sharedHandleParents(follows: Pick<FollowLite, 'handle'>[], min = 3): Set<string> {
  const counts = new Map<string, number>();
  for (const f of follows) {
    const parent = f.handle ? parentOf(f.handle.toLowerCase()) : null;
    // A country's second-level suffix (co.uk, com.au) is shared by everyone
    // with their own domain there, not a hosting provider.
    if (parent && !COUNTRY_SECOND_LEVEL.test(parent))
      counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= min).map(([p]) => p));
}

/** The site a link points at, as a candidate: its host (or host and path where
 *  the path is the blog), or null for a link that isn't to a blog. */
function siteOf(raw: string): string | null {
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (NOT_A_TLD.has(tld)) return null;
  if (hostMatches(host, NON_BLOG_HOSTS)) return null;
  const path = url.pathname.replace(/\/+$/, '');
  // The path is the blog: medium.com/@someone, write.as/someone.
  if (PATH_PLATFORMS.includes(host)) return path ? `${host}${path}` : null;
  // A fediverse or similar profile (/@name), not a blog.
  if (path.startsWith('/@')) return null;
  // The site's root, not the linked page: bio text is often cut short
  // ("cassidoo.co/newslett"), and a blog advertises its feed site-wide.
  return host;
}

function bioLinks(description: string): string[] {
  const out: string[] = [];
  for (const match of description.matchAll(BIO_URL)) {
    const site = siteOf(match[0].replace(/[.,;:!?…]+$/, ''));
    if (site) out.push(site);
  }
  return out;
}

/**
 * The sites worth asking about for one follow: the websites on their Sifa
 * profile (named by them, so the surest), their domain handle, then up to
 * MAX_PROFILE_LINKS other sites linked from their bio.
 */
export function siteCandidates(
  follow: FollowForSites,
  sharedParents: Set<string> = new Set()
): SiteCandidate[] {
  const out: SiteCandidate[] = [];
  const seen = new Set<string>();
  const handle = follow.handle?.toLowerCase();

  for (const link of follow.sifaLinks ?? []) {
    if (out.length >= MAX_SIFA_LINKS) break;
    // A listed feed is used as is; a listed site still has to be looked up.
    const site = link.feedUrl ? siteLabel(link.url) : siteOf(link.url);
    if (!site || seen.has(site)) continue;
    seen.add(site);
    out.push({ site, source: 'sifa', feedUrl: link.feedUrl, label: link.label });
  }

  if (handle && !seen.has(handle) && handle.includes('.') && !handle.startsWith('did:')) {
    const parent = parentOf(handle);
    const hosted =
      hostMatches(handle, PROVIDER_SUFFIXES) || (parent !== null && sharedParents.has(parent));
    if (!hosted) {
      out.push({ site: handle, source: 'handle' });
      seen.add(handle);
    }
  }

  if (follow.description) {
    let links = 0;
    for (const site of bioLinks(follow.description)) {
      if (links >= MAX_PROFILE_LINKS) break;
      if (seen.has(site)) continue;
      seen.add(site);
      out.push({ site, source: 'profile' });
      links++;
    }
  }
  return out;
}

/** How a web feed's row says where its site came from. */
export const SITE_SOURCE_LABEL: Record<SiteCandidate['source'], string> = {
  handle: 'their site',
  profile: 'linked from their profile',
  sifa: 'on their Sifa profile',
};

/** "someone.com" or "someone.com/blog", for a row's title. */
export function siteLabel(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Web feeds for a batch of follows: one per site found at their domain handle or
 * bio links, skipping a site that is already one of their standard.site
 * publications (the publication is the better way to follow it). `discover`
 * answers feed URLs per site (the backend's discover-sites); a site it has no
 * answer for (null or missing: the lookup failed) keeps the row in `prior`, the
 * feeds found for these follows last time, rather than dropping it.
 */
export async function findFollowFeeds(
  batch: (FollowLite & FollowForSites)[],
  publications: FollowingPublication[],
  sharedParents: Set<string>,
  discover: (sites: string[]) => Promise<Map<string, string[] | null>>,
  prior: FollowingPublication[] = []
): Promise<FollowingPublication[]> {
  const publicationHosts = new Set(publications.map((p) => `${p.did} ${hostOf(p.url) ?? ''}`));
  const wanted = batch.flatMap((follow) =>
    siteCandidates(follow, sharedParents)
      .filter((c) => !publicationHosts.has(`${follow.did} ${c.site.split('/')[0]}`))
      .map((candidate) => ({ follow, candidate }))
  );
  if (wanted.length === 0) return [];

  const toAsk = wanted.filter((w) => !w.candidate.feedUrl).map((w) => w.candidate.site);
  const feedsBySite =
    toAsk.length > 0 ? await discover([...new Set(toAsk)]) : new Map<string, string[] | null>();
  const out: FollowingPublication[] = [];
  const seen = new Set<string>();
  for (const { follow, candidate } of wanted) {
    const siteUrl = `https://${candidate.site}`;
    const feeds = candidate.feedUrl ? [candidate.feedUrl] : feedsBySite.get(candidate.site);
    if (feeds == null) {
      const kept = prior.find(
        (p) => p.kind === 'feed' && p.did === follow.did && p.url === siteUrl
      );
      if (kept && !seen.has(kept.publicationUri)) {
        seen.add(kept.publicationUri);
        out.push(kept);
      }
      continue;
    }
    const feedUrl = feeds[0];
    if (!feedUrl || seen.has(feedUrl)) continue;
    seen.add(feedUrl);
    out.push({
      did: follow.did,
      handle: follow.handle,
      displayName: follow.displayName,
      avatar: follow.avatar,
      kind: 'feed',
      siteSource: candidate.source,
      publicationUri: feedUrl,
      name: candidate.label || siteLabel(candidate.site),
      iconUrl: getFaviconUrl(siteUrl, 64),
      url: siteUrl,
    });
  }
  return out;
}
