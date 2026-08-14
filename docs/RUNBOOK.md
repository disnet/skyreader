# Skyreader Operations Runbook

What's watching Skyreader, what each signal means, and what to do when one fires.

Scope note: this covers **Phases 0–1** — external checks, dead-man's switches,
error tracking, post-deploy smoke checks, and structured logs with request-id
correlation. The admin ops panel (Phase 2), client signal (Phase 3), and SLO/alert
pruning (Phase 4) get their sections as they land.

The operating principle: **silence means healthy**. Every alert below is
outage-class by construction. If one fires without requiring action, fix or delete
it rather than learning to ignore it.

---

## 1. What's instrumented

| Surface                      | Signal                        | Where it lives                                   |
| ---------------------------- | ----------------------------- | ------------------------------------------------ |
| Backend Worker               | `GET /api/health`             | Shallow: status, version, timestamp. No deps.    |
| Backend Worker               | `GET /api/health/deep`        | D1 + poller lag + feed proxy. Secret-gated.      |
| Backend Worker               | Sentry (`@sentry/cloudflare`) | Exceptions from `fetch`, `scheduled`, DO alarm.  |
| Backend Worker               | Structured logs (Workers Logs) | One JSON object per event, keyed by `requestId`. |
| Backend cron (every minute)   | Heartbeat ping (`HEARTBEAT_URL`) | Dead-man's switch; also guards the firehose.  |
| Feed proxy                   | `GET /health`                 | Status, version, cached feed count. No auth.     |
| Feed proxy                   | `GET /stats`                  | Cache freshness + per-feed error counts. Secret. |
| Feed proxy                   | Sentry (`@sentry/bun`)        | Route escapes, warmer failures.                  |
| Feed proxy warmer            | Heartbeat ping (`WARM_HEARTBEAT_URL`) | Dead-man's switch for the warm loop.     |
| All deploys                  | `scripts/smoke-check.mjs`     | Post-deploy assertion against production.        |

Not yet covered (by design, see the plan): trend lines, an ops panel in the admin,
client-side errors.

---

## 2. External checks to configure

These are **configuration, not code** — they live in the monitoring vendor's
console. Reproduce them exactly from this list.

Recommendation: use **one** vendor for both uptime checks and heartbeats. Better
Stack does both on its free tier (verify current limits when you sign up), which
keeps this to a single account instead of an uptime service plus Healthchecks.io.
Any Healthchecks.io-style ping URL works for the heartbeats — the backend and
proxy just GET whatever URL you give them.

### Uptime checks

| Check              | URL                                                   | Interval | Alert on                    |
| ------------------ | ----------------------------------------------------- | -------- | --------------------------- |
| API (shallow)      | `https://api.skyreader.app/api/health`                | 60s      | 2 consecutive failures      |
| API (deep)         | `https://api.skyreader.app/api/health/deep`           | 5 min    | 2 consecutive non-200       |
| App                | `https://skyreader.app`                               | 60s      | 2 consecutive failures      |
| Linkblogs          | `https://linkblogs.skyreader.app`                     | 5 min    | 2 consecutive failures      |
| Feed proxy         | `https://skyreader-feed-proxy.fly.dev/health`         | 60s      | 2 consecutive failures      |
| Admin              | `https://skyreader-admin.pages.dev`                   | 5 min    | 2 consecutive failures      |

The deep check needs the header `X-Health-Secret: <HEALTH_CHECK_SECRET>`. It
returns **503 with a per-dependency breakdown** when anything is down, so it
alerts on its own status code — no response-body assertion needed.

"2 consecutive failures" everywhere: a single failed probe is usually the prober,
not us.

Alert delivery: email **and** phone push. An alert nobody sees is not an alert.

### Heartbeat (dead-man's) checks

| Check           | Period | Grace | Meaning when it fires                                        |
| --------------- | ------ | ----- | ------------------------------------------------------------ |
| `backend-cron`  | 1 min  | 5 min | The every-minute cron stopped firing or is failing every run. |
| `proxy-warmer`  | 1 min  | 5 min | The feed-proxy warm loop wedged or the machine is down.       |

Create each check, copy its ping URL, and set it as a secret (below). The backend
pings **only after a clean run**, so "cron throws every minute" reads the same as
"cron never fired" — both are outages.

---

## 3. Secrets and variables

### Backend (`npx wrangler secret put <NAME>`, per environment)

| Name                  | Required | Purpose                                                            |
| --------------------- | -------- | ------------------------------------------------------------------ |
| `SENTRY_DSN`          | no       | Error reporting. Unset ⇒ reporting is a silent no-op.              |
| `HEARTBEAT_URL`       | no       | Cron dead-man ping URL. Unset ⇒ no ping (correct for local/dev).   |
| `HEALTH_CHECK_SECRET` | no       | Gates `/api/health/deep`. Unset ⇒ the endpoint 503s, by design.    |

`SENTRY_ENVIRONMENT` is a plain var in `wrangler.toml` (`production` / `staging`).
`GIT_COMMIT_SHA` is passed by CI at deploy time (`--var GIT_COMMIT_SHA:<sha>`); a
manual `wrangler deploy` will report `version: "dev"`, which is worth knowing when
a smoke check fails right after a hand deploy.

### Feed proxy (`fly secrets set <NAME>=...`)

| Name                  | Required | Purpose                                        |
| --------------------- | -------- | ---------------------------------------------- |
| `SENTRY_DSN`          | no       | Already provisioned by `fly ext sentry create`. |
| `WARM_HEARTBEAT_URL`  | no       | Warmer dead-man ping URL.                      |

`GIT_COMMIT_SHA` is a Docker build arg passed by CI, surfaced on `/health`.

### Sentry account ownership

The proxy's DSN was provisioned by Fly's Sentry integration
(`fly ext sentry create`), which creates a project in a **Fly-managed org**.
Before pointing the backend at the same org, confirm it's one you control and can
add projects to. If it isn't: create your own Sentry org, make two projects
(`skyreader-backend`, `skyreader-feed-proxy`), and re-point the proxy — it's one
secret (`fly secrets set SENTRY_DSN=...`), no code change.

Both runtimes run **errors-only** (`tracesSampleRate: 0`). The backend additionally
disables the SDK's Fetch integration: it wraps every outbound call (PDS, feed
proxy, DID resolution) to produce spans we've turned off, and it measurably slowed
a background extraction fetch (124ms → ~17s in `backend/test/xrpc.spec.ts`). If a
future need for outbound breadcrumbs comes up, re-enable it deliberately and
re-measure.

Both runtimes report through a `reportError()` wrapper
(`backend/src/observability/sentry.ts`, `feed-proxy/src/instrument.ts`) rather
than calling the SDK at call sites, so swapping vendors — GlitchTip is
API-compatible, or a hand-rolled envelope POST — is a one-file change per runtime.

---

## 4. Alert inventory and response

### `API (shallow)` down

**Means:** the Worker isn't serving. Everything is down for everyone.
**Check:** Cloudflare status page, then `npx wrangler tail` for a crash loop, then
Sentry for a spike.
**Fix:** if a deploy caused it, re-run the previous successful deploy workflow
(the smoke check should have caught it — see why it didn't).

### `API (deep)` returning 503

**Means:** the Worker is up but a dependency isn't. The body says which:

```json
{ "status": "degraded", "checks": { "database": {...}, "poller": {...}, "feedProxy": {...} } }
```

- `database.ok = false` → D1 is unavailable or slow (>3s). Check Cloudflare status.
- `poller.ok = false` → the JetstreamPoller DO is stopped, or its last completed
  poll is >5 min old. The every-minute cron re-pings `/start` automatically, so
  first confirm the cron heartbeat is alive; if the cron is healthy and the poller
  still isn't, redeploy the backend to recycle the DO.
- `feedProxy.ok = false` → see below.

### `backend-cron` heartbeat missed

**Means:** the every-minute cron stopped firing or failed. **The JetstreamPoller
only stays alive because this cron pings it**, so a dead cron takes the firehose
with it within minutes.
**Check:** Sentry for `source: cron` events (they carry the failing `phase` tag);
`npx wrangler tail` for `[Cron]` lines.
**Fix:** confirm the trigger still exists in `wrangler.toml` (`crons = ["* * * * *"]`)
and redeploy. Cloudflare has occasionally dropped triggers on failed deploys.

### `proxy-warmer` heartbeat missed

**Means:** the warm loop wedged or the machine is down. Feeds go stale within the
hour, and user requests start blocking on upstream fetches.
**Check:** `fly status`, `fly logs -a skyreader-feed-proxy`, `/health`.
**Fix:** `fly machine restart <id>`. **Never `fly scale count`** — the proxy is a
deliberate singleton (SQLite on a per-machine volume, in-process firehose and
coalescing maps); a second machine means a split-brain cache. See the invariant
comment in `feed-proxy/fly.toml`.

### `Feed proxy` uptime check down

Same as above. A singleton has no failover; the alert exists to make the manual
restart fast, not to prevent the outage.

### App / Linkblogs / Admin down

**Means:** Cloudflare Pages isn't serving that project.
**Check:** the Pages dashboard for the project's latest deployment.
**Fix:** roll back to the previous deployment in the dashboard, or re-run the
deploy workflow.

### Sentry error spike

Triage by tag: `source` is one of `fetch`, `cron`, `jetstream-poller`, `route`,
`warmer`. Backend events carry the release (`GIT_COMMIT_SHA`), so "did this start
with the last deploy?" is answerable directly in Sentry.

Every backend event also carries a `requestId` tag and, when the request was
authenticated, the user's DID. Copy the id into Workers Logs to get the whole
request — see below.

---

## 4a. Reading the logs

Backend logs are **objects, not sentences**: Workers Logs indexes the fields of an
object passed to `console.*` but treats a string as opaque text. Every line from an
instrumented path carries `level`, `event`, and — inside a request, cron run, or
poll cycle — a `requestId`, plus `route` and `did` when known.

Query patterns that pay for themselves:

| Question                          | Filter                                            |
| --------------------------------- | ------------------------------------------------- |
| Everything about one failure      | `requestId = <id from Sentry or X-Request-Id>`    |
| Error rate on one endpoint        | `event = request AND route = /api/v2/feeds/batch` |
| Slow requests                     | `event = request AND durationMs > 3000`           |
| Is the cron doing its work?       | `event = cron_run`                                |
| Is the firehose keeping up?       | `event = jetstream_poll` → `subscriptionsLagMs`   |
| What failed inside a cron run?    | `event = cron_phase_failed` → `phase`             |

The id is also returned to callers as the `X-Request-Id` response header (exposed
via CORS), so a user-reported failure can be traced if they can quote it. The
backend stamps the same header on every feed-proxy call, and the proxy echoes it
into its own error logs and Sentry tags — one id, both runtimes.

Two deliberate gaps: the shallow health check emits no summary line (an uptime
poller would drown the log in identical entries), and leaf-level `console.log`
calls elsewhere in the codebase are still plain strings. Convert them
opportunistically; a big-bang rewrite is churn.

---

## 5. Post-deploy smoke checks

Every deploy workflow ends with `scripts/smoke-check.mjs`:

- Workers/proxy: asserts `200` **and** `version === <the SHA just deployed>` on the
  health endpoint. This proves the new code is serving — not merely that something
  answers.
- Pages apps: the same version assertion against `/_app/version.json` (SvelteKit
  writes `kit.version.name` there, and each `svelte.config.js` stamps it from
  `$GITHUB_SHA` at build time), **plus** a content sniff. The version check catches
  a deploy that silently didn't roll out; the sniff catches a deploy that rolled
  out but renders nothing.

It retries 6× at 10s intervals (`SMOKE_ATTEMPTS` / `SMOKE_DELAY_SECONDS` to
override) to absorb propagation delay.

Run it by hand during an incident:

```bash
node scripts/smoke-check.mjs https://api.skyreader.app/api/health --version <sha>
node scripts/smoke-check.mjs https://skyreader.app/_app/version.json --version <sha>
node scripts/smoke-check.mjs https://skyreader.app --contains '<title>Skyreader</title>'
```

**A red smoke step means production is wrong, not that the check is flaky.** Look
at the deployment before re-running it.

---

## 6. Fire drills

Run these on staging after configuring the checks; each must produce its alert
within the stated window. Until a drill has passed, treat the alert as unproven.

1. `fly machine stop` the proxy → uptime alert ≤2 min; deep health flips
   `feedProxy.ok`. Restart, confirm recovery.
2. Disable the staging cron trigger and deploy → `backend-cron` heartbeat alert
   within the grace period. Re-enable, confirm auto-recovery.
3. Throw deliberately in a staging route → Sentry event with the right
   `environment` and release, carrying a `requestId` tag whose value finds the
   matching Workers Logs line (proves correlation end to end). Then read the whole
   event, not just the headers: no `Authorization`/`Cookie`/DPoP value, no token in
   a query string, **no credential in a breadcrumb or in the exception message** —
   those are free text, where a header rule can't help. The Console integration is
   disabled precisely so a `console.error` on a failure path can't ship a session
   id (`src/observability/sentry.ts`); confirm the event has no console
   breadcrumbs at all.
4. Deploy with a deliberately wrong version stamp → smoke step fails, workflow red.
   Do it for a Pages app too: edit the built `_app/version.json`, or deploy the
   same SHA twice while asserting a different one — the point is to see the Pages
   smoke check catch a build that isn't the one CI just made.
