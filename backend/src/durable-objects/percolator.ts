/**
 * The saved-search matcher: runs every new item past the saved queries that
 * cover its source, once. See docs/plans/SAVED_SEARCH_CHANNELS.md.
 *
 * Searching an index with a query is backwards for alerts, and the per-reader
 * search index only holds what a reader has already read or saved. So this
 * pulls new items from D1 — `feed_items` by `seq` (RSS and newsletters),
 * `documents_v2` by `indexed_at`, and `follow_link_shares` by `first_seen_at`
 * (links the reader's Bluesky follows shared) — loads full bodies only for
 * items some live query covers, indexes the batch into a scratch FTS5 table with the search
 * tokenizer, runs each candidate query against just its own sources' rows, and
 * writes the hits to `channel_matches`. Same tokenizer and the same query
 * parser as `/` search, so the two agree on what matches.
 *
 * Nothing here is authoritative: the cursors are the only state, and a lost
 * pass replays (match writes are idempotent). The minute cron nudges it; a
 * backlog continues on the next alarm. New and edited queries are backfilled
 * over the last MATCH_WINDOW_MS, a few sources per pass, so a channel never
 * starts empty.
 *
 * Follows links carry no body, so the articles behind the ones a live query
 * covers are read here, once per URL (services/link-bodies.ts), within a
 * per-reader daily budget. A link is matched on its sharers' words and card
 * straight away, and once more against the article when that lands.
 *
 * One instance today ('percolator-0'). Sharding by seq modulo is the plan when
 * one instance's CPU stops keeping up; the streams are the same either way.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import {
  dedupKey,
  MATCH_BODY_CHARS,
  MATCH_RETENTION_MS,
  MATCH_WINDOW_MS,
  buildShareDocs,
  docInAnyScope,
  isSavedSearchEnabled,
  loadActiveQueries,
  loadMatchDocs,
  matchInsertStatements,
  queryCovers,
  readBackfillPage,
  readFollowsBackfillPage,
  readSharesOfUrl,
  readStreamPage,
  shareCursorOf,
  streamHeads,
  type ActiveQuery,
  type DocHead,
  type FeedHead,
  type MatchDoc,
  type MatchHit,
  type ShareHead,
  type StreamCursors,
} from '../services/saved-search';
import { deleteLinkBodies, extractLinkBody, readLinkBody } from '../services/link-bodies';
import { FOLLOW_LINKS_RETENTION_MS } from '../services/follow-links-store';
import { log, serializeError } from '../utils/logger';

const SCHEMA_VERSION = '2';
/** Debounce between a nudge and the pass it schedules. */
const NUDGE_DELAY_MS = 1_000;
/** Rows per stream per round. */
const PAGE_SIZE = 200;
const MAX_ROUNDS_PER_PASS = 6;
/** Wall-clock budget for one alarm; a backlog continues on the next. */
const PASS_BUDGET_MS = 15_000;
/**
 * D1 statements and R2 reads one pass may spend. An alarm gets 1,000
 * subrequests and each statement in a batch counts; this leaves headroom for
 * the reads a round makes before it knows how many hits it will write.
 */
const SUBREQUEST_BUDGET = 600;
/** Full bodies read from R2 per pass; past it an item matches on its inline text. */
const R2_BODIES_PER_PASS = 50;
/** Documents are passed only once they're this old (write-clock ties). */
const DOC_SETTLE_MS = 2_000;
/**
 * Shares, likewise. Their clock is read when a refresh builds a page's batch,
 * before D1 commits it, so they wait much longer: a minute costs nothing
 * against the five-minute target and covers a slow commit.
 */
const SHARE_SETTLE_MS = 60_000;
/** Pending backfills advanced per pass, and how much of each per step. */
const BACKFILL_QUERIES_PER_PASS = 4;
const BACKFILL_SOURCES_PER_STEP = 10;
const BACKFILL_ITEMS_PER_SOURCE = 50;
/** Shares per step of a follows backfill. */
const FOLLOWS_BACKFILL_PAGE = 200;
/** Articles behind follows links read per reader per day; past it a link matches on its card. */
export const LINK_EXTRACTIONS_PER_READER_PER_DAY = 300;
/** Articles read per pass, all at once (each is one proxy round-trip). */
const LINK_EXTRACTIONS_PER_PASS = 8;
/** Tries per link, and how long a failed one waits for its next. */
const LINK_EXTRACT_ATTEMPTS = 2;
const LINK_RETRY_DELAY_MS = 10 * 60 * 1000;
/** Batches of 1,000 expired articles dropped per retention run (every 6 hours). */
const LINK_RETENTION_ROUNDS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** DO SQLite binds at most 100 parameters per statement. */
const ROWID_CHUNK = 90;

// snippet() wraps matches in these; html-text output never contains them.
const MARK_OPEN = '\u0002';
const MARK_CLOSE = '\u0003';

/** One item a preview matched, newest first. */
export interface PreviewHit {
  kind: 'feed' | 'document';
  itemKey: string;
  title: string;
  url: string | null;
  sourceTitle: string;
  publishedAt: number | null;
  /** FTS5 snippet with matches wrapped in \u0002…\u0003. */
  snippet: string;
}

export interface PercolatorStats {
  cursors: StreamCursors | null;
  lastPassAt: number | null;
  lastPass: PassOutcome | null;
}

interface PassOutcome {
  queries: number;
  rounds: number;
  scanned: number;
  candidates: number;
  hits: number;
  backfillSteps: number;
  /** Follows-link articles read this pass, and how many of those failed. */
  extracted: number;
  extractFailed: number;
  more: boolean;
}

type PassBudget = { subrequests: number; r2: { left: number } };

export class Percolator extends DurableObject<Env> {
  private sql: SqlStorage;
  private running: Promise<PassOutcome> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    if (this.getMeta('schema_version') === SCHEMA_VERSION) return;
    // The articles behind follows links: one row per normalized URL, 'pending'
    // until read, then 'done' (its text is in R2) or 'failed'. `waiters` are the
    // readers whose shares get re-checked once against the article when it lands.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS link_bodies (
      url_normalized TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      waiters TEXT NOT NULL DEFAULT '[]',
      requested_at INTEGER NOT NULL,
      next_at INTEGER NOT NULL,
      settled_at INTEGER
    )`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS link_bodies_pending ON link_bodies(state, next_at, requested_at)`
    );
    // Articles read for each reader per UTC day, against their daily budget.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS extract_budget (
      user_did TEXT NOT NULL,
      day INTEGER NOT NULL,
      used INTEGER NOT NULL,
      PRIMARY KEY (user_did, day)
    )`);
    this.sql.exec(`DROP TABLE IF EXISTS scratch`);
    // A plain (not external-content) FTS5 table: filled per batch, emptied after.
    this.sql.exec(`CREATE VIRTUAL TABLE scratch USING fts5(
      title, author, source, body,
      tokenize = 'porter unicode61 remove_diacritics 2'
    )`);
    this.setMeta('schema_version', SCHEMA_VERSION);
  }

  private getMeta(key: string): string | null {
    const rows = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray();
    return rows.length ? (rows[0].value as string) : null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value
    );
  }

  private cursors(): StreamCursors | null {
    const raw = this.getMeta('cursors');
    return raw ? (JSON.parse(raw) as StreamCursors) : null;
  }

  // --- RPC ---------------------------------------------------------------------

  async nudge(): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    if (at == null) await this.ctx.storage.setAlarm(Date.now() + NUDGE_DELAY_MS);
  }

  /** Wake the matcher now: a saved search was just made or edited, so its look back can start. */
  async kick(): Promise<void> {
    const at = await this.ctx.storage.getAlarm();
    if (at == null || at > Date.now()) await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * What a query would match among these items, for the channel editor's
   * preview. Bodies kept in R2 aren't read (an item matches on its inline
   * text), so it's quick and close, not exact. Nothing is written.
   */
  async preview(
    ftsQuery: string,
    feeds: FeedHead[],
    docs: DocHead[],
    scope: { feedUrls: string[]; docScopes: ActiveQuery['docScopes'] }
  ): Promise<PreviewHit[]> {
    const loaded = await loadMatchDocs(
      this.env,
      feeds.map((f) => f.seq),
      docs.map((d) => d.record_uri),
      { left: 0, quiet: true }
    );
    const query: ActiveQuery = {
      userDid: '',
      channelUuid: '',
      ftsQuery,
      updatedAt: 0,
      backfillState: 'done',
      backfillFeedAfter: '',
      backfillDocAfter: '',
      backfillFollowsAfter: 'done',
      feedUrls: new Set(scope.feedUrls),
      docScopes: scope.docScopes,
      coversFollows: false,
    };
    // One hit per story, as the channel keeps one match per story.
    const seen = new Set<string>();
    return this.match(loaded, [query])
      .filter(({ doc }) => {
        const key = dedupKey(doc);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ doc, snippet }) => ({
        kind: doc.kind === 'document' ? ('document' as const) : ('feed' as const),
        itemKey: doc.itemKey,
        title: doc.title,
        url: doc.url,
        sourceTitle: doc.sourceTitle,
        publishedAt: doc.publishedAt,
        snippet,
      }))
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  }

  /** Run one pass now (tests and the operator); the alarm path is the normal one. */
  async runPass(): Promise<PassOutcome> {
    return this.pass();
  }

  async stats(): Promise<PercolatorStats> {
    return {
      cursors: this.cursors(),
      lastPassAt: Number(this.getMeta('last_pass_at')) || null,
      lastPass: JSON.parse(this.getMeta('last_pass') ?? 'null') as PassOutcome | null,
    };
  }

  /** Forget the cursors: the next pass starts from the streams' heads. */
  async reset(): Promise<void> {
    await this.running?.catch(() => undefined);
    this.sql.exec(`DELETE FROM meta WHERE key <> 'schema_version'`);
  }

  async alarm(): Promise<void> {
    if (!(await isSavedSearchEnabled(this.env))) return;
    try {
      const outcome = await this.pass();
      if (outcome.more) await this.ctx.storage.setAlarm(Date.now() + 1_000);
    } catch (error) {
      log.error('percolator_pass_failed', serializeError(error));
      // The minute cron nudges again; no tighter retry, so a broken query can't spin.
    }
  }

  // --- the pass ----------------------------------------------------------------

  private pass(): Promise<PassOutcome> {
    if (!this.running) {
      this.running = this.runOnce().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runOnce(): Promise<PassOutcome> {
    const started = Date.now();
    const deadline = started + PASS_BUDGET_MS;
    const budget: PassBudget = { subrequests: SUBREQUEST_BUDGET, r2: { left: R2_BODIES_PER_PASS } };
    const outcome: PassOutcome = {
      queries: 0,
      rounds: 0,
      scanned: 0,
      candidates: 0,
      hits: 0,
      backfillSteps: 0,
      extracted: 0,
      extractFailed: 0,
      more: false,
    };

    await this.redoGroupKeyQueries();
    const queries = await loadActiveQueries(this.env);
    budget.subrequests -= 2;
    outcome.queries = queries.length;

    const saved = this.cursors();
    let cursors: Required<StreamCursors>;
    if (!saved || queries.length === 0) {
      // A fresh matcher starts at the heads rather than replaying the archive,
      // and with no queries there is nothing to match: keep up without reading
      // a single body, so turning on the first query doesn't face a backlog.
      cursors = await streamHeads(this.env);
      budget.subrequests -= 3;
      this.setMeta('cursors', JSON.stringify(cursors));
    } else if (!saved.share) {
      // Saved before follows matching: that stream starts at its head.
      cursors = { ...saved, share: (await streamHeads(this.env)).share };
      budget.subrequests -= 3;
      this.setMeta('cursors', JSON.stringify(cursors));
    } else {
      cursors = saved as Required<StreamCursors>;
    }

    if (queries.length > 0) {
      while (
        outcome.rounds < MAX_ROUNDS_PER_PASS &&
        Date.now() < deadline &&
        budget.subrequests > 100
      ) {
        const now = Date.now();
        const page = await readStreamPage(
          this.env,
          cursors,
          PAGE_SIZE,
          now - DOC_SETTLE_MS,
          now - SHARE_SETTLE_MS
        );
        budget.subrequests -= 3;
        outcome.rounds++;
        if (page.feeds.length === 0 && page.docs.length === 0 && page.shares.length === 0) break;
        outcome.scanned += page.feeds.length + page.docs.length + page.shares.length;

        const windowStart = now - MATCH_WINDOW_MS;
        const hits = await this.matchHeads(
          page.feeds,
          page.docs,
          page.shares,
          queries,
          windowStart,
          budget
        );
        outcome.candidates += hits.candidates;
        outcome.hits += await this.writeHits(hits.hits, budget);

        cursors = {
          seq: page.feeds.at(-1)?.seq ?? cursors.seq,
          doc: page.docs.length
            ? { at: page.docs.at(-1)!.indexed_at, uri: page.docs.at(-1)!.record_uri }
            : cursors.doc,
          share: page.shares.length ? shareCursorOf(page.shares.at(-1)!) : cursors.share,
        };
        this.setMeta('cursors', JSON.stringify(cursors));
        outcome.more =
          page.feeds.length === PAGE_SIZE ||
          page.docs.length === PAGE_SIZE ||
          page.shares.length === PAGE_SIZE;
        if (!outcome.more) break;
      }

      let backfillFailed = false;
      const pending = queries.filter((q) => q.backfillState === 'pending');
      for (const query of pending.slice(0, BACKFILL_QUERIES_PER_PASS)) {
        if (Date.now() >= deadline || budget.subrequests < 100) break;
        try {
          await this.backfillStep(query, budget, outcome);
          backfillFailed = false;
        } catch (error) {
          // Left pending; the minute cron retries, so a failing step can't spin the alarm.
          backfillFailed = true;
          log.error('percolator_backfill_failed', {
            channelUuid: query.channelUuid,
            ...serializeError(error),
          });
        }
      }
      if (pending.length > 0 && !backfillFailed) outcome.more = true;

      if (Date.now() < deadline && budget.subrequests > 100) {
        try {
          if (await this.readLinks(queries, budget, outcome)) outcome.more = true;
        } catch (error) {
          log.error('percolator_links_failed', serializeError(error));
        }
      }
    }

    await this.applyRetention();
    this.setMeta('last_pass_at', String(Date.now()));
    this.setMeta('last_pass', JSON.stringify(outcome));
    if (outcome.hits > 0 || outcome.backfillSteps > 0 || outcome.extracted > 0) {
      log.info('percolator_pass', { ...outcome, durationMs: Date.now() - started });
    }
    return outcome;
  }

  /** Bodies for the covered items among `feeds`/`docs`/`shares`, matched against `queries`. */
  private async matchHeads(
    feeds: FeedHead[],
    docs: DocHead[],
    shares: ShareHead[],
    queries: ActiveQuery[],
    windowStart: number,
    budget: PassBudget
  ): Promise<{ hits: MatchHit[]; candidates: number }> {
    // Items no query covers are skipped here, before a body is read: the work
    // follows what saved searches watch, not everything ingested.
    const seqs = feeds
      .filter((f) => f.published_at == null || f.published_at >= windowStart)
      .filter((f) => queries.some((q) => q.feedUrls.has(f.feed_url)))
      .map((f) => f.seq);
    const uris = docs
      .filter((d) => d.published_at >= windowStart)
      .filter((d) =>
        queries.some((q) =>
          docInAnyScope({ authorDid: d.author_did, siteUri: d.site_uri }, q.docScopes)
        )
      )
      .map((d) => d.record_uri);
    const coveredShares = shares.filter(
      (s) =>
        s.shared_at >= windowStart &&
        queries.some((q) => q.coversFollows && q.userDid === s.user_did)
    );
    if (seqs.length === 0 && uris.length === 0 && coveredShares.length === 0) {
      return { hits: [], candidates: 0 };
    }

    const r2Before = budget.r2.left;
    const loaded: MatchDoc[] = [];
    if (seqs.length || uris.length) {
      loaded.push(...(await loadMatchDocs(this.env, seqs, uris, budget.r2)));
      budget.subrequests -= Math.ceil(seqs.length / 80) + Math.ceil(uris.length / 80) + 1;
    }
    if (coveredShares.length) loaded.push(...(await this.shareDocs(coveredShares, budget)));
    budget.subrequests -= r2Before - budget.r2.left;
    return { hits: this.match(loaded, queries), candidates: loaded.length };
  }

  /**
   * Match documents for covered shares, one per link per reader. A link whose
   * article is stored matches on it; one not read yet is queued for reading
   * (charged to a reader with budget left) and matches on its card for now,
   * then once more when the article lands.
   */
  private async shareDocs(shares: ShareHead[], budget: PassBudget): Promise<MatchDoc[]> {
    const links = new Map<string, { url: string; readers: Set<string> }>();
    for (const share of shares) {
      const link = links.get(share.url_normalized) ?? { url: share.url, readers: new Set() };
      link.readers.add(share.user_did);
      links.set(share.url_normalized, link);
    }
    const now = Date.now();
    const day = Math.floor(now / DAY_MS);
    const bodies = new Map<string, string>();
    const skipped = new Set<string>();
    let r2Skipped = 0;
    for (const [urlNormalized, link] of links) {
      const row = this.sql
        .exec(`SELECT state, waiters FROM link_bodies WHERE url_normalized = ?`, urlNormalized)
        .toArray()[0] as { state: string; waiters: string } | undefined;
      if (row?.state === 'done' && budget.r2.left > 0) {
        budget.r2.left--;
        try {
          const text = await readLinkBody(this.env, urlNormalized);
          if (text) bodies.set(urlNormalized, text);
        } catch (error) {
          // Matched on the card for now, and against the article on a re-check.
          log.warn('link_body_read_failed', serializeError(error));
          this.addWaiters(urlNormalized, row.waiters, link.readers);
        }
      } else if (row?.state === 'done' || row?.state === 'pending') {
        // Not read yet, or stored but past this pass's R2 reads: these readers
        // are re-checked against the article by readLinks.
        if (row.state === 'done') r2Skipped++;
        this.addWaiters(urlNormalized, row.waiters, link.readers);
      } else if (!row) {
        // Read once for everyone; it costs the first of these readers with budget left.
        if ([...link.readers].some((did) => this.spendExtraction(did, day))) {
          this.sql.exec(
            `INSERT INTO link_bodies (url_normalized, url, state, waiters, requested_at, next_at)
             VALUES (?, ?, 'pending', ?, ?, ?)`,
            urlNormalized,
            link.url,
            JSON.stringify([...link.readers]),
            now,
            now
          );
        } else {
          skipped.add(urlNormalized);
        }
      }
      // 'failed': the card is all there is.
    }
    if (r2Skipped > 0) log.info('saved_search_r2_budget_spent', { linkBodies: r2Skipped });
    if (skipped.size > 0) log.info('saved_search_extract_budget_spent', { links: skipped.size });
    return buildShareDocs(shares, bodies, skipped);
  }

  private addWaiters(urlNormalized: string, current: string, readers: Iterable<string>) {
    const waiters = new Set([...(JSON.parse(current) as string[]), ...readers]);
    this.sql.exec(
      `UPDATE link_bodies SET waiters = ? WHERE url_normalized = ?`,
      JSON.stringify([...waiters]),
      urlNormalized
    );
  }

  /** Charge one article read to `did` today; false when their budget is spent. */
  private spendExtraction(did: string, day: number): boolean {
    const row = this.sql
      .exec(`SELECT used FROM extract_budget WHERE user_did = ? AND day = ?`, did, day)
      .toArray()[0] as { used: number } | undefined;
    if (row && row.used >= LINK_EXTRACTIONS_PER_READER_PER_DAY) return false;
    this.sql.exec(
      `INSERT INTO extract_budget (user_did, day, used) VALUES (?, ?, 1)
       ON CONFLICT(user_did, day) DO UPDATE SET used = used + 1`,
      did,
      day
    );
    return true;
  }

  /**
   * Read the next few queued articles, all at once, then re-check the readers
   * waiting on stored articles: each one's shares of the link, matched against
   * the article. A link's waiters are cleared only once its re-check has been
   * written, so a failed write is retried by the next pass. Returns whether
   * more articles are ready to read now.
   */
  private async readLinks(
    queries: ActiveQuery[],
    budget: PassBudget,
    outcome: PassOutcome
  ): Promise<boolean> {
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT url_normalized, url, attempts FROM link_bodies
          WHERE state = 'pending' AND next_at <= ?
          ORDER BY requested_at LIMIT ?`,
        now,
        LINK_EXTRACTIONS_PER_PASS
      )
      .toArray() as { url_normalized: string; url: string; attempts: number }[];

    const texts = new Map<string, string>();
    if (rows.length > 0) {
      const results = await Promise.all(
        rows.map((r) => extractLinkBody(this.env, r.url, r.url_normalized, MATCH_BODY_CHARS))
      );
      // A proxy round-trip and an R2 write each.
      budget.subrequests -= rows.length * 2;
      for (const [i, row] of rows.entries()) {
        const result = results[i];
        const settledAt = Date.now();
        const attempts = row.attempts + 1;
        if (result.ok) {
          outcome.extracted++;
          texts.set(row.url_normalized, result.text);
          this.sql.exec(
            `UPDATE link_bodies SET state = 'done', attempts = ?, settled_at = ?
              WHERE url_normalized = ?`,
            attempts,
            settledAt,
            row.url_normalized
          );
        } else if (!result.retry || attempts >= LINK_EXTRACT_ATTEMPTS) {
          outcome.extractFailed++;
          this.sql.exec(
            `UPDATE link_bodies SET state = 'failed', attempts = ?, waiters = '[]', settled_at = ?
              WHERE url_normalized = ?`,
            attempts,
            settledAt,
            row.url_normalized
          );
        } else {
          outcome.extractFailed++;
          this.sql.exec(
            `UPDATE link_bodies SET attempts = ?, next_at = ? WHERE url_normalized = ?`,
            attempts,
            settledAt + LINK_RETRY_DELAY_MS,
            row.url_normalized
          );
        }
      }
    }

    const waiting = this.sql
      .exec(
        `SELECT url_normalized, waiters FROM link_bodies
          WHERE state = 'done' AND waiters <> '[]' ORDER BY settled_at LIMIT ?`,
        LINK_EXTRACTIONS_PER_PASS * 2
      )
      .toArray() as { url_normalized: string; waiters: string }[];
    const windowStart = Date.now() - MATCH_WINDOW_MS;
    for (const row of waiting) {
      if (budget.subrequests < 100) break;
      const urlNormalized = row.url_normalized;
      try {
        const readers = new Set(JSON.parse(row.waiters) as string[]);
        // Only readers who still have a query over follows links.
        const recheck = queries.filter((q) => q.coversFollows && readers.has(q.userDid));
        let text = texts.get(urlNormalized);
        if (recheck.length > 0 && text === undefined) {
          budget.subrequests -= 1;
          text = (await readLinkBody(this.env, urlNormalized)) ?? '';
        }
        if (recheck.length > 0 && text) {
          const shares = await readSharesOfUrl(
            this.env,
            [...new Set(recheck.map((q) => q.userDid))],
            urlNormalized,
            windowStart
          );
          budget.subrequests -= 1;
          const docs = buildShareDocs(shares, new Map([[urlNormalized, text]]), new Set());
          outcome.candidates += docs.length;
          outcome.hits += await this.writeHits(this.match(docs, recheck), budget);
        }
        // Only the waiters this re-check covered: shareDocs can't add any
        // mid-loop (a pass is one at a time), but keep the update exact anyway.
        this.sql.exec(
          `UPDATE link_bodies SET waiters = '[]' WHERE url_normalized = ? AND waiters = ?`,
          urlNormalized,
          row.waiters
        );
      } catch (error) {
        // Kept waiting, behind the rest, so one link that keeps failing can't
        // hold up everyone else's re-checks.
        log.warn('percolator_link_recheck_failed', serializeError(error));
        this.sql.exec(
          `UPDATE link_bodies SET settled_at = ? WHERE url_normalized = ?`,
          Date.now(),
          urlNormalized
        );
      }
    }

    const more = this.sql
      .exec(
        `SELECT 1 FROM link_bodies WHERE state = 'pending' AND next_at <= ? LIMIT 1`,
        Date.now()
      )
      .toArray();
    return more.length > 0;
  }

  /**
   * Index `docs` into the scratch table, run each query against the rows from
   * its own sources, and empty the table again.
   */
  private match(docs: MatchDoc[], queries: ActiveQuery[]): MatchHit[] {
    if (docs.length === 0) return [];
    const hits: MatchHit[] = [];
    this.ctx.storage.transactionSync(() => {
      docs.forEach((doc, i) => {
        this.sql.exec(
          `INSERT INTO scratch (rowid, title, author, source, body) VALUES (?, ?, ?, ?, ?)`,
          i + 1,
          doc.title,
          doc.author,
          doc.sourceTitle,
          doc.body
        );
      });
    });
    try {
      for (const query of queries) {
        const rowids: number[] = [];
        docs.forEach((doc, i) => {
          if (queryCovers(query, doc)) rowids.push(i + 1);
        });
        for (let start = 0; start < rowids.length; start += ROWID_CHUNK) {
          const ids = rowids.slice(start, start + ROWID_CHUNK);
          let rows: Record<string, SqlStorageValue>[];
          try {
            rows = this.sql
              .exec(
                `SELECT rowid, snippet(scratch, -1, ?, ?, '…', 24) AS s FROM scratch
                  WHERE scratch MATCH ? AND rowid IN (${ids.map(() => '?').join(',')})`,
                MARK_OPEN,
                MARK_CLOSE,
                query.ftsQuery,
                ...ids
              )
              .toArray();
          } catch (error) {
            // parseSearchQuery only emits quoted terms, so this "can't happen";
            // if it does, one bad query must not stop everyone else's matching.
            log.warn('percolator_query_failed', {
              channelUuid: query.channelUuid,
              ...serializeError(error),
            });
            break;
          }
          for (const row of rows) {
            hits.push({
              query: {
                userDid: query.userDid,
                channelUuid: query.channelUuid,
                updatedAt: query.updatedAt,
              },
              doc: docs[(row.rowid as number) - 1],
              snippet: (row.s as string) ?? '',
            });
          }
        }
      }
    } finally {
      this.sql.exec(`DELETE FROM scratch`);
    }
    return hits;
  }

  private async writeHits(hits: MatchHit[], budget: { subrequests: number }): Promise<number> {
    if (hits.length === 0) return 0;
    const statements = matchInsertStatements(this.env, hits, Date.now());
    for (let start = 0; start < statements.length; start += 50) {
      await this.env.DB.batch(statements.slice(start, start + 50));
    }
    budget.subrequests -= statements.length;
    return hits.length;
  }

  /**
   * Advance one pending backfill by a few sources (feeds, then document authors,
   * then the reader's stored follows shares), then record where it got to.
   */
  private async backfillStep(
    query: ActiveQuery,
    budget: PassBudget,
    outcome: PassOutcome
  ): Promise<void> {
    const since = Date.now() - MATCH_WINDOW_MS;
    const page = await readBackfillPage(
      this.env,
      query,
      since,
      BACKFILL_SOURCES_PER_STEP,
      BACKFILL_ITEMS_PER_SOURCE
    );
    budget.subrequests -= BACKFILL_SOURCES_PER_STEP;
    const matched = await this.matchHeads(page.feeds, page.docs, [], [query], since, budget);
    outcome.candidates += matched.candidates;
    outcome.hits += await this.writeHits(matched.hits, budget);

    // Follows shares are kept a week, so their backfill is that week.
    let done = page.done;
    let followsAfter = query.backfillFollowsAfter;
    if (page.done && query.coversFollows && followsAfter !== 'done') {
      const follows = await readFollowsBackfillPage(
        this.env,
        query,
        Date.now() - FOLLOW_LINKS_RETENTION_MS,
        FOLLOWS_BACKFILL_PAGE
      );
      budget.subrequests -= 1;
      const links = await this.matchHeads([], [], follows.shares, [query], since, budget);
      outcome.candidates += links.candidates;
      outcome.hits += await this.writeHits(links.hits, budget);
      followsAfter = follows.after;
      done = follows.done;
    }
    outcome.backfillSteps++;
    // Guarded on the version this step matched for: an edit in the meantime
    // already reset the backfill, and this must not mark it done.
    await this.env.DB.prepare(
      `UPDATE saved_queries
          SET backfill_feed_after = ?, backfill_doc_after = ?, backfill_follows_after = ?,
              backfill_state = ?
        WHERE user_did = ? AND channel_uuid = ? AND updated_at = ?`
    )
      .bind(
        page.feedAfter,
        page.docAfter,
        followsAfter,
        done ? 'done' : 'pending',
        query.userDid,
        query.channelUuid,
        query.updatedAt
      )
      .run();
    budget.subrequests -= 1;
  }

  /**
   * Once, on the first pass of a matcher that understands group source keys:
   * saved searches that name a group were matched by code that read the group
   * as no source at all, so an include filter matched nothing and an exclude
   * filter left nothing out. Treat them as edited: clear what they matched and
   * look back again. Run from here rather than a migration because migrations
   * apply before the deploy, and the old matcher would finish the look back
   * over no sources. Bumping updated_at voids an in-flight pass's writes.
   */
  private async redoGroupKeyQueries(): Promise<void> {
    if (this.getMeta('group_keys_redone') === '1') return;
    const named = `source_mode <> 'all' AND source_keys LIKE '%"group~%'`;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM channel_matches WHERE (user_did, channel_uuid) IN
           (SELECT user_did, channel_uuid FROM saved_queries WHERE ${named})`
      ),
      this.env.DB.prepare(
        `DELETE FROM channel_match_sources WHERE (user_did, channel_uuid) IN
           (SELECT user_did, channel_uuid FROM saved_queries WHERE ${named})`
      ),
      this.env.DB.prepare(
        `UPDATE saved_queries
            SET backfill_state = 'pending', backfill_feed_after = '', backfill_doc_after = '',
                backfill_follows_after = '', updated_at = updated_at + 1
          WHERE ${named}`
      ),
    ]);
    this.setMeta('group_keys_redone', '1');
  }

  private async applyRetention(): Promise<void> {
    const last = Number(this.getMeta('retention_at')) || 0;
    if (Date.now() - last < RETENTION_INTERVAL_MS) return;
    const cutoff = Date.now() - MATCH_RETENTION_MS;
    await this.env.DB.batch([
      this.env.DB.prepare(`DELETE FROM channel_matches WHERE matched_at < ?`).bind(cutoff),
      this.env.DB.prepare(`DELETE FROM channel_match_sources WHERE matched_at < ?`).bind(cutoff),
    ]);

    // Stored articles go when the shares that wanted them do. A failure here
    // leaves them for the next run rather than failing the pass.
    const linkCutoff = Date.now() - FOLLOW_LINKS_RETENTION_MS;
    try {
      for (let round = 0; round < LINK_RETENTION_ROUNDS; round++) {
        const expired = this.sql
          .exec(
            `SELECT url_normalized, state FROM link_bodies WHERE requested_at < ? LIMIT 1000`,
            linkCutoff
          )
          .toArray() as { url_normalized: string; state: string }[];
        if (expired.length === 0) break;
        await deleteLinkBodies(
          this.env,
          expired.filter((r) => r.state === 'done').map((r) => r.url_normalized)
        );
        this.ctx.storage.transactionSync(() => {
          for (const row of expired) {
            this.sql.exec(`DELETE FROM link_bodies WHERE url_normalized = ?`, row.url_normalized);
          }
        });
      }
    } catch (error) {
      log.warn('percolator_link_retention_failed', serializeError(error));
    }
    this.sql.exec(`DELETE FROM extract_budget WHERE day < ?`, Math.floor(Date.now() / DAY_MS) - 1);
    this.setMeta('retention_at', String(Date.now()));
  }
}
