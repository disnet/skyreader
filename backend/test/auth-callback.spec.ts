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
