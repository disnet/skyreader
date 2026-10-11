// Spike: per-user full-text search index in a SQLite-backed Durable Object.
//
// Answers three questions before we commit to the design in the atplan goal
// "Full-text search over everything read":
//   1. Does FTS5 work in Durable Object SQLite (and which SQLite version)?
//   2. How big is the index for a power reader's history, per layout variant?
//   3. Is p95 query latency comfortably under a second at 50k–100k items?
//
// Not production code. The corpus is synthetic and generated inside the DO
// (deterministic PRNG) so seeding doesn't ship hundreds of MB over HTTP.
// Run with ./run.sh; see README.md for results.

import { DurableObject } from 'cloudflare:workers';

interface Env {
  SEARCH_INDEX: DurableObjectNamespace<SearchIndex>;
}

// Layout variants under test.
//   ext     - external-content FTS5 over a docs_text table; snippet() works.
//   less    - contentless FTS5 (contentless_delete=1); text not stored, so no
//             snippet() - snippets would need the body re-fetched at query time.
//   ext_col - like ext but detail=column: smaller index, no phrase queries.
type Variant = 'ext' | 'less' | 'ext_col';

const KIND_READ = 1;
const KIND_SAVED = 2;
const KIND_HIGHLIGHTED = 4;

// --- deterministic synthetic corpus -------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES =
  'ka lo mi ta re su no vi da pe ri go ma te lu sa ne fi bo ra ze ko li mu de po na si to ve ga'.split(
    ' '
  );
const VOCAB_SIZE = 40_000;

// Pseudo-words built from syllables. Ranks 0..VOCAB_SIZE-1, sampled with a
// Zipf-ish distribution so term frequencies look like natural language: a few
// very common words, a long tail of rare ones.
const VOCAB: string[] = (() => {
  const rnd = mulberry32(42);
  const seen = new Set<string>();
  const out: string[] = [];
  while (out.length < VOCAB_SIZE) {
    const n = 1 + Math.floor(rnd() * 4);
    let w = '';
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rnd() * SYLLABLES.length)];
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
})();

// Inverse-CDF sampling of a Zipf(s≈1.07) over VOCAB via a precomputed table.
const ZIPF_CDF: Float64Array = (() => {
  const cdf = new Float64Array(VOCAB_SIZE);
  let sum = 0;
  for (let i = 0; i < VOCAB_SIZE; i++) {
    sum += 1 / Math.pow(i + 1, 1.07);
    cdf[i] = sum;
  }
  for (let i = 0; i < VOCAB_SIZE; i++) cdf[i] /= sum;
  return cdf;
})();

function zipfWord(rnd: () => number): string {
  const u = rnd();
  let lo = 0;
  let hi = VOCAB_SIZE - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ZIPF_CDF[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return VOCAB[lo];
}

function words(rnd: () => number, bytes: number): string {
  const parts: string[] = [];
  let len = 0;
  while (len < bytes) {
    const w = zipfWord(rnd);
    parts.push(w);
    len += w.length + 1;
  }
  return parts.join(' ');
}

interface Doc {
  itemKey: string;
  kind: number;
  url: string;
  title: string;
  author: string;
  feed: string;
  body: string;
  notes: string;
  touchedAt: number;
}

// Mix modelled on the tiered index plan: read-only items index ~2 KB of body,
// saved/highlighted items index full text (here 8-30 KB; capped at 64 KB in
// the real design). ~85% read-only, ~12% saved, ~3% highlighted with notes.
function makeDoc(i: number): Doc {
  const rnd = mulberry32(1_000_003 * (i + 1));
  const r = rnd();
  const kind =
    r < 0.85
      ? KIND_READ
      : r < 0.97
        ? KIND_READ | KIND_SAVED
        : KIND_READ | KIND_SAVED | KIND_HIGHLIGHTED;
  const bodyBytes = kind === KIND_READ ? 2_000 : 8_000 + Math.floor(rnd() * 22_000);
  return {
    itemKey: `item-${i}`,
    kind,
    url: `https://example${i % 1000}.test/posts/${i}`,
    title: words(rnd, 40 + Math.floor(rnd() * 50)),
    author: words(rnd, 12),
    feed: `feed ${VOCAB[i % 1000]}`,
    body: words(rnd, bodyBytes),
    notes: kind & KIND_HIGHLIGHTED ? words(rnd, 300 + Math.floor(rnd() * 900)) : '',
    // Spread over ~2 years of reading.
    touchedAt: 1_730_000_000_000 + Math.floor(rnd() * 63_000_000_000),
  };
}

// --- the index DO -------------------------------------------------------------

export class SearchIndex extends DurableObject<Env> {
  private sql: Pick<SqlStorage, 'exec'>;
  // Every cursor opened since the last tally(), so a method can report the
  // billed SQLite rows read/written (including FTS5's shadow tables).
  private cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const raw = ctx.storage.sql;
    this.sql = {
      exec: (query, ...bindings) => {
        const c = raw.exec(query, ...bindings);
        this.cursors.push(c);
        return c;
      },
    } as Pick<SqlStorage, 'exec'>;
  }

  private tally() {
    let rowsRead = 0;
    let rowsWritten = 0;
    for (const c of this.cursors) {
      rowsRead += c.rowsRead;
      rowsWritten += c.rowsWritten;
    }
    this.cursors = [];
    return { rowsRead, rowsWritten };
  }

  private setup(variant: Variant) {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY,
      item_key TEXT NOT NULL UNIQUE,
      kind INTEGER NOT NULL,
      url TEXT NOT NULL,
      touched_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS docs_touched ON docs(touched_at)`);
    const tokenize = `tokenize = 'porter unicode61 remove_diacritics 2'`;
    if (variant === 'less') {
      this.sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        title, author, feed, body, notes,
        content = '', contentless_delete = 1, ${tokenize}
      )`);
    } else {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS docs_text (
        id INTEGER PRIMARY KEY, title TEXT, author TEXT, feed TEXT, body TEXT, notes TEXT
      )`);
      const detail = variant === 'ext_col' ? `, detail = column` : '';
      this.sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        title, author, feed, body, notes,
        content = 'docs_text', content_rowid = 'id', ${tokenize}${detail}
      )`);
    }
  }

  info() {
    // sqlite_version() is not on the DO SQL function allowlist, so report
    // whether the compile options we rely on are present instead.
    let fts5 = false;
    try {
      this.sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS _probe USING fts5(x)`);
      this.sql.exec(`DROP TABLE _probe`);
      fts5 = true;
    } catch {
      // FTS5 unavailable
    }
    const version = fts5 ? 'fts5 available' : 'NO FTS5';
    let docs = 0;
    try {
      docs = this.sql.exec(`SELECT count(*) AS n FROM docs`).one().n as number;
    } catch {
      // not seeded yet
    }
    return { sqliteVersion: version, docs, databaseSize: this.ctx.storage.sql.databaseSize };
  }

  seed(variant: Variant, start: number, count: number) {
    this.setup(variant);
    this.tally();
    const t0 = performance.now();
    let textBytes = 0;
    for (let i = start; i < start + count; i++) {
      const d = makeDoc(i);
      textBytes +=
        d.title.length + d.author.length + d.feed.length + d.body.length + d.notes.length;
      const id = this.sql
        .exec(
          `INSERT INTO docs (item_key, kind, url, touched_at) VALUES (?, ?, ?, ?) RETURNING id`,
          d.itemKey,
          d.kind,
          d.url,
          d.touchedAt
        )
        .one().id as number;
      if (variant !== 'less') {
        this.sql.exec(
          `INSERT INTO docs_text (id, title, author, feed, body, notes) VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          d.title,
          d.author,
          d.feed,
          d.body,
          d.notes
        );
      }
      this.sql.exec(
        `INSERT INTO fts (rowid, title, author, feed, body, notes) VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        d.title,
        d.author,
        d.feed,
        d.body,
        d.notes
      );
    }
    return { inserted: count, textBytes, ms: performance.now() - t0, ...this.tally() };
  }

  optimize() {
    this.tally();
    const t0 = performance.now();
    this.sql.exec(`INSERT INTO fts (fts) VALUES ('optimize')`);
    return {
      ms: performance.now() - t0,
      databaseSize: this.ctx.storage.sql.databaseSize,
      ...this.tally(),
    };
  }

  // One update and one delete, to check the write paths the real index needs
  // (unsave -> re-tier, label tombstone -> delete) work for the variant.
  mutate(variant: Variant) {
    this.tally();
    const row = this.sql.exec(`SELECT id FROM docs ORDER BY id DESC LIMIT 1`).one();
    const id = row.id as number;
    if (variant === 'less') {
      this.sql.exec(`DELETE FROM fts WHERE rowid = ?`, id);
    } else {
      const old = this.sql.exec(`SELECT * FROM docs_text WHERE id = ?`, id).one();
      this.sql.exec(
        `INSERT INTO fts (fts, rowid, title, author, feed, body, notes) VALUES ('delete', ?, ?, ?, ?, ?, ?)`,
        id,
        old.title,
        old.author,
        old.feed,
        old.body,
        old.notes
      );
      this.sql.exec(`DELETE FROM docs_text WHERE id = ?`, id);
    }
    this.sql.exec(`DELETE FROM docs WHERE id = ?`, id);
    const cost = this.tally();
    const left = this.sql.exec(`SELECT count(*) AS n FROM fts WHERE rowid = ?`, id).one().n;
    return { deletedId: id, ftsRowsLeft: left, deleteCost: cost };
  }

  // Ranked query: bm25 with column weights (title, author, feed, body, notes),
  // plus a boost for saved/highlighted. Optional kind filter and date floor.
  query(variant: Variant, match: string, kindMask: number, since: number, limit: number) {
    this.tally();
    const t0 = performance.now();
    // Two phases: rank every match without snippet(), then compute snippets
    // for just the page. Putting snippet() in the ranked SELECT makes SQLite
    // evaluate it for every matching row before the sort - the first 50k run
    // measured that at up to ~5x slower on common terms.
    const rows = this.sql
      .exec(
        `SELECT d.id, d.item_key, d.kind, d.url,
                bm25(fts, 10.0, 3.0, 2.0, 1.0, 5.0)
                  - (CASE WHEN d.kind & ${KIND_HIGHLIGHTED} THEN 2.0
                          WHEN d.kind & ${KIND_SAVED} THEN 1.0 ELSE 0 END) AS score
           FROM fts JOIN docs d ON d.id = fts.rowid
          WHERE fts MATCH ?
            AND (? = 0 OR d.kind & ? != 0)
            AND d.touched_at >= ?
          ORDER BY score
          LIMIT ?`,
        match,
        kindMask,
        kindMask,
        since,
        limit
      )
      .toArray();
    const rankedMs = performance.now() - t0;
    if (variant !== 'less' && rows.length > 0) {
      const ids = rows.map((r) => r.id as number);
      const snippets = new Map(
        this.sql
          .exec(
            `SELECT rowid, snippet(fts, -1, '<mark>', '</mark>', '…', 24) AS s
               FROM fts WHERE fts MATCH ? AND rowid IN (${ids.map(() => '?').join(',')})`,
            match,
            ...ids
          )
          .toArray()
          .map((r) => [r.rowid as number, r.s as string])
      );
      for (const r of rows) r.snippet = snippets.get(r.id as number) ?? null;
    }
    // The UI shows "1,000+" past a cap, so never count the whole match set.
    const total = this.sql
      .exec(`SELECT count(*) AS n FROM (SELECT 1 FROM fts WHERE fts MATCH ? LIMIT 1001)`, match)
      .one().n as number;
    return {
      ms: performance.now() - t0,
      rankedMs,
      matches: total,
      top: rows.slice(0, 3),
      ...this.tally(),
    };
  }
}

// --- HTTP shim for the driver script ------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.searchParams;
    const user = p.get('user') ?? 'u';
    const variant = (p.get('variant') ?? 'ext') as Variant;
    const stub = env.SEARCH_INDEX.get(env.SEARCH_INDEX.idFromName(user));
    try {
      let out: unknown;
      switch (url.pathname) {
        case '/info':
          out = await stub.info();
          break;
        case '/seed':
          out = await stub.seed(variant, Number(p.get('start')), Number(p.get('count')));
          break;
        case '/optimize':
          out = await stub.optimize();
          break;
        case '/mutate':
          out = await stub.mutate(variant);
          break;
        case '/query':
          out = await stub.query(
            variant,
            p.get('q') ?? '',
            Number(p.get('kind') ?? 0),
            Number(p.get('since') ?? 0),
            Number(p.get('limit') ?? 20)
          );
          break;
        case '/vocab':
          // Words at given Zipf ranks, so the driver can pick common/rare terms.
          out = (p.get('ranks') ?? '').split(',').map((r) => VOCAB[Number(r)]);
          break;
        default:
          return new Response('not found', { status: 404 });
      }
      return Response.json(out);
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
};
