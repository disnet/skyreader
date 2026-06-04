/**
 * Shared client for constellation.microcosm.blue, with a circuit breaker.
 *
 * Mentions counts (mentions.ts), link-post social context (constellation.ts), and
 * lane expansion (mention-lane.ts) all query the same Constellation host, and all
 * three are *adornments* that degrade to empty on failure. The risk isn't a
 * single failed call — it's that Constellation slowing down makes every call wait
 * out the full 10 s timeout, and with the warm loop pre-fetching mentions for up
 * to 25 items × 200 feeds per tick that fan-out ties up the single machine in
 * dead waits.
 *
 * The breaker is module-level (one host, shared across all three callers) so a
 * Constellation outage backs every caller off together: after a run of
 * timeouts / 5xx / network errors it opens, and calls short-circuit to `null`
 * immediately for a cooldown instead of each eating a 10 s timeout. A clean 4xx
 * is a definitive "no data" answer (the service is healthy), so it does NOT count
 * toward the breaker.
 */

const CONSTELLATION_BASE = 'https://constellation.microcosm.blue';
const HEADERS = { 'User-Agent': 'Skyreader/1.0 (+https://skyreader.app)' };
const FETCH_TIMEOUT_MS = 10 * 1000;

// Consecutive tripping failures before the breaker opens, and how long it stays
// open before the next call is allowed through to probe recovery.
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30 * 1000;

let consecutiveFailures = 0;
let openUntil = 0;

/** True while the breaker is open (calls short-circuit to null). */
export function isConstellationBreakerOpen(now: number = Date.now()): boolean {
  return now < openUntil;
}

/** Test/ops hook: clear breaker state. */
export function resetConstellationBreaker(): void {
  consecutiveFailures = 0;
  openUntil = 0;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  openUntil = 0;
}

function recordFailure(now: number): void {
  consecutiveFailures++;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    openUntil = now + BREAKER_COOLDOWN_MS;
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
 * GET a Constellation endpoint and parse JSON, or return null. Never throws —
 * every failure (breaker open, timeout, network, non-OK, parse) degrades to null
 * so callers stay best-effort.
 */
export async function constellationGet<T>(
  path: string,
  params: Record<string, string>
): Promise<T | null> {
  if (isConstellationBreakerOpen()) return null;

  try {
    const qs = new URLSearchParams(params);
    const res = await fetch(`${CONSTELLATION_BASE}${path}?${qs}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 5xx / 429 → the service itself is unhealthy; count toward the breaker.
      // Any other non-OK (e.g. 400/404) is a definitive answer from a healthy
      // service — return null without tripping the breaker.
      if (res.status >= 500 || res.status === 429) recordFailure(Date.now());
      else recordSuccess();
      return null;
    }
    const data = (await res.json()) as T;
    recordSuccess();
    return data;
  } catch (error) {
    // Timeout / network error → service slow or unreachable.
    recordFailure(Date.now());
    console.error(`[constellation] ${path} error:`, error);
    return null;
  }
}
