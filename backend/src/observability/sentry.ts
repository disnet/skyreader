import * as Sentry from '@sentry/cloudflare';
import type { CloudflareOptions } from '@sentry/cloudflare';
import type { Env } from '../types';
import { scrubEvent } from './scrub';

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
    integrations: (defaults) => defaults.filter((integration) => integration.name !== 'Fetch'),
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
 */
export function reportError(error: unknown, context?: ReportContext): void {
  try {
    Sentry.captureException(error, { tags: context?.tags, extra: context?.extra });
  } catch (reportingError) {
    console.error('[Observability] Failed to report error:', reportingError);
  }
}
