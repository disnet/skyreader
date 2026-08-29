import type { Env } from '../types';

/**
 * D1 writes behind the Polar webhook (see routes/billing.ts for the event
 * mapping). Every write sets an absolute tier value, so webhook redelivery and
 * out-of-order events are naturally idempotent — no dedup table needed.
 *
 * tier_source semantics (migration 0073): upgrades are unconditional (a payment
 * beats any prior source), but downgrades only ever touch rows the subscription
 * path itself upgraded ('polar_subscription'). 'admin', 'polar_order', and NULL
 * (legacy/manual grants) are never auto-downgraded.
 */

/** order.paid: one-time purchase. Returns false when no user row matched the DID. */
export async function grantSupporterFromOrder(
  env: Env,
  did: string,
  polarCustomerId: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE users SET tier = 'supporter', tier_source = 'polar_order', polar_customer_id = ?, updated_at = unixepoch() WHERE did = ?"
  )
    .bind(polarCustomerId, did)
    .run();
  return result.meta.changes > 0;
}

/** customer.state_changed with an active subscription or granted benefit. */
export async function grantSupporterFromSubscription(
  env: Env,
  did: string,
  polarCustomerId: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE users SET tier = 'supporter', tier_source = 'polar_subscription', polar_customer_id = ?, updated_at = unixepoch() WHERE did = ?"
  )
    .bind(polarCustomerId, did)
    .run();
  return result.meta.changes > 0;
}

/**
 * order.paid with the marketing checkbox ticked (migration 0074). The email is
 * refreshed on every consenting order (subscription cycles redeliver the
 * original checkout's custom_field_data), but the consent timestamp keeps its
 * first value — it is the GDPR consent record, not a last-seen marker. A
 * cleared row (future unsubscribe flow) re-consents naturally: the COALESCE
 * finds NULL and stamps a fresh time.
 */
export async function recordMarketingConsent(env: Env, did: string, email: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET marketing_email = ?, marketing_email_consent_at = COALESCE(marketing_email_consent_at, unixepoch()), updated_at = unixepoch() WHERE did = ?'
  )
    .bind(email, did)
    .run();
}

/**
 * customer.state_changed with no active subscriptions and no granted benefits.
 * Downgrades only rows the subscription path upgraded; still stamps the Polar
 * customer id on the row either way so the linkage survives.
 */
export async function reconcileEmptyCustomerState(
  env: Env,
  did: string,
  polarCustomerId: string
): Promise<void> {
  await env.DB.prepare(
    "UPDATE users SET tier = 'free', updated_at = unixepoch() WHERE did = ? AND tier_source = 'polar_subscription'"
  )
    .bind(did)
    .run();
  await env.DB.prepare('UPDATE users SET polar_customer_id = ? WHERE did = ?')
    .bind(polarCustomerId, did)
    .run();
}
