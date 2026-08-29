import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { signWebhook } from './helpers/polar-webhook';

// The Polar webhook is the only writer of Polar-sourced tier state. These pin
// the boundary: signature verification (real standard-webhooks HMAC, not a
// mock), the event -> tier mapping, and — most load-bearing — that an "empty"
// customer.state_changed only ever downgrades rows the subscription path
// itself upgraded. See migrations/0073_polar_billing.sql for why.

const SECRET = 'test-polar-webhook-secret'; // pinned in vitest.config.mts
const DID = 'did:plc:polarwebhooktest';
const CUSTOMER_ID = '11111111-2222-3333-4444-555555555555';

const post = async (body: string, headers: Record<string, string>) =>
  SELF.fetch('http://localhost/api/webhook/polar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });

const signedPost = async (payload: unknown, id = 'msg_test_1') => {
  const body = JSON.stringify(payload);
  return post(body, await signWebhook(body, SECRET, id));
};

const userRow = () =>
  env.DB.prepare('SELECT tier, tier_source, polar_customer_id FROM users WHERE did = ?')
    .bind(DID)
    .first<{ tier: string; tier_source: string | null; polar_customer_id: string | null }>();

const marketingRow = () =>
  env.DB.prepare('SELECT marketing_email, marketing_email_consent_at FROM users WHERE did = ?')
    .bind(DID)
    .first<{ marketing_email: string | null; marketing_email_consent_at: number | null }>();

const seedUser = (tier = 'free', tierSource: string | null = null) =>
  env.DB.prepare(
    `INSERT INTO users (did, handle, pds_url, tier, tier_source, created_at) VALUES (?, 'polar.test', 'https://pds.test', ?, ?, unixepoch())`
  )
    .bind(DID, tier, tierSource)
    .run();

// Wire-format (snake_case) fixtures, shaped like real Polar deliveries — the
// handler reads this JSON directly (runtime-guarded), so the fixtures stay in
// the wire format on purpose.
const NOW = '2026-08-27T12:00:00Z';

const wireCustomer = (externalId: string | null) => ({
  id: CUSTOMER_ID,
  created_at: NOW,
  modified_at: null,
  metadata: {},
  external_id: externalId,
  email: 'reader@example.com',
  email_verified: true,
  type: 'individual',
  name: null,
  billing_name: null,
  billing_address: null,
  tax_id: null,
  organization_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  deleted_at: null,
  avatar_url: null,
});

const orderPaid = (
  externalId: string | null = DID,
  customFieldData: Record<string, unknown> = {}
) => ({
  type: 'order.paid',
  timestamp: NOW,
  data: {
    custom_field_data: customFieldData,
    id: '99999999-8888-7777-6666-555555555555',
    created_at: NOW,
    modified_at: null,
    status: 'paid',
    paid: true,
    subtotal_amount: 1000,
    discount_amount: 0,
    net_amount: 1000,
    tax_amount: 0,
    total_amount: 1000,
    applied_balance_amount: 0,
    due_amount: 0,
    refunded_amount: 0,
    refunded_tax_amount: 0,
    currency: 'usd',
    billing_reason: 'purchase',
    billing_name: null,
    billing_address: null,
    invoice_number: null,
    is_invoice_generated: false,
    receipt_number: null,
    customer_id: CUSTOMER_ID,
    product_id: null,
    discount_id: null,
    subscription_id: null,
    checkout_id: null,
    metadata: {},
    platform_fee_amount: 50,
    platform_fee_currency: 'usd',
    customer: wireCustomer(externalId),
    product: null,
    discount: null,
    subscription: null,
    items: [],
    description: 'Test Product',
    refundable_amount: 1000,
    refundable_tax_amount: 0,
  },
});

const wireSubscription = () => ({
  id: '12121212-3434-5656-7878-909090909090',
  created_at: NOW,
  modified_at: null,
  metadata: {},
  status: 'active',
  amount: 500,
  currency: 'usd',
  recurring_interval: 'month',
  current_period_start: NOW,
  current_period_end: '2026-09-27T12:00:00Z',
  trial_start: null,
  trial_end: null,
  cancel_at_period_end: false,
  canceled_at: null,
  started_at: NOW,
  ends_at: null,
  product_id: 'abcdabcd-abcd-abcd-abcd-abcdabcdabcd',
  discount_id: null,
  meters: [],
});

const customerState = (
  externalId: string | null = DID,
  activeSubscriptions: unknown[] = [],
  grantedBenefits: unknown[] = []
) => ({
  type: 'customer.state_changed',
  timestamp: NOW,
  data: {
    ...wireCustomer(externalId),
    active_subscriptions: activeSubscriptions,
    granted_benefits: grantedBenefits,
    active_meters: [],
  },
});

describe('POST /api/webhook/polar', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM users WHERE did = ?').bind(DID).run();
  });

  it('rejects a request with no signature headers', async () => {
    const response = await post(JSON.stringify(orderPaid()), {});
    expect(response.status).toBe(403);
  });

  it('rejects a garbage signature', async () => {
    const body = JSON.stringify(orderPaid());
    const headers = await signWebhook(body, SECRET);
    headers['webhook-signature'] = 'v1,aW52YWxpZC1zaWduYXR1cmU=';
    const response = await post(body, headers);
    expect(response.status).toBe(403);
  });

  it('rejects a signature over different bytes', async () => {
    const headers = await signWebhook(JSON.stringify(orderPaid()), SECRET);
    const response = await post(JSON.stringify(orderPaid('did:plc:someoneelse')), headers);
    expect(response.status).toBe(403);
  });

  it('rejects a stale timestamp even with a valid signature', async () => {
    const body = JSON.stringify(orderPaid());
    const staleTs = Math.floor(Date.now() / 1000) - 60 * 60;
    const headers = await signWebhook(body, SECRET, 'msg_stale', staleTs);
    const response = await post(body, headers);
    expect(response.status).toBe(403);
  });

  it('rejects non-POST methods', async () => {
    const response = await SELF.fetch('http://localhost/api/webhook/polar');
    expect(response.status).toBe(405);
  });

  it('order.paid grants supporter and records the Polar customer', async () => {
    await seedUser('free');
    const response = await signedPost(orderPaid());
    expect(response.status).toBe(200);
    expect(await userRow()).toEqual({
      tier: 'supporter',
      tier_source: 'polar_order',
      polar_customer_id: CUSTOMER_ID,
    });
  });

  it('order.paid for an unknown DID acks 200 and changes nothing', async () => {
    const response = await signedPost(orderPaid('did:plc:nobodyhome'));
    expect(response.status).toBe(200);
    expect(await userRow()).toBeNull();
  });

  it('order.paid with no external_id acks 200 and changes nothing', async () => {
    await seedUser('free');
    const response = await signedPost(orderPaid(null));
    expect(response.status).toBe(200);
    expect((await userRow())?.tier).toBe('free');
  });

  it('redelivery of the same order.paid is idempotent', async () => {
    await seedUser('free');
    await signedPost(orderPaid(), 'msg_first');
    const replay = await signedPost(orderPaid(), 'msg_first');
    expect(replay.status).toBe(200);
    expect((await userRow())?.tier).toBe('supporter');
  });

  it('order.paid with the marketing checkbox ticked records email + consent time', async () => {
    await seedUser('free');
    const before = Math.floor(Date.now() / 1000);
    const response = await signedPost(orderPaid(DID, { marketing_opt_in: true }));
    expect(response.status).toBe(200);
    const row = await marketingRow();
    expect(row?.marketing_email).toBe('reader@example.com');
    expect(row?.marketing_email_consent_at).toBeGreaterThanOrEqual(before);
  });

  it.each([
    ['no custom fields', {}],
    ['the checkbox unticked', { marketing_opt_in: false }],
    ['a non-boolean value', { marketing_opt_in: 'yes' }],
  ])('order.paid with %s records no marketing email', async (_label, fields) => {
    await seedUser('free');
    const response = await signedPost(orderPaid(DID, fields as Record<string, unknown>));
    expect(response.status).toBe(200);
    // The tier grant still lands; only the consent capture is skipped.
    expect((await userRow())?.tier).toBe('supporter');
    expect(await marketingRow()).toEqual({
      marketing_email: null,
      marketing_email_consent_at: null,
    });
  });

  it('a later consenting order refreshes the email but keeps the original consent time', async () => {
    await seedUser('free');
    await env.DB.prepare(
      'UPDATE users SET marketing_email = ?, marketing_email_consent_at = ? WHERE did = ?'
    )
      .bind('old@example.com', 12345, DID)
      .run();
    const response = await signedPost(orderPaid(DID, { marketing_opt_in: true }), 'msg_cycle_2');
    expect(response.status).toBe(200);
    expect(await marketingRow()).toEqual({
      marketing_email: 'reader@example.com',
      marketing_email_consent_at: 12345,
    });
  });

  it('an unticked order never withdraws previously recorded consent', async () => {
    await seedUser('free');
    await signedPost(orderPaid(DID, { marketing_opt_in: true }), 'msg_optin');
    const response = await signedPost(orderPaid(DID, {}), 'msg_later');
    expect(response.status).toBe(200);
    expect((await marketingRow())?.marketing_email).toBe('reader@example.com');
  });

  it('customer.state_changed with an active subscription grants supporter', async () => {
    await seedUser('free');
    const response = await signedPost(customerState(DID, [wireSubscription()]));
    expect(response.status).toBe(200);
    expect(await userRow()).toEqual({
      tier: 'supporter',
      tier_source: 'polar_subscription',
      polar_customer_id: CUSTOMER_ID,
    });
  });

  it('an empty customer state downgrades a subscription-sourced supporter', async () => {
    await seedUser('supporter', 'polar_subscription');
    const response = await signedPost(customerState());
    expect(response.status).toBe(200);
    expect((await userRow())?.tier).toBe('free');
    expect((await userRow())?.polar_customer_id).toBe(CUSTOMER_ID);
  });

  it.each([
    ['admin', 'admin'],
    ['polar_order', 'polar_order'],
    ['a legacy NULL source', null],
  ])(
    'an empty customer state never downgrades a supporter granted via %s',
    async (_label, source) => {
      await seedUser('supporter', source);
      const response = await signedPost(customerState());
      expect(response.status).toBe(200);
      const row = await userRow();
      expect(row?.tier).toBe('supporter');
      expect(row?.tier_source).toBe(source);
      // The linkage is still recorded even when no downgrade applies.
      expect(row?.polar_customer_id).toBe(CUSTOMER_ID);
    }
  );

  it('a subscribed-but-unhandled event type acks 200 without touching tiers', async () => {
    await seedUser('free');
    const response = await signedPost({
      type: 'customer.updated',
      timestamp: NOW,
      data: wireCustomer(DID),
    });
    expect(response.status).toBe(200);
    expect((await userRow())?.tier).toBe('free');
  });
});
