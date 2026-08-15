// Dead-man's switch ping for the self-warming loop. A wedged warmer (a tick that
// never settles, a timer that stops firing) throws nothing, so Sentry never hears
// about it and the cache just quietly goes stale. A monitor alerting on the
// absence of this ping is what catches that.
//
// Fire-and-forget by contract: never awaited on the tick's critical path, and it
// swallows every failure so a slow monitor can't stall warming.

const HEARTBEAT_TIMEOUT_MS = 5000;

/**
 * Ping a heartbeat URL (Healthchecks.io / Better Stack). No-op when `url` is
 * unset, which keeps local dev and tests quiet.
 */
export async function pingHeartbeat(url: string | undefined, source: string): Promise<void> {
  if (!url) return;

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[Heartbeat] ${source} ping returned ${response.status}`);
    }
  } catch (error) {
    console.warn(`[Heartbeat] ${source} ping failed:`, error);
  }
}
