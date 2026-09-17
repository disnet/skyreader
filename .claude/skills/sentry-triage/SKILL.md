---
name: sentry-triage
description: Triage production Sentry errors for Skyreader and propose fixes. Use when asked to check Sentry, triage errors, review the error stream, or investigate a production exception in the backend Worker or feed proxy.
---

# Sentry triage

Read the production error stream, decide what actually needs action, and fix what
you can root-cause with confidence. [`docs/RUNBOOK.md`](../../../docs/RUNBOOK.md)
is the source of truth for what each signal means — this skill is the procedure
for working through them, not a replacement for it.

The bar is the runbook's own: **silence means healthy** (§8). Most issues in the
stream are things you find when you look, not things that need a change. A pass
that reports "nothing needs action" is a good pass. Do not manufacture work.

## Scope

Org slug: **`tim-disney`** (region `https://us.sentry.io`). Two live projects:

| Project                | Runtime             | Reports via                           |
| ---------------------- | ------------------- | ------------------------------------- |
| `skyreader-backend`    | Cloudflare Worker   | `backend/src/observability/sentry.ts` |
| `skyreader-feed-proxy` | Fly.io (Bun + Hono) | `feed-proxy/src/instrument.ts`        |

A third project, `weathered-wind-8393`, is the leftover artifact of
`fly ext sentry create` and has never received an event. Ignore it. (RUNBOOK §3
"Sentry account ownership" still describes the pre-migration state where the proxy
reported into a Fly-managed org; both projects now live in `tim-disney`.)

The proxy is **much quieter than the backend** — single-digit issues against the
backend's hundreds of events. That is a real asymmetry, not a broken DSN, but if
the proxy shows _zero_ events over a window where the backend is busy, check that
`SENTRY_DSN` is still set on the Fly app before concluding it is healthy.

**Filter every query to `environment:production`.** Staging and production share
one project and are separated only by the `SENTRY_ENVIRONMENT` tag. Staging noise
is not an incident. If a staging issue looks genuinely alarming, mention it in one
line and move on — never open a PR for it.

## Tools

| Need                        | Tool                                    |
| --------------------------- | --------------------------------------- |
| Confirm org / project slugs | `find_organizations`, `find_projects`   |
| The issue list              | `search_issues` (grouped issues)        |
| One issue in depth          | `get_sentry_resource` (issue id or URL) |
| Counts, rates, time series  | `search_events`                         |
| Root cause you can't derive | `analyze_issue_with_seer`               |

`search_issues` returns grouped issues; `search_events` returns individual events
and aggregations. Reaching for the wrong one is the usual way to get a confusing
answer. Reach for `analyze_issue_with_seer` only when the stack trace and the code
genuinely do not explain the failure — it takes minutes, and on a well-instrumented
path the issue detail is usually enough.

`update_issue` exists and can resolve, ignore, or assign. **Do not use it.**
Deciding an issue is closed is the operator's call, not the triage pass's; say what
you would resolve and let a human click it.

## Procedure

### 1. Pull the window

Unresolved production issues first seen or last seen in the window, both projects,
ordered by event count. Separate **new** (first seen inside the window) from
**recurring** (first seen earlier, still firing) — the distinction drives
everything downstream.

Ignore issues already marked resolved or ignored in Sentry. Someone made that call
deliberately; re-litigating it is exactly the noise §8 is trying to kill.

### 2. Classify by `source`

Every backend event carries a `source` tag. It tells you which entry point failed,
and the runbook has a section per failure mode:

| `source`           | What it is                               | Runbook                    |
| ------------------ | ---------------------------------------- | -------------------------- |
| `fetch`            | An HTTP request handler threw            | §4a, §4                    |
| `route`            | A named route handler threw              | §4a                        |
| `cron`             | A scheduled run failed (has `phase`)     | §4 `backend-cron`          |
| `jetstream-poller` | The firehose DO alarm                    | §4 `jetstream_alarm_stuck` |
| `warmer`           | Feed proxy warm loop                     | §4 `proxy-warmer`          |
| `ingest-push`      | Proxy → backend ingest push              | §4d                        |
| `client`           | Browser error via `/api/telemetry/error` | §4 `source: client`        |

`client` events deserve special suspicion: they arrive through a **deliberately
public, forgeable endpoint**. Stack frames come from a minified bundle, so the
message and path are the useful parts. Never open a PR off a single `client`
event — look for a cluster sharing a `kind` and `appVersion`.

### 3. Correlate with deploys

Backend and proxy events carry `release` = `GIT_COMMIT_SHA`. For anything new:

```bash
git log --oneline -15 <release-sha>      # what shipped
git log --oneline <previous-release>..<release-sha>
```

A new issue whose every event carries one release, where the previous release is
clean, is a regression from that deploy — the strongest signal available. Name the
commit in the report.

### 4. Get the request context

Backend events carry a `requestId` tag, and a `did` when authenticated. That id
threads Sentry to Workers Logs (§4a):

| Question                     | Workers Logs filter                   |
| ---------------------------- | ------------------------------------- |
| Everything about one failure | `requestId = <id from Sentry>`        |
| Error rate on one endpoint   | `event = request AND route = <route>` |
| What failed inside a cron    | `event = cron_phase_failed` → `phase` |

You can't query Workers Logs from a headless session. Put the exact filter in the
report so a human can paste it.

### 5. Decide, per issue

Sort each issue into exactly one bucket:

- **Fix now** — root cause visible in this repo, the change is small and local, and
  a test can prove it. Goes on a branch (below).
- **Needs a human** — real, but the fix is architectural, ambiguous, spans an
  external service, or would widen well past the error. Report it with your
  diagnosis and a proposed direction. Do not push.
- **Infrastructure / upstream** — a PDS timing out, a feed host 503ing, Cloudflare.
  Report the rate; a code change is usually the wrong lever.
- **Alert-policy noise** — firing without anything actionable behind it. Say so,
  and name the §8 pruning action (delete, loosen, downgrade push→email). This is a
  real outcome, not a cop-out: §8 says make that call on the _first_ false page.

Read the runbook section before classifying. Several of these errors are
**documented expected behavior** under specific conditions — `firehose_lag_high`
is a message and not an exception on purpose, `documents_cap_saturated` has a
tuned threshold with a history in the pruning log. Do not "fix" a deliberate
design decision.

## Standing state (baseline as of 2026-09-17)

The production stream already carries long-running issues. They are listed so a
daily pass does not re-diagnose them from scratch every morning — **not** so it
skips them. Treat a jump in rate, or a reappearance after quiet, as new.

| Issue                                               | Shape                          | Read                                                                                            |
| --------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `TimeoutError` in `recordProxyStats`                | ~528 events / 29d, the loudest | Cron's proxy-stats fetch timing out. RUNBOOK §4d. Not user-facing.                              |
| `preload_recovery_failed` (client)                  | ~44 events / 12d               | The **only** condition wired to page (§2). A rate change here matters.                          |
| `D1_ERROR: D1 DB is overloaded`                     | Several groupings, same cause  | Cloudflare-side saturation. Infrastructure bucket unless it correlates with a deploy.           |
| `JetstreamPoller alarm overdue by Ns; re-armed`     | ~20 events / 6d                | The 2026-09-10 pruning-log fix _working_ — it re-arms and reports. Self-healing, not an outage. |
| `Actively read document authors past re-list floor` | ~115 events / 16d              | The threshold tuned on 2026-09-03 (pruning log). Check the log before touching it.              |
| `unread counts diverged on N/M feeds` (client)      | Recurring, low volume          | Client-reported divergence. Forgeable endpoint — needs a cluster, not one event.                |

The bottom four are **documented, deliberate behavior with history in the §8
pruning log**. Do not "fix" them. If one is firing without action available, the
correct output is a pruning recommendation, not a patch.

## Proposing fixes

Only for the **Fix now** bucket, and only when you can state the failure in one
sentence: these inputs, in this code path, produce this exception.

Ground rules:

- **One branch per pass**, `claude/sentry-triage-<YYYY-MM-DD>`, cut fresh from
  `origin/main`. Multiple unrelated fixes get separate commits on it; say so in the
  PR body so a reviewer can split it if they want.
- **Add a regression test that fails before the fix.** A Sentry-driven fix without
  a test is a guess. Backend: `backend/test/`. Proxy: `feed-proxy/`. If you cannot
  write a test that reproduces it, the issue belongs in **Needs a human** —
  demote it rather than pushing untested speculation.
- **Keep it minimal.** Fix the exception, not the surrounding code. Refactors,
  drive-by cleanups, and adjacent improvements are what makes a triage PR
  unreviewable.
- **Run the checks** before pushing: backend `npm run test`, frontend
  `npm run check`, plus whatever the touched package defines. A triage PR that
  breaks CI costs more than the error did.
- **Never suppress.** Swallowing an exception, widening a `catch`, lowering a log
  level, or skipping a test to make the stream quiet is out of bounds. If the
  honest answer is "this error is fine and should stop being reported", that is a
  **reporting** change with a comment explaining why — and it is a **Needs a
  human** call, not a unilateral one.
- **Respect the scrubbers.** `backend/src/observability/scrub.ts` and
  `feed-proxy/src/scrub.ts` decide what may leave the process. Never widen what
  gets attached to an event to make debugging easier; never paste a raw session
  id, OAuth state, token, or request body into a PR, issue, or report. A DID is
  public and fine. See the comments in `sentry.ts` for why the Console
  integration is off — the same reasoning applies to anything you add.

Open the PR as a draft, titled `Sentry triage: <the failure>`. Body: the Sentry
issue link, event count and window, `source` and `release`, the root cause in a
few sentences, what the test proves, and explicitly what you did **not** change.

## The report

Lead with the verdict, because most days it is "nothing needs action":

1. **One line up top** — quiet, or N issues needing attention.
2. **New this window** — each with source, count, release, verdict, and a link.
3. **Recurring** — only those that got worse or crossed a threshold. A flat-rate
   known issue gets one line, not a paragraph.
4. **Pushed** — branch and PR link, one line each.
5. **Needs you** — the judgment calls, with enough context to decide without
   opening Sentry.
6. **Pruning candidates** — anything firing without action available (§8).

Terse beats thorough. Someone is reading this on a phone before deciding whether
to open a laptop.
