/**
 * One reader's full-text search index: a SQLite-backed Durable Object per DID,
 * holding external-content FTS5 indexes over what they've read, saved and
 * highlighted: one over each item's own text (title, author, feed, body), one
 * over the reader's highlights and notes on it. They're apart so a new highlight
 * rewrites only the notes, never a body that can be a whole book. A long body
 * is also indexed as overlapping passages, only to find a snippet in it. See
 * docs/plans/FULL_TEXT_SEARCH.md and the spike in backend/spikes/search-index
 * (why a DO and not D1: per-user size, no cross-user filtering, and D1 can't
 * export a database with an FTS5 table).
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
  BOOK_BODY_CHARS,
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
import type { SearchTerms } from '../services/search-query';
import { log, serializeError } from '../utils/logger';

const SCHEMA_VERSION = '2';
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
/**
 * Bodies longer than this (books) are also indexed as passages, for snippets:
 * FTS5's snippet() slows down faster than linearly as a term recurs in one
 * text, so on a whole book a common word could take half a second a hit.
 * Snippets of a long body come from its best-matching passage instead.
 */
export const PASSAGE_MIN_CHARS = 64_000;
const PASSAGE_CHARS = 4_000;
/** Consecutive passages overlap this much, so a phrase across a cut still fits in one. */
const PASSAGE_OVERLAP = 400;
/** Passage rowids are docs.id * PASSAGE_STRIDE + n, so one item's passages are a rowid range. */
const PASSAGE_STRIDE = 1024;
/**
 * The most passages a body can have: each one starts at least
 * PASSAGE_CHARS / 2 - PASSAGE_OVERLAP characters after the last (passageSpans),
 * and no body is longer than BOOK_BODY_CHARS. Must fit in PASSAGE_STRIDE, which
 * a test holds.
 */
export const MAX_PASSAGES = Math.ceil(BOOK_BODY_CHARS / (PASSAGE_CHARS / 2 - PASSAGE_OVERLAP)) + 1;
export { PASSAGE_STRIDE };
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
    // A change to the layout drops everything and lets the cursors rebuild it
    // from zero (2: notes moved out of `fts` into `notes_fts`; passages).
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
      body TEXT NOT NULL
    )`);
    // Column order is the bm25() weight order in query(): title, author, feed, body.
    this.sql.exec(`CREATE VIRTUAL TABLE fts USING fts5(
      title, author, feed, body,
      content = 'docs_text', content_rowid = 'id',
      tokenize = 'porter unicode61 remove_diacritics 2'
    )`);
    // Highlight text and notes, only for items that have some; rowid = docs.id.
    this.sql.exec(`CREATE TABLE notes_text (id INTEGER PRIMARY KEY, notes TEXT NOT NULL)`);
    this.sql.exec(`CREATE VIRTUAL TABLE notes_fts USING fts5(
      notes,
      content = 'notes_text', content_rowid = 'id',
      tokenize = 'porter unicode61 remove_diacritics 2'
    )`);
    // A long body's passages, as spans of it in characters: the text is read
    // from docs_text through the view, never stored twice.
    this.sql.exec(
      `CREATE TABLE passages (id INTEGER PRIMARY KEY, start INTEGER NOT NULL, len INTEGER NOT NULL)`
    );
    this.sql.exec(`CREATE VIEW passages_text AS
      SELECT p.id, substr(t.body, p.start + 1, p.len) AS body
        FROM passages p JOIN docs_text t ON t.id = p.id / ${PASSAGE_STRIDE}`);
    this.sql.exec(`CREATE VIRTUAL TABLE passages_fts USING fts5(
      body,
      content = 'passages_text', content_rowid = 'id',
      tokenize = 'porter unicode61 remove_diacritics 2'
    )`);
    this.setMeta('schema_version', SCHEMA_VERSION);
  }

  private dropIndex() {
    this.sql.exec(`DROP TABLE IF EXISTS fts`);
    this.sql.exec(`DROP TABLE IF EXISTS docs_text`);
    this.sql.exec(`DROP TABLE IF EXISTS notes_fts`);
    this.sql.exec(`DROP TABLE IF EXISTS notes_text`);
    this.sql.exec(`DROP TABLE IF EXISTS passages_fts`);
    this.sql.exec(`DROP VIEW IF EXISTS passages_text`);
    this.sql.exec(`DROP TABLE IF EXISTS passages`);
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

  /** Keys a build deferred, waiting for the next round. */
  private pendingKeys(): string[] {
    const raw = this.getMeta('pending_keys');
    return raw ? (JSON.parse(raw) as string[]) : [];
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

  async search(did: string, terms: SearchTerms, opts: SearchOptions): Promise<SearchResponse> {
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
    return { ...this.query(terms, opts), building, indexedItems: this.indexedItems() };
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
      // Keys a build deferred (too much saved text for one) go before new pages.
      const pending = this.pendingKeys();
      if (pending.length > 0) {
        const built = await buildIndexDocs(this.env, did, pending);
        this.ctx.storage.transactionSync(() => {
          for (const doc of built.upserts) this.upsert(doc);
          for (const key of built.deletes) this.remove(key);
          this.setMeta('pending_keys', JSON.stringify(built.deferred));
        });
        outcome.upserts += built.upserts.length;
        outcome.deletes += built.deletes.length;
        outcome.rounds++;
        outcome.more = true; // whatever is left, and then the next page
        continue;
      }
      const page = await collectChangedKeys(this.env, did, cursors, ROUND_KEYS);
      let deferred = 0;
      if (page.keys.length > 0) {
        const built = await buildIndexDocs(this.env, did, page.keys);
        this.ctx.storage.transactionSync(() => {
          for (const doc of built.upserts) this.upsert(doc);
          for (const key of built.deletes) this.remove(key);
          this.setMeta('pending_keys', JSON.stringify(built.deferred));
          this.setMeta('cursors', JSON.stringify(page.cursors));
        });
        outcome.upserts += built.upserts.length;
        outcome.deletes += built.deletes.length;
        deferred = built.deferred.length;
      } else {
        this.setMeta('cursors', JSON.stringify(page.cursors));
      }
      const progressed = JSON.stringify(page.cursors) !== JSON.stringify(cursors);
      cursors = page.cursors;
      outcome.rounds++;
      outcome.unsettled ||= page.unsettled;
      // A page of nothing but unsettled rows can't move the cursors: stop and
      // let the settle pass below pick up from here.
      outcome.more = (page.more && progressed) || deferred > 0;
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
        const pending = new Set([...this.pendingKeys(), ...built.deferred]);
        this.setMeta('pending_keys', JSON.stringify([...pending]));
      });
    }
    this.setMeta('saved_reconciled_at', String(Date.now()));
    this.setMeta('reconcile_saved', '0');
    return stale.length;
  }

  private upsert(doc: IndexDoc) {
    const touchedAt = Math.max(doc.readAt ?? 0, doc.savedAt ?? 0, doc.highlightedAt ?? 0);
    const text = [doc.title, doc.author, doc.feedTitle, doc.body] as const;
    const existing = this.sql
      .exec(
        `SELECT d.id, t.title, t.author, t.feed, t.body
           FROM docs d JOIN docs_text t ON t.id = d.id WHERE d.item_key = ?`,
        doc.key
      )
      .toArray()[0];

    let id: number;
    if (existing) {
      id = existing.id as number;
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
        existing.body === text[3];
      // A re-read, a new highlight or a metadata change leaves the item's own
      // text alone: skip its FTS rewrite, which is most of a write's cost.
      if (!unchanged) {
        this.removePassages(id);
        this.sql.exec(
          `INSERT INTO fts (fts, rowid, title, author, feed, body) VALUES ('delete', ?, ?, ?, ?, ?)`,
          id,
          existing.title,
          existing.author,
          existing.feed,
          existing.body
        );
        this.sql.exec(
          `UPDATE docs_text SET title = ?, author = ?, feed = ?, body = ? WHERE id = ?`,
          ...text,
          id
        );
        this.sql.exec(
          `INSERT INTO fts (rowid, title, author, feed, body) VALUES (?, ?, ?, ?, ?)`,
          id,
          ...text
        );
        this.writePassages(id, doc.body);
      }
    } else {
      id = this.sql
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
        `INSERT INTO docs_text (id, title, author, feed, body) VALUES (?, ?, ?, ?, ?)`,
        id,
        ...text
      );
      this.sql.exec(
        `INSERT INTO fts (rowid, title, author, feed, body) VALUES (?, ?, ?, ?, ?)`,
        id,
        ...text
      );
      this.writePassages(id, doc.body);
    }
    this.writeNotes(id, doc.notes);
  }

  /** Index item `id`'s passages, if its body is long enough to have them. */
  private writePassages(id: number, body: string) {
    if (body.length <= PASSAGE_MIN_CHARS) return;
    let spans = passageSpans(body);
    if (spans.length > PASSAGE_STRIDE) {
      // Out of the item's rowid range; can't happen within MAX_PASSAGES.
      log.warn('search_index_passages_capped', { passages: spans.length });
      spans = spans.slice(0, PASSAGE_STRIDE);
    }
    spans.forEach(([start, len], n) => {
      this.sql.exec(
        `INSERT INTO passages (id, start, len) VALUES (?, ?, ?)`,
        id * PASSAGE_STRIDE + n,
        start,
        len
      );
    });
    this.sql.exec(
      `INSERT INTO passages_fts (rowid, body)
       SELECT id, body FROM passages_text WHERE id BETWEEN ? AND ?`,
      id * PASSAGE_STRIDE,
      id * PASSAGE_STRIDE + PASSAGE_STRIDE - 1
    );
  }

  /** Drop item `id`'s passages. Reads them through docs_text, so call it before the body changes. */
  private removePassages(id: number) {
    const lo = id * PASSAGE_STRIDE;
    const hi = lo + PASSAGE_STRIDE - 1;
    this.sql.exec(
      `INSERT INTO passages_fts (passages_fts, rowid, body)
       SELECT 'delete', id, body FROM passages_text WHERE id BETWEEN ? AND ?`,
      lo,
      hi
    );
    this.sql.exec(`DELETE FROM passages WHERE id BETWEEN ? AND ?`, lo, hi);
  }

  /** Replace item `id`'s notes; empty notes leave no row. */
  private writeNotes(id: number, notes: string) {
    const existing = this.sql.exec(`SELECT notes FROM notes_text WHERE id = ?`, id).toArray()[0];
    const old = (existing?.notes as string | undefined) ?? '';
    if (old === notes) return;
    if (existing) {
      this.sql.exec(
        `INSERT INTO notes_fts (notes_fts, rowid, notes) VALUES ('delete', ?, ?)`,
        id,
        old
      );
    }
    if (!notes) {
      this.sql.exec(`DELETE FROM notes_text WHERE id = ?`, id);
      return;
    }
    this.sql.exec(
      `INSERT INTO notes_text (id, notes) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET notes = excluded.notes`,
      id,
      notes
    );
    this.sql.exec(`INSERT INTO notes_fts (rowid, notes) VALUES (?, ?)`, id, notes);
  }

  private remove(key: string) {
    const existing = this.sql
      .exec(
        `SELECT d.id, t.title, t.author, t.feed, t.body
           FROM docs d JOIN docs_text t ON t.id = d.id WHERE d.item_key = ?`,
        key
      )
      .toArray()[0];
    if (!existing) return;
    const id = existing.id as number;
    this.sql.exec(
      `INSERT INTO fts (fts, rowid, title, author, feed, body) VALUES ('delete', ?, ?, ?, ?, ?)`,
      id,
      existing.title,
      existing.author,
      existing.feed,
      existing.body
    );
    this.writeNotes(id, '');
    this.removePassages(id);
    this.sql.exec(`DELETE FROM docs_text WHERE id = ?`, id);
    this.sql.exec(`DELETE FROM docs WHERE id = ?`, id);
  }

  // --- query -------------------------------------------------------------------

  private query(
    terms: SearchTerms,
    opts: SearchOptions
  ): Omit<SearchResponse, 'building' | 'indexedItems'> {
    const recentSince = Date.now() - RECENT_MS;
    const allPositive = terms.positives.join(' ');
    const anyPositive = terms.positives.join(' OR ');
    const anyNegative = terms.negatives.join(' OR ');

    // An item matches when every positive term is in its own text or its notes,
    // and no negative term is in either. Most matches have every term in the
    // text (`main`); the rest must have a note matching some term, so only those
    // few notes (`noted`) are checked term by term. bm25 per table, summed, with
    // notes weighted 5 against the body's 1. Snippets come later, for the page
    // only: snippet() here would run for every match before the sort (up to 5x
    // slower on common terms in the spike).
    const perTerm = terms.positives
      .map(
        () => `(EXISTS (SELECT 1 FROM fts WHERE fts MATCH ? AND rowid = noted.id)
             OR EXISTS (SELECT 1 FROM notes_fts WHERE notes_fts MATCH ? AND rowid = noted.id))`
      )
      .join(' AND ');
    const hits = `
      WITH main AS MATERIALIZED (
             SELECT rowid AS id, bm25(fts, 10.0, 3.0, 2.0, 1.0) AS s FROM fts WHERE fts MATCH ?),
           noted AS MATERIALIZED (
             SELECT rowid AS id, 5.0 * bm25(notes_fts) AS s FROM notes_fts WHERE notes_fts MATCH ?),
           hits AS (
             SELECT id FROM main
             UNION
             SELECT id FROM noted WHERE ${perTerm}
             ${
               anyNegative
                 ? `EXCEPT SELECT rowid FROM fts WHERE fts MATCH ?
                    EXCEPT SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?`
                 : ''
             })`;
    const hitsParams = [
      allPositive,
      anyPositive,
      ...terms.positives.flatMap((term) => [term, term]),
      ...(anyNegative ? [anyNegative, anyNegative] : []),
    ];

    const ranked = this.sql
      .exec(
        `${hits}
         SELECT d.id, d.item_key, d.item_type, d.url, d.title, d.feed_title, d.feed_url, d.kinds,
                d.read_at, d.saved_at, d.highlighted_at,
                COALESCE(main.s, 0) + COALESCE(noted.s, 0)
                  - (CASE WHEN d.kinds & ${KIND_HIGHLIGHTED} THEN 2.0
                          WHEN d.kinds & ${KIND_SAVED} THEN 1.0 ELSE 0 END)
                  - (CASE WHEN d.touched_at >= ? THEN 0.5 ELSE 0 END) AS score,
                count(*) OVER () AS total
           FROM hits JOIN docs d ON d.id = hits.id
           LEFT JOIN main ON main.id = hits.id
           LEFT JOIN noted ON noted.id = hits.id
          WHERE (? = 0 OR d.kinds & ? != 0)
            AND d.touched_at >= ?
          ORDER BY score
          LIMIT ? OFFSET ?`,
        ...hitsParams,
        recentSince,
        opts.kinds,
        opts.kinds,
        opts.since,
        opts.limit,
        opts.offset
      )
      .toArray();

    // Each hit's best passage from its text or its notes, whichever shows more
    // of the query (the text on a tie).
    const snippets = new Map<number, SnippetSegment[]>();
    if (ranked.length > 0) {
      const ids = ranked.map((r) => r.id as number);
      const inIds = ids.map(() => '?').join(',');
      const fromText = this.textSnippets(anyPositive, ids);
      const fromNotes = this.snippetsFrom('notes_fts', 0, anyPositive, ids, inIds);
      const matches = (segments: SnippetSegment[] | undefined) =>
        segments?.filter((seg) => seg.match).length ?? 0;
      for (const id of ids) {
        const text = fromText.get(id);
        const notes = fromNotes.get(id);
        snippets.set(id, (matches(notes) > matches(text) ? notes : text) ?? []);
      }
    }

    // Every match is ranked to sort the page, so the ranked query counts them
    // too. Only a page past the end has no row to carry the count.
    const total =
      ranked.length > 0
        ? Math.min(ranked[0].total as number, SEARCH_COUNT_CAP + 1)
        : opts.offset === 0
          ? 0
          : this.countHits(hits, hitsParams, opts);

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

  /** Matches for `hits` (capped), for a page past the last one. */
  private countHits(hits: string, hitsParams: string[], opts: SearchOptions): number {
    return this.sql
      .exec(
        `${hits}
         SELECT count(*) AS n FROM (
           SELECT 1 FROM hits JOIN docs d ON d.id = hits.id
            WHERE (? = 0 OR d.kinds & ? != 0) AND d.touched_at >= ?
            LIMIT ?)`,
        ...hitsParams,
        opts.kinds,
        opts.kinds,
        opts.since,
        SEARCH_COUNT_CAP + 1
      )
      .one().n as number;
  }

  /**
   * Snippets from each item's own text. A long body's comes from its
   * best-matching passage (see PASSAGE_MIN_CHARS). One whose passages don't
   * match matched in its title, author or feed: the first of those with a match
   * (one column at a time, so snippet() never reads the body).
   */
  private textSnippets(match: string, ids: number[]): Map<number, SnippetSegment[]> {
    const long = new Set<number>();
    for (const id of ids) {
      const lo = id * PASSAGE_STRIDE;
      if (this.sql.exec(`SELECT 1 FROM passages WHERE id = ?`, lo).toArray().length) long.add(id);
    }
    const short = ids.filter((id) => !long.has(id));
    const found = short.length
      ? this.snippetsFrom('fts', -1, match, short, short.map(() => '?').join(','))
      : new Map<number, SnippetSegment[]>();
    for (const id of long) {
      const lo = id * PASSAGE_STRIDE;
      const best = this.sql
        .exec(
          `SELECT rowid FROM passages_fts WHERE passages_fts MATCH ? AND rowid BETWEEN ? AND ?
            ORDER BY bm25(passages_fts) LIMIT 1`,
          match,
          lo,
          lo + PASSAGE_STRIDE - 1
        )
        .toArray()[0];
      if (best) {
        const segments = this.snippetsFrom('passages_fts', 0, match, [best.rowid as number], '?');
        const passage = [...segments.values()][0];
        if (passage) found.set(id, passage);
        continue;
      }
      // Columns of fts: title, author, feed.
      for (const column of [0, 1, 2]) {
        const segments = this.snippetsFrom('fts', column, match, [id], '?').get(id);
        if (segments?.some((seg) => seg.match)) {
          found.set(id, segments);
          break;
        }
        if (column === 0 && segments) found.set(id, segments);
      }
    }
    return found;
  }

  private snippetsFrom(
    table: 'fts' | 'notes_fts' | 'passages_fts',
    column: number,
    match: string,
    ids: number[],
    inIds: string
  ): Map<number, SnippetSegment[]> {
    const found = new Map<number, SnippetSegment[]>();
    for (const row of this.sql
      .exec(
        `SELECT rowid, snippet(${table}, ${column}, ?, ?, '…', 24) AS s
           FROM ${table} WHERE ${table} MATCH ? AND rowid IN (${inIds})`,
        MARK_OPEN,
        MARK_CLOSE,
        match,
        ...ids
      )
      .toArray()) {
      found.set(row.rowid as number, splitSnippet((row.s as string) ?? ''));
    }
    return found;
  }
}

/**
 * Overlapping [start, length] spans covering `text`, about PASSAGE_CHARS each,
 * cut at whitespace where there's some nearby. In characters (code points), as
 * SQLite's substr() counts them.
 */
export function passageSpans(text: string): Array<[number, number]> {
  const chars = Array.from(text);
  const isSpace = (i: number) => /\s/.test(chars[i] ?? '');
  const spans: Array<[number, number]> = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + PASSAGE_CHARS, chars.length);
    if (end < chars.length) {
      let cut = end;
      while (cut > start + PASSAGE_CHARS / 2 && !isSpace(cut)) cut--;
      if (cut > start + PASSAGE_CHARS / 2) end = cut;
    }
    spans.push([start, end - start]);
    if (end >= chars.length) break;
    let next = end - PASSAGE_OVERLAP;
    while (next < end && !isSpace(next)) next++;
    while (next < end && isSpace(next)) next++;
    start = next;
  }
  return spans;
}
