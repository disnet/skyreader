# Check for AI (Pangram)

An on-demand "Check for AI" action in the reader, backed by [Pangram](https://docs.pangram.com/api-reference/ai-detection).
Supporters only, rate limited, never automatic.

## Scope

- **Supporters only.** Free readers never see the action. Gate on `users.tier` server-side; the
  client hides the button off the same `tier` it already gets on the auth user
  (`frontend/src/lib/types/index.ts`).
- **Only in the full reader.** `SavedReader.svelte` is the one full-screen reader for saved and
  feed items alike, so one entry point covers both. Nothing in lists, cards, Home, or the magazine.
- **Only when asked.** The reader taps "Check for AI" in the reader's overflow menu
  (`ReaderChrome.svelte`). We never score at ingest, on open, or in the background.
- **Rate limited twice.** A monthly quota per user (the cost control) and a per-minute burst limit
  (abuse control).

## Why it's shaped like this

Pangram charges $0.05 per 100 words, so a 1,500-word article costs about $0.75. A supporter who
checks everything could cost more than their subscription. The monthly quota is the hard ceiling,
and we trim long text before sending it (see below) so each check stays cheap.

The verdict is also a judgment about someone else's writing, and detectors get it wrong
sometimes. PRODUCT.md asks for calm and quiet, so the result is something the reader asks for and
sees privately. It is never a label we put on an article or show anyone else.

## Backend

### Route: `POST /api/ai-check`

Request: `{ url: string, text: string }`. The client sends the plain text it is already rendering.
That covers extracted, R2-backed, and extension-captured bodies without re-deriving them on the
server.

1. Require a session, and require `tier === 'supporter'` via `getUserTier`
   (`backend/src/services/user-tier.ts`). Otherwise return `403 { error: 'supporters_only' }`.
2. Return 503 when `PANGRAM_API_KEY` is unset, so the feature is off wherever the secret isn't
   set (the same convention as `POLAR_ACCESS_TOKEN`).
3. Normalize the text (collapse whitespace), count words, and apply the length limits:
   - Under **150 words**: `422 { error: 'too_short' }`. Detectors are unreliable on short text,
     and a confident-looking verdict on a stub would mislead.
   - Over **~1,500 words**: send only the first 1,500. This keeps a check at about $0.75
     worst case. Record `truncated: true` so the UI can say "based on the first ~1,500 words".
4. **Cache lookup.** Key on `sha256(normalized text)`, not on the URL alone. If a client could
   write the verdict for a URL, it could poison that URL for everyone, but it can't fake a verdict
   for text it didn't send. A hit returns immediately and **does not use up quota**.
5. **Quota check** (miss only): count this month's rows in `ai_checks` for the DID and compare
   against `maxAiChecksPerMonth`. This mirrors the URL-save limit at `routes/saved.ts:178`.
   If exhausted: `429 { error: 'ai_check_limit_reached', limit, current, resetsAt }`.
6. **Call Pangram.** `POST https://text.external-api.pangram.com/task` with header `x-api-key`,
   then poll `GET /task/{id}` (~1s interval, ~20s budget) until `STAGE_SUCCESS` / `STAGE_FAILED`.
   If the budget runs out, return `202 { taskId }` and let the client re-poll
   `GET /api/ai-check/:taskId`. Don't hold the Worker open.
7. Store the result and the usage row, then return it.

Only a successful result uses up quota; a failed or timed-out Pangram call doesn't.

### Burst limit

Add `'/api/ai-check': { limit: 5, windowMs: 60000 }` to `RATE_LIMITS` in
`backend/src/services/rate-limit.ts`. This is separate from the monthly quota: it stops a stuck
client or script from spending a month's quota in a minute.

### Tier limits

Add `maxAiChecksPerMonth` to `TierLimits` in `backend/src/config/tier-limits.ts`: `free: 0`,
`supporter: 30` (tunable). With the 1,500-word cap, 30 checks is at most about $22 a month per
supporter, and far less in practice.

### Migration

```sql
-- Verdict cache, keyed by the exact text scored. Shared across users.
CREATE TABLE ai_check_results (
  text_hash     TEXT PRIMARY KEY,     -- sha256 of normalized, truncated text
  provider      TEXT NOT NULL,        -- 'pangram'
  model_version TEXT,                 -- Pangram's `version`; new models invalidate
  result_json   TEXT NOT NULL,        -- prediction_short, fractions, windows
  word_count    INTEGER NOT NULL,
  truncated     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- Usage ledger: one row per paid check (cache misses only). Drives the quota.
CREATE TABLE ai_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_did   TEXT NOT NULL,
  url        TEXT,
  text_hash  TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_checks_user_month ON ai_checks (user_did, created_at);
```

Keep `ai_checks.word_count` so the admin dashboard can show real spend later.

### Provider interface

Put Pangram behind a small `AiDetector` interface in `backend/src/services/ai-detect/`: text in;
`{ verdict: 'ai' | 'mixed' | 'human', fractionAi, fractionAiAssisted, fractionHuman, segments:
{ start, end, label, confidence }[], modelVersion }` out. Only `pangram.ts` knows Pangram's field
names, so switching to GPTZero or Originality.ai later is one new file plus a config value.

## Frontend

- **Entry point:** a "Check for AI" item in the reader's overflow menu, shown only when
  `auth.user.tier === 'supporter'`. Not in the toolbar; this is an occasional action.
- **While checking:** the item shows a quiet inline spinner. The reader keeps reading.
- **Result:** a small neutral line in `.reader-meta` (`SavedReader.svelte:1262`), after
  "N min read": _Likely human-written_, _Mixed: some AI-assisted passages_, or
  _Likely AI-generated_. Tapping it opens a small popover with the fractions,
  "based on the first ~1,500 words" when truncated, which checks are left this month, and one line
  saying detectors can be wrong. No red, no warning icons. It uses the muted meta color and
  follows DESIGN.md ("One Blue", flat).
- **Segments (optional, later):** the `windows` character offsets could tint AI-flagged paragraphs
  the way highlights do. Leave it out of v1; the offsets are against our normalized text and
  mapping them back to rendered DOM is its own job.
- **Remember locally:** cache the verdict per item in IndexedDB, so reopening the article shows it
  without another request. The server cache makes a repeat request free anyway.
- **Errors:** `too_short` becomes "Too short to check"; `ai_check_limit_reached` becomes "You've
  used this month's checks. Resets {date}."; other failures become "Couldn't check right now".

## Privacy & copy

- Checking sends the article text to Pangram. Say so in the popover the first time ("Text is sent
  to Pangram to check"), and in the docs page.
- The verdict is private to the reader who asked. It is never shown on cards, linkblogs, shares,
  or the Atmosphere.
- Before shipping, confirm Pangram's data-retention terms for API submissions, and turn off
  training or retention if they offer that. The API reference doesn't state a policy.
- Docs: add a short section to the reader docs page in `docs-site/` in the same PR (per CLAUDE.md).

## Rollout

1. Buy a Pangram developer key; set `PANGRAM_API_KEY` on staging only.
2. Ship backend + frontend; test with hand-granted supporter accounts on staging.
3. Watch `ai_checks` volume and word counts for a couple of weeks, then tune
   `maxAiChecksPerMonth` and the truncation cap.
4. Set the production secret.

## Out of scope

- Any automatic or background scoring, or badges on feed cards.
- Publishing verdicts as Atmosphere labels.
- A free tier allowance.
- Self-hosted detectors.
