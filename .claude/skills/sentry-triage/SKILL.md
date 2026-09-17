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

Two projects, one Sentry org:

| Project                | Runtime                       | Reports via                     |
| ---------------------- | ----------------------------- | ------------------------------- |
| `skyreader-backend`    | Cloudflare Worker             | `backend/src/observability/sentry.ts` |
| `skyreader-feed-proxy` | Fly.io (Bun + Hono)           | `feed-proxy/src/instrument.ts`  |

The proxy project may carry a different slug — its DSN was provisioned by
`fly ext sentry create` into a Fly-managed org (RUNBOOK §3 "Sentry account
ownership"). Use `find_projects` to discover the real slugs rather than assuming
these; if only one project exists, say so in the report instead of guessing.

**Filter every query to `environment:production`.** Staging and production share
one project and are separated only by the `SENTRY_ENVIRONMENT` tag. Staging noise
is not an incident. If a staging issue looks genuinely alarming, mention it in one
line and move on — never open a PR for it.

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

| `source`           | What it is                        | Runbook            |
| ------------------ | --------------------------------- | ------------------ |
| `fetch`            | An HTTP request handler threw     | §4a, §4            |
| `route`            | A named route handler threw       | §4a                |
| `cron`             | A scheduled run failed (has `phase`) | §4 `backend-cron`  |
| `jetstream-poller` | The firehose DO alarm             | §4 `jetstream_alarm_stuck` |
| `warmer`           | Feed proxy warm loop              | §4 `proxy-warmer`  |
| `ingest-push`      | Proxy → backend ingest push       | §4d                |
| `client`           | Browser error via `/api/telemetry/error` | §4 `source: client` |

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

| Question                     | Workers Logs filter                            |
| ---------------------------- | ---------------------------------------------- |
| Everything about one failure | `requestId = <id from Sentry>`                 |
| Error rate on one endpoint   | `event = request AND route = <route>`          |
| What failed inside a cron    | `event = cron_phase_failed` → `phase`          |

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
  real outcome, not a cop-out: §8 says make that call on the *first* false page.

Read the runbook section before classifying. Several of these errors are
**documented expected behavior** under specific conditions — `firehose_lag_high`
is a message and not an exception on purpose, `documents_cap_saturated` has a
tuned threshold with a history in the pruning log. Do not "fix" a deliberate
design decision.

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
