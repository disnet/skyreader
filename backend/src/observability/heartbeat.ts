// Dead-man's switch ping. The every-minute cron is what keeps the JetstreamPoller
// alive, so a cron that stops firing (or throws every run) silently kills the
// firehose. A monitor that alerts on the *absence* of this ping is the only thing
// that notices.
//
// Fire-and-forget by contract: call it inside `ctx.waitUntil()`, never `await` it
// on the critical path, and it swallows every failure — a slow or broken monitor
// must never fail or extend the cron.

const HEARTBEAT_TIMEOUT_MS = 5000;

/**
 * Ping a heartbeat URL (Healthchecks.io / Better Stack). No-op when `url` is
 * unset, which keeps local dev and staging quiet without an env-name check.
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
