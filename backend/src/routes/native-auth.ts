import type { Env } from '../types';
import { generateRandomString } from '../services/oauth';

/**
 * Native (macOS/iOS) sign-in handoff.
 *
 * The web app receives its session as an HttpOnly cookie and the CLI on a
 * loopback port. A native app can only be reached on its custom URL scheme,
 * which any other app on the device could also register, so the session never
 * travels on it. Instead (RFC 8252 / PKCE-shaped):
 *
 * 1. The app keeps a random verifier and starts login with
 *    `native_challenge = base64url(SHA-256(verifier))`.
 * 2. The callback stores a one-time code bound to that challenge and redirects
 *    to `skyreader://auth/callback?code=…`.
 * 3. The app posts `{ code, verifier }` to `/api/auth/native/exchange` and gets
 *    the session id back. A code intercepted without the verifier is useless.
 */

export const NATIVE_CALLBACK_URL = 'skyreader://auth/callback';

// Long enough to finish the redirect, short enough that a leaked code dies fast.
const HANDOFF_TTL_MS = 2 * 60 * 1000;

// base64url of a SHA-256 digest: 32 bytes -> 43 chars, no padding.
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isValidNativeChallenge(value: string): boolean {
  return CHALLENGE_PATTERN.test(value);
}

export function nativeErrorRedirect(message: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${NATIVE_CALLBACK_URL}?error=${encodeURIComponent(message)}` },
  });
}

/** Called from the OAuth callback once the session exists. */
export async function nativeSuccessRedirect(
  env: Env,
  sessionId: string,
  challenge: string
): Promise<Response> {
  const code = generateRandomString(32);
  await env.DB.prepare(
    'INSERT INTO native_auth_handoff (code, session_id, challenge, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(code, sessionId, challenge, Date.now() + HANDOFF_TTL_MS)
    .run();
  // No Set-Cookie: the browser that ran the OAuth flow isn't the app.
  return new Response(null, {
    status: 302,
    headers: { Location: `${NATIVE_CALLBACK_URL}?code=${encodeURIComponent(code)}` },
  });
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** POST /api/auth/native/exchange `{ code, verifier }` -> `{ sessionId }`. */
export async function handleNativeExchange(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: { code?: unknown; verifier?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const { code, verifier } = body;
  if (typeof code !== 'string' || typeof verifier !== 'string' || !code || !verifier) {
    return json({ error: 'Missing code or verifier' }, 400);
  }

  // Delete first, whatever the verifier: a code gets exactly one attempt, so it
  // can't be brute-forced against the verifier.
  const row = await env.DB.prepare(
    'DELETE FROM native_auth_handoff WHERE code = ? RETURNING session_id, challenge, expires_at'
  )
    .bind(code)
    .first<{ session_id: string; challenge: string; expires_at: number }>();

  if (!row || row.expires_at < Date.now() || (await challengeFor(verifier)) !== row.challenge) {
    return json({ error: 'invalid_grant' }, 400);
  }
  return json({ sessionId: row.session_id });
}
