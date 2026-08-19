import { getRequestContext } from './request-context';

/**
 * Per-query D1 timing, accumulated on the request context.
 *
 * The question this answers is "where did the wall clock go" on a route that
 * makes several D1 calls. D1 reports its own execution time in `meta.duration`,
 * so the gap between that and the round trip the Worker measured *is* the
 * network — which is exactly what Smart Placement moves. Read it as:
 *
 *   sum(d1Ms) ≈ wallMs   → the queries themselves are slow; look at the plan.
 *   sum(d1Ms) ≪ wallMs   → the Worker is far from the database; look at placement
 *                          and at how many round trips the route makes.
 *
 * `rowsRead` rides along because it is what D1 bills on and what grows with the
 * archive, so the same line that answers the latency question also shows a scan
 * getting more expensive over time.
 *
 * Everything here no-ops outside a request context (unit tests calling a handler
 * directly, module init), same contract as the rest of `request-context`.
 */
export interface D1QueryTiming {
  /** Stable, low-cardinality slug — the field you group by. */
  label: string;
  /** Round trip as the Worker saw it: execution + network. */
  wallMs: number;
  /** What D1 reports it spent executing. */
  d1Ms: number;
  rowsRead: number;
  /** Statements in this round trip — 1, or the size of a batch. */
  statements: number;
}

/**
 * D1 grew `served_by_region` / `served_by_primary` for read replication and the
 * installed @cloudflare/workers-types may predate them. Read them off a widened
 * shape rather than pinning a types bump to this diagnostic.
 */
type D1MetaWithRegion = D1Result['meta'] & {
  served_by_region?: string;
  served_by_primary?: boolean;
};

function record(timing: D1QueryTiming, meta: D1MetaWithRegion | undefined): void {
  const context = getRequestContext();
  if (!context) return;
  if (!context.d1) context.d1 = [];
  context.d1.push(timing);
  // Constant for the whole request, so it is kept once on the context rather
  // than repeated on every query.
  if (meta?.served_by_region && !context.d1Region) context.d1Region = meta.served_by_region;
}

function metaOf(result: { meta?: D1Result['meta'] }): D1MetaWithRegion | undefined {
  return result.meta as D1MetaWithRegion | undefined;
}

/** `stmt.all()`, timed. */
export async function timedAll<T>(label: string, stmt: D1PreparedStatement): Promise<D1Result<T>> {
  const started = Date.now();
  const result = await stmt.all<T>();
  const meta = metaOf(result);
  record(
    {
      label,
      wallMs: Date.now() - started,
      d1Ms: meta?.duration ?? 0,
      rowsRead: meta?.rows_read ?? 0,
      statements: 1,
    },
    meta
  );
  return result;
}

/**
 * `stmt.first()`, timed — implemented over `all()` because `first()` returns the
 * row alone and drops the `meta` this whole module exists to read. Same one round
 * trip, same `T | null` contract at the call site.
 */
export async function timedFirst<T>(label: string, stmt: D1PreparedStatement): Promise<T | null> {
  const result = await timedAll<T>(label, stmt);
  return result.results[0] ?? null;
}

/** `DB.batch()`, timed. One round trip carrying `stmts.length` statements. */
export async function timedBatch<T>(
  label: string,
  db: D1Database,
  stmts: D1PreparedStatement[]
): Promise<D1Result<T>[]> {
  const started = Date.now();
  const results = await db.batch<T>(stmts);
  let d1Ms = 0;
  let rowsRead = 0;
  let meta: D1MetaWithRegion | undefined;
  for (const result of results) {
    meta = metaOf(result) ?? meta;
    d1Ms += metaOf(result)?.duration ?? 0;
    rowsRead += metaOf(result)?.rows_read ?? 0;
  }
  record({ label, wallMs: Date.now() - started, d1Ms, rowsRead, statements: stmts.length }, meta);
  return results;
}

export interface D1Summary {
  /** Round trips — the number that placement and batching actually move. */
  d1RoundTrips: number;
  /** Statements executed; differs from round trips only when a batch ran. */
  d1Statements: number;
  /** Wall clock inside D1 calls, network included. */
  d1WallMs: number;
  /** D1's own reported execution time. `d1WallMs - d1Ms` is the network. */
  d1Ms: number;
  d1RowsRead: number;
  d1Region?: string;
}

export function getD1Timings(): D1QueryTiming[] {
  return getRequestContext()?.d1 ?? [];
}

/** Roll the request's queries into fields for a log line. */
export function d1Summary(): D1Summary | undefined {
  const context = getRequestContext();
  const timings = context?.d1;
  if (!timings || timings.length === 0) return undefined;

  let d1WallMs = 0;
  let d1Ms = 0;
  let d1RowsRead = 0;
  let d1Statements = 0;
  for (const timing of timings) {
    d1WallMs += timing.wallMs;
    d1Ms += timing.d1Ms;
    d1RowsRead += timing.rowsRead;
    d1Statements += timing.statements;
  }
  return {
    d1RoundTrips: timings.length,
    d1Statements,
    d1WallMs,
    d1Ms,
    d1RowsRead,
    ...(context?.d1Region ? { d1Region: context.d1Region } : {}),
  };
}
