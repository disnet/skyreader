import { Polar } from '@polar-sh/sdk';
import type { Env } from '../types';

/**
 * Polar API client (billing / merchant of record). Built per request — Workers
 * has no process.env, and env bindings only exist inside a handler.
 * POLAR_ACCESS_TOKEN unset means billing is off; calls will 401 at Polar and
 * surface as the handler's 5xx branch, never as a crash here.
 */
export function getPolarClient(env: Env): Polar {
  return new Polar({
    accessToken: env.POLAR_ACCESS_TOKEN ?? '',
    server: env.POLAR_SERVER === 'sandbox' ? 'sandbox' : 'production',
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
 * Key semantics match Polar's own verifier, not the standard-webhooks spec
 * reading of it: the HMAC key is the UTF-8 bytes of the secret string exactly
 * as Polar issued it (validateEvent base64-wraps the raw string; it never
 * strips or decodes a `whsec_` prefix). The signed content is
 * `${webhook-id}.${webhook-timestamp}.${raw body}`, and the header carries one
 * or more space-separated `v1,<base64>` entries.
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

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${headers.id}.${timestamp}.${body}`)
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(signed)));

  const matched = headers.signature.split(' ').some((entry) => {
    const [version, signature] = entry.split(',', 2);
    return version === 'v1' && signature !== undefined && timingSafeEqual(signature, expected);
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
