import type { Env } from '../types';
import {
  buildSetCookieHeader,
  getCookieDomain,
  isSecureContext,
  SESSION_COOKIE_MAX_AGE,
  SESSION_COOKIE_NAME,
} from '../utils/cookies';
import { sha256Hex } from '../utils/sha256';

// Sign-in from inside a workspace frame (atworkplace, docs/plans/ATWORKPLACE.md).
//
// A framed Skyreader runs under another top-level site, so the browser keeps its
// cookies in a partition of their own. Sign-in has to run in a popup (auth
// servers refuse to be framed), and the popup is top-level: a cookie set on the
// callback would land in the unpartitioned jar, which the frame can't see. So:
//
//   1. The frame picks a random relay secret and sends its SHA-256 with
//      /api/auth/login (`frame_relay_hash`). Only the hash ever leaves the frame
//      before the claim, and it never appears in a URL sent to the auth server.
//   2. The callback parks the new session under that hash and sets no cookie.
//   3. The frame polls POST /api/auth/frame-claim with the secret. The first
//      claim takes the session and gets it back as a partitioned cookie, kept
//      only in the shell's partition. The reader's own top-level cookie is
//      untouched and stays SameSite=Lax.
//
// Off unless WORKSPACE_FRAMING is "true" (staging only for now).

const PARK_TTL_MS = 10 * 60 * 1000;

export function isFrameSignInEnabled(env: Env): boolean {
  return env.WORKSPACE_FRAMING === 'true';
}

export function isRelayHash(value: string | null): value is string {
  return !!value && /^[0-9a-f]{64}$/.test(value);
}

export async function parkFrameSignIn(
  env: Env,
  relayHash: string,
  sessionId: string
): Promise<void> {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO frame_sign_in (relay_hash, session_id, expires_at) VALUES (?, ?, ?)'
  )
    .bind(relayHash, sessionId, Date.now() + PARK_TTL_MS)
    .run();
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
  if (typeof relay !== 'string' || !/^[0-9a-f]{64}$/.test(relay)) {
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
