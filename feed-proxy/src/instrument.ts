// Sentry initialization. Imported FIRST in index.ts (before any other module) so
// the Bun SDK can install its global error/rejection handlers and auto-
// instrumentation before the app boots.
//
// The DSN is provisioned by the Fly.io Sentry integration (`fly ext sentry
// create`), which sets the SENTRY_DSN secret on the machine. When SENTRY_DSN is
// unset — local dev, tests — init() is a no-op and nothing is sent, so this is
// safe to import unconditionally.
import * as Sentry from '@sentry/bun';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
    // Performance tracing is opt-in via env (off by default) — this proxy is
    // high-throughput and we only want error reporting unless we deliberately
    // turn sampling on.
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),
  });
  console.log('[Proxy] Sentry initialized');
} else {
  console.log('[Proxy] Sentry disabled (no SENTRY_DSN)');
}

export { Sentry };

// The build this process is running, stamped by the Fly build arg (see Dockerfile
// and .github/workflows/feed-proxy-deploy.yml). Surfaced on /health so a
// post-deploy smoke check can prove the new code is actually serving.
export const VERSION = process.env.GIT_COMMIT_SHA || 'dev';

export interface ReportContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/**
 * Report an error to the error tracker. Every call site goes through this rather
 * than `Sentry.captureException` directly, so swapping the vendor (GlitchTip, a
 * hand-rolled envelope POST, nothing at all) stays a one-file change. Never
 * throws — an observability failure must not become a request failure.
 */
export function reportError(error: unknown, context?: ReportContext): void {
  try {
    Sentry.captureException(error, { tags: context?.tags, extra: context?.extra });
  } catch (reportingError) {
    console.error('[Proxy] Failed to report error:', reportingError);
  }
}
