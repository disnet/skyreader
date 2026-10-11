# REVIEW.md

Repo-specific rules for code review (human, `/code-review`, or the PR review routine). Each
rule distills guidance already in the root and package `CLAUDE.md` files — read those for the
why. A broken **must** is blocking; everything else is a judgment call.

Review for correctness first (bugs, security, data loss, deploy hazards, offline/sync
regressions). Don't flag formatting or lint-level style — CI catches it.

## Backend (Workers + D1)

- **Auth and scoping (must):** every new route checks the session, and every query touching
  user data is scoped to the caller's DID — no cross-user reads or writes.
- **Internal endpoints (must):** `/api/internal/*` stays fail-closed when `FEED_PROXY_SECRET` is
  unset.
- **Migrations (must):** new files are numbered sequentially and are compatible with the Worker
  version currently deployed (migrations run before the new code ships). New query patterns get
  an index.
- **Secrets (must):** tokens, secrets, and session IDs never reach logs or Sentry.

## AT Protocol

- Lexicon changes stay backwards compatible; record keys are TIDs.
- `pds_sync_enabled` governs subscriptions (plus the standard.site follow-graph mirror) only.
- **Must:** nothing writes saves to the PDS — saves live in D1 (optionally a Semble/Margin
  collection via external backing).

## Frontend

- State uses Svelte 5 rune stores in `.svelte.ts` files, not writable stores.
- A Dexie schema change bumps the version and migrates existing data; offline writes go through
  the sync queue.
- Service worker / precache changes come with `npm run test:pwa` coverage.

## Design and copy

- One Blue: `#0066cc` is the only interaction blue. New `#2563eb` / `#3b82f6` / `#0085ff` is
  drift.
- Flat by default: shadows only on overlapping/floating elements. One system-sans UI typeface;
  true-white body.
- Copy uses the Atmosphere framing. Copy about Atmospheric sync names the public-visibility
  tradeoff. Copy never says saves live on the PDS.

## Docs, CI, operations

- A user-visible behavior change updates its `docs-site/` page in the same PR.
- **Must:** a new PR-check workflow triggers on `merge_group` and uses concurrency group
  `${{ github.head_ref || github.ref }}`, or the merge queue stalls.
- E2E tests never depend on another test having run first (the suite is sharded).
- Changes under `backend/src/observability/`, the health/telemetry routes,
  `frontend/src/lib/services/telemetry.ts`, or a deploy smoke check update `docs/RUNBOOK.md`.

## Known false positives

Add a line here whenever a reviewer keeps flagging something that's intentional.
