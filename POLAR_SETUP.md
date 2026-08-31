# Polar billing setup

Polar (merchant of record) powers the paid **Supporter** tier. Checkout and
webhook handling live in the backend Worker; entitlements are the existing
`users.tier` system. Each deploy environment points at its own Polar org:
**production runs against Polar LIVE** (org `disnetdev-llc`), where every
checkout without a discount code is a real charge, and **staging runs against a
separate sandbox org** where nothing is. The switch is `POLAR_SERVER` per
environment; there is no shared state between the two.

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
- Grandfathered supporters: `users.granted_tier`
  (`backend/migrations/0075_granted_tier.sql`) records the tier a user keeps for
  free no matter what Polar says. It was backfilled for every non-free tier that
  Polar didn't pay for, the admin app keeps it in step with hand-set tiers, and
  the empty-state downgrade lands on it instead of `'free'` — so an early
  supporter who chooses to start paying and later cancels returns to their
  grant. `/api/auth/me` ships `tierSource` + `grantedTier` so the client can
  tell a paid plan from a grant: a granted supporter has no Polar customer (the
  billing portal 404s for them), is told their access is theirs to keep, and is
  offered a paid plan only as an explicit option.
- There is no in-app billing management: **Polar hosts the customer portal and
  emails customers the link** — no app code needed. There's also no
  `success_url`; Polar shows its own confirmation, and the Settings page
  refreshes the tier on mount/focus when the user comes back.

## Provisioned resources (production)

- Webhook endpoint: `https://api.skyreader.app/api/webhook/polar`
  (`d3a7904a-93d9-4c2c-bd4b-dc114ac6da1c`), format `raw`, events `order.paid`,
  `customer.state_changed`
- Dashboard: https://polar.sh/dashboard/disnetdev-llc

## Provisioned resources (staging / sandbox)

Staging talks to a **separate Polar sandbox org**, reached by `POLAR_SERVER =
"sandbox"` in `[env.staging]`. Sandbox is its own account at
https://sandbox.polar.sh, not a mode on the production org: products, customers,
tokens, and webhook endpoints are all distinct, and a production id or token is
meaningless there. Checkouts are play money (test card `4242 4242 4242 4242`),
so unlike production no discount-code dance is needed to exercise the flow.

- Default checkout product: `4f3e636c-8dd5-4af1-af3d-b88e85b104e4`
  (`POLAR_PRODUCT_ID` in `[env.staging]`)
- Webhook endpoint: `https://api-staging.skyreader.app/api/webhook/polar`,
  format `raw`, events `order.paid`, `customer.state_changed`
- Secrets: `POLAR_ACCESS_TOKEN` / `POLAR_WEBHOOK_SECRET`, set per environment
  with `wrangler secret put <NAME> --env staging` (a named environment shares
  nothing with production, secrets included)

The sandbox products have to **mirror the production catalog's shape**, because
the UI derives everything from `GET /api/billing/products`:

- Only non-archived products with a fixed price and a `month`/`year` recurring
  interval survive the filter in `routes/billing.ts` — anything else is
  invisible to the app.
- One product's name must match `/believer/i`: that regex is how
  `routes/supporter/+page.svelte` splits patronage out of the supporter plans,
  and how the Settings plan card names the tier back from the live subscription.
- Each supporter product needs the `marketing_opt_in` checkbox custom field
  (unticked by default). The slug is matched exactly; a rename silently stops
  consent capture with no error.
- A second, cheaper annual supporter product is optional — it's what exercises
  the founding-price compare-at path.

## Env keys (names only — values in `.dev.vars` locally, `wrangler secret put` in prod)

| Key                    | Where                                               | Meaning                                      |
| ---------------------- | --------------------------------------------------- | -------------------------------------------- |
| `POLAR_ACCESS_TOKEN`   | secret                                              | Org token (products/checkouts/webhooks, r+w) |
| `POLAR_WEBHOOK_SECRET` | secret                                              | Signing secret from the webhook endpoint     |
| `POLAR_SERVER`         | `[vars]` (prod `"production"`, staging `"sandbox"`) | Polar environment                            |
| `POLAR_PRODUCT_ID`     | `[vars]`, per environment                           | Default checkout product for that org        |

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
- `backend/migrations/0075_granted_tier.sql` — `users.granted_tier`, the
  free-forever floor behind an early supporter's tier
- `backend/src/services/user-tier.ts` — `getUserTierInfo()` (tier + source +
  grant), served by `/api/auth/me`
- `admin/src/lib/queries/users.ts` — admin tier changes stamp
  `tier_source='admin'` and maintain `granted_tier`; the user detail page shows
  both
- `frontend/src/lib/utils/tier.ts` — paid vs granted, the one place that
  distinction is defined for the UI
- `frontend/src/routes/supporter/+page.svelte` — three states: paid (billing
  portal), granted (thank-you plus an optional paid plan), free (the pitch)
- `frontend/src/lib/services/api.ts` — `createCheckout()`
- `frontend/src/routes/settings/+page.svelte` — Upgrade button on the Plan
  card; tier refresh on mount/focus
- `frontend/src/lib/components/LimitNotice.svelte`,
  `frontend/src/lib/utils/limitCopy.ts` — the shared limit notice and its copy;
  every limit-hit surface routes to `/supporter` through them
  (`sidebar/FeedAddCompact.svelte` and `sidebar/SidebarAddFeed.svelte` were
  deleted here: both were unreferenced, and held the only `/settings` upsells)

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

## Verify staging against the sandbox org

- [ ] `[env.staging]` `POLAR_SERVER = "sandbox"` and `POLAR_PRODUCT_ID` is a
      sandbox id
- [ ] `wrangler secret put POLAR_ACCESS_TOKEN --env staging` and
      `POLAR_WEBHOOK_SECRET --env staging` (from `backend/`)
- [ ] `curl -X POST https://api-staging.skyreader.app/api/webhook/polar` →
      **403**. A **500** means the webhook secret didn't land — the handler
      fails closed before it ever verifies a signature.
- [ ] `GET /api/billing/products` (authed, staging) lists the sandbox catalog,
      Believer included
- [ ] Log in on staging → `/supporter` → checkout with `4242 4242 4242 4242` →
      staging D1 row shows `tier = 'supporter'`,
      `tier_source = 'polar_subscription'`
- [ ] Cancel the subscription in the sandbox dashboard → `customer.state_changed`
      with an empty state → the row reconciles back to `free`

## Caveats

- **Staging** runs against its own sandbox org (above). The failure mode to know:
  a production product id left in `[env.staging]` under a sandbox token names a
  product that exists nowhere, and surfaces only as an opaque 502 from
  `/api/billing/checkout`. Same for the reverse. Ids and tokens must never cross
  environments.
- Webhook deliveries 404 until the backend deploy that includes
  `/api/webhook/polar` ships; Polar retries with backoff, and no checkouts can
  exist before the Upgrade button ships anyway.
