import { Polar } from '@polar-sh/sdk';
import { HTTPClient } from '@polar-sh/sdk/lib/http.js';
import type { Env } from '../types';

/**
 * The Polar API version every request is pinned to (the `Polar-Version`
 * header). Unpinned requests get Polar's "Current" version, which changes every
 * quarter — so an unpinned integration can have its contract change under it
 * with no deploy on our side. Versions live ~9 months (3 as Next, 3 as Current,
 * 3 as Deprecated), then a removed version 404s on every call: bump this before
 * that, together with the webhook endpoints' api_version in the Polar dashboard.
 * See POLAR_SETUP.md ("API version").
 */
export const POLAR_API_VERSION = '2026-10';

/**
 * Polar API client (billing / merchant of record). Built per request — Workers
 * has no process.env, and env bindings only exist inside a handler.
 * POLAR_ACCESS_TOKEN unset means billing is off; calls will 401 at Polar and
 * surface as the handler's 5xx branch, never as a crash here.
 *
 * The 0.x SDK predates API versioning and sends no version header, so the pin
 * is stamped on every request through its HTTP client hook.
 */
export function getPolarClient(env: Env): Polar {
  const httpClient = new HTTPClient().addHook('beforeRequest', (request) => {
    request.headers.set('Polar-Version', POLAR_API_VERSION);
  });
  return new Polar({
    accessToken: env.POLAR_ACCESS_TOKEN ?? '',
    server: env.POLAR_SERVER === 'sandbox' ? 'sandbox' : 'production',
    httpClient,
  });
}

/**
 * Standard-webhooks signature verification, hand-rolled on crypto.subtle.
 *
 * The SDK ships `validateEvent` for this, but it calls `Buffer.from()` — a Node
 * global that only exists under the `nodejs_compat` flag this Worker
 * deliberately does not run (see the comment in wrangler.toml). It happens to
 * exist in the vitest runtime, which is exactly the trap: tests pass, every
 * production delivery 500s. So we verify ourselves and keep the SDK for the
 * checkout API only.
 *
 * Polar signs with one of two HMAC keys, depending on when the endpoint's
 * secret was generated, and nothing in the delivery says which:
 *   - before 2026-09-08 00:00 UTC (or a user-provided secret): "Polar HMAC" —
 *     the key is the UTF-8 bytes of the full `whsec_…` string as issued;
 *   - on or after it: Standard Webhooks — the key is the base64-decode of the
 *     part after `whsec_`.
 * Regenerating an endpoint's secret silently moves it to the second scheme, so
 * we accept either, as Polar's own SDK (>= 1.0.0-alpha.19) does. The signed
 * content is `${webhook-id}.${webhook-timestamp}.${raw body}`, and the header
 * carries one or more space-separated `v1,<base64>` entries.
 */
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface PolarWebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export type PolarWebhookVerification =
  | { ok: true; event: { type: string; data: unknown } }
  | { ok: false; reason: 'headers' | 'timestamp' | 'signature' | 'parse' };

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const STANDARD_WEBHOOKS_PREFIX = 'whsec_';

/**
 * Candidate HMAC keys for a secret: always the Polar HMAC key (raw UTF-8), plus
 * the Standard Webhooks key when the part after `whsec_` is valid base64.
 */
function webhookSigningKeys(secret: string): Uint8Array[] {
  const keys = [new TextEncoder().encode(secret)];
  if (secret.startsWith(STANDARD_WEBHOOKS_PREFIX)) {
    try {
      const decoded = atob(secret.slice(STANDARD_WEBHOOKS_PREFIX.length));
      if (decoded.length > 0) {
        keys.push(Uint8Array.from(decoded, (c) => c.charCodeAt(0)));
      }
    } catch {
      // Not base64 — only the Polar HMAC key applies.
    }
  }
  return keys;
}

export async function verifyPolarWebhook(
  body: string,
  headers: PolarWebhookHeaders,
  secret: string
): Promise<PolarWebhookVerification> {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: 'headers' };
  }

  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'timestamp' };
  }
  const skew = Math.abs(Date.now() / 1000 - timestamp);
  if (skew > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp' };
  }

  const content = new TextEncoder().encode(`${headers.id}.${timestamp}.${body}`);
  const expected = await Promise.all(
    webhookSigningKeys(secret).map(async (keyBytes) => {
      const key = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signed = await crypto.subtle.sign('HMAC', key, content);
      return btoa(String.fromCharCode(...new Uint8Array(signed)));
    })
  );

  const matched = headers.signature.split(' ').some((entry) => {
    const [version, signature] = entry.split(',', 2);
    return (
      version === 'v1' &&
      signature !== undefined &&
      expected.some((candidate) => timingSafeEqual(signature, candidate))
    );
  });
  if (!matched) {
    return { ok: false, reason: 'signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'parse' };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== 'string'
  ) {
    return { ok: false, reason: 'parse' };
  }
  const event = parsed as { type: string; data?: unknown };
  return { ok: true, event: { type: event.type, data: event.data ?? null } };
}
