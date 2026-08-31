-- Marketing email opt-in, captured from Polar checkout (see routes/billing.ts).
--
-- The Polar checkout carries a checkbox custom field (slug 'marketing_opt_in',
-- attached to the supporter products in the Polar dashboard). Only when that
-- box was ticked does the order.paid webhook copy the buyer's email here —
-- the billing email itself stays with Polar (data minimization: we hold an
-- address only when we may use it).
--
-- marketing_email_consent_at is the consent record (GDPR): when the user first
-- opted in. Later orders refresh the email but keep the original timestamp;
-- a future unsubscribe flow clears both columns.
ALTER TABLE users ADD COLUMN marketing_email TEXT;
ALTER TABLE users ADD COLUMN marketing_email_consent_at INTEGER;
