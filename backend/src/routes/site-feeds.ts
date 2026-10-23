import type { Env } from '../types';
import { FeedProxyClient, FeedProxyError } from '../services/feed-proxy-client';
import { log, serializeError } from '../utils/logger';
import { mapLimited } from './item-bodies';

/**
 * POST /api/v2/feeds/discover-sites
 *
 * Feed discovery for many sites at once: the domain handles and profile links of
 * the people a reader follows on Bluesky, so Discover can offer "the writing of
 * people you follow" alongside their standard.site publications.
 *
 * Body: `{ sites: string[] }` (at most MAX_SITES). Answers
 * `{ results: [{ site, feeds }] }` in the same order, where `site` echoes the
 * input and `feeds` lists the feed URLs found there: empty when none (or the site
 * isn't a usable public web address), null when the lookup failed and says
 * nothing either way, so a client keeps whatever it found before.
 *
 * Each site's answer is cached in D1 for every reader (`site_feed_discovery`),
 * so a writer followed by many readers is discovered once. Only sites missing
 * from the cache, or gone stale, reach the feed proxy.
 */

export const MAX_SITES = 30;
// Proxy discovers in flight per call: each is a site fetch plus a few probes.
const DISCOVER_CONCURRENCY = 10;
// Discover's first paint waits on a call, so one slow site mustn't hold it for
// the proxy's usual 25s. A site that times out isn't cached and is asked again
// on a later scan.
const DISCOVER_TIMEOUT_MS = 8_000;
// A site that has a feed rarely loses it; one without a feed rarely grows one.
const FOUND_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const NONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A failed discover is usually a dead site (a provider subdomain with no web
// server), but the same shapes come back when the proxy itself is down or
// misconfigured: Fly's edge drops the proxy's own 5xx body, and a JSON error
// carries no status. So it's remembered only for a few hours, which spares the
// proxy repeat lookups without hiding a real blog for long after an outage.
const ERROR_TTL_MS = 6 * 60 * 60 * 1000;
// Feeds kept per site. The first is the one offered; a couple more cover a site
// whose first advertised feed is a comments feed we drop.
const MAX_FEEDS_PER_SITE = 3;

// Hosts where a blog lives at a path (medium.com/@someone, write.as/someone).
// Mirrors frontend/src/lib/services/followSites.ts.
const PATH_PLATFORMS = ['medium.com', 'write.as'];

/** A site's cache key and the URL to discover it at, or null when it isn't a
 *  public web address worth asking the proxy about. */
export function normalizeSite(input: string): { key: string; url: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  // A dotted name with an alphabetic TLD: no IP literals, no localhost, no
  // single-label intranet names.
  if (!/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*[a-z0-9]$/.test(host)) return null;
  // A site is its host, except where the path is the blog. Keeping arbitrary
  // paths would let one caller bypass the cache with endless variants of a host.
  const path = PATH_PLATFORMS.includes(host) ? parsed.pathname.replace(/\/+$/, '') : '';
  return { key: `${host}${path}`, url: `https://${host}${path || '/'}` };
}

function isCommentsFeed(url: string): boolean {
  return /\/comments\/(feed|rss)|[?&]feed=comments/i.test(url);
}

interface CacheRow {
  site: string;
  feeds_json: string;
}

// `ttl` null: we learned nothing about the site (our timeout, a network
// error, load shedding), so nothing is cached and the answer is "unknown".
interface Outcome {
  feeds: string[] | null;
  ttl: number | null;
}

async function discover(client: FeedProxyClient, url: string): Promise<Outcome> {
  try {
    const { feeds } = await client.discoverFeeds(url, DISCOVER_TIMEOUT_MS);
    const kept = feeds.filter((f) => !isCommentsFeed(f)).slice(0, MAX_FEEDS_PER_SITE);
    return { feeds: kept, ttl: kept.length > 0 ? FOUND_TTL_MS : NONE_TTL_MS };
  } catch (error) {
    if (error instanceof FeedProxyError && !error.timedOut) {
      // The site refusing our fetcher is a real answer about the site.
      if (error.blocked) return { feeds: [], ttl: NONE_TTL_MS };
      if (error.status === undefined || error.status === 502) {
        log.info('site_feed_discover_error', { url, ...serializeError(error) });
        return { feeds: [], ttl: ERROR_TTL_MS };
      }
    }
    log.warn('site_feed_discover_failed', { url, ...serializeError(error) });
    return { feeds: null, ttl: null };
  }
}

export async function handleDiscoverSites(request: Request, env: Env): Promise<Response> {
  let body: { sites?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const sites = body.sites;
  if (!Array.isArray(sites) || sites.some((s) => typeof s !== 'string')) {
    return jsonResponse({ error: 'sites must be an array of strings' }, 400);
  }
  if (sites.length > MAX_SITES) {
    return jsonResponse({ error: `At most ${MAX_SITES} sites per request` }, 400);
  }

  const normalized = (sites as string[]).map(normalizeSite);
  const keys = [...new Set(normalized.filter((n) => n !== null).map((n) => n!.key))];
  const answers = new Map<string, string[] | null>();

  if (keys.length > 0) {
    const now = Date.now();
    const placeholders = keys.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT site, feeds_json FROM site_feed_discovery
       WHERE site IN (${placeholders}) AND expires_at > ?`
    )
      .bind(...keys, now)
      .all<CacheRow>();
    for (const row of results) {
      try {
        answers.set(row.site, JSON.parse(row.feeds_json) as string[]);
      } catch {
        // Unreadable row: treat as a miss and rediscover.
      }
    }

    const misses = keys.filter((k) => !answers.has(k));
    if (misses.length > 0) {
      const urlFor = new Map(normalized.filter((n) => n !== null).map((n) => [n!.key, n!.url]));
      const client = new FeedProxyClient(env);
      const outcomes = await mapLimited(misses, DISCOVER_CONCURRENCY, (key) =>
        discover(client, urlFor.get(key)!)
      );
      const writes: D1PreparedStatement[] = [];
      misses.forEach((key, i) => {
        const outcome = outcomes[i];
        answers.set(key, outcome.feeds);
        if (outcome.ttl === null) return;
        writes.push(
          env.DB.prepare(
            `INSERT INTO site_feed_discovery (site, feeds_json, expires_at) VALUES (?, ?, ?)
             ON CONFLICT(site) DO UPDATE SET feeds_json = excluded.feeds_json, expires_at = excluded.expires_at`
          ).bind(key, JSON.stringify(outcome.feeds), now + outcome.ttl)
        );
      });
      if (writes.length > 0) {
        try {
          await env.DB.batch(writes);
        } catch (error) {
          // The answer still goes back; the next reader just asks the proxy again.
          log.error('site_feed_cache_write_failed', serializeError(error));
        }
      }
    }
  }

  return jsonResponse({
    results: (sites as string[]).map((site, i) => {
      const n = normalized[i];
      return { site, feeds: n ? (answers.get(n.key) ?? null) : [] };
    }),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
