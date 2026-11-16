import { marked } from 'marked';
import type { Env, FeedItem } from '../types';
import { computeContentHash, ingestBatch } from '../routes/ingest';
import { MAX_STORED_BODY_BYTES } from '../routes/item-bodies';
import { checkRateLimit, getRateLimitConfig } from './rate-limit';
import { getUserTierLimits } from './user-tier';
import { generateTid } from '../utils/tid';
import { htmlToText } from '../utils/html-text';
import { sha256Hex } from '../utils/sha256';
import { log } from '../utils/logger';

/**
 * Push feeds: feeds a reader fills themselves, from a script or an agent (an
 * MCP client posting a weekly summary, a cron job, a GitHub Action), through
 * `POST /api/push` (routes/push.ts, app password with the `push` scope) or the
 * MCP tool `publish_to_feed` (services/mcp/tools.ts, the `mcp:push` scope).
 * Both land here. A Supporter feature (`liveIntegrations`, like the MCP server).
 *
 * A push feed is named, and the name is its identity: posting to "Weekly
 * summary" again lands in the same feed, so an agent needs no setup step and
 * no id to remember. The feed url is `push:<did>/<hash of the name>`.
 *
 * Like a newsletter it is PRIVATE and LOCAL-ONLY (services/local-only-sources.ts):
 * never crawled, never on the PDS, readable only by the DID its url names.
 * Each post is one `feed_items` row, so the timeline, unread counts, search,
 * saving and highlighting treat it like any feed. A post with a `guid` already
 * in the feed is ignored, so a retry is safe; there is no edit or delete.
 *
 * Removing a push feed from Manage Sources doesn't stop whatever posts to it:
 * the next post brings it back. Revoking the app password, or disconnecting
 * the AI app, is what stops it.
 */

export const PUSH_SOURCE_TYPE = 'push';
const FEED_URL_PREFIX = 'push:';

export const MAX_PUSH_FEED_NAME = 100;
export const MAX_PUSH_TITLE = 300;
export const MAX_PUSH_GUID = 200;
export const MAX_PUSH_AUTHOR = 100;
export const MAX_PUSH_URL = 2000;
// A long agent report is tens of KB; this is what the archive stores for one body.
export const MAX_PUSH_BODY_BYTES = MAX_STORED_BODY_BYTES;
// Push feeds one reader may have. A name per purpose; more is a loop naming feeds.
export const MAX_PUSH_FEEDS = 20;

// Posts per reader per UTC day, HTTP and MCP together, and per minute. The content
// only ever reaches its owner, so these bound cost, not spam.
export const PUSH_DAY_RATE_KEY = '/api/push:day';
export const PUSH_RATE_KEY = '/api/push';
// The numbers are in services/rate-limit.ts (RATE_LIMITS).

const SUMMARY_CHARS = 280;

// ---------------------------------------------------------------------------
// Identity and privacy
// ---------------------------------------------------------------------------

/** One name, however it's cased or spaced, is one feed. */
export function normalizePushFeedName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function pushFeedUrl(did: string, name: string): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(normalizePushFeedName(name)));
  return `${FEED_URL_PREFIX}${did}/${hash.slice(0, 24)}`;
}

/** `push:<did>/<key>` → its owner, or null for anything else. */
export function parsePushFeedUrl(
  feedUrl: string | null | undefined
): { did: string; key: string } | null {
  if (!feedUrl || !feedUrl.toLowerCase().startsWith(FEED_URL_PREFIX)) return null;
  const rest = feedUrl.slice(FEED_URL_PREFIX.length);
  const slash = rest.lastIndexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { did: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

export function isPushFeedUrl(feedUrl: string | null | undefined): boolean {
  return !!feedUrl && feedUrl.toLowerCase().startsWith(FEED_URL_PREFIX);
}

/**
 * True for a subscription row that must stay private, local and uncrawled.
 * Either half is enough: the source type, or any row naming a `push:` feed,
 * which is what stops a forged subscription from reading someone else's.
 */
export function isPushSubscription(
  feedUrl: string | null | undefined,
  sourceType: string | null | undefined
): boolean {
  return sourceType === PUSH_SOURCE_TYPE || isPushFeedUrl(feedUrl);
}

/** May this reader read this feed? Only the account it was made for. */
export function ownsPushFeed(viewerDid: string | null, feedUrl: string): boolean {
  const parsed = parsePushFeedUrl(feedUrl);
  return !!viewerDid && !!parsed && parsed.did === viewerDid;
}

// ---------------------------------------------------------------------------
// A post
// ---------------------------------------------------------------------------

export interface PushPost {
  feed: string;
  title: string;
  markdown?: string;
  html?: string;
  url?: string;
  guid?: string;
  author?: string;
  publishedAt?: string;
}

/** A post the caller got wrong: said back to them as is. */
export class PushInputError extends Error {}

export type PushOutcome =
  | {
      ok: true;
      /** 'duplicate': that guid was already posted to this feed; nothing changed. */
      status: 'created' | 'duplicate';
      feed: { name: string; feedUrl: string };
      guid: string;
      /** The feed is parked, so the reader won't see the post until they turn it back on. */
      parked: boolean;
    }
  | { ok: false; code: 'rate_limited'; retryAfter: number; message: string }
  | { ok: false; code: 'too_many_feeds' | 'over_subscription_cap'; message: string };

function optionalString(
  input: Record<string, unknown>,
  key: string,
  max: number
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new PushInputError(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new PushInputError(`${key} is longer than ${max} characters`);
  return trimmed || undefined;
}

/** Check a post's fields, from a JSON body or tool arguments. */
export function parsePushPost(input: Record<string, unknown>): PushPost {
  const feed = optionalString(input, 'feed', MAX_PUSH_FEED_NAME);
  if (!feed) throw new PushInputError('feed is required: the name of the feed to post to');
  const title = optionalString(input, 'title', MAX_PUSH_TITLE);
  if (!title) throw new PushInputError('title is required');

  const markdown = typeof input.markdown === 'string' ? input.markdown : undefined;
  const html = typeof input.html === 'string' ? input.html : undefined;
  if (input.markdown !== undefined && input.markdown !== null && markdown === undefined) {
    throw new PushInputError('markdown must be a string');
  }
  if (input.html !== undefined && input.html !== null && html === undefined) {
    throw new PushInputError('html must be a string');
  }
  if (markdown !== undefined && html !== undefined) {
    throw new PushInputError('send markdown or html, not both');
  }
  const body = markdown ?? html ?? '';
  if (new TextEncoder().encode(body).length > MAX_PUSH_BODY_BYTES) {
    throw new PushInputError(`the body is larger than ${MAX_PUSH_BODY_BYTES / 1024 / 1024} MB`);
  }

  const url = optionalString(input, 'url', MAX_PUSH_URL);
  if (url) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      throw new PushInputError('url must be an http(s) link');
    }
  }

  const guid = optionalString(input, 'guid', MAX_PUSH_GUID);
  const author = optionalString(input, 'author', MAX_PUSH_AUTHOR);
  const publishedAt = optionalString(input, 'publishedAt', 64);
  if (publishedAt && Number.isNaN(Date.parse(publishedAt))) {
    throw new PushInputError('publishedAt must be an ISO 8601 date');
  }
  return { feed, title, markdown, html, url, guid, author, publishedAt };
}

/** Markdown (what agents write) or HTML, as the item's body. The reader sanitizes it. */
export function renderPushBody(post: Pick<PushPost, 'markdown' | 'html'>): string {
  if (post.html !== undefined) return post.html;
  if (post.markdown === undefined || post.markdown === '') return '';
  return marked.parse(post.markdown, { async: false, gfm: true }) as string;
}

/**
 * Make the feed's subscription if it's new. False when the reader already has
 * MAX_PUSH_FEEDS, or as many subscriptions as their plan mirrors. Over the
 * active cap it's created parked, like any other overflow. One statement, so
 * two first posts at once make one row.
 */
async function ensurePushSubscription(
  env: Env,
  did: string,
  feedUrl: string,
  title: string
): Promise<'exists' | 'created' | 'too_many_feeds' | 'over_subscription_cap'> {
  const existing = await env.DB.prepare(
    `SELECT 1 AS ok FROM subscriptions_cache WHERE user_did = ? AND feed_url = ? LIMIT 1`
  )
    .bind(did, feedUrl)
    .first<{ ok: number }>();
  if (existing) return 'exists';

  const limits = await getUserTierLimits(env, did);
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(active = 1), 0) AS active,
            COALESCE(SUM(feed_url LIKE ?), 0) AS pushed
       FROM subscriptions_cache WHERE user_did = ?`
  )
    .bind(`${FEED_URL_PREFIX}%`, did)
    .first<{ total: number; active: number; pushed: number }>();
  if ((counts?.pushed ?? 0) >= MAX_PUSH_FEEDS) return 'too_many_feeds';
  if ((counts?.total ?? 0) >= limits.maxMirroredSubscriptions) return 'over_subscription_cap';
  const active = (counts?.active ?? 0) < limits.maxSubscriptions ? 1 : 0;

  // A TID rkey like every other row, so the client's rkey-addressed routes
  // (rename, park, delete) work on it. The record names a PDS record that
  // never exists: nothing pushes this row.
  const recordUri = `at://${did}/app.skyreader.feed.subscription/${generateTid()}`;
  // The feed cap is checked again inside the insert, so first posts to several
  // new names at once can't all slip under it.
  const inserted = await env.DB.prepare(
    `INSERT INTO subscriptions_cache
       (user_did, record_uri, feed_url, title, site_url, created_at, source_type, source, active)
     SELECT ?1, ?2, ?3, ?4, NULL, unixepoch(), ?5, 'push', ?6
      WHERE NOT EXISTS (SELECT 1 FROM subscriptions_cache WHERE user_did = ?1 AND feed_url = ?3)
        AND (SELECT COUNT(*) FROM subscriptions_cache WHERE user_did = ?1 AND feed_url LIKE ?7) < ?8`
  )
    .bind(
      did,
      recordUri,
      feedUrl,
      title,
      PUSH_SOURCE_TYPE,
      active,
      `${FEED_URL_PREFIX}%`,
      MAX_PUSH_FEEDS
    )
    .run();
  if ((inserted.meta.changes ?? 0) > 0) return 'created';
  // Nothing inserted: another post made this feed first, or made the last one allowed.
  const raced = await env.DB.prepare(
    `SELECT 1 AS ok FROM subscriptions_cache WHERE user_did = ? AND feed_url = ? LIMIT 1`
  )
    .bind(did, feedUrl)
    .first<{ ok: number }>();
  return raced ? 'exists' : 'too_many_feeds';
}

/**
 * Post one item to one of the reader's push feeds. The caller has checked who
 * they are and that their plan covers it.
 */
export async function publishToPushFeed(
  env: Env,
  did: string,
  post: PushPost,
  nowMs = Date.now()
): Promise<PushOutcome> {
  // Checked before anything is spent or made: Markdown can render larger than it
  // was written, and past this the archive keeps no body.
  const content = renderPushBody(post);
  if (new TextEncoder().encode(content).length > MAX_PUSH_BODY_BYTES) {
    throw new PushInputError(`the body is larger than ${MAX_PUSH_BODY_BYTES / 1024 / 1024} MB`);
  }

  for (const key of [PUSH_RATE_KEY, PUSH_DAY_RATE_KEY]) {
    const limit = await checkRateLimit(env, did, key);
    if (!limit.allowed) {
      const retryAfter = limit.retryAfter ?? 60;
      return {
        ok: false,
        code: 'rate_limited',
        retryAfter,
        message:
          key === PUSH_DAY_RATE_KEY
            ? `At most ${getRateLimitConfig(PUSH_DAY_RATE_KEY).limit} posts a day. Try again in ${retryAfter} seconds.`
            : `Too many posts at once. Try again in ${retryAfter} seconds.`,
      };
    }
  }

  const feedUrl = await pushFeedUrl(did, post.feed);
  const subscription = await ensurePushSubscription(env, did, feedUrl, post.feed);
  if (subscription === 'too_many_feeds') {
    return {
      ok: false,
      code: 'too_many_feeds',
      message: `At most ${MAX_PUSH_FEEDS} push feeds. Post to one that exists, or remove one in Manage Sources.`,
    };
  }
  if (subscription === 'over_subscription_cap') {
    return {
      ok: false,
      code: 'over_subscription_cap',
      message: 'This reader has as many sources as their plan holds.',
    };
  }

  // The feed row keeps the name the feed was first given; a later post spelling
  // it differently lands in the same feed and leaves that name alone.
  const [feedRow, sub] = await Promise.all([
    env.DB.prepare('SELECT title FROM feeds WHERE feed_url = ?')
      .bind(feedUrl)
      .first<{ title: string | null }>(),
    env.DB.prepare('SELECT active FROM subscriptions_cache WHERE user_did = ? AND feed_url = ?')
      .bind(did, feedUrl)
      .first<{ active: number }>(),
  ]);
  const feed = { name: feedRow?.title ?? post.feed, feedUrl };
  // Parked (over the plan's active cap, or by hand): kept, but not shown.
  const parked = sub?.active === 0;

  const guid = post.guid ?? `push-${generateTid()}`;
  // Stored under the feed's key: read and saved state are keyed by guid alone,
  // so two feeds given the same guid ("2026-11-16") must not share it.
  const storedGuid = `${FEED_URL_PREFIX}${feedUrl.slice(feedUrl.lastIndexOf('/') + 1)}:${guid}`;

  // A guid already posted is left as it is: the timeline delivers each item
  // once, so an edit would reach only devices that hadn't seen it yet. This is
  // what makes a retry safe.
  const before = await env.DB.prepare(
    'SELECT 1 AS ok FROM feed_items WHERE feed_url = ? AND guid = ?'
  )
    .bind(feedUrl, storedGuid)
    .first<{ ok: number }>();
  if (before) {
    log.info('push_feed_post', { status: 'duplicate' });
    return { ok: true, status: 'duplicate', feed, guid, parked };
  }

  // A future date would pin the post above everything else until then.
  const parsedDate = post.publishedAt ? Date.parse(post.publishedAt) : NaN;
  const publishedMs = Number.isNaN(parsedDate) ? nowMs : Math.min(parsedDate, nowMs);
  const summary = htmlToText(content, SUMMARY_CHARS * 2)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SUMMARY_CHARS);
  const item: FeedItem = {
    guid: storedGuid,
    url: post.url ?? '',
    title: post.title,
    ...(post.author ? { author: post.author } : {}),
    ...(content ? { content } : {}),
    ...(summary ? { summary } : {}),
    publishedAt: new Date(publishedMs).toISOString(),
  };

  await ingestBatch(
    env,
    [{ feedUrl, title: feed.name, siteUrl: null, description: null, imageUrl: null }],
    [
      {
        feedUrl,
        guid: storedGuid,
        item,
        publishedAt: publishedMs,
        firstSeenAt: nowMs,
        contentHash: await computeContentHash(item),
      },
    ]
  );

  log.info('push_feed_post', { status: 'created', newFeed: subscription === 'created', parked });
  return { ok: true, status: 'created', feed, guid, parked };
}

/** The reader's push feeds, for the MCP tool's description of where it can post. */
export async function listPushFeeds(env: Env, did: string): Promise<{ name: string }[]> {
  const rows = await env.DB.prepare(
    `SELECT COALESCE(f.title, sc.title) AS name
       FROM subscriptions_cache sc LEFT JOIN feeds f ON f.feed_url = sc.feed_url
      WHERE sc.user_did = ? AND sc.feed_url LIKE ?
      ORDER BY sc.created_at ASC LIMIT ?`
  )
    .bind(did, `${FEED_URL_PREFIX}%`, MAX_PUSH_FEEDS)
    .all<{ name: string }>();
  return rows.results ?? [];
}
