-- Polar billing: record where users.tier came from, and the Polar customer id.
--
-- tier_source disambiguates who last set users.tier so the Polar webhook can
-- reconcile without clobbering grants it doesn't own:
--   'admin'              - set from the admin app (shielded from webhook downgrades)
--   'polar_order'        - one-time purchase via the order.paid webhook
--   'polar_subscription' - active subscription via the customer.state_changed webhook
--   NULL                 - legacy rows (pre-Polar; treated like 'admin', never auto-downgraded)
--
-- Why order and subscription are distinct sources: customer.state_changed carries
-- only active subscriptions + granted benefits, so it cannot see one-time
-- purchases. An "empty state" downgrade must therefore only apply to rows the
-- subscription path upgraded, or the first state_changed after an order.paid
-- (e.g. the customer edits their email) would strip a paying user's tier.
ALTER TABLE users ADD COLUMN tier_source TEXT;
ALTER TABLE users ADD COLUMN polar_customer_id TEXT;

-- Look up users by Polar customer id (webhook tracing, admin)
CREATE INDEX IF NOT EXISTS idx_users_polar_customer ON users(polar_customer_id);
