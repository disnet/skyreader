import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleListBillingProducts } from '../src/routes/billing';
import type { Env, Session } from '../src/types';

// /api/billing/products feeds the upgrade UI. What matters: only unarchived
// recurring products come through, mapped to the small shape the frontend
// renders, monthly sorted before annual — and prices stay authored in exactly
// one place (the Polar dashboard), never in this repo.

const session: Session = {
  did: 'did:plc:productstest',
  handle: 'products.test',
  displayName: null,
  avatarUrl: null,
  pdsUrl: 'https://pds.test',
  accessToken: 'at',
  refreshToken: 'rt',
  dpopPrivateKey: '{}',
  expiresAt: Date.now() + 3600_000,
  grantedScopes: null,
};

const NOW = '2026-08-27T12:00:00Z';

/** Wire-format product satisfying the SDK's response schema. */
const wireProduct = (
  id: string,
  name: string,
  interval: 'month' | 'year' | null,
  priceAmount: number
) => ({
  id,
  created_at: NOW,
  modified_at: null,
  trial_interval: null,
  trial_interval_count: null,
  name,
  description: null,
  visibility: 'public',
  recurring_interval: interval,
  recurring_interval_count: interval ? 1 : null,
  meter_interval: null,
  meter_interval_count: null,
  is_recurring: interval !== null,
  is_archived: false,
  organization_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  metadata: {},
  prices: [
    {
      created_at: NOW,
      modified_at: null,
      id: `price-${id}`,
      source: 'catalog',
      amount_type: 'fixed',
      price_currency: 'usd',
      tax_behavior: null,
      is_archived: false,
      product_id: id,
      price_amount: priceAmount,
    },
  ],
  benefits: [],
  medias: [],
  attached_custom_fields: [],
});

const listResponse = (items: unknown[]) => ({
  items,
  pagination: { total_count: items.length, max_page: 1 },
});

const get = () => new Request('http://localhost/api/billing/products');

describe('GET /api/billing/products', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(
          listResponse([
            // Annual first on the wire to prove the handler sorts monthly first
            wireProduct('prod-annual', 'Skyreader Pro Annual', 'year', 9900),
            wireProduct('prod-monthly', 'Skyreader Pro Monthly', 'month', 1000),
            wireProduct('prod-onetime', 'One-time thing', null, 500),
          ])
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('requires a session (401 via the router, before any Polar call)', async () => {
    const response = await SELF.fetch('http://localhost/api/billing/products');
    expect(response.status).toBe(401);
  });

  it('rejects non-GET methods', async () => {
    const response = await handleListBillingProducts(
      new Request('http://localhost/api/billing/products', { method: 'POST' }),
      env as Env,
      session
    );
    expect(response.status).toBe(405);
  });

  it('returns recurring products only, monthly before annual', async () => {
    const response = await handleListBillingProducts(get(), env as Env, session);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      products: [
        {
          id: 'prod-monthly',
          name: 'Skyreader Pro Monthly',
          interval: 'month',
          priceAmount: 1000,
          priceCurrency: 'usd',
        },
        {
          id: 'prod-annual',
          name: 'Skyreader Pro Annual',
          interval: 'year',
          priceAmount: 9900,
          priceCurrency: 'usd',
        },
      ],
    });
  });

  it('maps a Polar API error to 502', async () => {
    fetchMock.mockResolvedValue(new Response('upstream broke', { status: 500 }));
    const response = await handleListBillingProducts(get(), env as Env, session);
    expect(response.status).toBe(502);
  });

  it('answers 503 when billing is not configured', async () => {
    const response = await handleListBillingProducts(
      get(),
      { ...(env as Env), POLAR_ACCESS_TOKEN: '' },
      session
    );
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
