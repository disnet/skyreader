# Polar billing setup

Polar (merchant of record) powers the paid **Supporter** tier. Checkout and
webhook handling live in the backend Worker; entitlements are the existing
`users.tier` system. **This integration points at Polar's LIVE production
environment** (org `disnetdev-llc`) — every checkout without a discount code is
a real charge.

## How it works

- `POST /api/billing/checkout` (authed) creates a Polar hosted checkout for
  `POLAR_PRODUCT_ID` (override with `?products=<id>`), setting
  `external_customer_id` to the user's DID, and returns `{ url }`. The Settings
  Plan card's Upgrade button navigates there.
- `POST /api/webhook/polar` (signature-verified, no session) receives
  `order.paid` and `customer.state_changed` and writes `users.tier` +
  `users.tier_source` + `users.polar_customer_id`. Signature verification is
  hand-rolled on `crypto.subtle` (`src/services/polar.ts`) because the SDK's
  `validateEvent` needs the `nodejs_compat` flag this Worker deliberately
  doesn't run.
- Downgrade safety: an "empty" customer state only downgrades rows with
  `tier_source='polar_subscription'`. Admin-granted (`'admin'` via the admin
  app), one-time-purchase (`'polar_order'`), and legacy `NULL` supporters are
  never auto-downgraded. See `backend/migrations/0073_polar_billing.sql`.
- There is no in-app billing management: **Polar hosts the customer portal and
  emails customers the link** — no app code needed. There's also no
  `success_url`; Polar shows its own confirmation, and the Settings page
  refreshes the tier on mount/focus when the user comes back.

## Provisioned resources (production)

- Product: **Skyreader Pro**, $10/month recurring —
  `b1be3773-3cd5-4fa3-b3c4-2471e492e7d9`
- Webhook endpoint: `https://api.skyreader.app/api/webhook/polar`
  (`d3a7904a-93d9-4c2c-bd4b-dc114ac6da1c`), format `raw`, events `order.paid`,
  `customer.state_changed`
- Dashboard: https://polar.sh/dashboard/disnetdev-llc

## Env keys (names only — values in `.dev.vars` locally, `wrangler secret put` in prod)

| Key                    | Where                        | Meaning                                        |
| ---------------------- | ---------------------------- | ---------------------------------------------- |
| `POLAR_ACCESS_TOKEN`   | secret                       | Org token (products/checkouts/webhooks, r+w)   |
| `POLAR_WEBHOOK_SECRET` | secret                       | Signing secret from the webhook endpoint       |
| `POLAR_SERVER`         | `[vars]` (`"production"`)    | Polar environment                              |
| `POLAR_PRODUCT_ID`     | `[vars]`                     | Default checkout product (Skyreader Pro)       |

Unset/empty = billing off: checkout answers 503, the webhook fails closed.

## Files created / changed

- `backend/migrations/0073_polar_billing.sql` — `users.tier_source`,
  `users.polar_customer_id` (+ index)
- `backend/src/services/polar.ts` — SDK client + webhook signature verification
- `backend/src/services/polar-entitlements.ts` — idempotent tier writes
- `backend/src/routes/billing.ts` — checkout + webhook handlers
- `backend/src/index.ts` — webhook mounted pre-session (telemetry precedent);
  checkout in the main switch
- `backend/wrangler.toml`, `backend/src/env.d.ts`, `backend/vitest.config.mts` —
  env plumbing (staging vars duplicated — named envs inherit nothing)
- `backend/test/polar-webhook.spec.ts`, `backend/test/polar-checkout.spec.ts`,
  `backend/test/helpers/polar-webhook.ts`
- `admin/src/lib/queries/users.ts` — admin tier changes stamp
  `tier_source='admin'`
- `frontend/src/lib/services/api.ts` — `createCheckout()`
- `frontend/src/routes/settings/+page.svelte` — Upgrade button on the Plan
  card; tier refresh on mount/focus
- `frontend/src/lib/components/ImportOPMLModal.svelte`,
  `frontend/src/lib/components/sidebar/FeedAddCompact.svelte` — sponsor links
  now point at `/settings`

## Verify before merging / after deploy

- [ ] `cd backend && npm run check && npm test` (includes the 21 Polar specs)
- [ ] `cd frontend && npm run check`
- [ ] Prod secrets set: `wrangler secret put POLAR_ACCESS_TOKEN` and
      `POLAR_WEBHOOK_SECRET` (from `backend/`)
- [ ] Deploy applies migration 0073 (CI runs `d1 migrations apply` before deploy)
- [ ] `curl -X POST https://api.skyreader.app/api/webhook/polar` → **403**
      (proves the route is live and fails closed on signature)
- [ ] End-to-end: create a **100% discount** in the Polar dashboard first
      (Products → Discounts; the token lacks the discounts scope). Note: on a
      recurring product a `once`-duration discount still starts a real
      subscription that bills next month — cancel it from the Polar dashboard
      after the test, or use duration `forever` and cancel anyway.
- [ ] Log in → Settings → Upgrade → complete checkout with the code → return
      to Settings → plan flips to Supporter (focus refresh); D1 row shows
      `tier_source='polar_subscription'`.

## Caveats

- **Staging**: shares the production Polar org but has no webhook endpoint and
  no secrets set, so staging checkout answers 503 and staging tiers never flip.
  Acceptable for now; register a second endpoint at
  `https://api-staging.skyreader.app/api/webhook/polar` (+ staging secrets) if
  staging billing is ever needed.
- Webhook deliveries 404 until the backend deploy that includes
  `/api/webhook/polar` ships; Polar retries with backoff, and no checkouts can
  exist before the Upgrade button ships anyway.
