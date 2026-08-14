import * as Sentry from '@sentry/cloudflare';
import type { CloudflareOptions } from '@sentry/cloudflare';
import type { Env } from '../types';
import { scrubEvent } from './scrub';
import { getRequestContext } from '../utils/request-context';

// Error reporting for the Worker. Everything goes through `reportError()` rather
// than calling `Sentry.captureException` at call sites: the vendor is then a
// one-file decision (swap the SDK for GlitchTip, or for a hand-rolled envelope
// POST if `@sentry/cloudflare` ever stops coexisting with our compat flags)
// without touching a single caller.
//
// Errors-only, matching the feed proxy: `tracesSampleRate: 0`. When SENTRY_DSN is
// unset — local dev, tests, staging before the secret is added — init is a no-op
// and nothing is sent.

export function sentryOptions(env: Env): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || 'development',
    // Set by CI (`--var GIT_COMMIT_SHA:...`), so an event points at a commit.
    release: env.GIT_COMMIT_SHA,
    tracesSampleRate: 0,
    // Drop the Fetch integration. It exists to turn outbound requests into spans
    // and breadcrumbs, and with tracing off the spans are dead weight — but the
    // wrapper still sits in front of every outbound call this Worker makes (PDS,
    // feed proxy, DID resolution, Jetstream). Measured in `test/xrpc.spec.ts`: the
    // background extraction fetch went 124ms → ~17s with it enabled. Not worth it
    // for breadcrumbs we don't need.
    //
    // Drop the Console integration too, for a different reason: it turns every
    // `console.*` call preceding an error into a breadcrumb, verbatim. This
    // codebase logs raw identifiers on failure paths (session ids, OAuth state),
    // and no scrubber can reliably tell a credential from prose once it's been
    // interpolated into a sentence — so the safe move is not to ship the channel
    // at all. `scrubEvent` still scrubs breadcrumbs defensively in case one gets
    // added another way. Workers Logs keeps the console output where it belongs.
    integrations: (defaults) =>
      defaults.filter(
        (integration) => integration.name !== 'Fetch' && integration.name !== 'Console'
      ),
    // Never let the SDK attach bodies/headers on its own judgement; scrubEvent
    // is the only thing that decides what ships.
    sendDefaultPii: false,
    beforeSend(event) {
      return scrubEvent(event);
    },
  };
}

export interface ReportContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/**
 * Report an error to the error tracker. Never throws: an observability failure
 * must not turn into a request failure.
 *
 * The request id is attached here rather than at call sites, so every report is
 * correlatable with the Workers Logs lines for the same request without any
 * caller having to remember.
 */
export function reportError(error: unknown, context?: ReportContext): void {
  try {
    const requestContext = getRequestContext();
    Sentry.captureException(error, {
      tags: {
        ...(requestContext?.requestId ? { requestId: requestContext.requestId } : {}),
        ...(requestContext?.route ? { route: requestContext.route } : {}),
        ...context?.tags,
      },
      extra: context?.extra,
      // A DID is a public identifier and the one thing that turns "someone hit
      // this" into "this account hits this" (see ./scrub.ts).
      user: requestContext?.did ? { id: requestContext.did } : undefined,
    });
  } catch (reportingError) {
    console.error('[Observability] Failed to report error:', reportingError);
  }
}

/**
 * Report a condition that nothing threw for — a threshold crossing, not a crash.
 *
 * `fingerprint` is the grouping key: every "firehose lag is high" event lands in
 * one issue rather than opening a new one each time the condition is re-checked.
 * Callers are still responsible for *when* to send (see the re-alert interval in
 * ops-metrics.ts); the fingerprint only controls grouping once sent.
 */
export function reportMessage(
  message: string,
  options: ReportContext & { level?: 'warning' | 'error'; fingerprint?: string[] } = {}
): void {
  try {
    const requestContext = getRequestContext();
    Sentry.captureMessage(message, {
      level: options.level ?? 'warning',
      fingerprint: options.fingerprint,
      tags: {
        ...(requestContext?.requestId ? { requestId: requestContext.requestId } : {}),
        ...(requestContext?.route ? { route: requestContext.route } : {}),
        ...options.tags,
      },
      extra: options.extra,
    });
  } catch (reportingError) {
    console.error('[Observability] Failed to report message:', reportingError);
  }
}

/**
 * Tag the in-flight Sentry scope with the request id, so an exception the SDK
 * captures on its own (one that escapes our own try/catch) is still correlatable.
 * No-op when Sentry isn't initialized.
 */
export function tagRequestId(requestId: string): void {
  try {
    Sentry.getCurrentScope().setTag('requestId', requestId);
  } catch {
    // Scope access before init, or a vendor swap that doesn't have scopes.
  }
}
