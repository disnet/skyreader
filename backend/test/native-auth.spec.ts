import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { storeOAuthState } from '../src/services/oauth';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:nativeuser123';
const TEST_HANDLE = 'native.bsky.social';
const TEST_STATE = 'native-state-token-12345678';
const VERIFIER = 'a-native-app-secret-verifier-that-never-leaves-the-device';

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// The auth server + profile calls the callback makes on a successful exchange.
function mockSuccessfulOAuth() {
  globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
    const urlStr = url.toString();
    if (urlStr.includes('.well-known/oauth-protected-resource')) {
      return jsonResponse({ authorization_servers: ['https://bsky.social'] });
    }
    if (urlStr.includes('.well-known/oauth-authorization-server')) {
      return jsonResponse({
        issuer: 'https://bsky.social',
        authorization_endpoint: 'https://bsky.social/oauth/authorize',
        token_endpoint: 'https://bsky.social/oauth/token',
        pushed_authorization_request_endpoint: 'https://bsky.social/oauth/par',
        revocation_endpoint: 'https://bsky.social/oauth/revoke',
      });
    }
    if (urlStr.includes('/oauth/token')) {
      return jsonResponse({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        sub: TEST_DID,
        scope: 'atproto',
      });
    }
    if (urlStr.includes('app.bsky.actor.getProfile')) {
      return jsonResponse({ did: TEST_DID, handle: TEST_HANDLE });
    }
    throw new Error(`Unexpected fetch: ${urlStr}`);
  });
}

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function exchange(body: unknown): Promise<Response> {
  return call(
    new IncomingRequest('http://localhost/api/auth/native/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

async function runNativeCallback(): Promise<Response> {
  return call(
    new IncomingRequest(
      `http://localhost/api/auth/callback?code=test-auth-code&state=${TEST_STATE}&iss=https%3A%2F%2Fbsky.social`
    )
  );
}

describe('native app sign-in handoff', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM oauth_state').run();
    await env.DB.prepare('DELETE FROM native_auth_handoff').run();
    await env.DB.prepare('DELETE FROM users').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await storeOAuthState(env, TEST_STATE, {
      codeVerifier: 'test-code-verifier-value',
      did: TEST_DID,
      handle: TEST_HANDLE,
      pdsUrl: 'https://pds.example.com',
      authServer: 'https://bsky.social',
      returnUrl: '/',
      frontendUrl: env.FRONTEND_URL,
      nativeChallenge: await challengeFor(VERIFIER),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('redirects to the app scheme with a one-time code, never the session', async () => {
    mockSuccessfulOAuth();
    const response = await runNativeCallback();

    expect(response.status).toBe(302);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    const location = new URL(response.headers.get('Location') || '');
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(
      'skyreader://auth/callback'
    );
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();

    const session = await env.DB.prepare('SELECT session_id FROM sessions WHERE did = ?')
      .bind(TEST_DID)
      .first<{ session_id: string }>();
    expect(session).toBeTruthy();
    expect(location.toString()).not.toContain(session!.session_id);

    const first = await exchange({ code, verifier: VERIFIER });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ sessionId: session!.session_id });

    // One use only.
    const second = await exchange({ code, verifier: VERIFIER });
    expect(second.status).toBe(400);
  });

  it('rejects the wrong verifier and burns the code', async () => {
    mockSuccessfulOAuth();
    const response = await runNativeCallback();
    const code = new URL(response.headers.get('Location') || '').searchParams.get('code');

    const wrong = await exchange({ code, verifier: 'someone-elses-guess' });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: 'invalid_grant' });

    const right = await exchange({ code, verifier: VERIFIER });
    expect(right.status).toBe(400);
  });

  it('rejects an expired code', async () => {
    await env.DB.prepare(
      'INSERT INTO native_auth_handoff (code, session_id, challenge, expires_at) VALUES (?, ?, ?, ?)'
    )
      .bind('stale-code', 'some-session', await challengeFor(VERIFIER), Date.now() - 1)
      .run();
    const response = await exchange({ code: 'stale-code', verifier: VERIFIER });
    expect(response.status).toBe(400);
  });

  it('sends an auth-server error back to the app', async () => {
    const response = await call(
      new IncomingRequest(
        `http://localhost/api/auth/callback?error=access_denied&error_description=User+declined&state=${TEST_STATE}`
      )
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      'skyreader://auth/callback?error=User%20declined'
    );
  });

  it('validates the exchange request', async () => {
    expect((await exchange({ code: 'x' })).status).toBe(400);
    const get = await call(new IncomingRequest('http://localhost/api/auth/native/exchange'));
    expect(get.status).toBe(405);
  });

  it('rejects a malformed native_challenge at login', async () => {
    const response = await call(
      new IncomingRequest(
        'http://localhost/api/auth/login?handle=native.bsky.social&native_challenge=not-a-digest'
      )
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid native_challenge' });
  });
});
