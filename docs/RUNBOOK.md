# Skyreader Operations Runbook

What's watching Skyreader, what each signal means, and what to do when one fires.

Scope note: this covers **Phases 0–4** of the observability plan — external
checks, dead-man's switches, error tracking, post-deploy smoke checks, structured
logs with request-id correlation, the admin ops panel and its trend history,
client-side error reports, and the SLOs and alert policy the thresholds answer to.

The operating principle: **silence means healthy**. Every alert below is
outage-class by construction. If one fires without requiring action, fix or delete
it rather than learning to ignore it.

---

## 1. What's instrumented

| Surface                     | Signal                                | Where it lives                                    |
| --------------------------- | ------------------------------------- | ------------------------------------------------- |
| Backend Worker              | `GET /api/health`                     | Shallow: status, version, timestamp. No deps.     |
| Backend Worker              | `GET /api/health/deep`                | D1 + poller lag + feed proxy. Secret-gated.       |
| Backend Worker              | Sentry (`@sentry/cloudflare`)         | Exceptions from `fetch`, `scheduled`, DO alarm.   |
| Backend Worker              | Structured logs (Workers Logs)        | One JSON object per event, keyed by `requestId`.  |
| Backend cron (every minute) | Heartbeat ping (`HEARTBEAT_URL`)      | Dead-man's switch; also guards the firehose.      |
| Feed proxy                  | `GET /health`                         | Status, version, cached feed count. No auth.      |
| Feed proxy                  | `GET /stats`                          | Cache freshness, per-feed errors, ingest backlog. |
| Feed proxy                  | Sentry (`@sentry/bun`)                | Route escapes, warmer failures.                   |
| Feed proxy warmer           | Heartbeat ping (`WARM_HEARTBEAT_URL`) | Dead-man's switch for the warm loop.              |
| Backend cron (every minute) | `system_status` rows (D1)             | Cron liveness, poller lag, proxy cache stats.     |
| Backend cron (hourly)       | `metrics_snapshots` rows (D1)         | One trend point per hour, pruned at 90 days.      |
| Admin dashboard             | Ops tiles + 30-day sparklines         | The same rows, rendered. No token, works locally. |
| Frontend PWA                | `POST /api/telemetry/error`           | Sampled client errors, forwarded to Sentry.       |
| Frontend PWA                | Settings → Diagnostics                | On-device state. Sent nowhere; read by a human.   |
| All deploys                 | `scripts/smoke-check.mjs`             | Post-deploy assertion against production.         |

Deliberately absent: per-user client telemetry (no page views, no session replay,
no third-party SDK in the browser bundle), distributed tracing, and log shipping.
See "Non-goals" in the plan — each was considered and declined, not overlooked.

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

| Check         | URL                                           | Interval | Alert on               |
| ------------- | --------------------------------------------- | -------- | ---------------------- |
| API (shallow) | `https://api.skyreader.app/api/health`        | 60s      | 2 consecutive failures |
| API (deep)    | `https://api.skyreader.app/api/health/deep`   | 5 min    | 2 consecutive non-200  |
| App           | `https://skyreader.app`                       | 60s      | 2 consecutive failures |
| Linkblogs     | `https://linkblogs.skyreader.app`             | 5 min    | 2 consecutive failures |
| Feed proxy    | `https://skyreader-feed-proxy.fly.dev/health` | 60s      | 2 consecutive failures |
| Admin         | `https://skyreader-admin.pages.dev`           | 5 min    | 2 consecutive failures |

Read the admin row narrowly: that host is behind Cloudflare Access, so an
unauthenticated probe gets a `200` sign-in page and reports healthy even when the
app itself is broken. It catches Cloudflare being down and nothing else. Give the
prober an Access service token if you want it to mean more.

The deep check needs the header `X-Health-Secret: <HEALTH_CHECK_SECRET>`. It
returns **503 with a per-dependency breakdown** when anything is down, so it
alerts on its own status code — no response-body assertion needed.

"2 consecutive failures" everywhere: a single failed probe is usually the prober,
not us.

Alert delivery: email **and** phone push. An alert nobody sees is not an alert.

### Heartbeat (dead-man's) checks

| Check          | Period | Grace | Meaning when it fires                                         |
| -------------- | ------ | ----- | ------------------------------------------------------------- |
| `backend-cron` | 1 min  | 5 min | The every-minute cron stopped firing or is failing every run. |
| `proxy-warmer` | 1 min  | 5 min | The feed-proxy warm loop wedged or the machine is down.       |

Create each check, copy its ping URL, and set it as a secret (below). The backend
pings **only after a clean run**, so "cron throws every minute" reads the same as
"cron never fired" — both are outages.

### Sentry issue alert

| Project             | Filter                                                   | Threshold             | Action               |
| ------------------- | -------------------------------------------------------- | --------------------- | -------------------- |
| `skyreader-backend` | `tags[source]:client tags[kind]:preload_recovery_failed` | 3 events in 5 minutes | Email and phone push |

Use a three-event threshold because `kind` arrives through a deliberately public
endpoint and is therefore forgeable. A cluster still catches a broken deploy
quickly without letting one anonymous POST page the operator.

**Scope every Sentry rule to `environment: production`.** Staging and production
share one project and are separated only by the `SENTRY_ENVIRONMENT` tag, so a rule
without that condition pages you for an environment nobody is relying on. Staging
errors stay visible in the issue stream; they just don't ring.

---

## 3. Secrets and variables

### Backend (`npx wrangler secret put <NAME>`, per environment)

| Name                   | Required | Purpose                                                          |
| ---------------------- | -------- | ---------------------------------------------------------------- |
| `SENTRY_DSN`           | no       | Error reporting. Unset ⇒ reporting is a silent no-op.            |
| `HEARTBEAT_URL`        | no       | Cron dead-man ping URL. Unset ⇒ no ping (correct for local/dev). |
| `HEALTH_CHECK_SECRET`  | no       | Gates `/api/health/deep`. Unset ⇒ the endpoint 503s, by design.  |
| `POLAR_ACCESS_TOKEN`   | no       | Polar API. Unset ⇒ billing off: checkout 503s.                   |
| `POLAR_WEBHOOK_SECRET` | no       | Polar webhook signing. Unset ⇒ the webhook fails closed (500).   |

The two `POLAR_*` secrets are **per Polar org, and the orgs differ per
environment**: production uses the live org, staging a separate sandbox one
(`POLAR_SERVER` in `wrangler.toml` picks which host the SDK talks to). Setting a
production token on staging authenticates against the wrong catalog and every
checkout 502s. Set them with `--env staging` and see [`POLAR_SETUP.md`](../POLAR_SETUP.md).

`SENTRY_ENVIRONMENT` is a plain var in `wrangler.toml` (`production` / `staging`).
`GIT_COMMIT_SHA` is passed by CI at deploy time (`--var GIT_COMMIT_SHA:<sha>`); a
manual `wrangler deploy` will report `version: "dev"`, which is worth knowing when
a smoke check fails right after a hand deploy.

### Feed proxy (`fly secrets set <NAME>=...`)

| Name                 | Required | Purpose                                         |
| -------------------- | -------- | ----------------------------------------------- |
| `SENTRY_DSN`         | no       | Already provisioned by `fly ext sentry create`. |
| `WARM_HEARTBEAT_URL` | no       | Warmer dead-man ping URL.                       |

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

### `firehose_lag_high` (Sentry message, not an exception)

**Means:** the poller's `app.skyreader.feed.subscription` stream has gone more than
**15 minutes** without being confirmed current. Either it can't keep up or it can't
reach Jetstream at all, so subscription records written on a user's PDS (another
device, another Atmospheric app) stop reaching Skyreader. Their feed list quietly
stops converging.

This alert is about the **subscriptions** stream only. The poller also drains a
`site.standard.document` stream (documents came back to the DO from the proxy), and
it is measured and alerted separately — see `documents_stream_lag_high` below. One
stream stuck while the other is healthy is exactly what a shared number would hide.

Lag is time since the most recent **proof** the stream was current, from either of
two one-sided signals (see `streamLagMs` in
`backend/src/durable-objects/jetstream-poller.ts`): a cycle that drained to idle,
or a cursor holding a recent event. Whichever is more recent wins, because each
signal is blind to a traffic pattern the other catches. Cursor age alone measures
how busy the collection is — staging showed a 36h "lag" against a poller doing
clean 3s cycles, since nobody had written that collection in 36h. Drains alone
measure how bursty it is — a collection busy enough that no 2s gap lands inside the
8s poll window never exits idle while being perfectly caught up. A stream that is
genuinely behind, or a Jetstream that can't be reached, has neither signal, and the
number climbs. The raw cursors stay on the DO's `/status` for debugging.

Sent by the every-minute cron with a fixed fingerprint, so it's **one issue, not
one per minute**: first crossing, then a reminder every 30 minutes while it lasts.
Recovery is silent by design — the admin's Firehose Lag tile goes green and
`event = firehose_lag_recovered` appears in the logs.

**Check:** the Ops panel (Firehose Lag, Last Poll, Poll Errors), then
`event = jetstream_poll` in Workers Logs. `durationMs` at the 8s poll timeout with
events processing means the stream is delivering faster than one cycle can drain;
a short `durationMs` with lag still climbing means cycles are ending without ever
connecting, which is Jetstream being unreachable. Cross-check the poller's
`/status` cursors: a cursor pinned in the past while events process is a real
backlog, and one at the live edge points at the drain signal instead.
**Fix:** usually none — a backlog after a Jetstream outage drains on its own; watch
that the number is falling. If it's flat or growing over 30 minutes, redeploy the
backend to recycle the DO (it resumes from its stored cursor, so nothing is lost).

### `documents_stream_lag_high` (Sentry message)

**Means:** the poller's `site.standard.document` stream (plus its
`app.standard-reader.collection` sidecar) has gone more than **15 minutes** without
being confirmed current. New posts from standard.site / Leaflet publications stop
appearing for their subscribers; nothing else is affected, and every document
already in D1 keeps serving.

Same threshold, same lag definition and the same fingerprint-once behaviour as
`firehose_lag_high`, decided independently. Two states are deliberately **not**
alerts: an ingest paused with `documents_ingest_enabled = '0'` (its lag climbs by
construction, and the tile says "Paused"), and an empty subscribed-author set
(nothing to be behind on, so the stream marks itself caught up).

**Check:** the Ops panel's **Document Stream Lag** and **Document Ingest** tiles,
then `event = jetstream_poll` in Workers Logs — `documentsProcessed`,
`documentsCapped`, `documentsAuthors`. A cycle capping every minute is the next
alert, not this one. `documentsAuthors: 0` with lag climbing means no subscription
rows carry `source_type = 'atproto.documents'`, which is a data problem, not a
stream problem.
**Fix:** usually none — a backlog drains at up to the apply cap per minute. If it's
flat over 30 minutes, redeploy the backend to recycle the DO; it resumes from its
stored cursor.

### `documents_cap_saturated` (Sentry message)

**Means:** ten consecutive poll cycles stopped on the per-cycle apply cap. One or
two capped cycles is a burst draining exactly as designed; ten in a row is a
sustained flood — most likely a **subscribed** author dumping thousands of
documents, which the server-side DID filter passes by design.

Nothing is lost while this lasts: the cursor is carried at the last applied event,
so the backlog keeps draining a capful per cycle, and the per-author 100-row cap
bounds what any single author can cost in storage. The risk it flags is the
document stream monopolising cycles while a flood lasts.

**Check:** who is writing — `event = documents_apply_cap_hit` for the streak, and

```sql
SELECT author_did, COUNT(*) FROM documents_v2
WHERE indexed_at > (unixepoch() - 3600) * 1000
GROUP BY author_did ORDER BY 2 DESC LIMIT 5;
```

**Fix:** if it's a legitimate large publisher, raise the cap
(`sync_state.documents_apply_cap`) and let it drain. If it's abuse, pause ingest
(§4e) and unsubscribe/park the author before resuming — the subscriptions stream
and document reads are untouched either way.

`documents_apply_cap_hit` also carries `cappedBy`. `apply-cap` is the tunable
bound above. `query-budget` means the cycle ran out of D1 queries first, which
raising the cap will not change: its events were costlier than the usual one
statement apiece — many distinct authors in one cycle, or publications whose
metadata had to be resolved cold. That drains too, just at fewer events per cycle.

### `source: client` errors after a deploy

**Means:** the browser is throwing. One report is a user with an extension or a
flaky network; a cluster sharing one `appVersion` tag minutes after a deploy is
the deploy.

Reports are **sampled at 10%** in the client, so treat counts as a tenth of
reality (`sampleRate` rides along on every event for exactly this reason). The
`kind` tag says which channel caught it:

| `kind`                    | Caught by                            | What it usually means                              |
| ------------------------- | ------------------------------------ | -------------------------------------------------- |
| `render`                  | SvelteKit `handleError`              | A route failed to load or render.                  |
| `uncaught`                | `window.onerror`                     | An exception outside a framework boundary.         |
| `rejection`               | `unhandledrejection`                 | A promise nobody caught — often a failed API call. |
| `preload_recovery_failed` | The stale-chunk guard, tripped twice | **The deploy bricked the PWA.** See below.         |

**A cluster of `preload_recovery_failed` events is the one to page on.** It means
clients asked for a chunk from their own build, didn't get it, reloaded once to
recover, and then failed again — so the page is stuck and the user's only remedy
is clearing storage. It is **never sampled away**. Its usual cause is a build
whose immutable assets stopped being served (`scripts/retain-immutable-assets.mjs`
retention expired or was skipped) while old tabs were still open.
**Fix:** re-deploy the frontend, which republishes the current build's assets; if
reports name an old `appVersion`, extend asset retention rather than chasing the
client.

**Check:** Sentry `source: client`, grouped by `kind` + message; then
`event = client_error` in Workers Logs for the same window (the log line carries
`path`, `appVersion` and `sampleRate`). Note that stack frames come from a
minified client bundle — the message and the path are the useful parts, and the
issue is grouped on them for that reason.

What never reaches either place: query strings (stripped in the browser and again
on the server), request bodies, and anything about the user beyond the DID already
attached to their session. See `backend/src/routes/telemetry.ts`.

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

| Question                         | Filter                                          |
| -------------------------------- | ----------------------------------------------- |
| Everything about one failure     | `requestId = <id from Sentry or X-Request-Id>`  |
| Error rate on one endpoint       | `event = request AND route = /api/v2/timeline`  |
| Slow requests                    | `event = request AND durationMs > 3000`         |
| Is the cron doing its work?      | `event = cron_run`                              |
| Is the firehose keeping up?      | `event = jetstream_poll` → `subscriptionsLagMs` |
| What failed inside a cron run?   | `event = cron_phase_failed` → `phase`           |
| Why is the ops panel stale?      | `event = ops_metrics_failed` → `step`           |
| Did the hourly trend point land? | `event = metrics_snapshot` → `prunedRows`       |
| Are browsers throwing?           | `event = client_error` → `kind`, `appVersion`   |

The id is also returned to callers as the `X-Request-Id` response header (exposed
via CORS), so a user-reported failure can be traced if they can quote it. The
backend stamps the same header on every feed-proxy call, and the proxy echoes it
into its own error logs and Sentry tags — one id, both runtimes.

Two deliberate gaps: the shallow health check emits no summary line (an uptime
poller would drown the log in identical entries), and leaf-level `console.log`
calls elsewhere in the codebase are still plain strings. Convert them
opportunistically; a big-bang rewrite is churn.

---

## 4b. The admin ops panel

The first section of the admin dashboard. It reads two D1 tables the backend cron
writes (migration `0067_system_status.sql`) — no API token, no production-only
path, so it works in local dev and staging the moment the cron has run once.

| Tile                     | Source                              | Green             | Amber                                             | Red                                               |
| ------------------------ | ----------------------------------- | ----------------- | ------------------------------------------------- | ------------------------------------------------- |
| Cron Last Run            | `system_status.cron_last_run`       | <3 min ago        | <10 min ago                                       | ≥10 min, or the run failed                        |
| Firehose Lag             | `poller_status.lagMs`               | <5 min (SLO bar)  | <15 min                                           | ≥15 min (= the Sentry alert)                      |
| Last Poll                | `poller_status.lastPollAt`          | <5 min ago        | never polled                                      | ≥5 min ago                                        |
| Poll Errors (last cycle) | `poller_status.errors`              | 0                 | ≥1                                                | —                                                 |
| Document Stream Lag      | `poller_status.documentsLagMs`      | <5 min            | <15 min, or paused                                | ≥15 min (= the Sentry alert)                      |
| Document Ingest          | `poller_status.documentsCapStreak`  | 0–2 capped cycles | ≥3 capped cycles                                  | ≥10 capped, or ingest disabled                    |
| Proxy Cache Fresh        | `proxy_stats.freshPct`              | ≥95% (SLO bar)    | ≥80%                                              | <80%, or stats >15 min old                        |
| Proxy Feeds in Error     | `proxy_stats.feedsInError`          | 0                 | ≥1                                                | any permanent failures                            |
| Document Sync            | `proxy_stats.documentAuthorsFrozen` | 0 frozen          | 1–2 frozen, or the proxy's document firehose down | ≥3 frozen, or ≥25% of active (= the Sentry alert) |

"SLO bar" means the tile grades the **latest reading** against the number §7's SLO
uses; the SLO itself is that bar held across a month of hourly points, so an amber
tile right now is not a breach and a green one is not compliance.

**A tile reading "Stale" or "No data" is a real finding**, not a rendering bug: the
values are written by the cron, so they stop moving exactly when it does. Cross-check
against the `backend-cron` heartbeat before assuming the panel is broken.

Staleness is graded on the **row**, not on the numbers inside it: the five poller
tiles go red together once `poller_status` is more than 5 minutes old, and all
three proxy tiles once `proxy_stats` is more than 15 minutes old. That's the case a
value can't see about itself — the cron alive and healthy, but its DO `/status` or
proxy `/stats` fetch failing, leaving a green lag from an hour ago in the table.
Stale poller tiles with a green Cron Last Run mean **the collector is
broken, not the poller**: look for `event = ops_metrics_failed` → `step`.

Below the tiles, **Trends (30 days, hourly)** sparklines the same numbers plus the
raw counts, from `metrics_snapshots`. The x axis is one point per hour, so an hour
with **no snapshot row at all** is a gap in the line exactly like an hour whose
value was unavailable — a break in a line always means "not recorded", never
"dropped to zero", and an isolated recorded hour shows as a dot. Retention is 90
days, pruned by the job that writes it; the panel shows the most recent 30.

Cadence, if a number looks older than expected: poller status every minute, proxy
stats every 5th minute, snapshot once an hour on the hour.

The **Feeds** tiles in the metrics section below the ops panel cover the ingest
side; §4d says what they mean and how to check the pieces they can't see.

---

## 4c. Client signal

The browser reports errors to our own backend — never to a third party — which
decides what reaches Sentry (`frontend/src/lib/services/telemetry.ts` →
`backend/src/routes/telemetry.ts`). The endpoint is unauthenticated on purpose: an
error on the login screen is one worth having. It is also routed **before session
resolution**, alongside the health endpoints — a report sent while D1 or the auth
path is degraded is the one you most want to arrive, and behind the auth gate that
report would have become a 500 the reporter never retries.

What restrains it, in the order it applies:

1. **Nothing in dev.** A local exception is one you're already looking at.
2. **Once per distinct error, per page load.** A render loop reports once.
3. **Five reports per page load.** Past that the page is telling one story.
4. **10% sampling** — except `preload_recovery_failed`, which always sends.
5. **20 accepted reports per minute per IP**, enforced server-side — by IP even
   for a signed-in user, since the route never resolves a session. A 429 carries
   no `Retry-After`: a broken page should drop the report, not schedule it.

Everything the client sends is capped and validated server-side — a 300-character
message, a 2000-character stack, a path with no query string, and a `kind` from a
closed set. Nothing else about the page is collected.

### Settings → Diagnostics

Not telemetry: it's sent nowhere and read by a human. It shows the app build, the
**service worker's** build, online state, unsynced queue depth and the last
successful sync, with a Copy button.

Ask for it in any "it's broken" report. The single most useful line is the service
worker one — "differs from app" means an update is half-applied, which is the
shape of most PWA weirdness, and a reload fixes it.

---

## 4d. Ingest health

Feed reads are served from D1, so what a reader sees is only as fresh as the
crawler's **push**, not the crawler's cache. Proxy cache freshness (§4b) is the
first hop of two; this section is the second. **None of it is wired to an alert
yet** — the signals are on the admin and on the proxy, and this is the list to
walk when the reader looks stale but every tile above is green.

> **Running any `wrangler d1 execute` in this runbook by hand:** run it from the
> **repo root** (or any directory with no `wrangler.toml` in scope), not from
> `backend/`. The checked-in `backend/wrangler.toml` carries a
> `YOUR_D1_DATABASE_ID` placeholder that CI substitutes at deploy time, so from
> `backend/` every command fails with `Invalid uuid`. With no config in scope,
> wrangler resolves `skyreader` / `skyreader-staging` by **name** against the
> account, which is what these commands want. This applies to every D1 command
> below — including the rollback commands, which is the worst moment to
> discover it.

| Signal                      | Where                                           | Healthy                            | How to check                                                                                                         |
| --------------------------- | ----------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Crawler talking to us       | `sync_state.crawler_heartbeat_at` (D1)          | stamped within ~5 min              | `npx wrangler d1 execute skyreader --remote --command "SELECT * FROM sync_state WHERE key = 'crawler_heartbeat_at'"` |
| Clients reading the archive | `GET /api/v2/timeline` → `ingestActive`         | `true` in an ingesting environment | Any authenticated timeline response                                                                                  |
| Rollout gate                | `sync_state.timeline_enabled` (D1)              | `'1'` once rolled out              | `npx wrangler d1 execute skyreader --remote --command "SELECT * FROM sync_state WHERE key = 'timeline_enabled'"`     |
| Push backlog (outbox)       | proxy `GET /stats` → `ingest.pending`           | near zero in steady state          | `curl -H "X-Proxy-Secret: $SECRET" https://skyreader-feed-proxy.fly.dev/stats`                                       |
| Push failing                | Sentry `source: ingest-push`, proxy logs        | silent                             | `fly logs -a skyreader-feed-proxy` → `Ingest push failed`                                                            |
| Feeds gone quiet            | Admin → Feeds, "Subscribed Feeds Not Ingesting" | small and stable                   | The dashboard's Feeds metrics                                                                                        |

Reading these correctly:

- **`crawler_heartbeat_at` is per-environment and stamped by _both_ internal
  endpoints** (`/api/internal/ingest` and the 5-minutely `/api/internal/crawl-set`
  pull), so it keeps ticking through a quiet period with no new items. A missing
  stamp means the proxy isn't talking to this Worker at all — usually `INGEST_URL`
  unset or pointed at the wrong environment, which is also the deliberate state
  before Phase 3. The consequence is not an outage: `ingestActive` goes false and
  clients fall back to the legacy batch path.
- **`ingest.pending` is the outbox depth**, and the push loop drains 100 items
  every 15s (~400/min). A few hundred is churn. A number that holds in the
  thousands across two readings means the push is erroring, not busy — check
  Sentry before touching the machine. The exception is the **first** enablement of
  `INGEST_URL` in an environment: the whole item log is dirty at once and the
  backfill legitimately takes hours to drain.
- **`feeds.last_ingest_at` is the last time that feed produced _new or changed_
  items**, not the last time it was crawled — nothing stamps it on a fetch that
  found nothing. A feed that publishes weekly therefore looks "not ingesting" for
  a week, so read the admin's count as a trend (a jump means the crawl set or the
  push stopped) rather than as a per-feed verdict.

Fix, once you know which one it is: a wedged warm loop or push loop is
`fly machine restart <id>` (never `fly scale count` — see §4's proxy-warmer entry);
a heartbeat that never arrives is configuration, not a restart.

### Document publication feed goes quiet

The admin's **Document Sync** tile and proxy `/stats` → `documents` cover the
Jetstream lane used by standard.site/Leaflet publications. This is the **proxy**
read path, which is the live one only while `documents_v2_enabled` is off; once it
is on, these numbers decay to zero by construction and §4e's D1 tiles are what a
reader depends on. `frozen > 0` means an actively read author has not had a full
PDS re-list for more than twice the 24-hour floor; `inBackoff > 0` explains why a
repair is waiting.

The `proxy-document-cache-frozen` alert fires when **3 or more** authors are
frozen, or when frozen authors are **25% or more** of the active ones (whichever
trips first), on two consecutive five-minute samples, and then reminds once a
day while it holds. A count of one or two is a warning on the tile and nothing on
the wire: each is a bounded gap in a single publication's list, and every
serve-from-cache path in the proxy now re-lists a row past the floor, so a
straggler heals on that author's next poll. What the threshold is actually asking
is whether re-listing has stopped working at all.

That is a change from `frozen > 0` re-alerting every 30 minutes, which is what a
single stuck author did for two days in September 2026 — 93 events for a
condition nobody could act on. If you find yourself tuning this again, the
question to ask is step 2 of the pruning pass: did it require action?

On the production proxy, inspect the affected author before changing it:

```sql
SELECT fetched_at, listed_at, error_count, last_error, last_error_at,
       next_retry_at, last_requested_at
FROM document_cache WHERE did = 'did:plc:...';
```

Confirm the record exists on the author's PDS, then schedule a safe re-list:

```sql
UPDATE document_cache
SET listed_at = 0, error_count = 0, next_retry_at = NULL
WHERE did = 'did:plc:...';
```

The next client poll serves the existing cache and refreshes it in the
background; a changed scope digest replaces the stale list without user action.
For multiple victims, update small batches of recently requested rows so the
upstream PDSes are not hit in a stampede.

### The timeline rollout gate

`ingestActive` is the AND of two things: a fresh crawler heartbeat and
`sync_state.timeline_enabled`. They are separate because the heartbeat lands
_seconds_ into the first backfill of an environment and that backfill takes hours
— without the gate, every reader switches to the timeline at the moment the
archive is emptiest and then drags the whole backfill through the incremental
drain (the expensive global scan, at its worst case, for the duration).

Only an explicit `'0'` gates. Migration 0071 sets it for a database that already
has users, so prod and staging start shut and a fresh environment (local dev,
e2e, CI) starts open.

```bash
# Open it — after ingest.pending has trended to ~0.
npx wrangler d1 execute skyreader --remote --command \
  "UPDATE sync_state SET value='1', updated_at=unixepoch() WHERE key='timeline_enabled'"

# Shut it — every client is back on the legacy batch path at its next poll.
npx wrangler d1 execute skyreader --remote --command \
  "UPDATE sync_state SET value='0', updated_at=unixepoch() WHERE key='timeline_enabled'"
```

Shutting it is the **fast rollback for the read path**, and the first thing to
reach for if the timeline misbehaves after a rollout: no Worker deploy, no waiting
out the 30-minute heartbeat freshness window, and the crawler keeps filling the
archive the whole time. It is not a fix for a bad Worker deploy generally — only
for "readers should not be on the timeline right now".

One caveat when shutting it: clients hold a committed `timelineCursor` and stop
advancing their per-subscription `feedCursors` while on the timeline, so the
batch path re-drains from wherever those cursors were left. The proxy's K=200
window bounds that, and the merge dedupes by GUID, so the cost is one heavier
sync, not duplicates.

**Guests have no batch path.** `/api/v2/feeds/batch` needs a session, so shutting
the gate doesn't move guest readers to a fallback — it empties their refresh
(they keep whatever is cached, and the client retries on the next poll rather
than fanning out to endpoints that would 401). Guest reading mode is therefore
only meaningful with the gate open; check it before announcing the feature.

---

## 4e. standard.site documents in D1

Documents are moving off the Fly proxy the same way feeds did: the poller DO writes
`site.standard.document` (and its reader-collection sidecar) straight into D1, and
reads are served from there. Two independent `sync_state` switches govern it — one
for writes, one for reads — so ingest can run and fill for as long as it takes while
readers stay on the proxy.

| Key                        | Default          | Governs                                                      |
| -------------------------- | ---------------- | ------------------------------------------------------------ |
| `documents_ingest_enabled` | on (absent = on) | Every background document write. `'0'` = flood kill switch.  |
| `documents_v2_enabled`     | off (only `'1'`) | Reads served from D1 instead of the proxy. The rollout gate. |
| `documents_apply_cap`      | 500              | Applied events per poll cycle before the drain carries over. |

```bash
# State of all three.
npx wrangler d1 execute skyreader --remote --command \
  "SELECT key, value, updated_at FROM sync_state WHERE key LIKE 'documents%'"
```

**Cutover, in order.** Nothing here needs a deploy.

1. **Backfill.** The firehose never replays history, so every already-subscribed
   author needs one `listRecords` walk. Drive it as a loop of bounded calls until
   `remaining` is 0 (new subscriptions backfill themselves at subscribe time):

   ```bash
   curl -sX POST -H "X-Proxy-Secret: $FEED_PROXY_SECRET" \
     https://api.skyreader.app/api/internal/documents/backfill | jq '.backfilled, .remaining'
   ```

   The cron re-lists stale authors anyway — one a minute plus three on the hour — so
   this only makes the migration finish in an afternoon instead of over days. Each
   call takes a handful of authors, sized so one request stays inside D1's
   per-invocation query ceiling; loop it. The response's `deferred` is how many of
   the chunk the call declined to start because that budget ran out before them —
   they are still queued, so just call again. An author can also come back in the
   queue after a successful walk: a repo with more curated editions than one walk's
   budget covers records the rest as `document_authors.collections_pending` and stays
   eligible so the next pass writes them, rather than dripping them out one walk's
   worth per reconcile interval. That converges — a walk only requeues an author when
   it wrote some — so it costs a few extra chunks, not a loop that never ends.
   `remaining` does reach 0
   even with authors nobody can list (deleted account, dead PDS): a failed list holds
   that author out of the queue for a backoff window that doubles per consecutive
   failure, up to the 7-day reconcile interval. Their `last_error` is on
   `document_authors`, and their scopes serve `status:'error'` — which is what keeps
   a reader's existing copy on screen rather than clearing it.

2. **Shadow-compare.** The gate on flipping reads: serve authors both ways and diff.
   It compares **one page** per call — pass the returned `cursor` back for the next
   one, and keep going until it comes back `null`. A single call says nothing about
   the authors behind its page, so the gate is _every page clean_, not one clean
   response.

   ```bash
   cursor=null
   while :; do
     out=$(curl -sX POST -H "X-Proxy-Secret: $FEED_PROXY_SECRET" \
       -d "{\"limit\":25,\"cursor\":$( [ "$cursor" = null ] && echo null || echo "\"$cursor\"" )}" \
       https://api.skyreader.app/api/internal/documents/shadow-compare)
     echo "$out" | jq '{clean, remaining, drift: [.scopes[] | select(.clean|not)]}'
     cursor=$(echo "$out" | jq -r '.cursor')
     [ "$cursor" = null ] && break
   done
   ```

   `missingInD1` is the one that costs a reader content; `cidMismatches` is an edit
   one side hasn't seen (usually a race, gone on the next run);
   `canonicalMismatches` points at a publication-cache divergence, not at documents.
   An author the proxy returned no entry for is reported as drift too
   (`No proxy entry returned`) — coverage of the walk has to be a fact, not an
   assumption. Pass `{"dids":[…]}` to re-check specific authors after a fix.

   **`clean` is not proof for an author at the per-author cap.** The compare diffs
   D1 against the proxy, and both sides pick which 100 documents to keep. When they
   pick by the same rule they agree whether or not the rule is right — so an author
   both sides got wrong reads `clean`, and only an author one side has since
   corrected shows up as drift at all. Only authors at the cap can disagree, which
   makes the exposure enumerable:

   ```bash
   npx wrangler d1 execute skyreader --remote --command \
     "SELECT author_did, COUNT(*) AS docs FROM documents_v2
       GROUP BY author_did HAVING COUNT(*) >= 100 ORDER BY 2 DESC"
   ```

   Force those through the backfill (`{"dids":[…]}`, five at a time) before reading
   the compare as a verdict. A repo the walk can list exhaustively — anything inside
   `MAX_LIST_PAGES` — re-ranks itself to the true newest 100 in one pass. A larger
   one can't be repaired by a walk and depends on the firehose rows already in D1,
   which is what the `exhaustive` prune gate exists to protect.

   **Drift that does not block the flip.** Two shapes are expected and mean D1 is
   the better side, not the broken one:
   - **D1 holds the newer `publishedAt`.** The proxy ranks an author's cap by the
     order their PDS served `listRecords`; D1 ranks by publication date, which is
     what every read path orders by. Those disagree whenever listing order isn't
     publication order — a Bridgy Fed repo (served oldest-first, `reverse`
     rejected), or a publication that imported a back catalogue in one write batch,
     where rkey order is write order and says nothing about when anything was
     published. Same counts on both sides with a symmetric difference and no
     `cidMismatches` is the signature. Drift the other way — the **proxy** holding
     newer content — is not this, and does stop the flip.
   - **An author whose PDS is down.** `last_listed_at` null with a listing error
     (§4d) means neither side has content and the flip changes nothing for their
     subscribers. Their scopes serve `status:'error'`, which is what keeps a
     reader's existing copy on screen.

   So the gate is _every page clean, or its drift explained and D1 the better
   side_ — recorded here rather than left to be re-derived, because a literal
   reading of "every page clean" is unreachable while the proxy is still ranking by
   a different key.

3. **Flip reads**, after a clean compare and a soak:

   ```bash
   npx wrangler d1 execute skyreader --remote --command \
     "INSERT INTO sync_state (key, value, updated_at) VALUES ('documents_v2_enabled','1',unixepoch())
      ON CONFLICT(key) DO UPDATE SET value='1', updated_at=unixepoch()"
   ```

   **Rollback is the same statement with `'0'`** — every client is back on the proxy
   path at its next poll, and D1 keeps ingesting the whole time.

**Which document verdict is the live one.** The ops panel carries two while this
rollout is in flight, and the gate decides which one means a reader is missing
documents. Until the flip that is the proxy's: `Document Sync` and
`proxy-document-cache-frozen` (§4d), with `Document Stream Lag` / `Document Ingest`
saying only whether the D1 copy is keeping up. After the flip it inverts — the D1
tiles are the read path, and the proxy tile grades a cache nobody reads.

Nothing needs silencing by hand. `frozen` and `active` count only authors requested
inside the proxy's 14-day warm window, and the warm loop re-lists those rows on its
own clock, so after the flip the counts don't spike — they drain to zero as rows age
out, and both the tile and the alert go quiet within that window. A `frozen` count
that keeps climbing after the flip means something is still on the proxy read path;
check the gate before touching the threshold.

Retire the proxy document cache and its alert together, in a pruning pass (§8), once
the flip has held long enough that you would not roll back — not at the flip itself.
For as long as `documents_v2_enabled` can go back to `'0'`, that cache is the
rollback target and its verdict still has to be trustworthy.

**Flood response.** `documents_cap_saturated`, or a `Document Ingest` tile stuck
red, means pausing writes:

```bash
npx wrangler d1 execute skyreader --remote --command \
  "INSERT INTO sync_state (key, value, updated_at) VALUES ('documents_ingest_enabled','0',unixepoch())
   ON CONFLICT(key) DO UPDATE SET value='0', updated_at=unixepoch()"
```

The subscriptions stream keeps running, reads keep serving whatever D1 holds, and
the document cursor stays put — so re-enabling resumes the drain rather than
skipping the backlog. Expect `Document Stream Lag` to read "Paused" while it's off.

The switch stops **every background loop that writes**: the drain, the poller's
per-cycle back catalogues and the cron's reconcile pause with it, since either would
otherwise keep writing up to a hundred rows an author while the flood is supposedly
paused. Their queues survive the pause.

Two kinds of write are deliberately exempt, so read the switch as "the loops stop",
not "nothing writes":

- **The backfill endpoint below** — an operator asking for a specific repair, which
  is what you want available during an incident.
- **Subscribe-time walks** (`ensureAuthorDocuments`, from the API subscribe, the
  Atmosphere subscribe/import and the PDS→local pull). A reader subscribing during
  an incident would otherwise see nothing but `status:'error'` on that linkblog.
  Each is one author, capped at 100 rows and deduped to one walk an hour, and the
  sync paths schedule at most `MAX_SYNC_BACKFILLS` of them per request — so this is
  a trickle, not a channel the flood can come back through. If a flood is arriving
  _via_ subscriptions, unsubscribe/park the author — the fix under
  `documents_cap_saturated` — rather than expecting this switch to stop it.

**A held cursor is only worth as much as Jetstream's replay buffer.** That buffer is
hours, not days: past it, reconnecting is served from the oldest event the server
still holds and everything in between is simply gone from the stream. So treat a
pause of a few hours as resumable and anything longer as lossy — after a long pause,
force the affected authors through the backfill endpoint rather than waiting on the
7-day reconcile to find the holes. (Jetstream v2's network replay is what removes
this bound; see `docs/plans/DOCUMENTS_TO_D1.md`.)

**Repairing one author** (the D1 equivalent of the proxy re-list below): force them
to the front of the reconcile queue, or backfill them directly.

```bash
curl -sX POST -H "X-Proxy-Secret: $FEED_PROXY_SECRET" \
  -d '{"dids":["did:plc:..."]}' https://api.skyreader.app/api/internal/documents/backfill
```

An explicit `dids` list ignores both the reconcile interval and the failure backoff,
so this is also how you retry an author sooner than their backoff would allow.

---

## 4f. Guest reading mode (unauthenticated surface)

Two public endpoints, both under `/api/guest/` (`backend/src/routes/guest.ts`),
both keyed by `CF-Connecting-IP` because there is no DID, and **both read-only**:

| Endpoint                       | Limit  | What it does                                                               |
| ------------------------------ | ------ | -------------------------------------------------------------------------- |
| `GET /api/guest/starter-feeds` | —      | Static curated channels, `Cache-Control: public, max-age=3600`.            |
| `POST /api/guest/timeline`     | 60/min | Read-only archive query over ≤50 caller-supplied feed URLs. Never fetches. |

There is no unauthenticated write into the archive. Adding a source needs an
account, so the only feeds a guest can name are the curated starter ones, which
ride `GET /api/internal/crawl-set` and are already as fresh as the crawler makes
them. Nothing here relaxes the `callerSubscribes` invariant that protects
`feeds`/`feed_items`, and nothing here can be pointed at a caller-chosen URL.

**If guest adds are ever reopened**, the write path they need is what this
section used to document, and it came with four bounds that all have to come
back with it: a per-IP rate on the warm endpoint, a durable per-feed freshness
window claimed with a single conditional `UPDATE … RETURNING` _before_ the fetch
(read-then-stamp let a concurrent burst straight through), a global daily
ceiling on new guest feeds held as an atomic counter, and a reaper for the
orphan feed rows that result. Both bounds being single-statement claims is the
part that is easy to get wrong.

What to watch: `guest_timeline` log volume and its `d1Ms` / `d1RowsRead`, its
429 rate, and the crawl-set size delta (~+9 for the starter channels).

---

## 5. Post-deploy smoke checks

Every deploy workflow except the admin's ends with `scripts/smoke-check.mjs`:

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

**The admin is the exception.** Both `skyreader-admin.pages.dev` and
`skyreader-admin-staging.pages.dev` are behind Cloudflare Access, which answers an
unauthenticated probe with a redirect to a sign-in page — a `200` full of HTML, so
the check reports "version is undefined" no matter how healthy the deploy is. Its
smoke steps were removed rather than made to lie. A green admin deploy therefore
means "wrangler accepted the upload", not "staging is serving this commit"; verify
by hand in the browser after an admin change that matters. To restore a real check,
give CI a way through Access first (a service token plus a Service Auth policy, or
a bypass policy scoped to `/_app/version.json`).

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
   breadcrumbs at all. **Do the same in a staging feed-proxy route**: it's the one
   runtime whose Sentry SDK sits under Bun+Hono, where whether request data is
   attached at all is untested. Its scrubber (`feed-proxy/src/scrub.ts`) redacts
   `X-Proxy-Secret` and tokenised feed URLs; the drill is what proves there was
   nothing else riding along.
4. Deploy with a deliberately wrong version stamp → smoke step fails, workflow red.
   Do it for a Pages app too: edit the built `_app/version.json`, or deploy the
   same SHA twice while asserting a different one — the point is to see the Pages
   smoke check catch a build that isn't the one CI just made.
5. Point the staging poller at an unreachable Jetstream host → the admin's Firehose
   Lag tile climbs through amber into red, and a `firehose_lag_high` Sentry event
   arrives once lag passes 15 min. Leave it broken for an hour: exactly **three**
   events (crossing, +30 min, +60 min), not sixty. Restore the host, confirm the
   tile goes green and `event = firehose_lag_recovered` appears — recovery is
   deliberately silent in Sentry, so the log line is the proof.
   Shortcut for the impatient: write a `poller_status` row by hand
   (`npx wrangler d1 execute skyreader-staging --remote --command "UPDATE system_status SET value = json_set(value, '$.lagMs', 3600000) WHERE key = 'poller_status'"`)
   — that drives the **panel**, but not the alert, which recomputes from the DO's
   cursors on the next cron minute.
6. Throw in a staging client route (`throw new Error('drill')` in a `+page.svelte`
   `onMount`) → a `source: client`, `kind: render` Sentry event carrying the
   frontend's `appVersion`. Then confirm the restraints: hard-reload the page ten
   times and count events, which should be roughly one (10% sampling), not ten.
   Sampling that isn't working is worse than no sampling — it turns one broken
   render loop into an unusable error tracker.
7. Break stale-chunk recovery on staging: load a page, deploy twice so the old
   chunks age out, then force a dynamic import from the still-open tab. First
   failure reloads; the second reports `kind: preload_recovery_failed`. This is the
   drill worth repeating after any change to
   `scripts/retain-immutable-assets.mjs` — that script is what normally stops this
   from happening at all.

---

## 7. SLOs

Four numbers, chosen to be **thresholds worth tuning against** — not dashboards to
admire, and not promises to anyone outside the project. Their only job is to make
"is this alert set right?" a question with an answer.

| SLO                | Target                               | Measured by                         | Window  |
| ------------------ | ------------------------------------ | ----------------------------------- | ------- |
| API availability   | 99.5%                                | Uptime check on `/api/health`       | 30 days |
| Firehose freshness | lag < 5 min, p95 of hourly snapshots | `metrics_snapshots.firehose_lag_ms` | 30 days |
| Crawl freshness    | ≥95% fresh, p05 of hourly snapshots  | `metrics_snapshots.proxy_fresh_pct` | 30 days |
| Cron liveness      | gap < 5 min                          | Heartbeat check history             | 30 days |

99.5% is ~3.6 hours a month. That is a deliberately loose target for a
single-operator project on a singleton proxy: it says "a couple of short outages a
month is survivable, a daily one is not." Tighten it only if you're also willing
to change the architecture it's measuring.

**Crawl freshness is the first of two hops, not the whole of feed freshness.**
`proxy_fresh_pct` says the crawler's own cache is current; since reads moved to D1,
what a reader actually sees also depends on the push that carries those items into
`feed_items` (§4d). The second hop has no SLO here because nothing records it
hourly — the outbox depth lives on the proxy's `/stats` and is read by hand. Making
it one means recording `ingest.pending` into `metrics_snapshots` beside the numbers
above; until then, say "crawl freshness" and mean it, rather than claiming a
reader-facing number this table can't compute.

Both freshness rows aggregate the **hourly** trend points, not the live tile: the
tile is a point-in-time reading and "95% fresh right now" says nothing about a
month. p95 for lag and p05 for freshness are the same statement pointed in
opposite directions — the worst 5% of hours are allowed to miss, the other 95%
must hold. Read them at the monthly pruning pass (§8) with the queries below (run
from `backend/`), which take the percentile by offset because SQLite has no
percentile function:

```bash
# Firehose lag, p95 (the 95th-worst-percent hour). Passes if < 300000.
npx wrangler d1 execute skyreader --remote --command "
  SELECT firehose_lag_ms FROM metrics_snapshots
  WHERE captured_at > (unixepoch() - 30*86400) * 1000 AND firehose_lag_ms IS NOT NULL
  ORDER BY firehose_lag_ms
  LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 95 / 100 AS INT) FROM metrics_snapshots
    WHERE captured_at > (unixepoch() - 30*86400) * 1000 AND firehose_lag_ms IS NOT NULL)"

# Crawl freshness (proxy cache), p05 (the 5th-worst-percent hour). Passes if >= 95.
npx wrangler d1 execute skyreader --remote --command "
  SELECT proxy_fresh_pct FROM metrics_snapshots
  WHERE captured_at > (unixepoch() - 30*86400) * 1000 AND proxy_fresh_pct IS NOT NULL
  ORDER BY proxy_fresh_pct
  LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 5 / 100 AS INT) FROM metrics_snapshots
    WHERE captured_at > (unixepoch() - 30*86400) * 1000 AND proxy_fresh_pct IS NOT NULL)"
```

An hour with no snapshot row is absent from both queries rather than counted as a
miss — a collector outage shows up as a **gap in the trend sparklines** (§4b), not
as a freshness breach. If `COUNT(*)` is far below 720, the number above is
answering for less than the window it claims; fix collection before tuning
anything against it.

Freshness alert thresholds are **looser than their SLOs on purpose**: the
firehose SLO is 5 minutes and its warning fires at 15. Availability alerts are
deliberately budget-agnostic and fire on a short current outage instead of waiting
for the 30-day error budget to be exhausted. Cron's 5-minute grace matches its
liveness boundary; tune both together if normal scheduling jitter approaches it.
Read the trend sparklines monthly to see whether you're drifting.

Where a number can't be measured yet, say so rather than inventing it: **API
availability and cron liveness live in the uptime vendor's own history**, which
means neither is queryable from here until the checks in §2 exist.

---

## 8. Alert policy

**Silence means healthy.** That's only trustworthy if silence is rare to break
falsely, which is the whole point of the two rules below.

**What earns a push notification.** An alert may page a phone only if it is
outage-class — users are affected right now, or will be within minutes — _and_
there is something a human can do about it at 3am. Everything currently
configured passes both tests: six uptime checks, two heartbeats, and the
multi-event `preload_recovery_failed` Sentry alert in §2. Everything else is a
thing you find when you look: Sentry issues, ops tiles, trends.

**What does not page.** Warning-level conditions (`firehose_lag_high` is a Sentry
message, not a phone call), individual client errors, feeds failing to parse, a
single 500. If one of these turns out to matter, the fix is usually a better
signal rather than a louder one.

### The pruning pass

Run **2–4 weeks after the checks go live**, then quarterly. It takes ten minutes
and it is the only thing keeping this system honest:

1. List every alert that fired since the last pass.
2. For each: did it require action? If no — delete it, loosen its threshold, or
   downgrade it from push to email. Do this on the _first_ false page, not the
   third; that's the point at which you start ignoring the channel.
3. For each incident **not** caught by an alert: what would have caught it, and is
   that worth the noise it would add? Sometimes the honest answer is no.
4. Note the outcome in this file (below), so the next pass starts from the last
   decision rather than from memory.

An alert deleted for firing falsely is a success of this process, not a
regression. The steady state to protect is a quiet phone that you still trust.

### Pruning log

| Date        | Change                                                                                                  | Why                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-03  | `proxy-document-cache-frozen`: threshold `frozen > 0` → 3 authors or 25% of active; re-alert 30m → 24h. | One stuck author fired 93 events over two days with no action available. Root cause fixed in the proxy the same day (the re-list floor was only checked on the firehose-covered path). |
| _(pending)_ | First pass due 2–4 weeks after the §2 checks are configured.                                            | —                                                                                                                                                                                      |
