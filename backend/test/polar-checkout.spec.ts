import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCreateCheckout } from '../src/routes/billing';
import type { Env, Session } from '../src/types';

// Checkout is the authed half of the Polar integration: it must never talk to
// Polar without a session, and the one thing that matters in the request it
// builds is external_customer_id = the session DID — that's the join key the
// webhook uses to find the user again.

const session: Session = {
  did: 'did:plc:checkouttest',
  handle: 'checkout.test',
  displayName: null,
  avatarUrl: null,
  pdsUrl: 'https://pds.test',
  accessToken: 'at',
  refreshToken: 'rt',
  dpopPrivateKey: '{}',
  expiresAt: Date.now() + 3600_000,
  grantedScopes: null,
};

const CHECKOUT_URL = 'https://polar.sh/checkout/test-client-secret';

/** Minimal wire-format Checkout that satisfies the SDK's response schema. */
const checkoutResponse = () => ({
  id: 'c0ffee00-1111-2222-3333-444444444444',
  created_at: '2026-08-27T12:00:00Z',
  modified_at: null,
  payment_processor: 'stripe',
  status: 'open',
  client_secret: 'test-client-secret',
  url: CHECKOUT_URL,
  expires_at: '2026-08-27T13:00:00Z',
  success_url: 'https://polar.sh/checkout/test-client-secret/confirmation',
  return_url: null,
  embed_origin: null,
  amount: 1000,
  discount_amount: 0,
  net_amount: 1000,
  tax_amount: null,
  tax_behavior: null,
  total_amount: 1000,
  currency: 'usd',
  allow_trial: null,
  active_trial_interval: null,
  active_trial_interval_count: null,
  trial_end: null,
  organization_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  product_id: null,
  product_price_id: null,
  discount_id: null,
  allow_discount_codes: true,
  require_billing_address: false,
  is_discount_applicable: true,
  is_free_product_price: false,
  is_payment_required: true,
  is_payment_setup_required: false,
  is_payment_form_required: true,
  customer_id: null,
  is_business_customer: false,
  customer_name: null,
  customer_email: null,
  customer_ip_address: null,
  customer_billing_name: null,
  customer_billing_address: null,
  customer_tax_id: null,
  payment_processor_metadata: {},
  billing_address_fields: {
    country: 'required',
    state: 'disabled',
    city: 'disabled',
    postal_code: 'disabled',
    line1: 'disabled',
    line2: 'disabled',
  },
  trial_interval: null,
  trial_interval_count: null,
  metadata: {},
  external_customer_id: session.did,
  products: [],
  product: null,
  product_price: null,
  prices: null,
  discount: null,
  subscription_id: null,
  attached_custom_fields: null,
  customer_metadata: {},
});

const post = (path = '/api/billing/checkout') =>
  new Request(`http://localhost${path}`, { method: 'POST' });

describe('POST /api/billing/checkout', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(checkoutResponse()), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('requires a session (401 via the router, before any Polar call)', async () => {
    const response = await SELF.fetch('http://localhost/api/billing/checkout', {
      method: 'POST',
    });
    expect(response.status).toBe(401);
  });

  it('rejects non-POST methods', async () => {
    const response = await handleCreateCheckout(
      new Request('http://localhost/api/billing/checkout'),
      env as Env,
      session
    );
    expect(response.status).toBe(405);
  });

  it('creates a checkout for the default product with the DID as external customer', async () => {
    const response = await handleCreateCheckout(post(), env as Env, session);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: CHECKOUT_URL });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(new URL(request.url).pathname).toBe('/v1/checkouts/');
    const sent = JSON.parse(await request.clone().text());
    // POLAR_PRODUCT_ID is pinned to 'prod-test' in vitest.config.mts
    expect(sent.products).toEqual(['prod-test']);
    expect(sent.external_customer_id).toBe(session.did);
    expect(sent.success_url).toBeUndefined();
  });

  it('lets ?products= override the default product', async () => {
    await handleCreateCheckout(
      post('/api/billing/checkout?products=prod-other'),
      env as Env,
      session
    );
    const request = fetchMock.mock.calls[0][0] as Request;
    const sent = JSON.parse(await request.clone().text());
    expect(sent.products).toEqual(['prod-other']);
  });

  it('maps a Polar API error to 502', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'validation' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const response = await handleCreateCheckout(post(), env as Env, session);
    expect(response.status).toBe(502);
  });

  it('answers 503 when no product is configured', async () => {
    const response = await handleCreateCheckout(
      post(),
      { ...(env as Env), POLAR_PRODUCT_ID: '' },
      session
    );
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
