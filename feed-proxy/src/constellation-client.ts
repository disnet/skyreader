/**
 * Shared client for constellation.microcosm.blue, with a circuit breaker.
 *
 * Mentions counts (mentions.ts), link-post social context (constellation.ts),
 * lane expansion (mention-lane.ts) and the linkblog registry
 * (linkblog-registry.ts) all query the same Constellation host, and all of them
 * are *adornments* that degrade to empty on failure. The risk isn't a single
 * failed call — it's that Constellation slowing down makes every call wait out
 * the full 10 s timeout, and with the warm loop pre-fetching mentions for up
 * to 25 items × 200 feeds per tick that fan-out ties up the single machine in
 * dead waits.
 *
 * Three mechanisms, in the order a request meets them:
 *
 * 1. **Circuit breaker** (module-level, one host, shared across all callers) so
 *    a Constellation outage backs every caller off together: after a run of
 *    timeouts / 5xx / network errors it opens, and calls short-circuit to `null`
 *    immediately for a cooldown instead of each eating a 10 s timeout. A clean
 *    4xx is a definitive "no data" answer (the service is healthy), so it does
 *    NOT count toward the breaker. It is checked twice — once on entry and again
 *    after the concurrency permit is granted — so a caller that queued while the
 *    breaker was closed still short-circuits if it opened in the meantime.
 * 2. **Concurrency cap**, because nothing else bounds our fan-out: the warm loop
 *    refreshes 8 feeds at once, each firing up to 25 mention enrichments, each of
 *    which issues up to 12 parallel per-source queries. Unbounded, that's
 *    hundreds of simultaneous sockets against a small community-run service — a
 *    rude thing to point at one. It also matters for the resets in (3), though
 *    not for the reason it first appeared to: those aren't load-shedding we
 *    provoke, but they *do* scale with how many sockets we open, and a low cap is
 *    what keeps the pool small and long-lived. Queue overflow returns `null`
 *    *without* counting a breaker failure: that's our own backpressure, not a
 *    Constellation health signal.
 * 3. **Retries on connection resets.** These resets are an *upstream* fault, and
 *    specifically a per-connection one. `constellation.microcosm.blue` publishes
 *    two A records, and on 2026-08-14 one of them was dead: 155.138.133.71
 *    answered every request with a 200, while 209.38.8.157 completed the TCP
 *    connect *and* a TLS handshake against a valid cert for the hostname, took
 *    the request, then closed without sending a byte — 11 times out of 11, over
 *    several minutes. Reproduce with:
 *
 *      for ip in $(dig +short A constellation.microcosm.blue); do \
 *        printf '%-16s ' "$ip"; \
 *        curl -s --resolve constellation.microcosm.blue:443:$ip -o /dev/null \
 *          -w '%{http_code}\n' -m 10 https://constellation.microcosm.blue/; done
 *
 *    So every *new* connection is a coin flip. Land on the healthy node and that
 *    socket then serves everything cleanly (47/48 sequential on a warm socket;
 *    0 failures across 54 requests in three back-to-back 3-wide bursts; warm
 *    sockets survived 30-60 s idle gaps untouched). Land on the dead one and you
 *    get ECONNRESET. Fresh-connection-per-request measured 26-30% failures;
 *    pooling is what hides that the rest of the time.
 *
 *    Consequences. Retry more than once: each attempt opens a socket and so flips
 *    the coin again, taking a ~28% per-connection failure rate to ~2% per logical
 *    call. Keep concurrency low, since failures scale with sockets opened rather
 *    than requests made. Do NOT "fix" this by disabling keep-alive — that makes
 *    every request a coin flip. And a keepalive heartbeat does NOT help (measured:
 *    26% failures cold vs 30% with a 20 s heartbeat, the heartbeat itself 0/13) —
 *    it keeps *one* socket warm while a burst opens more alongside it. Timeouts
 *    are NOT retried: the caller already waited 10 s, and the breaker is the right
 *    tool for a slow service. If the reproduction above stops showing a dead
 *    address, the upstream node was fixed; the retries stay cheap either way.
 *
 * Breaker, semaphore and counters are per-process module state. That's exactly
 * right on today's single Fly machine; a multi-machine deploy would get one
 * breaker *per machine*, not global coordination.
 */

import { OverloadError, Semaphore } from './semaphore';

const CONSTELLATION_BASE = 'https://constellation.microcosm.blue';
const HEADERS = { 'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)' };
const FETCH_TIMEOUT_MS = 10 * 1000;

// Consecutive tripping failures before the breaker opens, and how long it stays
// open before the next call is allowed through to probe recovery.
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30 * 1000;

// Concurrent requests allowed against the host, and how many callers may park
// waiting. The queue is generous because every caller is fire-and-forget or
// already tolerant of a 10 s wait; it exists to bound memory, not latency.
//
// Concurrency is deliberately low: it sets how many sockets we keep open, and
// resets scale with socket churn rather than request volume. Measured reset rate
// over a fixed request count — 1 concurrent: 2%, 2: 0%, 4: 8%, 6: 8%, 12: 14%.
// Three keeps a warm pool with enough parallelism for the warm loop's per-item
// fan-out; raising it buys throughput we don't need at the cost of resets.
const DEFAULT_CONCURRENCY = parseInt(process.env.CONSTELLATION_CONCURRENCY || '3', 10);
const DEFAULT_QUEUE_MAX = parseInt(process.env.CONSTELLATION_QUEUE_MAX || '200', 10);

// Backoff before each retry, jittered so a burst of resets (the common case —
// several workers opening sockets at once) doesn't re-collide on the reconnect.
const RETRY_DELAY_MS = 250;
const RETRY_JITTER_MS = 100;
// Retries after the first attempt. Each one opens a socket and so re-flips the
// coin described above: at the measured ~28% per-connection failure rate, one
// attempt fails 28% of the time, two 8%, three 2%.
const MAX_RESET_RETRIES = 2;

// An outage otherwise logs one line per failed call; the warm loop makes that
// thousands. Failures log at most once per window, carrying the count of the
// ones suppressed since — a rate, which is the number worth reading, rather
// than a wall of identical stacks. (Streak-based throttling doesn't work here:
// the common case is failures *interleaved* with successes, which resets a
// streak counter on every other call and so logs every single failure in full.)
const LOG_WINDOW_MS = 60 * 1000;
const LOG_EVERY_N_FAILURES = 25;

let consecutiveFailures = 0;
let openUntil = 0;
let lastFailureLogAt = 0;
let suppressedFailures = 0;
let semaphore = new Semaphore(DEFAULT_CONCURRENCY, DEFAULT_QUEUE_MAX);

const counters = {
  /** Logical calls that reached the network (breaker closed, permit acquired). */
  requests: 0,
  /** Connection resets seen (every attempt of a retried call counts its own). */
  resets: 0,
  /** Retry attempts made after a reset (a call may make several). */
  retries: 0,
  /** Retries that then succeeded — the errors this hardening absorbs. */
  retriesRecovered: 0,
  /** Logical calls that counted a breaker failure. */
  failures: 0,
  /** Calls dropped by our own backpressure (queue full). */
  shed: 0,
  /** Times the breaker transitioned to open. */
  breakerOpens: 0,
  /** Calls short-circuited because the breaker was open. */
  shortCircuited: 0,
};

/** True while the breaker is open (calls short-circuit to null). */
export function isConstellationBreakerOpen(now: number = Date.now()): boolean {
  return now < openUntil;
}

/** Test/ops hook: clear breaker state and counters. */
export function resetConstellationBreaker(): void {
  consecutiveFailures = 0;
  openUntil = 0;
  lastFailureLogAt = 0;
  suppressedFailures = 0;
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
}

/**
 * Test hook: resize the concurrency gate. Production sets it once from env at
 * module load — this exists so tests can exercise the cap and the shed path
 * without firing hundreds of calls. Only safe with nothing in flight.
 */
export function setConstellationLimits(
  concurrency: number = DEFAULT_CONCURRENCY,
  maxQueue: number = DEFAULT_QUEUE_MAX
): void {
  semaphore = new Semaphore(concurrency, maxQueue);
}

/** Snapshot for /stats: what the breaker, the gate and the retry path are doing. */
export function getConstellationStats(): {
  breakerOpen: boolean;
  consecutiveFailures: number;
  inUse: number;
  queued: number;
} & typeof counters {
  return {
    breakerOpen: isConstellationBreakerOpen(),
    consecutiveFailures,
    inUse: semaphore.inUse,
    queued: semaphore.queued,
    ...counters,
  };
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  openUntil = 0;
}

function recordFailure(now: number): void {
  counters.failures++;
  consecutiveFailures++;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    openUntil = now + BREAKER_COOLDOWN_MS;
    counters.breakerOpens++;
    // Reset the counter so the cooldown is the gate; the first failure after it
    // expires re-opens the breaker rather than tripping instantly.
    consecutiveFailures = 0;
    console.warn(
      `[constellation] circuit breaker OPEN for ${BREAKER_COOLDOWN_MS / 1000}s ` +
        `after ${BREAKER_THRESHOLD} consecutive failures`
    );
  }
}

/**
 * One line, not a stack. Every failure here comes out of the same `fetch` call
 * in `attempt`, so the stack is identical every time and says nothing; the code
 * and message are the whole signal.
 */
function describeError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return String(error);
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  const label = typeof code === 'string' ? code : typeof name === 'string' ? name : 'Error';
  return typeof message === 'string' ? `${label}: ${message}` : label;
}

/** At most one failure line per window, carrying how many it stands in for. */
function logFailure(path: string, error: unknown, now: number): void {
  if (now - lastFailureLogAt < LOG_WINDOW_MS) {
    suppressedFailures++;
    return;
  }
  const also = suppressedFailures
    ? ` (+${suppressedFailures} more in the last ${Math.round(LOG_WINDOW_MS / 1000)}s)`
    : '';
  console.error(`[constellation] ${path} failed${also}: ${describeError(error)}`);
  lastFailureLogAt = now;
  suppressedFailures = 0;
}

/**
 * Is this a connection reset — the shape a retry fixes (in practice, a socket
 * that died on or just after setup; see the header note)? Deliberately
 * defensive about Bun's error shapes: it surfaces
 * these as `code: 'ECONNRESET'` on some paths and as a bare message on others,
 * and the wording has moved between releases. A shape we don't recognise simply
 * doesn't retry (today's behavior), never crashes.
 *
 * Timeouts (`TimeoutError` from AbortSignal.timeout) and caller aborts are
 * excluded on purpose: waiting another 10 s helps nobody.
 */
function isRetryableConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, code, message } = error as { name?: string; code?: unknown; message?: unknown };
  if (name === 'TimeoutError' || name === 'AbortError') return false;
  if (typeof code === 'string' && ['ECONNRESET', 'EPIPE', 'ConnectionClosed'].includes(code)) {
    return true;
  }
  if (typeof message !== 'string') return false;
  const text = message.toLowerCase();
  return (
    text.includes('socket connection was closed') ||
    text.includes('connection closed') ||
    text.includes('connection reset') ||
    text.includes('econnreset') ||
    text.includes('epipe')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One network attempt. Returns the parsed body, or a verdict for the caller:
 * `retry` for a connection reset (worth one more go), `fail` for anything that
 * should count toward the breaker, `null-ok` for a definitive 4xx.
 */
type Attempt<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'null-ok' }
  | { kind: 'fail'; error?: unknown }
  | { kind: 'retry'; error: unknown };

async function attempt<T>(url: string): Promise<Attempt<T>> {
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 5xx / 429 → the service itself is unhealthy; count toward the breaker.
      // Any other non-OK (e.g. 400/404) is a definitive answer from a healthy
      // service — return null without tripping the breaker.
      if (res.status >= 500 || res.status === 429) {
        return { kind: 'fail', error: `HTTP ${res.status}` };
      }
      return { kind: 'null-ok' };
    }
    return { kind: 'ok', data: (await res.json()) as T };
  } catch (error) {
    if (isRetryableConnectionError(error)) {
      counters.resets++;
      return { kind: 'retry', error };
    }
    return { kind: 'fail', error };
  }
}

/**
 * GET a Constellation endpoint and parse JSON, or return null. Never throws —
 * every failure (breaker open, overload, timeout, network, non-OK, parse)
 * degrades to null so callers stay best-effort.
 *
 * A reset-then-success sequence counts as one success; a call whose every
 * attempt reset counts as exactly *one* breaker failure, so the threshold still
 * means "5 logical calls failed", not "5 sockets died".
 */
export async function constellationGet<T>(
  path: string,
  params: Record<string, string>
): Promise<T | null> {
  if (isConstellationBreakerOpen()) {
    counters.shortCircuited++;
    return null;
  }

  const qs = new URLSearchParams(params);
  const url = `${CONSTELLATION_BASE}${path}?${qs}`;

  try {
    await semaphore.acquire();
  } catch (error) {
    if (error instanceof OverloadError) {
      // Our own backpressure, not a Constellation health signal — no breaker
      // failure, and the count in /stats is the signal worth looking at.
      counters.shed++;
      if (counters.shed === 1 || counters.shed % LOG_EVERY_N_FAILURES === 0) {
        console.warn(`[constellation] shed ${counters.shed} request(s): queue full (${path})`);
      }
      return null;
    }
    throw error;
  }

  try {
    // The breaker may have opened while we sat in the queue: with the default
    // queue that's up to 200 callers who passed the check above and would each
    // otherwise spend a 10 s timeout on an already-failing host — exactly the
    // storm the breaker exists to stop. Re-check now that it's our turn.
    if (isConstellationBreakerOpen()) {
      counters.shortCircuited++;
      return null;
    }

    counters.requests++;
    let result = await attempt<T>(url);
    // The first error names the socket that died first — keep it for the log if
    // every attempt resets, since the later ones are the same story retold.
    const firstError = result.kind === 'retry' ? result.error : undefined;
    let retried = false;

    for (let i = 0; result.kind === 'retry' && i < MAX_RESET_RETRIES; i++) {
      counters.retries++;
      retried = true;
      await sleep(RETRY_DELAY_MS + Math.random() * RETRY_JITTER_MS);
      result = await attempt<T>(url);
    }
    if (result.kind === 'retry') {
      // Every attempt reset: one logical failure, not one per dead socket.
      result = { kind: 'fail', error: firstError };
    }

    const recovered = retried && (result.kind === 'ok' || result.kind === 'null-ok');
    if (recovered) {
      counters.retriesRecovered++;
      // Absorbed resets are the expected background noise of this host, not an
      // incident: /stats carries the count, and the log gets an occasional line
      // so a *changed* rate is still visible without a flood of self-healed ones.
      if (counters.retriesRecovered % LOG_EVERY_N_FAILURES === 1) {
        console.warn(
          `[constellation] absorbed ${counters.retriesRecovered} connection reset(s) ` +
            `by retrying (latest ${path})`
        );
      }
    }

    switch (result.kind) {
      case 'ok':
        recordSuccess();
        return result.data;
      case 'null-ok':
        recordSuccess();
        return null;
      default: {
        const now = Date.now();
        recordFailure(now);
        logFailure(path, result.error, now);
        return null;
      }
    }
  } finally {
    semaphore.release();
  }
}
