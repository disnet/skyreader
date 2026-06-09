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
