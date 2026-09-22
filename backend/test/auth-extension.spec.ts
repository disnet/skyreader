import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { getOAuthState, storeOAuthState } from '../src/services/oauth';
import { isValidExtensionReturnUrl } from '../src/routes/auth';

// Browser-extension login: Safari won't send the web app's session cookie on an
// extension's fetches, so the extension runs its own login and the callback
// hands the session id to the extension's connected.html instead.

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_DID = 'did:plc:extensionuser1';
const TEST_HANDLE = 'ext.bsky.social';
const TEST_STATE = 'extension-state-token-1234';
const NONCE = 'n0nce_abcdefghijklmnop';
const RETURN = `safari-web-extension://2B3E9A1C-0000-4000-8000-000000000000/connected.html?nonce=${NONCE}`;

const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  headers: new Headers(),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const AUTH_META = {
  issuer: 'https://bsky.social',
  authorization_endpoint: 'https://bsky.social/oauth/authorize',
  token_endpoint: 'https://bsky.social/oauth/token',
  pushed_authorization_request_endpoint: 'https://bsky.social/oauth/par',
};

function mockNetwork() {
  globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('com.atproto.identity.resolveHandle')) return json({ did: TEST_DID });
    if (u.includes('plc.directory') || u.includes('did:plc:'))
      return json({
        id: TEST_DID,
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds.example.com',
          },
        ],
      });
    if (u.includes('.well-known/oauth-protected-resource'))
      return json({ authorization_servers: ['https://bsky.social'] });
    if (u.includes('.well-known/oauth-authorization-server')) return json(AUTH_META);
    if (u.includes('/oauth/par'))
      return json({ request_uri: 'urn:ietf:params:oauth:request_uri:test' });
    if (u.includes('/oauth/token'))
      return json({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        sub: TEST_DID,
        scope: 'atproto',
      });
    if (u.includes('app.bsky.actor.getProfile'))
      return json({ did: TEST_DID, handle: TEST_HANDLE });
    throw new Error(`Unexpected fetch: ${u}`);
  });
}

async function call(path: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new IncomingRequest(`http://localhost${path}`, { headers: { Origin: env.FRONTEND_URL } }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe('isValidExtensionReturnUrl', () => {
  it('accepts connected.html on each extension scheme', () => {
    expect(isValidExtensionReturnUrl(RETURN)).toBe(true);
    expect(
      isValidExtensionReturnUrl(`chrome-extension://abcdefghijklmnop/connected.html?nonce=${NONCE}`)
    ).toBe(true);
    expect(
      isValidExtensionReturnUrl(`moz-extension://1234-5678/connected.html?nonce=${NONCE}`)
    ).toBe(true);
  });

  it('rejects web origins, other pages, and extra URL parts', () => {
    expect(isValidExtensionReturnUrl(`https://evil.example/connected.html?nonce=${NONCE}`)).toBe(
      false
    );
    expect(isValidExtensionReturnUrl(`safari-web-extension://abc/popup.html?nonce=${NONCE}`)).toBe(
      false
    );
    // The nonce is required, and nothing else may ride along.
    expect(isValidExtensionReturnUrl('safari-web-extension://abc/connected.html')).toBe(false);
    expect(isValidExtensionReturnUrl('safari-web-extension://abc/connected.html?nonce=short')).toBe(
      false
    );
    expect(
      isValidExtensionReturnUrl(`safari-web-extension://abc/connected.html?nonce=${NONCE}&x=1`)
    ).toBe(false);
    expect(
      isValidExtensionReturnUrl(`safari-web-extension://abc/connected.html?nonce=${NONCE}#x`)
    ).toBe(false);
    expect(isValidExtensionReturnUrl('javascript:alert(1)')).toBe(false);
    expect(isValidExtensionReturnUrl('not a url')).toBe(false);
  });
});

describe('extension login', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM oauth_state').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects an extension_return that is not an extension page', async () => {
    mockNetwork();
    const res = await call(
      `/api/auth/login?handle=${TEST_HANDLE}&extension_return=${encodeURIComponent('https://evil.example/connected.html')}`
    );
    expect(res.status).toBe(400);
  });

  it('stores a valid extension_return on the OAuth state', async () => {
    mockNetwork();
    const res = await call(
      `/api/auth/login?handle=${TEST_HANDLE}&extension_return=${encodeURIComponent(RETURN)}`
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT state FROM oauth_state').first<{ state: string }>();
    const state = await getOAuthState(env, row!.state);
    expect(state?.extensionReturnUrl).toBe(RETURN);
  });

  it('hands the session to the extension page in the fragment, without a cookie', async () => {
    mockNetwork();
    await storeOAuthState(env, TEST_STATE, {
      codeVerifier: 'verifier',
      did: TEST_DID,
      handle: TEST_HANDLE,
      pdsUrl: 'https://pds.example.com',
      authServer: 'https://bsky.social',
      returnUrl: '/',
      frontendUrl: env.FRONTEND_URL,
      extensionReturnUrl: RETURN,
    });

    const res = await call(
      `/api/auth/callback?code=c&state=${TEST_STATE}&iss=${encodeURIComponent('https://bsky.social')}`
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    const location = new URL(res.headers.get('Location')!);
    expect(`${location.protocol}//${location.host}${location.pathname}${location.search}`).toBe(
      RETURN
    );
    const sessionId = new URLSearchParams(location.hash.slice(1)).get('session_id');
    expect(sessionId).toBeTruthy();

    // The handed-over id is a real session: /api/auth/me accepts it as a Bearer token.
    const ctx = createExecutionContext();
    const me = await worker.fetch(
      new IncomingRequest('http://localhost/api/auth/me', {
        headers: { Authorization: `Bearer ${sessionId}` },
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { did: string }).did).toBe(TEST_DID);
  });
});
