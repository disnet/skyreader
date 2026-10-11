/**
 * One reader's full-text search index: a SQLite-backed Durable Object per DID,
 * holding an external-content FTS5 index over what they've read, saved and
 * highlighted. See docs/plans/FULL_TEXT_SEARCH.md and the spike in
 * backend/spikes/search-index (why a DO and not D1: per-user size, no
 * cross-user filtering, and D1 can't export a database with an FTS5 table).
 *
 * Everything here is derived, so it can be dropped and rebuilt (`reset`). It is
 * kept current by pulling: `sync` walks cursors over D1 (services/search-index.ts)
 * and rebuilds each changed item's document. Writes `nudge` it, which debounces a
 * sync onto an alarm; a search also catches up first, so a missed nudge only
 * delays freshness. A first sync from cursor zero is the backfill — the alarm
 * keeps rescheduling itself until the backlog is drained.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import {
  CURSOR_LAG_MS,
  KIND_HIGHLIGHTED,
  KIND_SAVED,
  ZERO_CURSORS,
  buildIndexDocs,
  collectChangedKeys,
  listSavedKeys,
  type IndexDoc,
  type SyncCursors,
} from '../services/search-index';
import { log, serializeError } from '../utils/logger';

const SCHEMA_VERSION = '1';
/** Debounce between a write's nudge and the sync it schedules. */
const NUDGE_DELAY_MS = 2_000;
/** Changed keys per sync round (each round is a handful of D1 queries). */
const ROUND_KEYS = 100;
/**
 * Rounds per sync. A round is up to ~3×ROUND_KEYS keys and costs roughly 60
 * subrequests (D1 queries plus up to 25 R2 reads), and one invocation — an alarm
 * included — gets 1,000. Eight rounds stays well inside that; a backlog continues
 * on the next alarm.
 */
const MAX_ROUNDS_PER_SYNC = 8;
/** Wall-clock budget for one alarm's sync; a backlog continues on the next alarm. */
const ALARM_BUDGET_MS = 15_000;
/** How long a search will wait on catching up before it answers from what's indexed. */
const SEARCH_CATCHUP_MS = 1_500;
/** Saves are hard-deleted, so the saved set is diffed against D1 at least this often. */
const SAVED_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Recent items get a small ranking lift. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
/** The UI says "1,000+" past this, so no query counts further. */
export const SEARCH_COUNT_CAP = 1_000;

export interface SearchOptions {
  /** 0 = any; else a KIND_* bitmask the item must overlap. */
  kinds: number;
  /** Only items touched at or after this (ms). */
  since: number;
  limit: number;
  offset: number;
}

export interface SearchHit {
  itemKey: string;
  itemType: string;
  url: string | null;
  title: string;
  feedTitle: string;
  feedUrl: string | null;
  kinds: number;
  readAt: number | null;
  savedAt: number | null;
  highlightedAt: number | null;
  /** The best-matching passage, as plain-text runs; `match` runs are the query's terms. */
  snippet: SnippetSegment[];
}

export interface SnippetSegment {
  text: string;
  match: boolean;
}

// snippet() wraps matches in these. They can't occur in indexed text (html-text
// output is printable), so the split is unambiguous — and the client gets text
// runs, never markup it would have to trust.
const MARK_OPEN = '\u0002';
const MARK_CLOSE = '\u0003';

export function splitSnippet(raw: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  for (const part of raw.split(MARK_OPEN)) {
    const close = part.indexOf(MARK_CLOSE);
    if (close === -1) {
      if (part) segments.push({ text: part, match: false });
      continue;
    }
    if (close > 0) segments.push({ text: part.slice(0, close), match: true });
    const rest = part.slice(close + 1);
    if (rest) segments.push({ text: rest, match: false });
  }
  return segments;
}

export interface SearchResponse {
  hits: SearchHit[];
  /** Matches, capped at SEARCH_COUNT_CAP + 1 (so > cap means "more than"). */
  total: number;
  /** The index is still working through a backlog (first build, or a large burst). */
  building: boolean;
  indexedItems: number;
}

export interface IndexStats {
  did: string | null;
  indexedItems: number;
  databaseBytes: number;
  cursors: SyncCursors;
  lastSyncAt: number | null;
  backlog: boolean;
}

interface SyncOutcome {
  rounds: number;
  upserts: number;
  deletes: number;
  more: boolean;
  /** Recent rows were indexed but not yet passed by the cursors. */
  unsettled: boolean;
}

export class SearchIndex extends DurableObject<Env> {
  private sql: SqlStorage;
  /** The sync in flight, so a search and an alarm never walk the cursors twice. */
  private syncing: Promise<SyncOutcome> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const version = this.getMeta('schema_version');
    if (version === SCHEMA_VERSION) return;
    // No prior version to upgrade from yet; a future change to the layout
    // drops everything and lets the cursors rebuild it from zero.
    this.dropIndex();
    this.sql.exec(`CREATE TABLE docs (
      id INTEGER PRIMARY KEY,
      item_key TEXT NOT NULL UNIQUE,
      item_type TEXT NOT NULL,
      url TEXT,
      feed_url TEXT,
      feed_title TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      kinds INTEGER NOT NULL,
      read_at INTEGER,
      saved_at INTEGER,
      highlighted_at INTEGER,
      touched_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX docs_touched ON docs(touched_at)`);
    this.sql.exec(`CREATE TABLE docs_text (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      feed TEXT NOT NULL,
      body TEXT NOT NULL,
      notes TEXT NOT NULL
    )`);
    // Column order is the bm25() weight order in search(): title, author, feed, body, notes.
    this.sql.exec(`CREATE VIRTUAL TABLE fts USING fts5(
      title, author, feed, body, notes,
      content = 'docs_text', content_rowid = 'id',
      tokenize = 'porter unicode61 remove_diacritics 2'
    )`);
    this.setMeta('schema_version', SCHEMA_VERSION);
  }

  private dropIndex() {
    this.sql.exec(`DROP TABLE IF EXISTS fts`);
    this.sql.exec(`DROP TABLE IF EXISTS docs_text`);
    this.sql.exec(`DROP TABLE IF EXISTS docs`);
    this.sql.exec(`DELETE FROM meta WHERE key <> 'did'`);
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

  private rememberDid(did: string) {
    const known = this.getMeta('did');
    if (known && known !== did) throw new Error('search index belongs to a different reader');
    if (!known) this.setMeta('did', did);
  }

  private cursors(): SyncCursors {
    const raw = this.getMeta('cursors');
    return raw ? (JSON.parse(raw) as SyncCursors) : ZERO_CURSORS;
  }

  private indexedItems(): number {
    return this.sql.exec(`SELECT count(*) AS n FROM docs`).one().n as number;
  }

  // --- RPC ---------------------------------------------------------------------

  /** Something this reader's index covers may have changed: sync soon. */
  async nudge(did: string, opts: { reconcileSaved?: boolean } = {}): Promise<void> {
    this.rememberDid(did);
    if (opts.reconcileSaved) this.setMeta('reconcile_saved', '1');
    if ((await this.ctx.storage.getAlarm()) == null) {
      await this.ctx.storage.setAlarm(Date.now() + NUDGE_DELAY_MS);
    }
  }

  async search(did: string, match: string, opts: SearchOptions): Promise<SearchResponse> {
    this.rememberDid(did);
    // Catch up on whatever changed since the last sync, but never let a backlog
    // (a first build) hold the answer: past the budget, answer from what's
    // indexed and say it's still building.
    const catchUp = this.sync(SEARCH_CATCHUP_MS);
    const outcome = await Promise.race([
      catchUp,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SEARCH_CATCHUP_MS)),
    ]);
    const building = outcome === null || outcome.more;
    if (building) await this.ensureAlarm(0);
    return { ...this.query(match, opts), building, indexedItems: this.indexedItems() };
  }

  async stats(): Promise<IndexStats> {
    return {
      did: this.getMeta('did'),
      indexedItems: this.indexedItems(),
      databaseBytes: this.ctx.storage.sql.databaseSize,
      cursors: this.cursors(),
      lastSyncAt: Number(this.getMeta('last_sync_at')) || null,
      backlog: this.getMeta('backlog') === '1',
    };
  }

  /** Drop the index and rebuild it from cursor zero. */
  async reset(): Promise<void> {
    await this.syncing?.catch(() => undefined);
    this.setMeta('schema_version', '');
    this.migrate();
    await this.ensureAlarm(0);
  }

  async alarm(): Promise<void> {
    if (!this.getMeta('did')) return;
    try {
      const outcome = await this.sync(ALARM_BUDGET_MS);
      if (outcome.more) await this.ensureAlarm(1_000);
    } catch (error) {
      log.error('search_index_sync_failed', serializeError(error));
      // Back off rather than spin; the next nudge or search retries sooner.
      await this.ensureAlarm(60_000);
    }
  }

  // --- sync --------------------------------------------------------------------

  private async ensureAlarm(delayMs: number) {
    const at = await this.ctx.storage.getAlarm();
    const want = Date.now() + delayMs;
    if (at == null || at > want) await this.ctx.storage.setAlarm(want);
  }

  private sync(budgetMs: number): Promise<SyncOutcome> {
    if (!this.syncing) {
      this.syncing = this.runSync(budgetMs).finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async runSync(budgetMs: number): Promise<SyncOutcome> {
    const did = this.getMeta('did');
    if (!did) return { rounds: 0, upserts: 0, deletes: 0, more: false, unsettled: false };
    const deadline = Date.now() + budgetMs;
    const outcome: SyncOutcome = {
      rounds: 0,
      upserts: 0,
      deletes: 0,
      more: false,
      unsettled: false,
    };

    const lastReconcile = Number(this.getMeta('saved_reconciled_at')) || 0;
    if (
      this.getMeta('reconcile_saved') === '1' ||
      Date.now() - lastReconcile > SAVED_RECONCILE_INTERVAL_MS
    ) {
      outcome.deletes += await this.reconcileSaved(did);
    }

    let cursors = this.cursors();
    do {
      const page = await collectChangedKeys(this.env, did, cursors, ROUND_KEYS);
      if (page.keys.length > 0) {
        const built = await buildIndexDocs(this.env, did, page.keys);
        this.ctx.storage.transactionSync(() => {
          for (const doc of built.upserts) this.upsert(doc);
          for (const key of built.deletes) this.remove(key);
          this.setMeta('cursors', JSON.stringify(page.cursors));
        });
        outcome.upserts += built.upserts.length;
        outcome.deletes += built.deletes.length;
      } else {
        this.setMeta('cursors', JSON.stringify(page.cursors));
      }
      const progressed = JSON.stringify(page.cursors) !== JSON.stringify(cursors);
      cursors = page.cursors;
      outcome.rounds++;
      outcome.unsettled ||= page.unsettled;
      // A page of nothing but unsettled rows can't move the cursors: stop and
      // let the settle pass below pick up from here.
      outcome.more = page.more && progressed;
    } while (outcome.more && Date.now() < deadline && outcome.rounds < MAX_ROUNDS_PER_SYNC);
    // The rows held back by the cursor lag get one more pass once they settle,
    // so a read-then-unread inside one second converges without another write.
    if (outcome.unsettled && !outcome.more) await this.ensureAlarm(CURSOR_LAG_MS + 1_000);

    this.setMeta('last_sync_at', String(Date.now()));
    this.setMeta('backlog', outcome.more ? '1' : '0');
    if (outcome.upserts || outcome.deletes) {
      log.info('search_index_synced', { ...outcome, indexedItems: this.indexedItems() });
    }
    return outcome;
  }

  /** Re-derive every indexed save that D1 no longer has. Returns how many were rebuilt. */
  private async reconcileSaved(did: string): Promise<number> {
    const live = await listSavedKeys(this.env, did);
    const stale = this.sql
      .exec(`SELECT item_key FROM docs WHERE kinds & ? != 0`, KIND_SAVED)
      .toArray()
      .map((r) => r.item_key as string)
      .filter((key) => !live.has(key));
    if (stale.length > 0) {
      // The item may still be read or highlighted, so rebuild rather than delete.
      const built = await buildIndexDocs(this.env, did, stale);
      this.ctx.storage.transactionSync(() => {
        for (const doc of built.upserts) this.upsert(doc);
        for (const key of built.deletes) this.remove(key);
      });
    }
    this.setMeta('saved_reconciled_at', String(Date.now()));
    this.setMeta('reconcile_saved', '0');
    return stale.length;
  }

  private upsert(doc: IndexDoc) {
    const touchedAt = Math.max(doc.readAt ?? 0, doc.savedAt ?? 0, doc.highlightedAt ?? 0);
    const text = [doc.title, doc.author, doc.feedTitle, doc.body, doc.notes] as const;
    const existing = this.sql
      .exec(
        `SELECT d.id, t.title, t.author, t.feed, t.body, t.notes
           FROM docs d JOIN docs_text t ON t.id = d.id WHERE d.item_key = ?`,
        doc.key
      )
      .toArray()[0];

    if (existing) {
      const id = existing.id as number;
      this.sql.exec(
        `UPDATE docs SET item_type = ?, url = ?, feed_url = ?, feed_title = ?, title = ?, kinds = ?,
                read_at = ?, saved_at = ?, highlighted_at = ?, touched_at = ?
          WHERE id = ?`,
        doc.itemType,
        doc.url,
        doc.feedUrl,
        doc.feedTitle,
        doc.title,
        doc.kinds,
        doc.readAt,
        doc.savedAt,
        doc.highlightedAt,
        touchedAt,
        id
      );
      const unchanged =
        existing.title === text[0] &&
        existing.author === text[1] &&
        existing.feed === text[2] &&
        existing.body === text[3] &&
        existing.notes === text[4];
      // A re-read or a metadata change leaves the text alone: skip the FTS
      // rewrite, which is most of a write's cost.
      if (unchanged) return;
      this.sql.exec(
        `INSERT INTO fts (fts, rowid, title, author, feed, body, notes) VALUES ('delete', ?, ?, ?, ?, ?, ?)`,
        id,
        existing.title,
        existing.author,
        existing.feed,
        existing.body,
        existing.notes
      );
      this.sql.exec(
        `UPDATE docs_text SET title = ?, author = ?, feed = ?, body = ?, notes = ? WHERE id = ?`,
        ...text,
        id
      );
      this.sql.exec(
        `INSERT INTO fts (rowid, title, author, feed, body, notes) VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        ...text
      );
      return;
    }

    const id = this.sql
      .exec(
        `INSERT INTO docs (item_key, item_type, url, feed_url, feed_title, title, kinds,
                           read_at, saved_at, highlighted_at, touched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        doc.key,
        doc.itemType,
        doc.url,
        doc.feedUrl,
        doc.feedTitle,
        doc.title,
        doc.kinds,
        doc.readAt,
        doc.savedAt,
        doc.highlightedAt,
        touchedAt
      )
      .one().id as number;
    this.sql.exec(
      `INSERT INTO docs_text (id, title, author, feed, body, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      ...text
    );
    this.sql.exec(
      `INSERT INTO fts (rowid, title, author, feed, body, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      ...text
    );
  }

  private remove(key: string) {
    const existing = this.sql
      .exec(
        `SELECT d.id, t.title, t.author, t.feed, t.body, t.notes
           FROM docs d JOIN docs_text t ON t.id = d.id WHERE d.item_key = ?`,
        key
      )
      .toArray()[0];
    if (!existing) return;
    this.sql.exec(
      `INSERT INTO fts (fts, rowid, title, author, feed, body, notes) VALUES ('delete', ?, ?, ?, ?, ?, ?)`,
      existing.id,
      existing.title,
      existing.author,
      existing.feed,
      existing.body,
      existing.notes
    );
    this.sql.exec(`DELETE FROM docs_text WHERE id = ?`, existing.id);
    this.sql.exec(`DELETE FROM docs WHERE id = ?`, existing.id);
  }

  // --- query -------------------------------------------------------------------

  private query(
    match: string,
    opts: SearchOptions
  ): Omit<SearchResponse, 'building' | 'indexedItems'> {
    const recentSince = Date.now() - RECENT_MS;
    // Rank every match without snippet(), then snippet only the page: snippet()
    // in the ranked SELECT runs for every matching row before the sort (up to
    // 5x slower on common terms in the spike).
    const ranked = this.sql
      .exec(
        `SELECT d.id, d.item_key, d.item_type, d.url, d.title, d.feed_title, d.feed_url, d.kinds,
                d.read_at, d.saved_at, d.highlighted_at,
                bm25(fts, 10.0, 3.0, 2.0, 1.0, 5.0)
                  - (CASE WHEN d.kinds & ${KIND_HIGHLIGHTED} THEN 2.0
                          WHEN d.kinds & ${KIND_SAVED} THEN 1.0 ELSE 0 END)
                  - (CASE WHEN d.touched_at >= ? THEN 0.5 ELSE 0 END) AS score
           FROM fts JOIN docs d ON d.id = fts.rowid
          WHERE fts MATCH ?
            AND (? = 0 OR d.kinds & ? != 0)
            AND d.touched_at >= ?
          ORDER BY score
          LIMIT ? OFFSET ?`,
        recentSince,
        match,
        opts.kinds,
        opts.kinds,
        opts.since,
        opts.limit,
        opts.offset
      )
      .toArray();

    const snippets = new Map<number, SnippetSegment[]>();
    if (ranked.length > 0) {
      const ids = ranked.map((r) => r.id as number);
      for (const row of this.sql
        .exec(
          `SELECT rowid, snippet(fts, -1, ?, ?, '…', 24) AS s
             FROM fts WHERE fts MATCH ? AND rowid IN (${ids.map(() => '?').join(',')})`,
          MARK_OPEN,
          MARK_CLOSE,
          match,
          ...ids
        )
        .toArray()) {
        snippets.set(row.rowid as number, splitSnippet((row.s as string) ?? ''));
      }
    }

    const total = this.sql
      .exec(
        `SELECT count(*) AS n FROM (
           SELECT 1 FROM fts JOIN docs d ON d.id = fts.rowid
            WHERE fts MATCH ? AND (? = 0 OR d.kinds & ? != 0) AND d.touched_at >= ?
            LIMIT ?)`,
        match,
        opts.kinds,
        opts.kinds,
        opts.since,
        SEARCH_COUNT_CAP + 1
      )
      .one().n as number;

    return {
      hits: ranked.map((r) => ({
        itemKey: r.item_key as string,
        itemType: r.item_type as string,
        url: (r.url as string | null) ?? null,
        title: r.title as string,
        feedTitle: r.feed_title as string,
        feedUrl: (r.feed_url as string | null) ?? null,
        kinds: r.kinds as number,
        readAt: (r.read_at as number | null) ?? null,
        savedAt: (r.saved_at as number | null) ?? null,
        highlightedAt: (r.highlighted_at as number | null) ?? null,
        snippet: snippets.get(r.id as number) ?? [],
      })),
      total,
    };
  }
}
