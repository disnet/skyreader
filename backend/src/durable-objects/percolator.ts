/**
 * The saved-search matcher: runs every new item past the saved queries that
 * cover its source, once. See docs/plans/SAVED_SEARCH_CHANNELS.md.
 *
 * Searching an index with a query is backwards for alerts, and the per-reader
 * search index only holds what a reader has already read or saved. So this
 * pulls new items from D1 — `feed_items` by `seq` (RSS and newsletters) and
 * `documents_v2` by `indexed_at` — loads full bodies only for items some live
 * query covers, indexes the batch into a scratch FTS5 table with the search
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
 * One instance today ('percolator-0'). Sharding by seq modulo is the plan when
 * one instance's CPU stops keeping up; the streams are the same either way.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import {
  MATCH_RETENTION_MS,
  MATCH_WINDOW_MS,
  docInAnyScope,
  isSavedSearchEnabled,
  loadActiveQueries,
  loadMatchDocs,
  matchInsertStatements,
  readBackfillPage,
  readStreamPage,
  streamHeads,
  type ActiveQuery,
  type DocCursor,
  type DocHead,
  type FeedHead,
  type MatchDoc,
  type MatchHit,
} from '../services/saved-search';
import { log, serializeError } from '../utils/logger';

const SCHEMA_VERSION = '1';
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
/** Pending backfills advanced per pass, and how much of each per step. */
const BACKFILL_QUERIES_PER_PASS = 4;
const BACKFILL_SOURCES_PER_STEP = 10;
const BACKFILL_ITEMS_PER_SOURCE = 50;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** DO SQLite binds at most 100 parameters per statement. */
const ROWID_CHUNK = 90;

// snippet() wraps matches in these; html-text output never contains them.
const MARK_OPEN = '\u0002';
const MARK_CLOSE = '\u0003';

interface StreamCursors {
  seq: number;
  doc: DocCursor;
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
  more: boolean;
}

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
    const budget = { subrequests: SUBREQUEST_BUDGET, r2: { left: R2_BODIES_PER_PASS } };
    const outcome: PassOutcome = {
      queries: 0,
      rounds: 0,
      scanned: 0,
      candidates: 0,
      hits: 0,
      backfillSteps: 0,
      more: false,
    };

    const queries = await loadActiveQueries(this.env);
    budget.subrequests -= 2;
    outcome.queries = queries.length;

    let cursors = this.cursors();
    if (!cursors || queries.length === 0) {
      // A fresh matcher starts at the heads rather than replaying the archive,
      // and with no queries there is nothing to match: keep up without reading
      // a single body, so turning on the first query doesn't face a backlog.
      cursors = await streamHeads(this.env);
      budget.subrequests -= 2;
      this.setMeta('cursors', JSON.stringify(cursors));
    }

    if (queries.length > 0) {
      while (
        outcome.rounds < MAX_ROUNDS_PER_PASS &&
        Date.now() < deadline &&
        budget.subrequests > 100
      ) {
        const now = Date.now();
        const page = await readStreamPage(this.env, cursors, PAGE_SIZE, now - DOC_SETTLE_MS);
        budget.subrequests -= 2;
        outcome.rounds++;
        if (page.feeds.length === 0 && page.docs.length === 0) break;
        outcome.scanned += page.feeds.length + page.docs.length;

        const windowStart = now - MATCH_WINDOW_MS;
        const hits = await this.matchHeads(page.feeds, page.docs, queries, windowStart, budget);
        outcome.candidates += hits.candidates;
        outcome.hits += await this.writeHits(hits.hits, budget);

        cursors = {
          seq: page.feeds.at(-1)?.seq ?? cursors.seq,
          doc: page.docs.length
            ? { at: page.docs.at(-1)!.indexed_at, uri: page.docs.at(-1)!.record_uri }
            : cursors.doc,
        };
        this.setMeta('cursors', JSON.stringify(cursors));
        outcome.more = page.feeds.length === PAGE_SIZE || page.docs.length === PAGE_SIZE;
        if (!outcome.more) break;
      }

      const pending = queries.filter((q) => q.backfillState === 'pending');
      for (const query of pending.slice(0, BACKFILL_QUERIES_PER_PASS)) {
        if (Date.now() >= deadline || budget.subrequests < 100) break;
        await this.backfillStep(query, budget, outcome);
      }
      if (pending.length > 0) outcome.more = true;
    }

    await this.applyRetention();
    this.setMeta('last_pass_at', String(Date.now()));
    this.setMeta('last_pass', JSON.stringify(outcome));
    if (outcome.hits > 0 || outcome.backfillSteps > 0) {
      log.info('percolator_pass', { ...outcome, durationMs: Date.now() - started });
    }
    return outcome;
  }

  /** Bodies for the covered items among `feeds`/`docs`, matched against `queries`. */
  private async matchHeads(
    feeds: FeedHead[],
    docs: DocHead[],
    queries: ActiveQuery[],
    windowStart: number,
    budget: { subrequests: number; r2: { left: number } }
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
    if (seqs.length === 0 && uris.length === 0) return { hits: [], candidates: 0 };

    const r2Before = budget.r2.left;
    const loaded = await loadMatchDocs(this.env, seqs, uris, budget.r2);
    budget.subrequests -=
      Math.ceil(seqs.length / 80) + Math.ceil(uris.length / 80) + 1 + (r2Before - budget.r2.left);
    return { hits: this.match(loaded, queries), candidates: loaded.length };
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
          const covered =
            doc.kind === 'feed'
              ? query.feedUrls.has(doc.sourceRef)
              : docInAnyScope({ authorDid: doc.sourceRef, siteUri: doc.siteUri }, query.docScopes);
          if (covered) rowids.push(i + 1);
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

  /** Advance one pending backfill by a few sources, then record where it got to. */
  private async backfillStep(
    query: ActiveQuery,
    budget: { subrequests: number; r2: { left: number } },
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
    const matched = await this.matchHeads(page.feeds, page.docs, [query], since, budget);
    outcome.candidates += matched.candidates;
    outcome.hits += await this.writeHits(matched.hits, budget);
    outcome.backfillSteps++;
    // Guarded on the version this step matched for: an edit in the meantime
    // already reset the backfill, and this must not mark it done.
    await this.env.DB.prepare(
      `UPDATE saved_queries
          SET backfill_feed_after = ?, backfill_doc_after = ?, backfill_state = ?
        WHERE user_did = ? AND channel_uuid = ? AND updated_at = ?`
    )
      .bind(
        page.feedAfter,
        page.docAfter,
        page.done ? 'done' : 'pending',
        query.userDid,
        query.channelUuid,
        query.updatedAt
      )
      .run();
    budget.subrequests -= 1;
  }

  private async applyRetention(): Promise<void> {
    const last = Number(this.getMeta('retention_at')) || 0;
    if (Date.now() - last < RETENTION_INTERVAL_MS) return;
    await this.env.DB.prepare(`DELETE FROM channel_matches WHERE matched_at < ?`)
      .bind(Date.now() - MATCH_RETENTION_MS)
      .run();
    this.setMeta('retention_at', String(Date.now()));
  }
}
