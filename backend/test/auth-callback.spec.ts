import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';
import { storeOAuthState } from '../src/services/oauth';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Mock auth server metadata response
const MOCK_AUTH_META = {
  issuer: 'https://bsky.social',
  authorization_endpoint: 'https://bsky.social/oauth/authorize',
  token_endpoint: 'https://bsky.social/oauth/token',
  pushed_authorization_request_endpoint: 'https://bsky.social/oauth/par',
  revocation_endpoint: 'https://bsky.social/oauth/revoke',
};

// Mock successful token response
function mockTokenResponse(did: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      sub: did,
      scope: 'atproto',
    }),
    text: async () => '',
  };
}

// Mock invalid_client_metadata error response
function mockClientMetadataError() {
  return {
    ok: false,
    status: 400,
    headers: new Headers(),
    json: async () => ({ error: 'invalid_client_metadata' }),
    text: async () =>
      JSON.stringify({
        error: 'invalid_client_metadata',
        error_description: 'Unable to obtain client metadata',
      }),
  };
}

// Mock profile response
function mockProfileResponse(did: string, handle: string) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      did,
      handle,
      displayName: 'Test User',
    }),
    text: async () => '',
  };
}

// Mock resource server metadata
function mockResourceMeta() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      authorization_servers: ['https://bsky.social'],
    }),
    text: async () => '',
  };
}

// Mock auth server metadata
function mockAuthServerMeta() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => MOCK_AUTH_META,
    text: async () => '',
  };
}

const TEST_DID = 'did:plc:testuser123';
const TEST_HANDLE = 'test.bsky.social';
const TEST_STATE = 'test-state-token-12345678';

describe('auth callback token exchange', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    // Clean up tables
    await env.DB.prepare('DELETE FROM oauth_state').run();
    await env.DB.prepare('DELETE FROM users').run();
    await env.DB.prepare('DELETE FROM sessions').run();

    // Store OAuth state for callback
    await storeOAuthState(env, TEST_STATE, {
      codeVerifier: 'test-code-verifier-value',
      did: TEST_DID,
      handle: TEST_HANDLE,
      pdsUrl: 'https://pds.example.com',
      authServer: 'https://bsky.social',
      returnUrl: '/',
      frontendUrl: env.FRONTEND_URL,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('retries token exchange on invalid_client_metadata error', async () => {
    let tokenCallCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString();

      // Auth server metadata discovery (2 calls: resource + auth server)
      if (urlStr.includes('.well-known/oauth-protected-resource')) {
        return mockResourceMeta();
      }
      if (urlStr.includes('.well-known/oauth-authorization-server')) {
        return mockAuthServerMeta();
      }

      // Token endpoint - fail first, succeed on retry
      if (urlStr.includes('/oauth/token')) {
        tokenCallCount++;
        if (tokenCallCount === 1) {
          return mockClientMetadataError();
        }
        return mockTokenResponse(TEST_DID);
      }

      // Profile fetch
      if (urlStr.includes('app.bsky.actor.getProfile')) {
        return mockProfileResponse(TEST_DID, TEST_HANDLE);
      }

      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const request = new IncomingRequest(
      `http://localhost/api/auth/callback?code=test-auth-code&state=${TEST_STATE}&iss=https%3A%2F%2Fbsky.social`
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    // Should redirect to success (callback page), not error
    expect(response.status).toBe(302);
    const location = response.headers.get('Location') || '';
    expect(location).toContain('/auth/callback');
    expect(location).not.toContain('error');

    // Token endpoint should have been called twice (initial + retry)
    expect(tokenCallCount).toBe(2);
  });

  it('fails after retry if token exchange still returns invalid_client_metadata', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString();

      if (urlStr.includes('.well-known/oauth-protected-resource')) {
        return mockResourceMeta();
      }
      if (urlStr.includes('.well-known/oauth-authorization-server')) {
        return mockAuthServerMeta();
      }

      // Token endpoint - always fail
      if (urlStr.includes('/oauth/token')) {
        return mockClientMetadataError();
      }

      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const request = new IncomingRequest(
      `http://localhost/api/auth/callback?code=test-auth-code&state=${TEST_STATE}&iss=https%3A%2F%2Fbsky.social`
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    // Should redirect to error page
    expect(response.status).toBe(302);
    const location = response.headers.get('Location') || '';
    expect(location).toContain('error');
  });

  it('does not retry on non-client-metadata errors', async () => {
    let tokenCallCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString();

      if (urlStr.includes('.well-known/oauth-protected-resource')) {
        return mockResourceMeta();
      }
      if (urlStr.includes('.well-known/oauth-authorization-server')) {
        return mockAuthServerMeta();
      }

      // Token endpoint - fail with a different error
      if (urlStr.includes('/oauth/token')) {
        tokenCallCount++;
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          json: async () => ({ error: 'invalid_grant' }),
          text: async () => JSON.stringify({ error: 'invalid_grant' }),
        };
      }

      throw new Error(`Unexpected fetch: ${urlStr}`);
    });

    const request = new IncomingRequest(
      `http://localhost/api/auth/callback?code=test-auth-code&state=${TEST_STATE}&iss=https%3A%2F%2Fbsky.social`
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    // Should redirect to error
    expect(response.status).toBe(302);
    const location = response.headers.get('Location') || '';
    expect(location).toContain('error');

    // Token endpoint should only be called once (no retry for non-metadata errors)
    expect(tokenCallCount).toBe(1);
  });
});

describe('auth callback after a permission upgrade', () => {
  const originalFetch = globalThis.fetch;
  const OLD_SESSION = 'session-before-upgrade';
  const UPGRADE_STATE = 'upgrade-state-token-1234567';
  const GRANTED =
    'atproto repo?collection=app.skyreader.feed.subscription&collection=app.skyreader.social.follow&collection=app.skyreader.reading.readAlong repo:network.cosmik.card repo:network.cosmik.collection repo:network.cosmik.collectionLink repo:network.cosmik.connection';

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM oauth_state').run();
    await env.DB.prepare('DELETE FROM sessions').run();
    await env.DB.prepare('DELETE FROM users').run();
    await env.DB.prepare(
      `INSERT INTO users (did, handle, pds_url, created_at, registered_at) VALUES (?, ?, 'https://pds.example.com', unixepoch(), unixepoch())`
    )
      .bind(TEST_DID, TEST_HANDLE)
      .run();
    await env.DB.prepare(
      `INSERT INTO sessions (session_id, did, handle, pds_url, access_token, refresh_token, dpop_private_key, expires_at, granted_scopes)
       VALUES (?, ?, ?, 'https://pds.example.com', 'tok', 'rtok', ?, ?, 'atproto')`
    )
      .bind(
        OLD_SESSION,
        TEST_DID,
        TEST_HANDLE,
        JSON.stringify({ kty: 'EC' }),
        Date.now() + 3_600_000
      )
      .run();
    await storeOAuthState(env, UPGRADE_STATE, {
      codeVerifier: 'test-code-verifier-value',
      did: TEST_DID,
      handle: TEST_HANDLE,
      pdsUrl: 'https://pds.example.com',
      authServer: 'https://bsky.social',
      returnUrl: '/settings',
      frontendUrl: env.FRONTEND_URL,
      replaceSessionId: OLD_SESSION,
    });

    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('.well-known/oauth-protected-resource')) return mockResourceMeta();
      if (urlStr.includes('.well-known/oauth-authorization-server')) return mockAuthServerMeta();
      if (urlStr.includes('/oauth/token')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
            sub: TEST_DID,
            scope: GRANTED,
          }),
          text: async () => '',
        };
      }
      if (urlStr.includes('app.bsky.actor.getProfile')) {
        return mockProfileResponse(TEST_DID, TEST_HANDLE);
      }
      throw new Error(`Unexpected fetch: ${urlStr}`);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('retires the old session and remembers the granted features', async () => {
    const request = new IncomingRequest(
      `http://localhost/api/auth/callback?code=test-auth-code&state=${UPGRADE_STATE}&iss=https%3A%2F%2Fbsky.social`
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toContain('/auth/callback');

    const sessions = await env.DB.prepare(
      'SELECT session_id, granted_scopes FROM sessions WHERE did = ?'
    )
      .bind(TEST_DID)
      .all<{ session_id: string; granted_scopes: string }>();
    expect(sessions.results).toHaveLength(1);
    expect(sessions.results[0].session_id).not.toBe(OLD_SESSION);
    expect(sessions.results[0].granted_scopes).toBe(GRANTED);

    const user = await env.DB.prepare('SELECT oauth_features FROM users WHERE did = ?')
      .bind(TEST_DID)
      .first<{ oauth_features: string }>();
    expect(user?.oauth_features).toBe('semble');
  });

  it('sends a reader who declines back to where they asked from, still signed in', async () => {
    const request = new IncomingRequest(
      `http://localhost/api/auth/callback?error=access_denied&state=${UPGRADE_STATE}`
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`${env.FRONTEND_URL}/settings`);

    const session = await env.DB.prepare('SELECT session_id FROM sessions WHERE session_id = ?')
      .bind(OLD_SESSION)
      .first();
    expect(session).not.toBeNull();
  });
});
