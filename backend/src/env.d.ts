// Secrets not included in cf-typegen output (defined in .dev.vars / wrangler secrets).
//
// This merges into the global `Env` that `worker-configuration.d.ts` declares, which
// is the interface every handler is typed against. It used to augment
// `Cloudflare.Env` instead — that worked while wrangler emitted
// `interface Env extends Cloudflare.Env {}`, but current wrangler emits
// `interface Env extends __BaseEnv_Env {}`, so an augmentation of `Cloudflare.Env`
// no longer reaches it. Only declare things cf-typegen does NOT emit here: a name it
// also emits is a merge conflict, not an override.
interface Env {
  FEED_PROXY_SECRET: string;
  // Observability. All optional: unset means "that signal is off", which is the
  // correct behavior in local dev, tests, and CI.
  //   SENTRY_DSN          - secret; error reporting is a no-op without it
  //   SENTRY_ENVIRONMENT  - [vars]; "production" / "staging" (emitted by cf-typegen)
  //   GIT_COMMIT_SHA      - passed by CI (`--var GIT_COMMIT_SHA:...`); the /api/health version
  //   HEARTBEAT_URL       - secret; dead-man's-switch ping URL for the every-minute cron
  //   HEALTH_CHECK_SECRET - secret; gates /api/health/deep via the X-Health-Secret header
  SENTRY_DSN?: string;
  GIT_COMMIT_SHA?: string;
  HEARTBEAT_URL?: string;
  HEALTH_CHECK_SECRET?: string;
}
