import type { Env, Session } from '../types';
import { getPolarClient, verifyPolarWebhook } from '../services/polar';
import {
  grantSupporterFromOrder,
  grantSupporterFromSubscription,
  reconcileEmptyCustomerState,
} from '../services/polar-entitlements';
import { log, serializeError } from '../utils/logger';
import { reportError } from '../observability/sentry';

// Polar billing (merchant of record). Three surfaces:
//   GET  /api/billing/products  - authed; the purchasable plans for the upgrade UI
//   POST /api/billing/checkout  - authed; creates a hosted checkout, returns { url }
//   POST /api/webhook/polar     - server-to-server; standard-webhooks HMAC, no session
//
// The join key between the two worlds is the atproto DID: checkout sets it as
// Polar's external_customer_id, and the webhook resolves it back to a users row.
// Entitlement writes live in services/polar-entitlements.ts.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// GET /api/billing/products - the purchasable plans, straight from Polar.
// Settings renders one option per product (monthly/annual), so prices live in
// exactly one place: the Polar dashboard. No cache — this is a settings-page
// visit, not a hot path.
export async function handleListBillingProducts(
  request: Request,
  env: Env,
  session: Session | null
): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!session) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!env.POLAR_ACCESS_TOKEN) {
    return json({ error: 'Billing is not configured' }, 503);
  }

  try {
    const page = await getPolarClient(env).products.list({ isArchived: false, limit: 100 });
    const products = page.result.items
      .filter((p) => p.recurringInterval === 'month' || p.recurringInterval === 'year')
      .flatMap((p) => {
        const price = p.prices.find(
          (pr) => 'amountType' in pr && pr.amountType === 'fixed' && 'priceAmount' in pr
        );
        if (!price || !('priceAmount' in price)) return [];
        return [
          {
            id: p.id,
            name: p.name,
            interval: p.recurringInterval as 'month' | 'year',
            priceAmount: price.priceAmount,
            priceCurrency: price.priceCurrency,
          },
        ];
      })
      .sort((a, b) => (a.interval === b.interval ? 0 : a.interval === 'month' ? -1 : 1));
    return json({ products });
  } catch (error) {
    log.error('polar_products_failed', serializeError(error));
    reportError(error, { tags: { route: 'billing/products' } });
    return json({ error: 'Failed to load plans' }, 502);
  }
}

// POST /api/billing/checkout[?products=<id>] - start a hosted checkout
export async function handleCreateCheckout(
  request: Request,
  env: Env,
  session: Session | null
): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!session) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const requested = new URL(request.url).searchParams.get('products');
  const productId = requested || env.POLAR_PRODUCT_ID;
  if (!productId || !env.POLAR_ACCESS_TOKEN) {
    return json({ error: 'Billing is not configured' }, 503);
  }

  try {
    const checkout = await getPolarClient(env).checkouts.create({
      products: [productId],
      // The one field that lets the webhook find this user again. Polar creates
      // the customer on first checkout and reuses it on the next.
      externalCustomerId: session.did,
    });
    return json({ url: checkout.url });
  } catch (error) {
    log.error('polar_checkout_failed', serializeError(error));
    reportError(error, { tags: { route: 'billing/checkout' } });
    return json({ error: 'Failed to create checkout' }, 502);
  }
}

// POST /api/webhook/polar - Polar event delivery.
//
// Mounted before session resolution (see index.ts): Polar sends no cookie, and a
// D1 blip in the session path must not 500 a delivery Polar will then retry.
// Unknown DIDs and unhandled event types are acked with 200 — a 4xx/5xx makes
// Polar retry a delivery that will never succeed. Only signature failures (403)
// and our own DB errors (thrown -> 500 -> retry, which we want) are non-200.
//
// Signature verification is ours, not the SDK's — see verifyPolarWebhook for
// why. That also means no zod parse of the payload: everything under event.data
// is untrusted wire-format (snake_case) JSON, so every field we touch is
// runtime-checked here rather than trusted from a type.
export async function handlePolarWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  // Fail closed, like FEED_PROXY_SECRET in routes/ingest.ts: no secret, no service.
  if (!env.POLAR_WEBHOOK_SECRET) {
    log.error('polar_webhook_unconfigured', {});
    return json({ error: 'Webhook not configured' }, 500);
  }

  // Raw text, never re-serialized JSON — the signature covers these exact bytes.
  const body = await request.text();
  const verification = await verifyPolarWebhook(
    body,
    {
      id: request.headers.get('webhook-id') ?? '',
      timestamp: request.headers.get('webhook-timestamp') ?? '',
      signature: request.headers.get('webhook-signature') ?? '',
    },
    env.POLAR_WEBHOOK_SECRET
  );
  if (!verification.ok) {
    return json({ received: false }, 403);
  }

  const { event } = verification;
  const webhookId = request.headers.get('webhook-id') ?? '';

  switch (event.type) {
    case 'order.paid': {
      const customer = asCustomer((event.data as { customer?: unknown } | null)?.customer);
      if (!customer) {
        log.warn('polar_webhook_malformed', { webhookId, event: event.type });
        break;
      }
      if (!customer.externalId) {
        // A customer created outside our checkout flow — nothing to grant.
        log.warn('polar_webhook_no_external_id', {
          webhookId,
          event: event.type,
          customerId: customer.id,
        });
        break;
      }
      const matched = await grantSupporterFromOrder(env, customer.externalId, customer.id);
      if (!matched) {
        log.warn('polar_webhook_unknown_customer', {
          webhookId,
          event: event.type,
          did: customer.externalId,
        });
      } else {
        log.info('polar_tier_granted', {
          webhookId,
          event: event.type,
          did: customer.externalId,
          source: 'order',
        });
      }
      break;
    }

    case 'customer.state_changed': {
      // The payload IS the customer state: the customer plus its active
      // subscriptions and granted benefits.
      const customer = asCustomer(event.data);
      if (!customer) {
        log.warn('polar_webhook_malformed', { webhookId, event: event.type });
        break;
      }
      if (!customer.externalId) {
        log.warn('polar_webhook_no_external_id', {
          webhookId,
          event: event.type,
          customerId: customer.id,
        });
        break;
      }
      const state = event.data as {
        active_subscriptions?: unknown;
        granted_benefits?: unknown;
      };
      const activeSubscriptions = Array.isArray(state.active_subscriptions)
        ? state.active_subscriptions
        : [];
      const grantedBenefits = Array.isArray(state.granted_benefits) ? state.granted_benefits : [];
      // Active subscriptions or granted benefits both mean "entitled"; an empty
      // state only downgrades rows the subscription path itself upgraded (a
      // one-time order is invisible here — see services/polar-entitlements.ts).
      if (activeSubscriptions.length > 0 || grantedBenefits.length > 0) {
        const matched = await grantSupporterFromSubscription(env, customer.externalId, customer.id);
        if (!matched) {
          log.warn('polar_webhook_unknown_customer', {
            webhookId,
            event: event.type,
            did: customer.externalId,
          });
        } else {
          log.info('polar_tier_granted', {
            webhookId,
            event: event.type,
            did: customer.externalId,
            source: 'subscription',
          });
        }
      } else {
        await reconcileEmptyCustomerState(env, customer.externalId, customer.id);
        log.info('polar_state_reconciled', {
          webhookId,
          event: event.type,
          did: customer.externalId,
        });
      }
      break;
    }

    default:
      // Subscribed events we don't act on yet — ack so Polar doesn't retry.
      break;
  }

  return json({ received: true });
}

/** Pull the two customer fields we use out of untrusted webhook JSON. */
function asCustomer(value: unknown): { id: string; externalId: string | null } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, external_id } = value as { id?: unknown; external_id?: unknown };
  if (typeof id !== 'string') return null;
  return { id, externalId: typeof external_id === 'string' && external_id ? external_id : null };
}
