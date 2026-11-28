/**
 * Watch for updates: news about the saves a reader asked to hear about
 * (docs/plans/SAVE_WATCHES.md).
 *
 * Semble connections reach every save for free, off the firehose
 * (services/semble-connections.ts). The rest of what happens to a page has to
 * be asked for, so it's asked only for saves the reader switched Watch on:
 *
 * - **Mentions**, daily: the feed proxy's Constellation counts per lane (people
 *   who posted it on Bluesky, commented on Leaflet, noted it on a linkblog or on
 *   margin.at). A lane that grew becomes an event naming the newest few.
 * - **Citations**, weekly, for a save with a DOI: OpenAlex's `cited_by_count`,
 *   and on a rise the newest citing works.
 *
 * Checks are per normalized URL (`watch_targets`), not per reader, so a paper
 * ten readers watch costs one check. A target's first settled check only sets
 * the baseline: switching Watch on never reports what was already there.
 */

import type { Env } from '../types';
import type { TierLimits } from '../config/tier-limits';
import { enqueueJobs, type Job } from './jobs';
import { FeedProxyClient, type ArticleMentionsResult } from './feed-proxy-client';
import { savedUrlKey } from './semble-connections';
import { exactDoi, idsFromUrl } from './export/identifiers';
import { log, serializeError } from '../utils/logger';

/** The mention lanes a watch reports. Semble has its own lane on the Shelf. */
export const WATCHED_LANES = ['bluesky', 'leaflet', 'linkblog', 'margin'] as const;
export type WatchedLane = (typeof WATCHED_LANES)[number];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** How often a target's mentions are checked. A little under a day, so the cron's slots drift. */
export const MENTION_CHECK_MS = 20 * HOUR;
/** How often a target with a DOI is asked about citations. */
export const CITATION_CHECK_MS = 7 * DAY - 4 * HOUR;
/**
 * Targets the cron queues per minute of cadence, per kind. 50 a minute is
 * 72,000 a day: room to spare, while one cron run stays a couple of sends.
 */
export const WATCH_CHECKS_PER_CRON = 50;
/** A queued check not done by then is queued again. */
const REQUEUE_MS = 2 * HOUR;
/** Targets per mention job: one proxy call for the counts, plus a lane lookup per change. */
export const MENTION_JOB_TARGETS = 25;
/** Targets per citation job: one or two OpenAlex calls each. */
export const CITATION_JOB_TARGETS = 10;
/** People or works described per event; the rest are a count. */
const DETAIL_PER_EVENT = 3;
/** Unseen events sent per save; older ones still count. */
const EVENTS_PER_SAVE = 6;
/** Events kept this long, so a reader away for months still finds a recent trail. */
export const EVENT_RETENTION_MS = 90 * DAY;

export type WatchRefusal = 'not_found' | 'no_url' | 'limit';

export interface WatchEvent {
  kind: 'mentions' | 'citations';
  /** The mention lane, for `mentions`. */
  lane: WatchedLane | null;
  /** How many more people (mentions) or works (citations). */
  count: number;
  /** A few of them, newest first. */
  detail: WatchEventDetail[];
  /** When the check found it (ms). */
  at: number;
}

export interface WatchEventDetail {
  /** Mentions: who. */
  did?: string;
  handle?: string | null;
  displayName?: string | null;
  /** Citations: the citing work's title. */
  title?: string | null;
  year?: number | null;
  /** Where to read it: the post, note or work. */
  url?: string | null;
  note?: string | null;
}

export interface SaveWatch {
  rkey: string;
  watchedAt: number;
  /** When the reader last cleared this save's updates; null if never. */
  seenAt: number | null;
  /** Events since the last clear (or since watching). */
  unseen: number;
  /** When the newest unseen event arrived; null when none. */
  latestAt: number | null;
  /** The newest unseen events, newest first, up to EVENTS_PER_SAVE. */
  events: WatchEvent[];
  /** Whether the save has a DOI, so citations are checked. */
  citations: boolean;
}

function doiFor(url: string | null, declared: string | null): string | null {
  return (url ? idsFromUrl(url).doi : undefined) ?? exactDoi(declared) ?? null;
}

/** Saves this reader watches that still exist. What the cap counts. */
async function countWatches(env: Env, userDid: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM save_watches w
       JOIN saved_articles s ON s.user_did = w.user_did AND s.rkey = w.rkey
      WHERE w.user_did = ?`
  )
    .bind(userDid)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Switch Watch on for these saves, as far as the plan's cap allows. A save
 * already watched counts as watched and costs nothing. Refusals name the save
 * and why: gone, no web address to watch (an upload), or over the cap.
 */
export async function watchSaves(
  env: Env,
  userDid: string,
  rkeys: string[],
  limits: Pick<TierLimits, 'maxWatchedSaves'>,
  now = Date.now()
): Promise<{ watched: string[]; refused: { rkey: string; reason: WatchRefusal }[] }> {
  const wanted = [...new Set(rkeys)];
  if (wanted.length === 0) return { watched: [], refused: [] };
  const placeholders = wanted.map(() => '?').join(',');
  const [saves, existing] = await env.DB.batch([
    env.DB.prepare(
      `SELECT rkey, url, url_key, doi FROM saved_articles WHERE user_did = ? AND rkey IN (${placeholders})`
    ).bind(userDid, ...wanted),
    env.DB.prepare(
      `SELECT rkey FROM save_watches WHERE user_did = ? AND rkey IN (${placeholders})`
    ).bind(userDid, ...wanted),
  ]);
  const byRkey = new Map(
    (
      saves.results as {
        rkey: string;
        url: string | null;
        url_key: string | null;
        doi: string | null;
      }[]
    ).map((s) => [s.rkey, s])
  );
  const already = new Set((existing.results as { rkey: string }[]).map((r) => r.rkey));

  let room = limits.maxWatchedSaves - (await countWatches(env, userDid));
  const watched: string[] = [];
  const refused: { rkey: string; reason: WatchRefusal }[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const rkey of wanted) {
    const save = byRkey.get(rkey);
    if (!save) {
      refused.push({ rkey, reason: 'not_found' });
      continue;
    }
    if (already.has(rkey)) {
      watched.push(rkey);
      continue;
    }
    const urlKey = save.url_key || savedUrlKey(save.url);
    if (!urlKey || !save.url) {
      refused.push({ rkey, reason: 'no_url' });
      continue;
    }
    if (room <= 0) {
      refused.push({ rkey, reason: 'limit' });
      continue;
    }
    room--;
    watched.push(rkey);
    statements.push(
      env.DB.prepare(
        `INSERT INTO save_watches (user_did, rkey, url_key, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_did, rkey) DO NOTHING`
      ).bind(userDid, rkey, urlKey, now),
      // A DOI found later (another reader's save declared one) fills a target in.
      env.DB.prepare(
        `INSERT INTO watch_targets (url_key, url, doi) VALUES (?, ?, ?)
         ON CONFLICT(url_key) DO UPDATE SET doi = COALESCE(watch_targets.doi, excluded.doi)`
      ).bind(urlKey, save.url, doiFor(save.url, save.doi))
    );
    if (!save.url_key) {
      statements.push(
        env.DB.prepare(
          'UPDATE saved_articles SET url_key = ? WHERE user_did = ? AND rkey = ?'
        ).bind(urlKey, userDid, rkey)
      );
    }
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return { watched, refused };
}

/** Switch Watch off for these saves, and stop checking URLs nobody watches any more. */
export async function unwatchSaves(env: Env, userDid: string, rkeys: string[]): Promise<void> {
  const wanted = [...new Set(rkeys)];
  if (wanted.length === 0) return;
  const placeholders = wanted.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `DELETE FROM save_watches WHERE user_did = ? AND rkey IN (${placeholders}) RETURNING url_key`
  )
    .bind(userDid, ...wanted)
    .all<{ url_key: string }>();
  const keys = [...new Set(rows.results.map((r) => r.url_key))];
  if (keys.length > 0) await dropUnwatchedTargets(env, keys);
}

async function dropUnwatchedTargets(env: Env, urlKeys: string[]): Promise<void> {
  const placeholders = urlKeys.map(() => '?').join(',');
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM watch_targets WHERE url_key IN (${placeholders})
         AND NOT EXISTS (SELECT 1 FROM save_watches w WHERE w.url_key = watch_targets.url_key)`
    ).bind(...urlKeys),
    env.DB.prepare(
      `DELETE FROM watch_events WHERE url_key IN (${placeholders})
         AND NOT EXISTS (SELECT 1 FROM save_watches w WHERE w.url_key = watch_events.url_key)`
    ).bind(...urlKeys),
  ]);
}

/**
 * Every save this reader watches, with what's new on each. Small and whole (the
 * cap bounds it), so the client fetches the list rather than a delta.
 */
export async function listSaveWatches(env: Env, userDid: string): Promise<SaveWatch[]> {
  const [watches, events] = await env.DB.batch([
    env.DB.prepare(
      `SELECT w.rkey, w.created_at, w.seen_at, t.doi
         FROM save_watches w
         JOIN saved_articles s ON s.user_did = w.user_did AND s.rkey = w.rkey
         LEFT JOIN watch_targets t ON t.url_key = w.url_key
        WHERE w.user_did = ?`
    ).bind(userDid),
    env.DB.prepare(
      `SELECT w.rkey, e.kind, e.lane, e.count, e.detail, e.created_at
         FROM save_watches w
         JOIN saved_articles s ON s.user_did = w.user_did AND s.rkey = w.rkey
         JOIN watch_events e ON e.url_key = w.url_key
                            AND e.created_at > COALESCE(w.seen_at, w.created_at)
        WHERE w.user_did = ?
        ORDER BY e.created_at DESC, e.id DESC`
    ).bind(userDid),
  ]);

  const byRkey = new Map<string, WatchEvent[]>();
  for (const row of events.results as {
    rkey: string;
    kind: 'mentions' | 'citations';
    lane: WatchedLane | null;
    count: number;
    detail: string | null;
    created_at: number;
  }[]) {
    const list = byRkey.get(row.rkey) ?? [];
    list.push({
      kind: row.kind,
      lane: row.lane,
      count: row.count,
      detail: parseDetail(row.detail),
      at: row.created_at,
    });
    byRkey.set(row.rkey, list);
  }

  return (
    watches.results as {
      rkey: string;
      created_at: number;
      seen_at: number | null;
      doi: string | null;
    }[]
  ).map((w) => {
    const list = byRkey.get(w.rkey) ?? [];
    return {
      rkey: w.rkey,
      watchedAt: w.created_at,
      seenAt: w.seen_at,
      unseen: list.length,
      latestAt: list[0]?.at ?? null,
      events: list.slice(0, EVENTS_PER_SAVE),
      citations: Boolean(w.doi),
    };
  });
}

function parseDetail(raw: string | null): WatchEventDetail[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WatchEventDetail[]) : [];
  } catch {
    return [];
  }
}

/** Clear these saves' updates (every watched save when `rkeys` is null). */
export async function markWatchesSeen(
  env: Env,
  userDid: string,
  rkeys: string[] | null,
  now = Date.now()
): Promise<number> {
  if (rkeys === null) {
    const result = await env.DB.prepare('UPDATE save_watches SET seen_at = ? WHERE user_did = ?')
      .bind(now, userDid)
      .run();
    return result.meta.changes ?? 0;
  }
  const wanted = [...new Set(rkeys)];
  if (wanted.length === 0) return 0;
  const result = await env.DB.prepare(
    `UPDATE save_watches SET seen_at = ? WHERE user_did = ? AND rkey IN (${wanted.map(() => '?').join(',')})`
  )
    .bind(now, userDid, ...wanted)
    .run();
  return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Scheduling (the minute cron) and the checks themselves (JOBS queue)
// ---------------------------------------------------------------------------

/**
 * Queue the targets whose mentions or citations are due, in jobs. Returns how
 * many targets were queued. Called by the cron every few minutes with a small
 * limit, so a day's checks spread across the day instead of landing at once.
 */
export async function enqueueDueWatchChecks(
  env: Env,
  limit: number,
  now = Date.now()
): Promise<number> {
  const [mentions, citations] = await env.DB.batch([
    env.DB.prepare(
      `SELECT url_key FROM watch_targets
        WHERE (mentions_checked_at IS NULL OR mentions_checked_at < ?)
          AND (mentions_queued_at IS NULL OR mentions_queued_at < ?)
        ORDER BY mentions_checked_at IS NOT NULL, mentions_checked_at
        LIMIT ?`
    ).bind(now - MENTION_CHECK_MS, now - REQUEUE_MS, limit),
    env.DB.prepare(
      `SELECT url_key FROM watch_targets
        WHERE doi IS NOT NULL
          AND (citations_checked_at IS NULL OR citations_checked_at < ?)
          AND (citations_queued_at IS NULL OR citations_queued_at < ?)
        ORDER BY citations_checked_at IS NOT NULL, citations_checked_at
        LIMIT ?`
    ).bind(now - CITATION_CHECK_MS, now - REQUEUE_MS, limit),
  ]);
  const mentionKeys = (mentions.results as { url_key: string }[]).map((r) => r.url_key);
  const citationKeys = (citations.results as { url_key: string }[]).map((r) => r.url_key);

  const jobs: Job[] = [
    ...chunk(mentionKeys, MENTION_JOB_TARGETS).map((urlKeys): Job => ({
      type: 'watch.check',
      check: 'mentions',
      urlKeys,
    })),
    ...chunk(citationKeys, CITATION_JOB_TARGETS).map((urlKeys): Job => ({
      type: 'watch.check',
      check: 'citations',
      urlKeys,
    })),
  ];
  if (jobs.length === 0) return 0;
  await enqueueJobs(env, jobs);
  const stamps: D1PreparedStatement[] = [];
  for (const keys of chunk(mentionKeys, 50)) {
    stamps.push(
      env.DB.prepare(
        `UPDATE watch_targets SET mentions_queued_at = ? WHERE url_key IN (${keys.map(() => '?').join(',')})`
      ).bind(now, ...keys)
    );
  }
  for (const keys of chunk(citationKeys, 50)) {
    stamps.push(
      env.DB.prepare(
        `UPDATE watch_targets SET citations_queued_at = ? WHERE url_key IN (${keys.map(() => '?').join(',')})`
      ).bind(now, ...keys)
    );
  }
  await env.DB.batch(stamps);
  return mentionKeys.length + citationKeys.length;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface TargetRow {
  url_key: string;
  url: string;
  doi: string | null;
  mention_counts: string | null;
  mentions_checked_at: number | null;
  citations: number | null;
  openalex_id: string | null;
  citations_checked_at: number | null;
}

async function loadTargets(env: Env, urlKeys: string[]): Promise<TargetRow[]> {
  if (urlKeys.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT url_key, url, doi, mention_counts, mentions_checked_at, citations, openalex_id,
            citations_checked_at
       FROM watch_targets WHERE url_key IN (${urlKeys.map(() => '?').join(',')})`
  )
    .bind(...urlKeys)
    .all<TargetRow>();
  return rows.results;
}

/** The `watch.check` job: one batch of targets, one kind of check. */
export async function runWatchCheck(
  env: Env,
  check: 'mentions' | 'citations',
  urlKeys: string[]
): Promise<void> {
  const targets = await loadTargets(env, urlKeys);
  if (targets.length === 0) return;
  if (check === 'mentions') await checkMentions(env, targets);
  else await checkCitations(env, targets);
}

type LaneCounts = Partial<Record<WatchedLane, number>>;

function laneCounts(result: ArticleMentionsResult): LaneCounts {
  const counts: LaneCounts = {};
  for (const lane of result.lanes) {
    if ((WATCHED_LANES as readonly string[]).includes(lane.lane)) {
      counts[lane.lane as WatchedLane] = lane.count;
    }
  }
  return counts;
}

function parseCounts(raw: string | null): LaneCounts | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as LaneCounts) : {};
  } catch {
    return {};
  }
}

/**
 * Lanes that grew since the last check, with how many more people. A lane that
 * shrank (a deleted post) just lowers the baseline, so a later rise past it
 * still counts.
 */
export function laneGrowth(before: LaneCounts, after: LaneCounts): [WatchedLane, number][] {
  const grown: [WatchedLane, number][] = [];
  for (const lane of WATCHED_LANES) {
    const delta = (after[lane] ?? 0) - (before[lane] ?? 0);
    if (delta > 0) grown.push([lane, delta]);
  }
  return grown;
}

async function checkMentions(env: Env, targets: TargetRow[]): Promise<void> {
  const proxy = new FeedProxyClient(env);
  const now = Date.now();
  let results: ArticleMentionsResult[];
  try {
    results = await proxy.fetchArticleMentions(
      targets.map((t) => t.url),
      undefined,
      { maxAgeMs: MENTION_CHECK_MS }
    );
  } catch (error) {
    // The queue retries; the targets stay due.
    log.warn('watch_mentions_failed', { targets: targets.length, ...serializeError(error) });
    throw error;
  }
  const byUrl = new Map(results.map((r) => [r.url, r]));

  const statements: D1PreparedStatement[] = [];
  for (const target of targets) {
    const result = byUrl.get(target.url);
    if (!result) continue;
    const before = parseCounts(target.mention_counts);
    const after = laneCounts(result);
    if (before === null) {
      // The first look at a cold URL comes back empty while the proxy asks
      // Constellation. Settle the baseline on a later check, or the next one
      // would report everything that was already there as new.
      if (result.pending) {
        statements.push(
          env.DB.prepare(
            'UPDATE watch_targets SET mentions_queued_at = NULL WHERE url_key = ?'
          ).bind(target.url_key)
        );
        continue;
      }
    } else {
      for (const [lane, count] of laneGrowth(before, after)) {
        const detail = await describeLane(proxy, target.url, lane, target.mentions_checked_at ?? 0);
        statements.push(
          env.DB.prepare(
            `INSERT INTO watch_events (url_key, kind, lane, count, detail, created_at)
             VALUES (?, 'mentions', ?, ?, ?, ?)`
          ).bind(target.url_key, lane, count, detail.length ? JSON.stringify(detail) : null, now)
        );
      }
    }
    statements.push(
      env.DB.prepare(
        `UPDATE watch_targets SET mention_counts = ?, mentions_checked_at = ?, mentions_queued_at = NULL
          WHERE url_key = ?`
      ).bind(JSON.stringify(after), now, target.url_key)
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
}

/** The newest few people in a lane since the last check. Best-effort: names are adornment. */
async function describeLane(
  proxy: FeedProxyClient,
  url: string,
  lane: WatchedLane,
  since: number
): Promise<WatchEventDetail[]> {
  try {
    const { entries } = await proxy.fetchMentionLaneItems(url, lane);
    return entries
      .map((e) => ({ e, at: e.createdAt ? Date.parse(e.createdAt) : NaN }))
      .filter(({ at }) => Number.isFinite(at) && at > since)
      .sort((a, b) => b.at - a.at)
      .slice(0, DETAIL_PER_EVENT)
      .map(({ e }) => ({
        did: e.did,
        handle: e.handle,
        displayName: e.displayName,
        url: e.url,
        note: e.note ? e.note.slice(0, 300) : null,
      }));
  } catch (error) {
    log.warn('watch_lane_failed', { lane, ...serializeError(error) });
    return [];
  }
}

// --- Citations (OpenAlex) ---------------------------------------------------

const OPENALEX = 'https://api.openalex.org';

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number;
}

/** An OpenAlex URL with the key (when the environment has one). */
export function openAlexUrl(env: Env, path: string, params: Record<string, string>): string {
  const url = new URL(path, OPENALEX);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);
  return url.toString();
}

async function openAlex<T>(
  env: Env,
  path: string,
  params: Record<string, string>
): Promise<T | null> {
  const response = await fetch(openAlexUrl(env, path, params), {
    headers: { Accept: 'application/json', 'User-Agent': 'Skyreader (https://skyreader.app)' },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OpenAlex ${response.status}`);
  return (await response.json()) as T;
}

async function checkCitations(env: Env, targets: TargetRow[]): Promise<void> {
  const now = Date.now();
  for (const target of targets) {
    if (!target.doi) continue;
    const statements: D1PreparedStatement[] = [];
    try {
      // A single lookup by DOI: free and uncapped on OpenAlex's pricing.
      const work = await openAlex<OpenAlexWork>(env, `/works/doi:${target.doi}`, {
        select: 'id,cited_by_count',
      });
      const count = work?.cited_by_count ?? null;
      const id = work?.id?.split('/').pop() ?? null;
      if (count !== null && target.citations !== null && count > target.citations && id) {
        const detail = await newestCitations(env, id);
        statements.push(
          env.DB.prepare(
            `INSERT INTO watch_events (url_key, kind, lane, count, detail, created_at)
             VALUES (?, 'citations', NULL, ?, ?, ?)`
          ).bind(
            target.url_key,
            count - target.citations,
            detail.length ? JSON.stringify(detail) : null,
            now
          )
        );
      }
      statements.push(
        env.DB.prepare(
          `UPDATE watch_targets SET citations = ?, openalex_id = ?, citations_checked_at = ?,
                  citations_queued_at = NULL
            WHERE url_key = ?`
        ).bind(count, id, now, target.url_key)
      );
    } catch (error) {
      // One paper OpenAlex chokes on never stalls the rest: it stays due and is
      // queued again after REQUEUE_MS.
      log.warn('watch_citations_failed', { ...serializeError(error) });
      continue;
    }
    await env.DB.batch(statements);
  }
}

/** The newest few works citing this one. Best-effort. */
async function newestCitations(env: Env, openAlexId: string): Promise<WatchEventDetail[]> {
  try {
    const page = await openAlex<{ results?: OpenAlexWork[] }>(env, '/works', {
      filter: `cites:${openAlexId}`,
      sort: 'publication_date:desc',
      per_page: String(DETAIL_PER_EVENT),
      select: 'id,doi,display_name,publication_year',
    });
    return (page?.results ?? []).map((w) => ({
      title: w.display_name ?? null,
      year: w.publication_year ?? null,
      url: w.doi ?? w.id ?? null,
    }));
  } catch (error) {
    log.warn('watch_citation_list_failed', { ...serializeError(error) });
    return [];
  }
}

// --- Housekeeping (hourly) --------------------------------------------------

/**
 * Drop watches whose save is gone, URLs nobody watches, and old events. Saves
 * are deleted down several paths (the reader, a backing sync, an import's
 * undo), so the watch rows are swept here rather than hooked into each one.
 */
export async function pruneSaveWatches(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM save_watches WHERE NOT EXISTS (
         SELECT 1 FROM saved_articles s
          WHERE s.user_did = save_watches.user_did AND s.rkey = save_watches.rkey)`
    ),
    env.DB.prepare(
      `DELETE FROM watch_targets WHERE NOT EXISTS (
         SELECT 1 FROM save_watches w WHERE w.url_key = watch_targets.url_key)`
    ),
    env.DB.prepare(
      `DELETE FROM watch_events WHERE created_at < ? OR NOT EXISTS (
         SELECT 1 FROM watch_targets t WHERE t.url_key = watch_events.url_key)`
    ).bind(now - EVENT_RETENTION_MS),
  ]);
}
