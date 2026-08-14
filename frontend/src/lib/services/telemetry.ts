import { browser, dev, version } from '$app/environment';

// Client error reporting — Phase 3 of the observability plan, and deliberately
// the smallest thing that answers one question: did a deploy break the app for
// real users? It is not analytics. There is no third-party SDK in the bundle, no
// session replay, no breadcrumbs, no page views. The browser posts a name, a
// message, a truncated stack and a path to our own backend, which decides what
// reaches the error tracker (backend/src/routes/telemetry.ts).
//
// Three rules keep it honest:
//
// 1. **Sample.** We need to know that a build is throwing, not to count every
//    throw. One in ten is plenty of signal and a tenth of the noise — except for
//    the failure that means the app can't recover at all, which is always sent.
// 2. **Never make things worse.** A page reporting an error is already having a
//    bad time: no retries, no throwing, no awaiting, and nothing sent while
//    offline (the queue would just be another thing to go wrong).
// 3. **Send no identifiers.** The path is stripped of its query string here and
//    again on the server; nothing else about the page goes with it.

const API_BASE = import.meta.env.VITE_API_URL || '';

/** One in ten. Enough to see a broken deploy within minutes at any real volume. */
const SAMPLE_RATE = 0.1;

/**
 * Per page load. A render loop can throw thousands of times a minute; after this
 * many the extra reports say nothing the first ones didn't, and the backend's
 * rate limit would drop them anyway.
 */
const MAX_REPORTS_PER_LOAD = 5;

const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_CHARS = 2000;

export type ClientErrorKind = 'render' | 'uncaught' | 'rejection' | 'preload_recovery_failed';

/**
 * Kinds that bypass sampling: the app told us it tried to recover from a bad
 * deploy and failed. That's the one report where a 90% chance of silence is
 * unacceptable, and by construction it can only happen once per page.
 */
const ALWAYS_SEND: ReadonlySet<ClientErrorKind> = new Set(['preload_recovery_failed']);

let sent = 0;
const seen = new Set<string>();

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Whatever was thrown, reduced to a name and a message. */
function describe(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: truncate(error.message || String(error), MAX_MESSAGE_CHARS),
      stack: error.stack ? truncate(error.stack, MAX_STACK_CHARS) : undefined,
    };
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    return {
      name: 'Error',
      message: truncate(
        typeof message === 'string' ? message : JSON.stringify(error) || 'unknown',
        MAX_MESSAGE_CHARS
      ),
    };
  }
  return { name: 'Error', message: truncate(String(error), MAX_MESSAGE_CHARS) };
}

/** Path only. Query strings are where share tokens and OAuth params live. */
function currentPath(): string {
  try {
    return window.location.pathname;
  } catch {
    return '/';
  }
}

/**
 * Report a client error. Fire-and-forget by design: callers neither await nor
 * handle failures, because a failed report must not become a second error.
 */
export function reportClientError(kind: ClientErrorKind, error: unknown): void {
  // A dev-server exception is a thing you're already looking at; sending it would
  // just mix local noise into production's error tracker.
  if (!browser || dev) return;

  try {
    if (sent >= MAX_REPORTS_PER_LOAD) return;
    // Offline is not a signal about the app, and holding a report until the
    // network returns is a queue we'd have to reason about. Drop it.
    if (navigator.onLine === false) return;

    const { name, message, stack } = describe(error);

    // Same error, same page load: the first one already said it.
    const key = `${kind}|${name}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);

    const sampled = ALWAYS_SEND.has(kind) || Math.random() < SAMPLE_RATE;
    if (!sampled) return;

    sent++;
    void fetch(`${API_BASE}/api/telemetry/error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      // Survives the navigation/unload that often accompanies a fatal error.
      keepalive: true,
      body: JSON.stringify({
        kind,
        name,
        message,
        stack,
        appVersion: version,
        path: currentPath(),
        sampleRate: ALWAYS_SEND.has(kind) ? 1 : SAMPLE_RATE,
      }),
    }).catch(() => {
      // The backend is unreachable, which the uptime checks already know about.
    });
  } catch {
    // Reporting must never be the thing that breaks the page.
  }
}

/** Test seam: per-page-load state that would otherwise leak between cases. */
export function resetTelemetryForTests(): void {
  sent = 0;
  seen.clear();
}
