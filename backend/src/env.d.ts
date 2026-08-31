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
  // Polar billing. Declared non-optional like FEED_PROXY_SECRET — cf-typegen
  // also reads .dev.vars, where these keys exist, and emits them as `string`;
  // an optional redeclaration here would be a merge conflict. Empty/unset still
  // means billing is off: checkout answers 503, the webhook fails closed (500).
  //   POLAR_ACCESS_TOKEN   - secret; org access token (products/checkouts/webhooks)
  //   POLAR_WEBHOOK_SECRET - secret; standard-webhooks signing secret (whsec_...)
  // POLAR_SERVER and POLAR_PRODUCT_ID are [vars] — cf-typegen emits them, so they
  // must NOT be redeclared here (merge conflict, per the note above).
  POLAR_ACCESS_TOKEN: string;
  POLAR_WEBHOOK_SECRET: string;
}
