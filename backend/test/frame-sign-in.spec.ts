import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { storeOAuthState } from '../src/services/oauth';
import { sha256Hex } from '../src/utils/sha256';

// Sign-in from inside a workspace frame (routes/frame-sign-in.ts).

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:framereader';
const TEST_HANDLE = 'frame.bsky.social';
const RELAY = 'a'.repeat(64);
const BINDING = 'binding-cookie-value';
const hashOf = (v: string) => sha256Hex(new TextEncoder().encode(v));
const framingOn = { ...env, WORKSPACE_FRAMING: 'true' } as Env;

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

async function call(request: Request, e: Env = framingOn) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, e, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function claim(relay: string, e: Env = framingOn) {
  return call(
    new IncomingRequest('https://api-staging.skyreader.app/api/auth/frame-claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://staging.skyreader.app' },
      body: JSON.stringify({ relay }),
    }),
    e
  );
}

async function park(relay: string, sessionId: string, expiresAt = Date.now() + 60_000) {
  await env.DB.prepare(
    'INSERT INTO frame_sign_in (relay_hash, session_id, expires_at) VALUES (?, ?, ?)'
  )
    .bind(await sha256Hex(new TextEncoder().encode(relay)), sessionId, expiresAt)
    .run();
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM frame_sign_in').run();
  await env.DB.prepare('DELETE FROM oauth_state').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('starting a framed sign-in', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('com.atproto.identity.resolveHandle')) return ok({ did: TEST_DID });
      if (u.includes('plc.directory') || u.includes('did:plc:')) {
        return ok({
          id: TEST_DID,
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.example.com',
            },
          ],
        });
      }
      if (u.includes('.well-known/oauth-protected-resource')) {
        return ok({ authorization_servers: ['https://bsky.social'] });
      }
      if (u.includes('.well-known/oauth-authorization-server')) {
        return ok({
          issuer: 'https://bsky.social',
          authorization_endpoint: 'https://bsky.social/oauth/authorize',
          token_endpoint: 'https://bsky.social/oauth/token',
          pushed_authorization_request_endpoint: 'https://bsky.social/oauth/par',
        });
      }
      if (u.includes('/oauth/par')) return ok({ request_uri: 'urn:test' });
      throw new Error(`Unexpected fetch: ${u}`);
    });
  });

  const login = (hash: string, e?: Env) =>
    call(
      new IncomingRequest(
        `https://api-staging.skyreader.app/api/auth/login?handle=${TEST_HANDLE}&frame_relay_hash=${hash}`
      ),
      e
    );

  it('remembers the relay hash with the OAuth state, never in the auth URL', async () => {
    const hash = await sha256Hex(new TextEncoder().encode(RELAY));
    const response = await login(hash);
    expect(response.status).toBe(200);
    const { authUrl } = (await response.json()) as { authUrl: string };
    expect(authUrl).not.toContain(hash);

    // The binding cookie ties the callback to this browser.
    const cookie = response.headers.get('Set-Cookie') ?? '';
    const binding = /__Host-frame_sign_in_binding=([^;]+)/.exec(cookie)?.[1];
    expect(binding).toBeTruthy();
    expect(cookie).toContain('Secure');
    expect(cookie).not.toContain('Domain');
    expect(cookie).toContain('HttpOnly');

    const row = await env.DB.prepare(
      'SELECT frame_relay_hash, frame_binding_hash FROM oauth_state'
    ).first<{ frame_relay_hash: string; frame_binding_hash: string }>();
    expect(row?.frame_relay_hash).toBe(hash);
    expect(row?.frame_binding_hash).toBe(await hashOf(binding!));
  });

  it('refuses a relay hash another sign-in is already using', async () => {
    const hash = await hashOf(RELAY);
    expect((await login(hash)).status).toBe(200);
    expect((await login(hash)).status).toBe(400);
  });

  it('refuses a framed sign-in when framing is off, or with a malformed hash', async () => {
    const hash = await sha256Hex(new TextEncoder().encode(RELAY));
    expect((await login(hash, env)).status).toBe(400);
    expect((await login('not-a-hash')).status).toBe(400);
    const overHttp = await call(
      new IncomingRequest(
        `http://localhost/api/auth/login?handle=${TEST_HANDLE}&frame_relay_hash=${hash}`
      )
    );
    expect(overHttp.status).toBe(400);
  });
});

describe('the callback of a framed sign-in', () => {
  const STATE = 'frame-state-token-12345678';

  beforeEach(async () => {
    await storeOAuthState(env, STATE, {
      codeVerifier: 'test-code-verifier-value',
      did: TEST_DID,
      handle: TEST_HANDLE,
      pdsUrl: 'https://pds.example.com',
      authServer: 'https://bsky.social',
      returnUrl: '/',
      frontendUrl: env.FRONTEND_URL,
      frameRelayHash: await hashOf(RELAY),
      frameBindingHash: await hashOf(BINDING),
    });
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('.well-known/oauth-protected-resource')) {
        return ok({ authorization_servers: ['https://bsky.social'] });
      }
      if (u.includes('.well-known/oauth-authorization-server')) {
        return ok({
          issuer: 'https://bsky.social',
          authorization_endpoint: 'https://bsky.social/oauth/authorize',
          token_endpoint: 'https://bsky.social/oauth/token',
        });
      }
      if (u.includes('/oauth/token')) {
        return ok({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          sub: TEST_DID,
          scope: 'atproto',
        });
      }
      if (u.includes('app.bsky.actor.getProfile')) return ok({ handle: TEST_HANDLE });
      if (u.includes('listRecords') || u.includes('putRecord') || u.includes('createRecord')) {
        return ok({ records: [] });
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });
  });

  const callback = (cookie?: string, e?: Env) =>
    call(
      new IncomingRequest(
        `https://api-staging.skyreader.app/api/auth/callback?code=c&state=${STATE}&iss=https%3A%2F%2Fbsky.social`,
        { headers: cookie ? { Cookie: cookie } : {} }
      ),
      e
    );

  it('fails a framed sign-in whose callback lands after framing was turned off', async () => {
    const response = await callback(`__Host-frame_sign_in_binding=${BINDING}`, env);
    expect(response.headers.get('Location')).toContain('/auth/error');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('parks the session for the frame and sets no session cookie in the popup', async () => {
    const response = await callback(`__Host-frame_sign_in_binding=${BINDING}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`${env.FRONTEND_URL}/auth/callback?framed=1`);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^__Host-frame_sign_in_binding=; Max-Age=0/);

    const session = await env.DB.prepare('SELECT session_id FROM sessions WHERE did = ?')
      .bind(TEST_DID)
      .first<{ session_id: string }>();
    expect(session).not.toBeNull();

    const claimed = await claim(RELAY);
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get('Set-Cookie')).toContain(`session_id=${session!.session_id}`);
  });

  it('refuses a sign-in finished in a browser that did not start it', async () => {
    for (const cookie of [undefined, '__Host-frame_sign_in_binding=someone-else']) {
      await env.DB.prepare('DELETE FROM oauth_state').run();
      await storeOAuthState(env, STATE, {
        codeVerifier: 'test-code-verifier-value',
        did: TEST_DID,
        handle: TEST_HANDLE,
        pdsUrl: 'https://pds.example.com',
        authServer: 'https://bsky.social',
        returnUrl: '/',
        frontendUrl: env.FRONTEND_URL,
        frameRelayHash: await hashOf(RELAY),
        frameBindingHash: await hashOf(BINDING),
      });
      const response = await callback(cookie);
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toContain('/auth/error');
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect((await claim(RELAY)).status).toBe(202);
      const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{
        n: number;
      }>();
      expect(sessions?.n).toBe(0);
      // Refused before the token exchange: the account isn't even registered.
      const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
      expect(users?.n).toBe(0);
    }
  });
});

describe('claiming a framed sign-in', () => {
  it('waits while the popup is still signing in', async () => {
    const response = await claim(RELAY);
    expect(response.status).toBe(202);
  });

  it('hands the session over once, as a partitioned cookie', async () => {
    await park(RELAY, 'parked-session');
    const first = await claim(RELAY);
    expect(first.status).toBe(200);
    const cookie = first.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain('session_id=parked-session');
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Partitioned');
    expect(cookie).toContain('HttpOnly');

    expect((await claim(RELAY)).status).toBe(202);
  });

  it('ignores a different relay and an expired one', async () => {
    await park(RELAY, 'parked-session', Date.now() - 1);
    expect((await claim(RELAY)).status).toBe(202);
    await park('b'.repeat(64), 'other-session');
    expect((await claim(RELAY)).status).toBe(202);
  });

  it('rejects a malformed relay, and is off unless framing is on', async () => {
    expect((await claim('short')).status).toBe(400);
    await park(RELAY, 'parked-session');
    expect((await claim(RELAY, env)).status).toBe(404);
  });
});

describe('cleaning up framed sign-ins', () => {
  it('drops unclaimed sign-ins and the sessions they parked', async () => {
    const { cleanupFrameSignIns } = await import('../src/routes/frame-sign-in');
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, created_at, registered_at) VALUES (?, ?, 'https://pds.example.com', unixepoch(), unixepoch())`
    )
      .bind(TEST_DID, TEST_HANDLE)
      .run();
    for (const id of ['stale-session', 'fresh-session']) {
      await env.DB.prepare(
        `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at)
         VALUES (?, ?, ?, 'https://pds.example.com', 't', 'r', '{}', ?)`
      )
        .bind(id, TEST_DID, TEST_HANDLE, Date.now() + 3_600_000)
        .run();
    }
    await park(RELAY, 'stale-session', Date.now() - 1);
    await park('b'.repeat(64), 'fresh-session');

    await cleanupFrameSignIns(env, Date.now());

    const left = await env.DB.prepare('SELECT session_id FROM sessions').all<{
      session_id: string;
    }>();
    expect(left.results.map((r) => r.session_id)).toEqual(['fresh-session']);
    expect((await claim('b'.repeat(64))).status).toBe(200);
  });
});

describe('signing out of a frame', () => {
  it('clears the partitioned cookie as well as the top-level one', async () => {
    const response = await call(
      new IncomingRequest('https://api-staging.skyreader.app/api/auth/logout', {
        method: 'POST',
        headers: { Origin: 'https://staging.skyreader.app' },
      })
    );
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[1]).toContain('Partitioned');
    expect(cookies[1]).toContain('Max-Age=0');
  });
});
