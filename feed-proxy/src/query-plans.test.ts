import { describe, expect, it, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  initDatabase,
  WARM_DUE_FEEDS_SQL,
  CRAWL_CYCLE_SQL,
  WARM_DUE_DOCUMENTS_SQL,
  STATS_DOCUMENTS_ACTIVE_SQL,
  STATS_DOCUMENTS_FROZEN_SQL,
  STATS_DOCUMENTS_BACKOFF_SQL,
  STATS_PENDING_PUSH_SQL,
} from './app';
import { DIRTY_ROWS_SQL, DIRTY_COUNT_SQL } from './ingest-push';

/**
 * Pins the EXPLAIN QUERY PLAN of every hot periodic scan to its covering index.
 *
 * These queries run every tick/interval against tables whose rows are dominated
 * by multi-hundred-KB blobs (cache.parsed_json, feed_items.item_json,
 * document_cache.documents_json). A plan that falls back to touching row pages
 * re-reads the whole database from disk each cycle once the DB outgrows the
 * page cache — measured at ~1.3 GB/min of reads with the event loop starved in
 * D-state on synchronous SQLite (the 2026-08-21 iowait incident).
 *
 * If one of these assertions fails after a schema or query change, extend the
 * corresponding index (or the query's column set) so the scan is answerable
 * from the index again — don't delete the assertion.
 */
describe('query plans: periodic scans stay on covering indexes', () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(':memory:');
    initDatabase(db);
  });

  function plan(sql: string): string {
    return db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((r) => r.detail)
      .join('\n');
  }

  it('warm due-scan is a covering-index scan with no sort step', () => {
    const p = plan(WARM_DUE_FEEDS_SQL);
    expect(p).toContain('COVERING INDEX idx_cache_warm');
    // ORDER BY fetched_at must come from the index, not a temp b-tree.
    expect(p).not.toContain('TEMP B-TREE');
  });

  it('crawl-cycle stat is answered from idx_cache_warm', () => {
    expect(plan(CRAWL_CYCLE_SQL)).toContain('COVERING INDEX idx_cache_warm');
  });

  it('document warm due-scan is covering with no sort step', () => {
    const p = plan(WARM_DUE_DOCUMENTS_SQL);
    expect(p).toContain('COVERING INDEX idx_document_cache_warm');
    expect(p).not.toContain('TEMP B-TREE');
  });

  it('pusher dirty-scan walks idx_feed_items_push, not the item rows', () => {
    // Not COVERING for the SELECT (it projects item_json for matched rows),
    // but the seq-ordered walk + hash filter must ride the index so clean rows
    // never load their blobs.
    expect(plan(DIRTY_ROWS_SQL)).toMatch(/SCAN fi USING (COVERING )?INDEX idx_feed_items_push/);
  });

  it('pusher dirty-count is fully covering', () => {
    expect(plan(DIRTY_COUNT_SQL)).toContain('COVERING INDEX idx_feed_items_push');
  });

  it('/stats freshness counts search idx_cache_warm', () => {
    expect(plan('SELECT COUNT(*) as count FROM cache WHERE fetched_at > ?')).toContain(
      'COVERING INDEX idx_cache_warm'
    );
    expect(
      plan('SELECT COUNT(*) as count FROM cache WHERE fetched_at <= ? AND fetched_at > ?')
    ).toContain('COVERING INDEX idx_cache_warm');
  });

  it('/stats error counts use the partial error/backoff indexes', () => {
    expect(plan('SELECT COUNT(*) as count FROM cache WHERE error_count > 0')).toContain(
      'COVERING INDEX idx_cache_errors'
    );
    expect(plan('SELECT COUNT(*) as count FROM cache WHERE next_retry_at > ?')).toContain(
      'COVERING INDEX idx_cache_backoff'
    );
    expect(
      plan('SELECT COUNT(*) as count FROM cache WHERE next_retry_at > ? AND error_count >= 5')
    ).toContain('COVERING INDEX idx_cache_backoff');
  });

  it('/stats document counts are covering, not blob row reads', () => {
    // Regression: these three shipped on a single-column
    // idx_document_cache_last_requested_at, so each one loaded the row page —
    // and documents_json blob — of every active author to answer a COUNT. That
    // is what pushed /stats past recordProxyStats's 3s timeout on ~13% of its
    // samples (SKYREADER-BACKEND-4). Measured 72ms -> 0ms once covered.
    for (const sql of [
      STATS_DOCUMENTS_ACTIVE_SQL,
      STATS_DOCUMENTS_FROZEN_SQL,
      STATS_DOCUMENTS_BACKOFF_SQL,
    ]) {
      expect(plan(sql)).toContain('COVERING INDEX idx_document_cache_active');
    }
  });

  it('/stats pending-push count keeps the pusher plan', () => {
    // Same shape as DIRTY_COUNT_SQL, pinned separately because /stats holds its
    // own copy. The whole-log walk is inherent; what must not change is that fi
    // leads on its covering index and both joins resolve without row reads.
    // Leading with cache instead costs 10x (measured 31ms -> 320ms), which is
    // what an index on push_state(seq, pushed_hash) talks the planner into.
    const p = plan(STATS_PENDING_PUSH_SQL);
    expect(p).toContain('SCAN fi USING COVERING INDEX idx_feed_items_push');
    expect(p).toContain('SEARCH c USING COVERING INDEX');
    expect(p).toContain('SEARCH ps USING INTEGER PRIMARY KEY');
  });

  it('feed-health report resolves via multi-index OR, not a table scan', () => {
    // Mirrors selectFeedHealth in ingest-push.ts (COALESCE was removed there
    // precisely so fetched_at could use an index; fetched_at is NOT NULL).
    const p = plan(
      `SELECT url, error_count, last_error, last_error_at, next_retry_at, fetched_at
         FROM cache
        WHERE last_requested_at IS NOT NULL
          AND (error_count > 0 OR fetched_at < ?)`
    );
    expect(p).toContain('MULTI-INDEX OR');
    expect(p).toContain('idx_cache_errors');
    expect(p).toContain('idx_cache_warm');
  });

  it("cleanup's eviction subquery is covering", () => {
    expect(plan('SELECT url_hash FROM cache WHERE fetched_at < ?')).toContain(
      'COVERING INDEX idx_cache_warm'
    );
  });
});
