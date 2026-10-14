// Bluesky likes and bookmarks as sources: the posts a reader liked or bookmarked
// on Bluesky that carry a link become articles in their reader, so something
// spotted in a Bluesky client is one tap from being read (and saved) here.
//
// Each is a subscription like any other — a subscriptions_cache row whose items
// sit in feed_items and reach the client through GET /api/v2/timeline — so read
// state, unread counts, channels and saving all work unchanged. Like a
// newsletter, the row is PRIVATE and LOCAL-ONLY:
//   - its feed_url (`bsky-likes:<did>` / `bsky-bookmarks:<did>`) names its owner
//     and isn't fetchable, so it is never crawled;
//   - it is never written to the PDS (what you bookmark is private, and the
//     record would be meaningless to any other app), and a PDS record or API
//     call naming one is ignored or refused;
//   - only its owner reads it (feeds-v2, item-bodies ask `ownsLocalOnlyFeed`).
//
// Items are pulled on read: after a timeline request, under waitUntil, at most
// once per BSKY_SOURCE_GATE_MS per source (`refreshBskySourcesIfDue`). Likes are
// public records in the reader's own repo, hydrated through the public appview,
// so they need no extra permission; bookmarks are private and need
// BSKY_BOOKMARKS_SCOPES (getBookmarks, proxied to the appview by the PDS).
//
// Un-liking or un-bookmarking leaves the article in the reader, the way an RSS
// item outlives its removal from the feed.

import type { Env, FeedItem, Session } from '../types';
import { BSKY_BOOKMARKS_SCOPES } from '../config/scopes';
import { computeContentHash, ingestBatch, type IngestItem } from '../routes/ingest';
import { fetchPosts } from './bsky-appview';
import { postLink, SHARE_TEXT_MAX, type TimelineItem } from './follow-links';
import { isScopeDenial } from './follow-links-store';
import { createPDSClient, type PDSClient } from './pds-client';
import { grantsScopes } from './scope-check';
import { getUserTierLimits } from './user-tier';
import { generateTid } from '../utils/tid';
import { escapeHtml } from '../utils/html-text';
import { log, serializeError } from '../utils/logger';

export type BskySourceKind = 'likes' | 'bookmarks';
export const BSKY_SOURCE_KINDS: readonly BskySourceKind[] = ['likes', 'bookmarks'];

export const BSKY_LIKES_SOURCE_TYPE = 'bsky.likes';
export const BSKY_BOOKMARKS_SOURCE_TYPE = 'bsky.bookmarks';

const SOURCE_TYPE: Record<BskySourceKind, string> = {
  likes: BSKY_LIKES_SOURCE_TYPE,
  bookmarks: BSKY_BOOKMARKS_SOURCE_TYPE,
};
const FEED_URL_PREFIX: Record<BskySourceKind, string> = {
  likes: 'bsky-likes:',
  bookmarks: 'bsky-bookmarks:',
};
const TITLE: Record<BskySourceKind, string> = {
  likes: 'Bluesky likes',
  bookmarks: 'Bluesky bookmarks',
};
const SITE_URL = 'https://bsky.app';

/** Minimum time between two refreshes of one source. */
export const BSKY_SOURCE_GATE_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;
// The first walk reaches further back so a new source starts with something in
// it; later walks only need what arrived since the last one.
export const FIRST_WALK_MAX_PAGES = 3;
// Later refreshes: the top of the list gets up to WALK_MAX_PAGES, and a gap left
// by an earlier burst gets what's left of REFRESH_MAX_PAGES. Five pages is about
// 25 subrequests plus one insert per link post: well inside an invocation.
export const WALK_MAX_PAGES = 2;
export const REFRESH_MAX_PAGES = 5;

/** `last_error` when the PDS refused getBookmarks for want of scope. */
export const BSKY_SOURCE_SCOPE_DENIED = 'scope_denied';

// ---------------------------------------------------------------------------
// Identity and privacy
// ---------------------------------------------------------------------------

export function bskySourceFeedUrl(kind: BskySourceKind, did: string): string {
  return `${FEED_URL_PREFIX[kind]}${did}`;
}

/** `bsky-likes:<did>` → its parts, or null for anything else. */
export function parseBskySourceFeedUrl(
  feedUrl: string | null | undefined
): { kind: BskySourceKind; did: string } | null {
  if (!feedUrl) return null;
  for (const kind of BSKY_SOURCE_KINDS) {
    const prefix = FEED_URL_PREFIX[kind];
    if (feedUrl.toLowerCase().startsWith(prefix)) {
      const did = feedUrl.slice(prefix.length);
      return did ? { kind, did } : null;
    }
  }
  return null;
}

export function isBskySourceFeedUrl(feedUrl: string | null | undefined): boolean {
  if (!feedUrl) return false;
  const lower = feedUrl.toLowerCase();
  return BSKY_SOURCE_KINDS.some((kind) => lower.startsWith(FEED_URL_PREFIX[kind]));
}

/**
 * True for a subscription row that must stay private, local and uncrawled.
 * Either half is enough: a row claiming the source type, or any row naming a
 * `bsky-likes:`/`bsky-bookmarks:` feed — the latter is what stops a forged
 * subscription from pointing at someone else's bookmarks.
 */
export function isBskySourceSubscription(
  feedUrl: string | null | undefined,
  sourceType: string | null | undefined
): boolean {
  return (
    sourceType === BSKY_LIKES_SOURCE_TYPE ||
    sourceType === BSKY_BOOKMARKS_SOURCE_TYPE ||
    isBskySourceFeedUrl(feedUrl)
  );
}

/** May this reader read this feed? Only the account it was gathered for. */
export function ownsBskySourceFeed(viewerDid: string | null, feedUrl: string): boolean {
  const parsed = parseBskySourceFeedUrl(feedUrl);
  return !!viewerDid && !!parsed && parsed.did === viewerDid;
}

/**
 * Statements that forget a source's walk, the items it gathered and its feeds
 * row — but only while no subscription holds it, so batch them AFTER the
 * subscription's own delete. The guard is what makes them safe to race: a
 * second "turn on" (whose subscription insert is a no-op) forgets nothing, and
 * a refresh that finishes after the source was removed can sweep up what it
 * just ingested.
 */
export function bskySourceDeleteStatements(
  env: Env,
  userDid: string,
  feedUrl: string | null | undefined
): D1PreparedStatement[] {
  const parsed = parseBskySourceFeedUrl(feedUrl);
  if (!parsed || parsed.did !== userDid) return [];
  const unsubscribed =
    'NOT EXISTS (SELECT 1 FROM subscriptions_cache WHERE user_did = ?1 AND feed_url = ?2)';
  return [
    env.DB.prepare(
      `DELETE FROM bsky_source_sync WHERE user_did = ?1 AND kind = ?3 AND ${unsubscribed}`
    ).bind(userDid, feedUrl, parsed.kind),
    env.DB.prepare(`DELETE FROM feed_items WHERE feed_url = ?2 AND ${unsubscribed}`).bind(
      userDid,
      feedUrl
    ),
    env.DB.prepare(`DELETE FROM feeds WHERE feed_url = ?2 AND ${unsubscribed}`).bind(
      userDid,
      feedUrl
    ),
  ];
}

// ---------------------------------------------------------------------------
// Posts → feed items
// ---------------------------------------------------------------------------

/** The slice of app.bsky.feed.defs#postView we read. */
export type BskyPostView = NonNullable<TimelineItem['post']> & {
  record?: { createdAt?: string };
};

function firstLine(text: string, max: number): string {
  const line =
    text
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The post on bsky.app, for the "on Bluesky" link under its words. */
export function bskyPostWebUrl(postUri: string, authorDid: string): string | null {
  const rkey = postUri.split('/').pop();
  return rkey ? `https://bsky.app/profile/${authorDid}/post/${rkey}` : null;
}

/**
 * One liked or bookmarked post as a feed item, or null when it carries no link
 * worth reading (see `postLink`). The item IS the linked article: its url is the
 * link, and it arrives without a body (`contentTruncated`), so opening it
 * extracts the page like any excerpt-only feed. The post's own words ride along
 * as the card's preview (`contentLead`), since why it caught your eye is part of
 * why you kept it. Dated by when you liked or bookmarked it, so the river reads
 * in the order you found things.
 */
export function bskyPostItem(post: BskyPostView, keptAt: string): FeedItem | null {
  if (!post.uri || !post.author?.did) return null;
  const link = postLink(post);
  if (!link) return null;
  const { url, external } = link;

  const text = post.record?.text?.trim() ?? '';
  const name = post.author.displayName?.trim() || post.author.handle || post.author.did;
  const handle = post.author.handle ? `@${post.author.handle}` : null;
  const title = external?.title?.trim() || (text && firstLine(text, 140)) || hostOf(url);
  const description = external?.description?.trim();
  const postUrl = bskyPostWebUrl(post.uri, post.author.did);

  let contentLead: string | undefined;
  if (text) {
    const words = escapeHtml(text.slice(0, SHARE_TEXT_MAX)).replace(/\n+/g, '<br>');
    const who = escapeHtml(handle ? `${name} (${handle})` : name);
    const where = postUrl ? `<a href="${escapeHtml(postUrl)}">on Bluesky</a>` : 'on Bluesky';
    contentLead = `<blockquote><p>${words}</p></blockquote><p>— ${who} ${where}</p>`;
  }

  return {
    guid: post.uri,
    url,
    title,
    author: name,
    ...(description
      ? { summary: description }
      : text
        ? { summary: text.slice(0, SHARE_TEXT_MAX) }
        : {}),
    ...(external?.thumb ? { imageUrl: external.thumb } : {}),
    publishedAt: keptAt,
    contentTruncated: true,
    ...(contentLead ? { contentLead } : {}),
  };
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

interface Kept {
  post: BskyPostView;
  keptAt: string;
}

interface WalkResult {
  kept: Kept[];
  /** The newest mark seen this walk, to store once the items are in. */
  newest: string | null;
  /** Where to carry on from, when the page budget ran out before `stop`. */
  cursor: string | null;
  /** Reached `stop`, or the end of the list: nothing left below. */
  reachedStop: boolean;
  pages: number;
  error: string | null;
  scopeDenied?: boolean;
}

function failed(error: string, scopeDenied = false): WalkResult {
  return { kept: [], newest: null, cursor: null, reachedStop: false, pages: 0, error, scopeDenied };
}

interface LikeRecord {
  subject?: { uri?: string };
  createdAt?: string;
}

/**
 * The reader's likes, newest first from `cursor` (the top when undefined), down
 * to `stop` (a like's rkey: a TID, so it sorts by time) or the page budget.
 * Like records hold only the post's uri, so the posts are hydrated from the
 * public appview.
 */
async function walkLikes(
  pds: PDSClient,
  startCursor: string | undefined,
  stop: string | null,
  maxPages: number
): Promise<WalkResult> {
  const likes: { rkey: string; subject: string; keptAt: string }[] = [];
  // Over every like walked, not just likes of posts: a run of liked feeds or
  // lists must still move the mark past itself.
  let newest: string | null = null;
  let cursor = startCursor;
  let reachedStop = false;
  let pages = 0;
  while (pages < maxPages) {
    const res = await pds.listRecords<LikeRecord>('app.bsky.feed.like', cursor, PAGE_SIZE);
    if (!res.success) return failed(res.error);
    pages++;
    for (const record of res.data.records) {
      const rkey = record.uri.split('/').pop() ?? '';
      if (stop && rkey <= stop) {
        reachedStop = true;
        break;
      }
      if (!newest || rkey > newest) newest = rkey;
      const subject = record.value?.subject?.uri;
      if (!subject?.includes('/app.bsky.feed.post/')) continue;
      likes.push({ rkey, subject, keptAt: record.value.createdAt ?? new Date().toISOString() });
    }
    cursor = res.data.cursor;
    if (!cursor || res.data.records.length === 0) reachedStop = true;
    if (reachedStop) break;
  }

  const next = reachedStop ? null : (cursor ?? null);
  if (likes.length === 0) {
    return { kept: [], newest, cursor: next, reachedStop, pages, error: null };
  }

  const { posts, complete } = await fetchPosts<BskyPostView>(likes.map((l) => l.subject));
  if (!complete) return failed('getPosts failed');
  const kept: Kept[] = [];
  for (const like of likes) {
    const post = posts.get(like.subject);
    if (post) kept.push({ post, keptAt: like.keptAt });
  }
  return { kept, newest, cursor: next, reachedStop, pages, error: null };
}

interface BookmarkView {
  subject?: { uri?: string };
  createdAt?: string;
  item?: BskyPostView & { $type?: string };
}

const POST_VIEW = 'app.bsky.feed.defs#postView';

function timeOf(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The reader's bookmarks, newest first from `cursor` (the top when undefined),
 * down to `stop` (a bookmark's createdAt) or the page budget. getBookmarks
 * returns hydrated posts.
 */
async function walkBookmarks(
  pds: PDSClient,
  startCursor: string | undefined,
  stop: string | null,
  maxPages: number
): Promise<WalkResult> {
  const stopTime = timeOf(stop);
  const kept: Kept[] = [];
  let newest: string | null = null;
  let cursor = startCursor;
  let reachedStop = false;
  let pages = 0;
  while (pages < maxPages) {
    const res = await pds.getBookmarks<BookmarkView>(cursor, PAGE_SIZE);
    if (!res.success) return failed(res.error, isScopeDenial(res));
    pages++;
    const bookmarks = res.data.bookmarks ?? [];
    for (const bookmark of bookmarks) {
      const keptAt = bookmark.createdAt ?? bookmark.item?.indexedAt ?? null;
      if (stop && keptAt && timeOf(keptAt) <= stopTime) {
        reachedStop = true;
        break;
      }
      if (keptAt && timeOf(keptAt) > timeOf(newest)) newest = keptAt;
      const item = bookmark.item;
      // A bookmark of a post since deleted or blocked comes back as a stub.
      if (!item || (item.$type && item.$type !== POST_VIEW)) continue;
      kept.push({ post: item, keptAt: keptAt ?? new Date().toISOString() });
    }
    cursor = res.data.cursor;
    if (!cursor || bookmarks.length === 0) reachedStop = true;
    if (reachedStop) break;
  }
  return {
    kept,
    newest,
    cursor: reachedStop ? null : (cursor ?? null),
    reachedStop,
    pages,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

interface SyncRow {
  last_poll_at: number;
  newest_seen: string | null;
  last_error: string | null;
  gap_cursor: string | null;
  gap_stop: string | null;
}

export type RefreshOutcome =
  | { refreshed: true; ingested: number }
  | { refreshed: false; reason: 'gated' | 'locked' | 'scope_missing' | 'error'; error?: string };

/**
 * Pull new link posts from one source into feed_items.
 *
 * Safe from waitUntil and from several requests at once: the claim is a
 * compare-and-set on `last_poll_at`, so only one caller walks.
 *
 * The first walk takes the newest FIRST_WALK_MAX_PAGES pages. After that a walk
 * goes newest-first down to the high-water mark, and nothing above the mark is
 * ever skipped:
 *  - An error leaves the mark (and any gap) where it was, so the next refresh
 *    walks the same ground again (ingest is idempotent on guid).
 *  - Running out of pages first leaves a gap. Its cursor is saved, the mark
 *    moves to the top (which is now covered), and later refreshes finish the
 *    gap once they've caught up on new items. A second gap folds into the
 *    first: the one saved walk runs from the newer cursor down to the older
 *    stop, re-walking the covered ground in between.
 */
export async function refreshBskySource(
  env: Env,
  session: Session,
  kind: BskySourceKind,
  opts: { force?: boolean; now?: number } = {}
): Promise<RefreshOutcome> {
  const did = session.did;
  const now = opts.now ?? Date.now();

  if (kind === 'bookmarks' && !grantsScopes(session.grantedScopes, BSKY_BOOKMARKS_SCOPES)) {
    return { refreshed: false, reason: 'scope_missing' };
  }

  const existing = await env.DB.prepare(
    `SELECT last_poll_at, newest_seen, last_error, gap_cursor, gap_stop
       FROM bsky_source_sync WHERE user_did = ? AND kind = ?`
  )
    .bind(did, kind)
    .first<SyncRow>();
  if (existing && !opts.force && now - existing.last_poll_at < BSKY_SOURCE_GATE_MS) {
    return { refreshed: false, reason: 'gated' };
  }

  // Insert-or-compare-and-set in one statement: a concurrent claimer either
  // inserted first (so the update's WHERE no longer matches) or already moved
  // last_poll_at.
  const claim = await env.DB.prepare(
    `INSERT INTO bsky_source_sync (user_did, kind, last_poll_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_did, kind) DO UPDATE SET last_poll_at = excluded.last_poll_at
       WHERE bsky_source_sync.last_poll_at = ?4`
  )
    .bind(did, kind, now, existing?.last_poll_at ?? -1)
    .run();
  if (!claim.meta.changes) return { refreshed: false, reason: 'locked' };

  const mark = existing?.newest_seen ?? null;
  const savedGap =
    existing?.gap_cursor && existing.gap_stop
      ? { cursor: existing.gap_cursor, stop: existing.gap_stop }
      : null;
  const pds = createPDSClient(session);
  const walk = (cursor: string | undefined, stop: string | null, maxPages: number) =>
    (kind === 'likes' ? walkLikes : walkBookmarks)(pds, cursor, stop, maxPages).catch((error) =>
      failed(error instanceof Error ? error.message : 'walk failed')
    );

  // The top of the list, down to the mark.
  const top = await walk(undefined, mark, mark ? WALK_MAX_PAGES : FIRST_WALK_MAX_PAGES);

  if (top.error) {
    const stored = top.scopeDenied ? BSKY_SOURCE_SCOPE_DENIED : top.error.slice(0, 200);
    await env.DB.prepare(
      'UPDATE bsky_source_sync SET last_error = ? WHERE user_did = ? AND kind = ?'
    )
      .bind(stored, did, kind)
      .run();
    log.warn('bsky_source_refresh_failed', { did, kind, error: top.error });
    return { refreshed: false, reason: 'error', error: stored };
  }

  const kept = [...top.kept];
  let gap = savedGap;
  if (mark && !top.reachedStop && top.cursor) {
    // A burst bigger than the budget: remember where the walk stopped. The
    // first walk has no mark to reach, so it never leaves one.
    gap = { cursor: top.cursor, stop: savedGap?.stop ?? mark };
  } else if (top.reachedStop && savedGap) {
    // Caught up at the top: spend what's left finishing the older gap.
    const remaining = REFRESH_MAX_PAGES - top.pages;
    if (remaining > 0) {
      const older = await walk(savedGap.cursor, savedGap.stop, remaining);
      if (older.error) {
        // Keep the gap as it was; the top's items still go in.
        log.warn('bsky_source_gap_walk_failed', { did, kind, error: older.error });
      } else {
        // Oldest last: the ingest loop below reverses, so these go in first.
        kept.push(...older.kept);
        gap = older.reachedStop ? null : { cursor: older.cursor!, stop: savedGap.stop };
      }
    }
  }

  const feedUrl = bskySourceFeedUrl(kind, did);
  const entries: IngestItem[] = [];
  // Oldest first, so the archive's seq order matches the order they were kept.
  for (const { post, keptAt } of [...kept].reverse()) {
    const item = bskyPostItem(post, keptAt);
    if (!item) continue;
    const publishedAt = timeOf(keptAt) || null;
    entries.push({
      feedUrl,
      guid: item.guid,
      item,
      publishedAt,
      firstSeenAt: now,
      contentHash: await computeContentHash(item),
    });
  }

  if (entries.length > 0) {
    await ingestBatch(
      env,
      [{ feedUrl, title: TITLE[kind], siteUrl: SITE_URL, description: null, imageUrl: null }],
      entries
    );
  }

  // Still ours only if nobody re-claimed or removed the source mid-walk.
  const settled = await env.DB.prepare(
    `UPDATE bsky_source_sync
        SET newest_seen = COALESCE(?, newest_seen), last_error = NULL,
            gap_cursor = ?, gap_stop = ?
      WHERE user_did = ? AND kind = ? AND last_poll_at = ?`
  )
    .bind(top.newest, gap?.cursor ?? null, gap?.stop ?? null, did, kind, now)
    .run();
  if (!settled.meta.changes) {
    // Removed while we walked: sweep up what we just put back (the guard keeps
    // it all if the source was turned on again meanwhile).
    await env.DB.batch(bskySourceDeleteStatements(env, did, feedUrl));
    log.info('bsky_source_refresh_superseded', { did, kind });
    return { refreshed: false, reason: 'locked' };
  }
  log.info('bsky_source_refreshed', {
    did,
    kind,
    walked: kept.length,
    ingested: entries.length,
    gap: !!gap,
  });
  return { refreshed: true, ingested: entries.length };
}

// Readers this isolate has seen with neither source, until when (ms). Nearly
// every reader has neither, so this spares their timeline polls the lookup.
// Turning a source on runs its first walk itself, so a stale entry elsewhere
// only delays that source's next refresh by up to one gate.
const NO_SOURCES_TTL_MS = BSKY_SOURCE_GATE_MS;
const NO_SOURCES_MAX = 10_000;
const noSourcesUntil = new Map<string, number>();

/** Test hook: forget the isolate's negative cache. */
export function resetBskySourceCache(): void {
  noSourcesUntil.clear();
}

/**
 * After a timeline request: refresh whichever of the reader's Bluesky sources
 * are subscribed, active and past the gate. One indexed read for a reader with
 * neither, at most once per gate per isolate.
 */
export async function refreshBskySourcesIfDue(env: Env, session: Session): Promise<void> {
  const now = Date.now();
  const cachedUntil = noSourcesUntil.get(session.did);
  if (cachedUntil !== undefined) {
    if (cachedUntil > now) return;
    noSourcesUntil.delete(session.did);
  }

  const rows = await env.DB.prepare(
    `SELECT sc.feed_url, s.last_poll_at
       FROM subscriptions_cache sc
       LEFT JOIN bsky_source_sync s
         ON s.user_did = sc.user_did
        AND s.kind = CASE WHEN sc.feed_url = ?2 THEN 'likes' ELSE 'bookmarks' END
      WHERE sc.user_did = ?1 AND sc.feed_url IN (?2, ?3) AND sc.active = 1`
  )
    .bind(
      session.did,
      bskySourceFeedUrl('likes', session.did),
      bskySourceFeedUrl('bookmarks', session.did)
    )
    .all<{ feed_url: string; last_poll_at: number | null }>();

  if ((rows.results ?? []).length === 0) {
    if (noSourcesUntil.size >= NO_SOURCES_MAX) noSourcesUntil.clear();
    noSourcesUntil.set(session.did, now + NO_SOURCES_TTL_MS);
    return;
  }
  for (const row of rows.results ?? []) {
    if (row.last_poll_at !== null && now - row.last_poll_at < BSKY_SOURCE_GATE_MS) continue;
    const parsed = parseBskySourceFeedUrl(row.feed_url);
    if (!parsed) continue;
    try {
      await refreshBskySource(env, session, parsed.kind, { now });
    } catch (error) {
      log.error('bsky_source_refresh_threw', {
        did: session.did,
        kind: parsed.kind,
        ...serializeError(error),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Turning a source on and off
// ---------------------------------------------------------------------------

export interface BskySourceStatus {
  enabled: boolean;
  /** On, but parked by the plan's limit on active sources: nothing is gathered. */
  parked: boolean;
  /** The source needs a permission this session doesn't hold (bookmarks only). */
  scopeRequired: boolean;
  lastPollAt: number | null;
  error: string | null;
}

export async function readBskySourceStatus(
  env: Env,
  session: Session
): Promise<Record<BskySourceKind, BskySourceStatus>> {
  const [subs, syncs] = await Promise.all([
    env.DB.prepare(
      'SELECT feed_url, active FROM subscriptions_cache WHERE user_did = ? AND feed_url IN (?, ?)'
    )
      .bind(
        session.did,
        bskySourceFeedUrl('likes', session.did),
        bskySourceFeedUrl('bookmarks', session.did)
      )
      .all<{ feed_url: string; active: number }>(),
    env.DB.prepare('SELECT kind, last_poll_at, last_error FROM bsky_source_sync WHERE user_did = ?')
      .bind(session.did)
      .all<{ kind: string; last_poll_at: number; last_error: string | null }>(),
  ]);
  const subscribed = new Map((subs.results ?? []).map((r) => [r.feed_url, r.active === 1]));
  const sync = new Map((syncs.results ?? []).map((r) => [r.kind, r]));
  const hasBookmarkScope = grantsScopes(session.grantedScopes, BSKY_BOOKMARKS_SCOPES);

  const status = {} as Record<BskySourceKind, BskySourceStatus>;
  for (const kind of BSKY_SOURCE_KINDS) {
    const row = sync.get(kind);
    const active = subscribed.get(bskySourceFeedUrl(kind, session.did));
    status[kind] = {
      enabled: active !== undefined,
      parked: active === false,
      scopeRequired:
        kind === 'bookmarks' && (!hasBookmarkScope || row?.last_error === BSKY_SOURCE_SCOPE_DENIED),
      lastPollAt: row?.last_poll_at || null,
      error: row?.last_error ?? null,
    };
  }
  return status;
}

export type EnableResult = 'enabled' | 'already' | 'over_mirror_cap' | 'scope_required';

/**
 * Subscribe the reader to one of their Bluesky sources and run its first walk,
 * so the client's next read finds it populated. Over the plan's active cap the
 * row is created parked, like any other overflow, and the status says so.
 * Already on: walk again now, which is how a newly granted permission clears a
 * refusal without waiting out the gate.
 */
export async function enableBskySource(
  env: Env,
  session: Session,
  kind: BskySourceKind
): Promise<EnableResult> {
  if (kind === 'bookmarks' && !grantsScopes(session.grantedScopes, BSKY_BOOKMARKS_SCOPES)) {
    return 'scope_required';
  }
  const did = session.did;
  const feedUrl = bskySourceFeedUrl(kind, did);
  const existing = await env.DB.prepare(
    'SELECT active FROM subscriptions_cache WHERE user_did = ? AND feed_url = ? LIMIT 1'
  )
    .bind(did, feedUrl)
    .first<{ active: number }>();
  if (existing) {
    if (existing.active) await walkNow(env, session, kind);
    return 'already';
  }

  const limits = await getUserTierLimits(env, did);
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(active = 1), 0) AS active
       FROM subscriptions_cache WHERE user_did = ?`
  )
    .bind(did)
    .first<{ total: number; active: number }>();
  if ((counts?.total ?? 0) >= limits.maxMirroredSubscriptions) return 'over_mirror_cap';
  const active = (counts?.active ?? 0) < limits.maxSubscriptions ? 1 : 0;

  // A TID rkey like every other row, so the client's rkey-addressed routes
  // (rename, park, delete) work on it unchanged. The record_uri names a PDS
  // record that never exists — nothing ever pushes this row.
  const recordUri = `at://${did}/app.skyreader.feed.subscription/${generateTid()}`;
  await env.DB.batch([
    // A fresh start: a source turned off and on again re-walks from the top.
    ...bskySourceDeleteStatements(env, did, feedUrl),
    env.DB.prepare(
      `INSERT OR IGNORE INTO subscriptions_cache
         (user_did, record_uri, feed_url, title, site_url, created_at, source_type, source, active)
       VALUES (?, ?, ?, ?, ?, unixepoch(), ?, 'bluesky', ?)`
    ).bind(did, recordUri, feedUrl, TITLE[kind], SITE_URL, SOURCE_TYPE[kind], active),
  ]);

  noSourcesUntil.delete(did);
  if (active) await walkNow(env, session, kind);
  return 'enabled';
}

async function walkNow(env: Env, session: Session, kind: BskySourceKind): Promise<void> {
  try {
    await refreshBskySource(env, session, kind, { force: true });
  } catch (error) {
    // The row is in; the next timeline read retries the walk.
    log.error('bsky_source_first_walk_threw', {
      did: session.did,
      kind,
      ...serializeError(error),
    });
  }
}

/** Unsubscribe the reader from one of their Bluesky sources and drop its items. */
export async function disableBskySource(
  env: Env,
  session: Session,
  kind: BskySourceKind
): Promise<void> {
  const feedUrl = bskySourceFeedUrl(kind, session.did);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM subscriptions_cache WHERE user_did = ? AND feed_url = ?').bind(
      session.did,
      feedUrl
    ),
    ...bskySourceDeleteStatements(env, session.did, feedUrl),
  ]);
}
