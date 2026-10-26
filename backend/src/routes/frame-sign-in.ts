import type { Env } from '../types';
import {
  buildSetCookieHeader,
  getCookieDomain,
  isSecureContext,
  parseCookies,
  SESSION_COOKIE_MAX_AGE,
  SESSION_COOKIE_NAME,
} from '../utils/cookies';
import { generateRandomString } from '../services/oauth';
import { sha256Hex } from '../utils/sha256';

// Sign-in from inside a workspace frame (atworkplace, docs/plans/ATWORKPLACE.md).
//
// A framed Skyreader runs under another top-level site, so the browser keeps its
// cookies in a partition of their own. Sign-in has to run in a popup (auth
// servers refuse to be framed), and the popup is top-level: a cookie set on the
// callback would land in the unpartitioned jar, which the frame can't see. So:
//
//   1. The frame picks a random relay secret and opens the popup on
//      /auth/frame-start, which gets the secret's SHA-256 from the frame by
//      postMessage (checked same-origin both ways) and sends it with
//      /api/auth/login (`frame_relay_hash`). Only the hash leaves the frame
//      before the claim, and it never appears in a URL.
//   2. That login response also sets a binding cookie in the popup's
//      (top-level) jar. The callback goes on (token exchange, then parking the
//      new session under the relay hash) only if the browser finishing sign-in
//      carries that cookie, and sets no session cookie itself. Without the binding, anyone could start a framed
//      login with their own relay, send the auth URL to someone else, and claim
//      the session of whoever approved it. The postMessage handoff in step 1 is
//      the other half: a page on another site can't open /auth/frame-start and
//      feed it a relay of its choosing.
//   3. The frame polls POST /api/auth/frame-claim with the secret. The first
//      claim takes the session and gets it back as a partitioned cookie, kept
//      only in the shell's partition. The reader's own top-level cookie is
//      untouched and stays SameSite=Lax.
//
// Off unless WORKSPACE_FRAMING is "true" (staging only for now).

const PARK_TTL_MS = 10 * 60 * 1000;
// __Host-: Secure, Path=/, no Domain, so no other *.skyreader.app host can plant
// one. Framed sign-in is https-only (login refuses it otherwise).
const BINDING_COOKIE = '__Host-frame_sign_in_binding';

export function isFrameSignInEnabled(env: Env): boolean {
  return env.WORKSPACE_FRAMING === 'true';
}

export function isRelayHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * A fresh binding for a framed sign-in: its hash goes in the OAuth state, the
 * cookie goes on the login response.
 */
export async function newFrameBinding(): Promise<{ bindingHash: string; cookie: string }> {
  const binding = generateRandomString(32);
  return {
    bindingHash: await sha256Hex(new TextEncoder().encode(binding)),
    cookie: buildSetCookieHeader(BINDING_COOKIE, binding, {
      maxAge: PARK_TTL_MS / 1000,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
    }),
  };
}

/** Does the browser finishing this callback carry the binding its login set? */
export async function hasFrameBinding(request: Request, bindingHash: string): Promise<boolean> {
  const binding = parseCookies(request.headers.get('Cookie')).get(BINDING_COOKIE);
  if (!binding) return false;
  return (await sha256Hex(new TextEncoder().encode(binding))) === bindingHash;
}

export function clearFrameBindingCookie(): string {
  return buildSetCookieHeader(BINDING_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
  });
}

/**
 * Hourly cleanup: framed sign-ins nobody claimed, and the sessions they parked,
 * which nobody else holds a cookie for.
 */
export async function cleanupFrameSignIns(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM frame_sign_in WHERE expires_at < ?)'
    ).bind(now),
    env.DB.prepare('DELETE FROM frame_sign_in WHERE expires_at < ?').bind(now),
  ]);
}

/**
 * Is this relay hash already taken by a sign-in in flight or waiting to be
 * claimed? The hash isn't secret (it rides in a query string), so a second
 * sign-in with it must not be able to swap its own session in.
 */
export async function isRelayHashInUse(env: Env, relayHash: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM oauth_state WHERE frame_relay_hash = ?1
     UNION ALL SELECT 1 FROM frame_sign_in WHERE relay_hash = ?1 LIMIT 1`
  )
    .bind(relayHash)
    .first();
  return row !== null;
}

/** Parks a finished sign-in for its frame. First one wins; false if the hash was taken. */
export async function parkFrameSignIn(
  env: Env,
  relayHash: string,
  sessionId: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO frame_sign_in (relay_hash, session_id, expires_at) VALUES (?, ?, ?)'
  )
    .bind(relayHash, sessionId, Date.now() + PARK_TTL_MS)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * POST /api/auth/frame-claim — body { relay }. 200 with the partitioned session
 * cookie once the popup's sign-in has finished, 202 while it hasn't (the frame
 * polls), 400 for a malformed relay, 404 when framing is off.
 */
export async function handleFrameSignInClaim(request: Request, env: Env): Promise<Response> {
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...extra },
    });

  // Partitioned cookies must be Secure, so there's nothing to hand out over http.
  if (!isFrameSignInEnabled(env) || !isSecureContext(request)) {
    return json({ error: 'Not found' }, 404);
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let relay: unknown;
  try {
    relay = ((await request.json()) as { relay?: unknown }).relay;
  } catch {
    relay = undefined;
  }
  if (!isRelayHash(relay)) {
    return json({ error: 'Invalid relay' }, 400);
  }

  const relayHash = await sha256Hex(new TextEncoder().encode(relay));
  // Single use: the DELETE is the claim, so two concurrent polls can't both win.
  const row = await env.DB.prepare(
    'DELETE FROM frame_sign_in WHERE relay_hash = ? AND expires_at > ? RETURNING session_id'
  )
    .bind(relayHash, Date.now())
    .first<{ session_id: string }>();

  if (!row) {
    return json({ status: 'pending' }, 202);
  }

  const cookie = buildSetCookieHeader(SESSION_COOKIE_NAME, row.session_id, {
    maxAge: SESSION_COOKIE_MAX_AGE,
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    partitioned: true,
    domain: getCookieDomain(env, request),
    path: '/',
  });
  return json({ status: 'signed-in' }, 200, { 'Set-Cookie': cookie });
}
