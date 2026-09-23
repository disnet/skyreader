// From your follows: the D1 half. Refreshes a reader's link shares from their
// Following timeline and serves them grouped by article.
// See docs/plans/FOLLOWS_LINKS_PLAN.md; extraction rules live in follow-links.ts.

import type { Env, Session } from '../types';
import { createPDSClient } from './pds-client';
import {
  extractLinkShare,
  type LinkShare,
  type ShareKind,
  type TimelineItem,
} from './follow-links';
import { log } from '../utils/logger';

/** A refresh is due once the last one is this old. */
export const FOLLOW_LINKS_GATE_MS = 10 * 60 * 1000;
/** How long a share is kept, and the widest window the surface serves. */
export const FOLLOW_LINKS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How long opened/dismissed state outlives the shares it was about. */
export const FOLLOW_LINKS_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Page caps. A first refresh walks back up to the retention window; a later one
 * only back to the high-water mark, which is usually a page or two. ~470ms a
 * page (Phase 0), so a full first walk is ~10s: fine under waitUntil.
 */
export const FIRST_REFRESH_MAX_PAGES = 20;
export const REFRESH_MAX_PAGES = 10;
const PAGE_SIZE = 100;
/**
 * One upsert per share, and D1 allows 1,000 queries plus subrequests per
 * invocation. A link-heavy timeline could otherwise spend it all; stop paging
 * once this many shares are written.
 */
export const MAX_SHARES_PER_REFRESH = 600;
/** Rows read to build the served list; enough for a heavy week. */
const SERVE_ROW_LIMIT = 3000;
/** Articles served per request. The list ends; that is part of the calm. */
export const SERVE_LINK_LIMIT = 60;

export type FollowLinksWindow = '24h' | '3d' | '7d';
export const FOLLOW_LINKS_WINDOWS: Record<FollowLinksWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': FOLLOW_LINKS_RETENTION_MS,
};

interface SyncRow {
  last_poll_at: number;
  newest_seen_at: number | null;
  complete: number;
  last_error: string | null;
  gap_cursor: string | null;
  gap_stop_at: number | null;
  gap_at: number | null;
}

const SYNC_COLUMNS =
  'last_poll_at, newest_seen_at, complete, last_error, gap_cursor, gap_stop_at, gap_at';

export interface FollowLinksSync {
  lastPollAt: number;
  complete: boolean;
  error: string | null;
}

export async function readFollowLinksSync(env: Env, did: string): Promise<FollowLinksSync | null> {
  const row = await env.DB.prepare(
    'SELECT last_poll_at, newest_seen_at, complete, last_error FROM follow_link_sync WHERE user_did = ?'
  )
    .bind(did)
    .first<SyncRow>();
  if (!row) return null;
  return { lastPollAt: row.last_poll_at, complete: !!row.complete, error: row.last_error };
}

export function followLinksNeedRefresh(sync: FollowLinksSync | null, now: number): boolean {
  return !sync || now - sync.lastPollAt >= FOLLOW_LINKS_GATE_MS;
}

/** When a timeline item landed in the feed: the repost's time for a repost. */
function itemTime(item: TimelineItem): number | null {
  const at = item.reason?.indexedAt ?? item.post?.indexedAt;
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export type RefreshResult =
  | { refreshed: false; reason: 'gated' | 'locked' }
  | { refreshed: true; pages: number; shares: number; reachedEnd: boolean; error?: string };

/** Pages and upserts left in this refresh, shared by the walks it makes. */
interface WalkBudget {
  pages: number;
  shares: number;
}

interface WalkResult {
  pages: number;
  written: number;
  /** Newest and oldest item times seen, or null if no page came back. */
  newest: number | null;
  oldest: number | null;
  /** Where to carry on from: the next page to fetch, or the one that failed. */
  cursor: string | undefined;
  /** The walk got down to `stopAt` (or the end of the timeline). */
  reachedStop: boolean;
  error?: string;
}

/**
 * Walk the timeline newest-first from `cursor` down to `stopAt`, upserting the
 * link shares on the way, until the budget runs out. Pages are written whole:
 * the share cap stops the walk before a page rather than part-way through one,
 * so `cursor` is always a clean place to resume.
 */
async function walkTimeline(
  env: Env,
  pds: ReturnType<typeof createPDSClient>,
  did: string,
  cursor: string | undefined,
  stopAt: number,
  budget: WalkBudget
): Promise<WalkResult> {
  const out: WalkResult = {
    pages: 0,
    written: 0,
    newest: null,
    oldest: null,
    cursor,
    reachedStop: false,
  };

  // A page carries at most PAGE_SIZE shares, so this never overshoots the cap.
  while (budget.pages > 0 && budget.shares >= PAGE_SIZE) {
    const res = await pds.getTimeline<TimelineItem>(out.cursor, PAGE_SIZE);
    if (!res.success) {
      out.error = res.error;
      break;
    }
    budget.pages--;
    out.pages++;
    const feed = res.data.feed ?? [];

    const shares: LinkShare[] = [];
    let pageOldest = Infinity;
    for (const item of feed) {
      const at = itemTime(item);
      if (at === null) continue;
      if (out.newest === null || at > out.newest) out.newest = at;
      if (out.oldest === null || at < out.oldest) out.oldest = at;
      pageOldest = Math.min(pageOldest, at);
      if (at < stopAt) continue;
      const share = extractLinkShare(item, did);
      if (share) shares.push(share);
    }

    if (shares.length > 0) {
      await env.DB.batch(shares.map((s) => upsertShare(env, did, s)));
      out.written += shares.length;
      budget.shares -= shares.length;
    }

    const next = res.data.cursor;
    if (!next || feed.length === 0 || pageOldest < stopAt) {
      out.reachedStop = true;
      break;
    }
    out.cursor = next;
  }
  return out;
}

/**
 * Pull new link shares from the reader's Following timeline into D1.
 *
 * Safe to run from `waitUntil` and from several requests at once: the claim is
 * a compare-and-set on `last_poll_at`, so only one caller walks.
 *
 * The walk goes newest-first down to the high-water mark (or, the first time,
 * the retention window). Nothing between the top of the timeline and where a
 * walk stopped is ever skipped:
 *  - An error leaves the high-water mark where it was, so the next refresh
 *    walks the same ground again (upserts make that harmless).
 *  - Running out of pages or shares first leaves a gap. Its cursor is saved,
 *    the high-water mark moves to the top (which is now covered), and later
 *    refreshes finish the gap once they have caught up on new posts. A second
 *    gap folds into the first: the one saved walk runs from the newer cursor
 *    down to the older stop, re-walking the covered ground in between.
 */
export async function refreshFollowLinks(
  env: Env,
  session: Session,
  opts: { force?: boolean; now?: number } = {}
): Promise<RefreshResult> {
  const did = session.did;
  const now = opts.now ?? Date.now();
  const existing = await env.DB.prepare(
    `SELECT ${SYNC_COLUMNS} FROM follow_link_sync WHERE user_did = ?`
  )
    .bind(did)
    .first<SyncRow>();

  if (
    existing &&
    !opts.force &&
    !followLinksNeedRefresh(
      { lastPollAt: existing.last_poll_at, complete: !!existing.complete, error: null },
      now
    )
  ) {
    return { refreshed: false, reason: 'gated' };
  }

  const claim = existing
    ? await env.DB.prepare(
        'UPDATE follow_link_sync SET last_poll_at = ? WHERE user_did = ? AND last_poll_at = ?'
      )
        .bind(now, did, existing.last_poll_at)
        .run()
    : await env.DB.prepare(
        'INSERT INTO follow_link_sync (user_did, last_poll_at) VALUES (?, ?) ON CONFLICT(user_did) DO NOTHING'
      )
        .bind(did, now)
        .run();
  if (!claim.meta.changes) return { refreshed: false, reason: 'locked' };

  const firstRun = !existing?.complete;
  const retentionCutoff = now - FOLLOW_LINKS_RETENTION_MS;
  const budget: WalkBudget = {
    pages: firstRun ? FIRST_REFRESH_MAX_PAGES : REFRESH_MAX_PAGES,
    shares: MAX_SHARES_PER_REFRESH,
  };
  const pds = createPDSClient(session);

  let newestSeen = existing?.newest_seen_at ?? null;
  // A saved gap whose walk has already passed its stop (or aged out of the
  // window) has nothing left to fetch.
  let gap =
    existing?.gap_cursor &&
    !(
      existing.gap_at !== null &&
      existing.gap_at < Math.max(existing.gap_stop_at ?? 0, retentionCutoff)
    )
      ? { cursor: existing.gap_cursor, stopAt: existing.gap_stop_at ?? 0, at: existing.gap_at }
      : null;

  // The top of the timeline, down to the high-water mark.
  const topStop = Math.max(newestSeen ?? 0, retentionCutoff);
  const top = await walkTimeline(env, pds, did, undefined, topStop, budget);
  let error = top.error;
  if (!error && top.newest !== null) {
    if (!top.reachedStop) {
      gap = { cursor: top.cursor!, stopAt: gap?.stopAt ?? topStop, at: top.oldest };
    }
    newestSeen = Math.max(newestSeen ?? 0, top.newest);
  }

  // Then an older gap, with whatever budget is left.
  let gapWalk: WalkResult | null = null;
  if (!error && top.reachedStop && gap) {
    gapWalk = await walkTimeline(
      env,
      pds,
      did,
      gap.cursor,
      Math.max(gap.stopAt, retentionCutoff),
      budget
    );
    if (gapWalk.reachedStop) {
      gap = null;
    } else {
      // Keep what it covered, whether it ran out or hit an error.
      gap = { cursor: gapWalk.cursor!, stopAt: gap.stopAt, at: gapWalk.oldest ?? gap.at };
      error = gapWalk.error;
    }
  }

  const pages = top.pages + (gapWalk?.pages ?? 0);
  const written = top.written + (gapWalk?.written ?? 0);
  const reachedEnd = !error && top.reachedStop && gap === null;

  await env.DB.prepare(
    `UPDATE follow_link_sync
        SET newest_seen_at = ?1, gap_cursor = ?2, gap_stop_at = ?3, gap_at = ?4,
            complete = CASE WHEN ?5 THEN 1 ELSE complete END,
            last_error = ?6
      WHERE user_did = ?7`
  )
    .bind(
      newestSeen,
      gap?.cursor ?? null,
      gap?.stopAt ?? null,
      gap?.at ?? null,
      top.error ? 0 : 1,
      error ?? null,
      did
    )
    .run();

  if (error) {
    log.warn('follow_links_refresh_failed', { did, pages, written, error });
  } else {
    log.info('follow_links_refreshed', { did, pages, written, reachedEnd, firstRun });
  }
  return { refreshed: true, pages, shares: written, reachedEnd, ...(error ? { error } : {}) };
}

function upsertShare(env: Env, did: string, s: LinkShare) {
  const sharedAt = Date.parse(s.sharedAt);
  return env.DB.prepare(
    `INSERT INTO follow_link_shares
       (user_did, post_uri, sharer_did, kind, url, url_normalized, post_text,
        card_title, card_description, card_thumb, sharer_handle, sharer_name, sharer_avatar, shared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_did, post_uri, sharer_did) DO UPDATE SET
       post_text = excluded.post_text,
       card_title = COALESCE(excluded.card_title, card_title),
       card_description = COALESCE(excluded.card_description, card_description),
       card_thumb = COALESCE(excluded.card_thumb, card_thumb),
       sharer_handle = excluded.sharer_handle,
       sharer_name = excluded.sharer_name,
       sharer_avatar = excluded.sharer_avatar`
  ).bind(
    did,
    s.postUri,
    s.sharer.did,
    s.kind,
    s.url,
    s.urlNormalized,
    s.text,
    s.card?.title ?? null,
    s.card?.description ?? null,
    s.card?.thumb ?? null,
    s.sharer.handle ?? null,
    s.sharer.displayName ?? null,
    s.sharer.avatar ?? null,
    Number.isFinite(sharedAt) ? sharedAt : Date.now()
  );
}

// ---------------------------------------------------------------------------
// Serving

interface ShareRow {
  post_uri: string;
  sharer_did: string;
  kind: ShareKind;
  url: string;
  url_normalized: string;
  post_text: string | null;
  card_title: string | null;
  card_description: string | null;
  card_thumb: string | null;
  sharer_handle: string | null;
  sharer_name: string | null;
  sharer_avatar: string | null;
  shared_at: number;
}

export interface FollowLinkSharer {
  did: string;
  handle: string | null;
  name: string | null;
  avatar: string | null;
  kind: ShareKind;
  postUri: string;
  text: string | null;
  sharedAt: number;
}

export interface FollowLink {
  /** The link to open: the posted URL behind the best card, tracking and all. */
  url: string;
  urlNormalized: string;
  /** Host, for the byline and as the title of last resort. */
  site: string;
  title: string | null;
  description: string | null;
  thumb: string | null;
  sharers: FollowLinkSharer[];
  sharerCount: number;
  firstSharedAt: number;
  lastSharedAt: number;
  opened: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Group rows (newest first) into one entry per article, ranked by how many
 * distinct people shared it, then by the latest share. Pure, for testing.
 *
 * Each sharer appears once per article, at their latest share of it. The card
 * is the freshest share that has one, since a bare-facet share has none and
 * another follow's post of the same link usually does.
 */
export function groupFollowLinks(
  rows: ShareRow[],
  state: Map<string, { opened: boolean; dismissed: boolean }>,
  limit = SERVE_LINK_LIMIT
): FollowLink[] {
  const byUrl = new Map<string, { rows: ShareRow[]; sharers: Map<string, ShareRow> }>();
  for (const row of rows) {
    if (state.get(row.url_normalized)?.dismissed) continue;
    let group = byUrl.get(row.url_normalized);
    if (!group) {
      group = { rows: [], sharers: new Map() };
      byUrl.set(row.url_normalized, group);
    }
    group.rows.push(row);
    const prior = group.sharers.get(row.sharer_did);
    if (!prior || row.shared_at > prior.shared_at) group.sharers.set(row.sharer_did, row);
  }

  const links: FollowLink[] = [];
  for (const [urlNormalized, group] of byUrl) {
    const byTime = [...group.rows].sort((a, b) => b.shared_at - a.shared_at);
    const carded = byTime.find((r) => r.card_title) ?? byTime[0];
    const sharers = [...group.sharers.values()]
      .sort((a, b) => b.shared_at - a.shared_at)
      .map((r) => ({
        did: r.sharer_did,
        handle: r.sharer_handle,
        name: r.sharer_name,
        avatar: r.sharer_avatar,
        kind: r.kind,
        postUri: r.post_uri,
        text: r.post_text,
        sharedAt: r.shared_at,
      }));
    links.push({
      url: carded.url,
      urlNormalized,
      site: hostOf(urlNormalized),
      title: carded.card_title,
      description: carded.card_description,
      thumb: carded.card_thumb,
      sharers,
      sharerCount: sharers.length,
      firstSharedAt: byTime[byTime.length - 1].shared_at,
      lastSharedAt: byTime[0].shared_at,
      opened: !!state.get(urlNormalized)?.opened,
    });
  }

  links.sort((a, b) => b.sharerCount - a.sharerCount || b.lastSharedAt - a.lastSharedAt);
  return links.slice(0, limit);
}

export async function readFollowLinks(
  env: Env,
  did: string,
  window: FollowLinksWindow,
  now = Date.now()
): Promise<FollowLink[]> {
  const since = now - FOLLOW_LINKS_WINDOWS[window];
  const [rows, state] = await env.DB.batch([
    env.DB.prepare(
      `SELECT post_uri, sharer_did, kind, url, url_normalized, post_text, card_title,
              card_description, card_thumb, sharer_handle, sharer_name, sharer_avatar, shared_at
         FROM follow_link_shares
        WHERE user_did = ? AND shared_at >= ?
        ORDER BY shared_at DESC
        LIMIT ?`
    ).bind(did, since, SERVE_ROW_LIMIT),
    env.DB.prepare(
      `SELECT url_normalized, opened_at, dismissed_at FROM follow_link_state WHERE user_did = ?`
    ).bind(did),
  ]);
  const stateMap = new Map<string, { opened: boolean; dismissed: boolean }>();
  for (const s of state.results as {
    url_normalized: string;
    opened_at: number | null;
    dismissed_at: number | null;
  }[]) {
    stateMap.set(s.url_normalized, { opened: !!s.opened_at, dismissed: !!s.dismissed_at });
  }
  return groupFollowLinks(rows.results as ShareRow[], stateMap);
}

/**
 * Who among the reader's follows shared this one article, newest first, across
 * the whole retention window. Feeds the "People you follow" group in the
 * reader's Discussion panel, for any article however it was opened. Dismissing
 * a link on /following doesn't hide who shared it here.
 */
export async function readFollowLinkSharers(
  env: Env,
  did: string,
  urlNormalized: string,
  now = Date.now()
): Promise<FollowLinkSharer[]> {
  const rows = await env.DB.prepare(
    `SELECT post_uri, sharer_did, kind, url, url_normalized, post_text, card_title,
            card_description, card_thumb, sharer_handle, sharer_name, sharer_avatar, shared_at
       FROM follow_link_shares
      WHERE user_did = ? AND url_normalized = ? AND shared_at >= ?
      ORDER BY shared_at DESC`
  )
    .bind(did, urlNormalized, now - FOLLOW_LINKS_RETENTION_MS)
    .all<ShareRow>();
  const [link] = groupFollowLinks(rows.results, new Map(), 1);
  return link?.sharers ?? [];
}

export type FollowLinkAction = 'opened' | 'dismissed' | 'restored';

export async function setFollowLinkState(
  env: Env,
  did: string,
  urlNormalized: string,
  action: FollowLinkAction,
  now = Date.now()
): Promise<void> {
  const opened = action === 'opened' ? now : null;
  const dismissed = action === 'dismissed' ? now : null;
  await env.DB.prepare(
    `INSERT INTO follow_link_state (user_did, url_normalized, opened_at, dismissed_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(user_did, url_normalized) DO UPDATE SET
       opened_at = COALESCE(opened_at, excluded.opened_at),
       dismissed_at = CASE WHEN ?6 = 'restored' THEN NULL
                           ELSE COALESCE(excluded.dismissed_at, dismissed_at) END,
       updated_at = excluded.updated_at`
  )
    .bind(did, urlNormalized, opened, dismissed, now, action)
    .run();
}

/** Hourly cron: drop shares past retention, and state nobody has touched in a month. */
export async function purgeFollowLinks(env: Env, now = Date.now()): Promise<number> {
  const [shares, state] = await env.DB.batch([
    env.DB.prepare('DELETE FROM follow_link_shares WHERE shared_at < ?').bind(
      now - FOLLOW_LINKS_RETENTION_MS
    ),
    env.DB.prepare('DELETE FROM follow_link_state WHERE updated_at < ?').bind(
      now - FOLLOW_LINKS_STATE_RETENTION_MS
    ),
  ]);
  return (shares.meta?.changes ?? 0) + (state.meta?.changes ?? 0);
}
