// Secrets not included in cf-typegen output (defined in .dev.vars / wrangler secrets)
declare namespace Cloudflare {
  interface Env {
    FEED_PROXY_SECRET: string;
    // Observability. All optional: unset means "that signal is off", which is the
    // correct behavior in local dev, tests, and CI.
    //   SENTRY_DSN          - secret; error reporting is a no-op without it
    //   SENTRY_ENVIRONMENT  - [vars]; "production" / "staging"
    //   GIT_COMMIT_SHA      - passed by CI (`--var GIT_COMMIT_SHA:...`); the /api/health version
    //   HEARTBEAT_URL       - secret; dead-man's-switch ping URL for the every-minute cron
    //   HEALTH_CHECK_SECRET - secret; gates /api/health/deep via the X-Health-Secret header
    SENTRY_DSN?: string;
    SENTRY_ENVIRONMENT?: string;
    GIT_COMMIT_SHA?: string;
    HEARTBEAT_URL?: string;
    HEALTH_CHECK_SECRET?: string;
    // atproto Spaces spike (docs/plans/SPACES_SAVES_SPIKE.md). `.dev.vars` only —
    // deliberately absent from wrangler.toml, so the entire mirror/read-back path
    // is unreachable in staging and production. Checked as `=== 'true'`.
    SPACES_SAVES_ENABLED?: string;
    // Public base for users' linkblogs (linkblogs.skyreader.app). A [vars] entry,
    // so cf-typegen also emits it; declared here too for envs typed without it.
    LINKBLOG_PUBLIC_URL?: string;
  }
}
